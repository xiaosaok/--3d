import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.web.min.js';
env.allowLocalModels=false;
env.backends.onnx.wasm.numThreads=1;
env.backends.onnx.wasm.proxy=false;
env.backends.onnx.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
let classifier=null;
let work=Promise.resolve();
self.onmessage=event=>{const request=event.data;work=work.then(async()=>{try{if(!classifier){self.postMessage({id:request.id,type:'progress',text:'首次准备浏览器识图模型（约154MB），请保持页面打开…'});classifier=await pipeline('zero-shot-image-classification','Xenova/clip-vit-base-patch32',{dtype:'q8',device:'wasm',progress_callback:p=>{if(p.status==='progress'&&p.file?.endsWith('.onnx'))self.postMessage({id:request.id,type:'progress',text:'下载识图模型 '+Math.floor(p.progress||0)+'%（图片仍在本机）'})}})}const result=await classifier(request.image,request.catalog.map(c=>c.label));const best=result[0],second=result[1],item=request.catalog.find(c=>c.label===best.label);const threshold=item.id==='kitchen'?.60:.42;const review=item.id==='other'||best.score<threshold||best.score-second.score<.20;self.postMessage({id:request.id,type:'result',result:{id:review?'other':item.id,suggestedId:item.id,review,source:'image-content',model:'CLIP browser classification',alternatives:result.slice(0,3).map(r=>({id:request.catalog.find(c=>c.label===r.label).id,score:r.score}))}})}catch(e){self.postMessage({id:request.id,type:'error',error:'浏览器识图暂不可用：'+e.message+'。可手选柜型继续制作。'})}})};

