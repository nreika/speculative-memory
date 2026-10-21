import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sequenceFrame,naturalCompare,createSequenceLibrary,parseSequenceFrameUrl} from './browserOutputSequences';
import {BrowserOutputsStore,validateBrowserOutputs,stampSequenceStarts,type BrowserOutputConfig} from './browserOutputs';

const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a5f4d0b20000000049454e44ae426082','hex');
async function folder(files:string[],captions?:Record<string,string>){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sequences-'));const seq=path.join(dir,'sequences','demo');await fs.mkdir(seq,{recursive:true});
 for(const f of files)await fs.writeFile(path.join(seq,f),f.endsWith('.txt')?'x':PNG);
 if(captions)await fs.writeFile(path.join(seq,'captions.json'),JSON.stringify(captions));
 return {dir,root:path.join(dir,'sequences'),cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
const seqOutput=(extra:Partial<BrowserOutputConfig>={}):BrowserOutputConfig=>({id:'screen-10',label:'Seq',source:'fixed-sequence',delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,fade:true,sequenceFolder:'demo',frameSec:5,startFrame:2,endFrame:4,loop:true,sequenceStartedAtMs:1000,...extra});

test('frame selection: start/end window, loop, clamp, deterministic over time',()=>{
 const at=(s:number,o:object={})=>sequenceFrame({count:5,startFrame:2,endFrame:4,frameSec:5,startedAtMs:1000,nowMs:1000+s*1000,...o})!.frame;
 assert.deepEqual([0,4.9,5,10,14.99,15,20,25].map(s=>at(s)),[2,2,3,4,4,2,3,4]);
 assert.equal(at(-30),2,'a start time in the future shows the start frame');
 assert.equal(at(100,{loop:false}),4,'no loop holds the end frame');
 assert.equal(sequenceFrame({count:5,startFrame:2,endFrame:4,frameSec:5,loop:false,startedAtMs:0,nowMs:99999})!.nextChangeAtMs,null);
 assert.equal(sequenceFrame({count:5,startFrame:2,endFrame:4,frameSec:5,startedAtMs:1000,nowMs:7000})!.nextChangeAtMs,11000);
 assert.deepEqual((({start,end})=>[start,end])(sequenceFrame({count:3,startFrame:9,endFrame:20,frameSec:1,startedAtMs:0,nowMs:0})!),[3,3],'start/end clamp to the frame count');
 assert.equal(sequenceFrame({count:5,frameSec:30,startedAtMs:0,nowMs:150000})!.frame,1,'end absent = last; 5 frames x 30 s loops after 150 s');
 assert.equal(sequenceFrame({count:0,frameSec:5,startedAtMs:0,nowMs:0}),null);
 for(let t=0;t<60000;t+=777)assert.equal(at(t/1000),at(t/1000),'same time, same frame');
});

test('listing ignores non-images, sorts naturally, serves frames by index and reads captions.json',async()=>{
 const f=await folder(['10.png','2.png','1.png','notes.txt','b.JPG'],{'2.png':'二枚目'});
 try{
  assert.ok(['1.png','2.png','10.png'].sort(naturalCompare).join()==='1.png,2.png,10.png');
  await fs.mkdir(path.join(f.root,'bad name'));await fs.mkdir(path.join(f.root,'empty'));
  const lib=createSequenceLibrary({directory:f.root});
  const list=await lib.list();
  assert.deepEqual(list.map(s=>[s.name,s.frameCount]),[['demo',4],['empty',0]]);
  assert.equal(list[0].thumbnailUrl,'/captures/sequences/demo/0001.png');
  const demo=(await lib.folder('demo'))!;
  assert.deepEqual(demo.frames.map(x=>x.filename),['1.png','2.png','10.png','b.JPG']);
  assert.equal(demo.frames[3].url,'/captures/sequences/demo/0004.jpg');
  assert.equal(demo.frames[1].caption,'二枚目');
  assert.ok((await lib.resolve('/captures/sequences/demo/0003.png'))!.absolutePath.endsWith('10.png'));
  for(const bad of ['/captures/sequences/demo/0003.jpg','/captures/sequences/demo/0009.png','/captures/sequences/../x/0001.png','/captures/sequences/demo/1.png','/captures/sequences/nope/0001.png'])assert.equal(await lib.resolve(bad),null,bad);
  assert.equal(parseSequenceFrameUrl('/captures/sequences/demo/0000.png'),null);
  const now=(await lib.current({folder:'demo',frameSec:5,startFrame:2,endFrame:4,startedAtMs:0,nowMs:5000}))!;
  assert.equal(now.content.imageUrl,'/captures/sequences/demo/0003.png');assert.equal(now.content.sequenceLabel,'SEQ · demo · 3/4');assert.equal(now.content.caption,'');
 }finally{await f.cleanup();}
});

test('import writes numbered frames into a new folder, never overwrites, rejects non-images and bad names',async()=>{
 const f=await folder([]);
 try{
  const lib=createSequenceLibrary({directory:f.root}),data='data:image/png;base64,'+PNG.toString('base64');
  await lib.importFrame({folder:'new_seq',index:1,imageDataUrl:data});await lib.importFrame({folder:'new_seq',index:2,imageDataUrl:data});
  assert.deepEqual((await lib.folder('new_seq'))!.frames.map(x=>x.filename),['0001.png','0002.png']);
  await assert.rejects(lib.importFrame({folder:'new_seq',index:1,imageDataUrl:data}),/already has frame 1/);
  await assert.rejects(lib.importFrame({folder:'../x',index:1,imageDataUrl:data}),/Sequence name/);
  await assert.rejects(lib.importFrame({folder:'ok',index:1,imageDataUrl:'data:image/png;base64,'+Buffer.from('nope').toString('base64')}),/PNG or JPEG/);
 }finally{await f.cleanup();}
});

test('output validation: sequence fields only on fixed-sequence, defaults, ranges',()=>{
 const [o]=validateBrowserOutputs([{id:'screen-9',label:'S',source:'fixed-sequence',delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,sequenceFolder:'demo'}]);
 assert.deepEqual([o.frameSec,o.startFrame,o.endFrame,o.loop,o.sequenceStartedAtMs],[30,1,undefined,true,0]);
 const base={id:'screen-9',label:'S',source:'fixed-sequence',delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,sequenceFolder:'demo'};
 for(const bad of [{sequenceFolder:undefined},{sequenceFolder:'a/b'},{frameSec:0.5},{frameSec:86401},{startFrame:0},{startFrame:1.5},{startFrame:3,endFrame:2},{loop:'yes'},{source:'a',sequenceFolder:'demo'},{contentId:'x'}])
  assert.throws(()=>validateBrowserOutputs([{...base,...bad}]),JSON.stringify(bad));
});

test('playback restarts only when the sequence is assigned or its settings change',()=>{
 const prev=[seqOutput()];
 assert.equal(stampSequenceStarts([seqOutput({sequenceStartedAtMs:5})],prev,9000)[0].sequenceStartedAtMs,1000,'unchanged keeps the start');
 assert.equal(stampSequenceStarts([seqOutput({label:'renamed'})],prev,9000)[0].sequenceStartedAtMs,1000);
 assert.equal(stampSequenceStarts([seqOutput({frameSec:6})],prev,9000)[0].sequenceStartedAtMs,9000);
 assert.equal(stampSequenceStarts([seqOutput()],[],9000)[0].sequenceStartedAtMs,9000);
});

test('store snapshot cycles 2→3→4→2 at 5 s per frame (fixture catalog, no live server)',async()=>{
 const f=await folder(['f1.png','f2.png','f3.png','f4.png','f5.png']);
 try{
  const configFile=path.join(f.dir,'browser-output-config.json');
  await fs.writeFile(configFile,JSON.stringify({schema:1,outputs:[seqOutput()]}));
  let time=1000;
  const store=new BrowserOutputsStore({configFile,now:()=>time,loadCatalog:async()=>({contents:[],current:{},sourceScopes:{},clocks:{}})});
  const seen:number[]=[];
  for(const t of [0,5,10,15,20]){time=1000+t*1000;const s=(await store.snapshot('screen-10'))!;seen.push(s.sequence!.frame);
   assert.equal(s.outputStatus.state,'ready');assert.equal(s.content!.imageUrl,`/captures/sequences/demo/000${s.sequence!.frame}.png`);assert.equal(s.view.fadeOnImageChange,true);assert.equal((s.content as any).sequenceLabel,`SEQ · demo · ${s.sequence!.frame}/5`);}
  assert.deepEqual(seen,[2,3,4,2,3]);
  // A save that keeps the sequence keeps its clock; a save to an unknown folder is refused.
  const c=await store.configuration(true);
  time=50000;const saved=await store.update({baseRevision:c.revision,requestId:'ui-1',outputs:[{...seqOutput(),label:'renamed'}]});
  assert.equal(saved.outputs[0].sequenceStartedAtMs,1000);
  await assert.rejects(store.update({baseRevision:saved.revision,requestId:'ui-2',outputs:[seqOutput({sequenceFolder:'missing'})]}),/Unknown or empty sequence folder/);
  const restarted=await store.update({baseRevision:saved.revision,requestId:'ui-3',outputs:[seqOutput({frameSec:10})]});
  assert.equal(restarted.outputs[0].sequenceStartedAtMs,50000);
 }finally{await f.cleanup();}
});
