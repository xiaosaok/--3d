// Floor-plan import is local to the browser. Source drawings are never uploaded.
const $ = s => document.querySelector(s);
const finite = n => Number.isFinite(n);
const box = pts => [Math.min(...pts.map(p=>p.x)),Math.min(...pts.map(p=>p.y)),Math.max(...pts.map(p=>p.x)),Math.max(...pts.map(p=>p.y))];
const overlap = (a,b,gap=0) => a[0]<=b[2]+gap && a[2]+gap>=b[0] && a[1]<=b[3]+gap && a[3]+gap>=b[1];
const union = boxes => [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const area = p => Math.abs(p.reduce((s,q,i)=>{const n=p[(i+1)%p.length];return s+q.x*n.y-n.x*q.y},0))/2;

function dominant(items, gap){
  if (!items.length) return [];
  const seen=new Set(), groups=[];
  for(let i=0;i<items.length;i++){
    if(seen.has(i)) continue;
    const q=[i], group=[]; seen.add(i);
    while(q.length){
      const j=q.pop(); group.push(items[j]);
      for(let k=0;k<items.length;k++) if(!seen.has(k)&&overlap(items[j].box,items[k].box,gap)){seen.add(k);q.push(k)}
    }
    groups.push(group);
  }
  groups.sort((a,b)=>b.reduce((s,v)=>s+(v.weight||1),0)-a.reduce((s,v)=>s+(v.weight||1),0));
  return groups[0];
}
function pathPolygon(path){
  const pts=path.vertices?.length ? path.vertices : path.edges?.filter(e=>e.type===1).map(e=>e.start);
  return pts?.filter(p=>finite(p.x)&&finite(p.y)) || [];
}
function inside(x,y,p){
  let c=false;
  for(let i=0,j=p.length-1;i<p.length;j=i++){
    const a=p[i],b=p[j];
    if((a.y>y)!==(b.y>y) && x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)c=!c;
  }
  return c;
}
function rasterPolygons(polys, step){
  const extent=union(polys.map(p=>p.box)), x0=Math.floor(extent[0]/step)*step, y0=Math.floor(extent[1]/step)*step;
  const w=Math.ceil((extent[2]-x0)/step)+1,h=Math.ceil((extent[3]-y0)/step)+1;
  if(w*h>1500000) throw Error('图纸范围过大，请先在 CAD 中裁剪到单套户型');
  const mask=new Uint8Array(w*h);
  for(const {points:p,box:b} of polys){
    const xa=Math.max(0,Math.floor((b[0]-x0)/step)),xb=Math.min(w-1,Math.ceil((b[2]-x0)/step));
    const ya=Math.max(0,Math.floor((b[1]-y0)/step)),yb=Math.min(h-1,Math.ceil((b[3]-y0)/step));
    for(let y=ya;y<=yb;y++)for(let x=xa;x<=xb;x++) if(inside(x0+(x+.5)*step,y0+(y+.5)*step,p)) mask[y*w+x]=1;
  }
  return mergeMask(mask,w,h,x0,y0,step);
}
function mergeMask(mask,w,h,x0,y0,step){
  const result=[],active=new Map();
  for(let y=0;y<=h;y++){
    const next=new Map();
    if(y<h)for(let x=0;x<w;){
      if(!mask[y*w+x]){x++;continue}
      const a=x;while(x<w&&mask[y*w+x])x++;
      const key=`${a}:${x}`,old=active.get(key);
      next.set(key,old ? [old[0],old[1],old[2],y+1] : [a,y,x,y+1]);
    }
    for(const [key,r] of active)if(!next.has(key))result.push([x0+r[0]*step,y0+r[1]*step,x0+r[2]*step,y0+r[3]*step]);
    active.clear(); for(const [k,v] of next)active.set(k,v);
  }
  return result.filter(r=>(r[2]-r[0])*(r[3]-r[1])>=step*step);
}
function segmentsOf(e){
  if(e.type==='LINE'&&e.startPoint&&e.endPoint)return [[e.startPoint,e.endPoint]];
  if(e.type==='LINE'&&e.vertices?.length>=2)return [[e.vertices[0],e.vertices[1]]];
  if((e.type==='LWPOLYLINE'||e.type==='POLYLINE2D')&&e.vertices?.length){
    const p=e.vertices, out=[];for(let i=1;i<p.length;i++)out.push([p[i-1],p[i]]);
    if((e.flag&1)||e.shape)out.push([p.at(-1),p[0]]);
    return out;
  }
  return [];
}
function lineRects(entities,thickness){
  const parts=[];
  for(const e of entities)for(const [a,b] of segmentsOf(e)){
    if(![a.x,a.y,b.x,b.y].every(finite))continue;
    const dx=Math.abs(a.x-b.x),dy=Math.abs(a.y-b.y),len=Math.hypot(dx,dy);
    if(len<thickness*1.8 || Math.min(dx,dy)>Math.max(dx,dy)*.08)continue;
    const t=thickness/2;
    parts.push({box:dx>dy?[Math.min(a.x,b.x),a.y-t,Math.max(a.x,b.x),a.y+t]:[a.x-t,Math.min(a.y,b.y),a.x+t,Math.max(a.y,b.y)],weight:len});
  }
  return dominant(parts,thickness*5).map(v=>v.box);
}
function unitFactor(header){
  return {1:25.4,2:304.8,4:1,5:10,6:1000,7:1000000,14:100,15:10000}[Number(header?.INSUNITS??header?.$INSUNITS)] || 1;
}
function makePlan(rects,name,source,scale=1,invertY=true){
  rects=rects.filter(r=>r.every(finite)&&r[2]>r[0]&&r[3]>r[1]);
  if(!rects.length)throw Error('没有识别到墙体，请检查图纸或更换文件');
  const e=union(rects),midX=(e[0]+e[2])/2,midY=(e[1]+e[3])/2;
  const tx=x=>Math.round(6000+(x-midX)*scale),ty=y=>Math.round(5300+(invertY?midY-y:y-midY)*scale);
  const walls=rects.map(r=>{const a=tx(r[0]),b=tx(r[2]),c=ty(r[1]),d=ty(r[3]);return [Math.min(a,b),Math.min(c,d),Math.max(a,b),Math.max(c,d),'e']})
    .filter(r=>r[2]-r[0]>=20&&r[3]-r[1]>=20);
  if(walls.length>2000)throw Error('检测到的墙线过多，请先裁剪图纸到单套户型');
  const [x0,y0,x1,y1]=union(walls.map(r=>r.slice(0,4)));
  const inset=Math.min(100,(x1-x0)/20,(y1-y0)/20);
  const rooms=[{id:'imported',name:'导入户型',poly:[[x0+inset,y0+inset],[x1-inset,y0+inset],[x1-inset,y1-inset],[x0+inset,y1-inset]],mat:'tile800',at:[6000,5300]}];
  return {source,name,walls,wins:[],doors:[],slides:[],rooms,bounds:{x:x0-1200,y:y0-1200,w:x1-x0+2400,h:y1-y0+2400},widthMm:x1-x0,heightMm:y1-y0};
}
export function extractCadPlan(db,name='CAD 户型'){
  const entities=db.entities||[];
  const factor=unitFactor(db.header);
  const wall=entities.filter(e=>/wall|墙|砌体|partition/i.test(e.layer||''));
  const hatch=wall.filter(e=>e.type==='HATCH').map(e=>{
    const polys=(e.boundaryPaths||[]).map(pathPolygon).filter(p=>p.length>=3&&area(p)>1000/factor**2).map(points=>({points,box:box(points)}));
    return {polys,box:polys.length?union(polys.map(p=>p.box)):null,weight:polys.reduce((n,p)=>n+area(p.points),0)};
  }).filter(h=>h.box);
  let rects=[];
  if(hatch.length){
    const main=dominant(hatch,2000).flatMap(h=>h.polys);
    if(main.length)rects=rasterPolygons(main,50/factor);
  }
  if(rects.length<3)rects=lineRects(wall.length?wall:entities,180/factor);
  return makePlan(rects,name,'cad',factor,true);
}

function imageRuns(data,w,h,horizontal){
  const count=horizontal?h:w,long=horizontal?w:h,minLength=Math.max(30,Math.round(long*.07)),runs=[];
  for(let row=0;row<count;row+=2){
    let start=-1,gap=0;
    for(let col=0;col<=long;col++){
      const x=horizontal?col:row,y=horizontal?row:col;
      const i=(y*w+x)*4,dark=col<long&&data[i]*.299+data[i+1]*.587+data[i+2]*.114<145&&data[i+3]>100;
      if(dark){if(start<0)start=col;gap=0}
      else if(start>=0 && ++gap>2){const end=col-gap+1;if(end-start>=minLength)runs.push(horizontal?[start,row-1,end,row+2]:[row-1,start,row+2,end]);start=-1;gap=0}
    }
  }
  return runs;
}
export function extractImagePlan(canvas,name='图片户型',actualWidthM=10){
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),{width:w,height:h}=canvas;
  const data=ctx.getImageData(0,0,w,h).data;
  const runs=[...imageRuns(data,w,h,true),...imageRuns(data,w,h,false)];
  const chosen=dominant(runs.map(box=>({box,weight:Math.max(box[2]-box[0],box[3]-box[1])})),Math.max(12,Math.min(w,h)*.025));
  const rects=chosen.map(v=>v.box);
  if(rects.length<4)throw Error('图片中未找到足够的墙线。请使用清晰、正视的黑白户型图');
  const e=union(rects),scale=actualWidthM*1000/(e[2]-e[0]);
  const thick=Math.max(100,Math.min(240,scale*3));
  const adjusted=rects.map(r=>{
    const dx=r[2]-r[0],dy=r[3]-r[1],t=thick/scale/2;
    return dx>dy?[r[0],(r[1]+r[3])/2-t,r[2],(r[1]+r[3])/2+t]:[(r[0]+r[2])/2-t,r[1],(r[0]+r[2])/2+t,r[3]];
  });
  return makePlan(adjusted,name,'image',scale,false);
}

