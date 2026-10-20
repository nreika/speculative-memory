/** Reinspect archived tests with the SAME QA and improvement service as live captures. */
import '../server/loadEnv';
import fs from 'node:fs';
import path from 'node:path';
import { QaService } from '../server/qa/qaService';
import { CaptureEventStore } from '../server/events/captureEvents';
import { readQaRows, latestQaRows, isRejectedQaRow, completedQaCaptureIds } from '../server/qa/localJudge';

const val=(key:string,fallback:string)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const prefix=val('--prefix','test-TSC001-fixed-');
const limit=Number(val('--captures','11'));
const eventsFile=path.join(process.cwd(),'logs/capture-events.jsonl');
const rows=fs.readFileSync(eventsFile,'utf8').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const captures=new Map<string,any>();
for(const row of rows)if(row.result==='completed'&&row.captureId.startsWith(prefix)&&row.archiveDir)captures.set(row.captureId,row);
const selected=[...captures.values()].slice(-limit);
let busy=true;
let liveQueue=0;
const poll=async()=>{
 try{
  const [capture,qa]=await Promise.all([fetch('http://127.0.0.1:3000/api/capture/status'),fetch('http://127.0.0.1:3000/api/qa?limit=1')]);
  const c=await capture.json();const q=await qa.json();busy=!!c.active||!q.idleWindow;liveQueue=q.queue;
 }catch{busy=true;}
};
await poll();
const timer=setInterval(()=>{void poll();},500);
const svc=new QaService({isBusy:()=>busy||liveQueue>0,events:new CaptureEventStore(eventsFile)});
const done=new Set(latestQaRows(readQaRows(path.join(process.cwd(),'logs/qa-local.jsonl'))).filter(r=>typeof r.ok==='boolean' && !isRejectedQaRow(r)).map(r=>r.captureId+'|'+r.sceneKey));
try{
 for(const [index,event] of selected.entries()){
  const dir=event.archiveDir;
  const file=fs.readdirSync(dir).find(f=>f.endsWith('_prompts.json'))!;
  const doc=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  const scenes=doc.scenes??[];
  // Rotate which of A/B/C is inspected first, rather than always inspecting A first.
  const order=[...scenes.slice(index%scenes.length),...scenes.slice(0,index%scenes.length)];
  console.log(`QA ${index+1}/${selected.length} ${event.captureId}: ${order.map(s=>s.sceneKey).join(',')}`);
  for(const scene of order){
   if(!process.argv.includes('--recheck') && done.has(event.captureId+'|'+scene.sceneKey))continue;
   const image=path.join(dir,`${doc.generationId}_${scene.letter}.png`);
   svc.enqueueScene({captureId:event.captureId,sceneKey:scene.sceneKey,nowPath:path.join(dir,doc.sourceFile),imagePath:image,predictionPrompt:scene.predictionPrompt,archiveDir:dir,rulebookVersion:doc.rulebookVersion,expectedPeople:scene.behindView?1:doc.vlm?.guard?.unoccupied?0:doc.vlm?.guard?.people?.length,sceneCount:scenes.length,test:true});
   await svc.queue.idle();
  }
 }
 const selectedIds=new Set(selected.map(event=>event.captureId));
 const checked=latestQaRows(readQaRows(path.join(process.cwd(),'logs/qa-local.jsonl'))).filter(row=>selectedIds.has(row.captureId));
 console.log(`DONE ${completedQaCaptureIds(checked).size}/${selected.length} test captures fully inspected; unknown or incomplete captures do not count towards validation`);
}finally{clearInterval(timer);svc.queue.stop();}
