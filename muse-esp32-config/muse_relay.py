"""LAN-only DNS and end-to-end TLS relay for the user's Muse board."""
import ipaddress
import select
import socket
import socketserver
import struct
import threading
import time
import re
import subprocess
import os
import tempfile
import wave
import asyncio
import edge_tts
import imageio_ffmpeg
from http.server import BaseHTTPRequestHandler, HTTPServer

LISTEN_IP = '192.0.2.10'
BOARD_IP = '192.0.2.20'
DNS_UPSTREAM = ('127.0.0.1', 1053)
PROXY_UPSTREAM = ('127.0.0.1', 7890)
ALLOWED_DOMAINS = ('muse.ai', 'metaaivm.com')

def refresh_board_ip():
    global BOARD_IP
    while True:
        try:
            result = subprocess.run(['arp', '-a'], capture_output=True, text=True, timeout=3,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            for line in result.stdout.splitlines():
                if '00-00-00-00-00-00' in line.lower():
                    match = re.search(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', line)
                    if match:
                        BOARD_IP = match.group(0)
        except (OSError, subprocess.TimeoutExpired):
            pass
        time.sleep(10)

def allowed(host):
    host = host.rstrip('.').lower()
    return any(host == domain or host.endswith('.' + domain) for domain in ALLOWED_DOMAINS)

def dns_name(packet):
    pos, labels = 12, []
    while pos < len(packet):
        n = packet[pos]; pos += 1
        if n == 0:
            return '.'.join(labels), pos
        if n > 63 or pos + n > len(packet):
            raise ValueError('invalid DNS question')
        labels.append(packet[pos:pos+n].decode('ascii')); pos += n
    raise ValueError('invalid DNS question')

class DNSHandler(socketserver.BaseRequestHandler):
    def handle(self):
        if self.client_address[0] != BOARD_IP:
            return
        packet, listener = self.request
        try:
            name, end = dns_name(packet)
            qtype, qclass = struct.unpack('!HH', packet[end:end+4])
            if allowed(name) and qtype == 1 and qclass == 1:
                flags = (struct.unpack('!H', packet[2:4])[0] & 0x0100) | 0x8080
                head = packet[:2] + struct.pack('!HHHHH', flags, 1, 1, 0, 0)
                answer = b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 10, 4) + socket.inet_aton(LISTEN_IP)
                listener.sendto(head + packet[12:end+4] + answer, self.client_address)
            else:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as upstream:
                    upstream.settimeout(3)
                    upstream.sendto(packet, DNS_UPSTREAM)
                    listener.sendto(upstream.recv(4096), self.client_address)
        except (ValueError, OSError, struct.error, UnicodeError):
            return

def extract_sni(data):
    if len(data) < 5 or data[0] != 22:
        raise ValueError('not TLS')
    length = int.from_bytes(data[3:5], 'big')
    if len(data) < 5 + length:
        return None
    payload = data[5:5+length]
    if len(payload) < 42 or payload[0] != 1:
        raise ValueError('not client hello')
    p = 38
    p += 1 + payload[p]
    n = int.from_bytes(payload[p:p+2], 'big'); p += 2 + n
    p += 1 + payload[p]
    end = p + 2 + int.from_bytes(payload[p:p+2], 'big'); p += 2
    while p + 4 <= min(end, len(payload)):
        typ = int.from_bytes(payload[p:p+2], 'big'); n = int.from_bytes(payload[p+2:p+4], 'big'); p += 4
        if p+n > len(payload): raise ValueError('invalid extension')
        if typ == 0 and n >= 5:
            size = int.from_bytes(payload[p+3:p+5], 'big')
            if size <= n-5: return payload[p+5:p+5+size].decode('ascii')
        p += n
    raise ValueError('missing SNI')

class TLSHandler(socketserver.BaseRequestHandler):
    def handle(self):
        if self.client_address[0] != BOARD_IP:
            return
        client = self.request
        client.settimeout(10)
        data = b''
        try:
            host = None
            while host is None and len(data) < 65536:
                chunk = client.recv(8192)
                if not chunk: return
                data += chunk
                host = extract_sni(data)
            if not host or not allowed(host): return
            with socket.create_connection(PROXY_UPSTREAM, timeout=10) as upstream:
                upstream.sendall(('CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n' % (host, host)).encode('ascii'))
                response = b''
                while b'\r\n\r\n' not in response and len(response) < 8192:
                    part = upstream.recv(4096)
                    if not part: return
                    response += part
                if not response.startswith(b'HTTP/1.1 200') and not response.startswith(b'HTTP/1.0 200'):
                    return
                upstream.sendall(data)
                client.setblocking(False); upstream.setblocking(False)
                last = time.monotonic()
                while time.monotonic() - last < 120:
                    ready, _, _ = select.select([client, upstream], [], [], 5)
                    for source in ready:
                        buf = source.recv(16384)
                        if not buf: return
                        target = upstream if source is client else client
                        target.setblocking(True); target.settimeout(10); target.sendall(buf); target.setblocking(False)
                        last = time.monotonic()
        except (OSError, ValueError, IndexError, UnicodeError):
            return

class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

class UDPServer(socketserver.ThreadingMixIn, socketserver.UDPServer):
    allow_reuse_address = True
    daemon_threads = True

class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.client_address[0] != BOARD_IP or self.path != '/speech':
            self.send_error(403); return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 1023:
                self.send_error(400); return
            message = self.rfile.read(length).decode('utf-8')
            voice_source = 'online'
            try:
                async def generate():
                    voice = edge_tts.Communicate(message, 'zh-CN-XiaoxiaoNeural', rate='-8%',
                                                 proxy='http://127.0.0.1:7890')
                    audio = bytearray()
                    async for item in voice.stream():
                        if item['type'] == 'audio': audio.extend(item['data'])
                    return bytes(audio)
                mp3 = asyncio.run(asyncio.wait_for(generate(), timeout=15))
                converted = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-i', 'pipe:0',
                    '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], input=mp3,
                    capture_output=True, timeout=6, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if converted.returncode or not converted.stdout:
                    raise ValueError('voice conversion failed')
                pcm = converted.stdout
            except Exception:
                pcm = None
                voice_source = 'local'
            if pcm is None:
              with tempfile.TemporaryDirectory(prefix='muse-voice-') as directory:
                output = os.path.join(directory, 'speech.wav')
                env = os.environ.copy(); env['MUSE_SPEECH_TEXT'] = message; env['MUSE_SPEECH_PATH'] = output
                script = '''Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, Sixteen, Mono
$s.SetOutputToWaveFile($env:MUSE_SPEECH_PATH, $f)
$s.Speak($env:MUSE_SPEECH_TEXT)
$s.Dispose()'''
                result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                    env=env, capture_output=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if result.returncode:
                    self.send_error(500); return
                with wave.open(output, 'rb') as f:
                    if (f.getnchannels(), f.getsampwidth(), f.getframerate()) != (1, 2, 16000):
                        self.send_error(500); return
                    pcm = f.readframes(f.getnframes())
            self.send_response(200); self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('X-Muse-Voice', voice_source)
            self.send_header('Content-Length', str(len(pcm))); self.end_headers(); self.wfile.write(pcm)
        except (ValueError, UnicodeError, OSError, subprocess.TimeoutExpired, wave.Error):
            self.send_error(500)

class HTTPThreadServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    with UDPServer((LISTEN_IP, 53), DNSHandler) as dns, Server((LISTEN_IP, 443), TLSHandler) as tls, HTTPThreadServer((LISTEN_IP, 4215), TTSHandler) as tts:
        threading.Thread(target=dns.serve_forever, daemon=True).start()
        threading.Thread(target=refresh_board_ip, daemon=True).start()
        threading.Thread(target=tts.serve_forever, daemon=True).start()
        tls.serve_forever()