async function readDrawing(file,widthM){
  const ext=file.name.split('.').at(-1).toLowerCase();
  if(ext==='dxf'){
    const bytes=await file.arrayBuffer();let text=new TextDecoder().decode(bytes);
    if(text.includes('\ufffd'))text=new TextDecoder('gb18030').decode(bytes);
    const parsed=new window.DxfParser().parseSync(text);
    return extractCadPlan(parsed,file.name);
  }
  if(ext==='dwg'){
    const {LibreDwg,Dwg_File_Type}=await import('./vendor/libredwg/dist/libredwg-web.js');
    const cad=await LibreDwg.create(new URL('./vendor/libredwg/wasm/',import.meta.url).href.replace(/\/$/,''));
    const ptr=cad.dwg_read_data(await file.arrayBuffer(),Dwg_File_Type.DWG);
    if(!ptr)throw Error('CAD 文件无法解析，请检查文件格式');
    try{return extractCadPlan(cad.convert(ptr),file.name)}finally{cad.dwg_free(ptr)}
  }
  const bitmap=await createImageBitmap(file),cv=document.createElement('canvas');
  const scale=Math.min(1,1200/Math.max(bitmap.width,bitmap.height));
  cv.width=Math.round(bitmap.width*scale);cv.height=Math.round(bitmap.height*scale);
  cv.getContext('2d').drawImage(bitmap,0,0,cv.width,cv.height);bitmap.close();
  return extractImagePlan(cv,file.name,widthM);
}
function drawPreview(plan){
  const canvas=$('#importPreview'),dpr=Math.min(devicePixelRatio||1,2),b=canvas.getBoundingClientRect();
  canvas.width=Math.max(1,Math.round(b.width*dpr));canvas.height=Math.max(1,Math.round(b.height*dpr));
  const c=canvas.getContext('2d'),p=plan.bounds,s=Math.min(canvas.width/p.w,canvas.height/p.h)*.94;
  c.fillStyle='#f8f6f0';c.fillRect(0,0,canvas.width,canvas.height);
  c.save();c.translate((canvas.width-p.w*s)/2-p.x*s,(canvas.height-p.h*s)/2-p.y*s);c.scale(s,s);
  c.fillStyle='#e9e3d7';const poly=plan.rooms[0].poly;c.beginPath();poly.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fill();
  c.fillStyle='#34312d';for(const r of plan.walls)c.fillRect(r[0],r[1],r[2]-r[0],r[3]-r[1]);c.restore();
}
let chosenFile=null, pending=null, runId=0;
async function processFile(){
  const id=++runId,file=chosenFile;if(!file)return;
  pending=null;$('#applyImport').disabled=true;$('#importStatus').textContent='正在识别墙体，请稍候…';
  try{
    const plan=await readDrawing(file,Number($('#imageWidth').value)||10);
    if(id!==runId)return;
    pending=plan;drawPreview(plan);
    $('#importStatus').textContent=`已识别 ${plan.walls.length} 段墙体 · 约 ${(plan.widthMm/1000).toFixed(1)} × ${(plan.heightMm/1000).toFixed(1)} 米。请核对墙线后生成。`;
    $('#applyImport').disabled=false;
  }catch(e){if(id===runId)$('#importStatus').textContent=e.message||'识别失败，请换一张清晰图纸';console.error(e)}
}
if(typeof document!=='undefined'){
  const dialog=$('#importDialog');
  $('#importDrawing').onclick=()=>$('#drawingIn').click();
  $('#drawingIn').onchange=e=>{
    chosenFile=e.target.files[0];e.target.value='';if(!chosenFile)return;
    const image=/\.(jpe?g|png)$/i.test(chosenFile.name);
    $('#imageWidthLabel').hidden=$('#retryImport').hidden=!image;
    dialog.showModal();processFile();
  };
  $('#retryImport').onclick=processFile;
  $('#closeImport').onclick=$('#cancelImport').onclick=()=>{runId++;dialog.close()};
  $('#applyImport').onclick=()=>{if(!pending)return;window.FloorPlanBridge.apply(pending);dialog.close()};
  addEventListener('resize',()=>{if(pending&&dialog.open)drawPreview(pending)});
}
