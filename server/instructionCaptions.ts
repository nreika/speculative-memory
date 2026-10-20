import fs from 'node:fs';
import path from 'node:path';

type Request = {captureId:string;sceneKey:string;imageUrl:string};
type Row = {captureId:string;images?:{now?:string;a?:string;b?:string;c?:string}};
/** Read-only projection: join the exact displayed capture/image to its saved generation instruction. */
export function createInstructionCaptionLookup(root:string, rows:()=>Row[]) {
  const cache=new Map<string,{stamp:string;doc:any}>();
  return (request:Request): (Request & {plannedDescription:string})|undefined => {
    if(!/^gen_[abc]$/.test(request.sceneKey))return;
    const letter=request.sceneKey.slice(-1) as 'a'|'b'|'c';
    const row=rows().find(r=>r.captureId===request.captureId&&r.images?.[letter]===request.imageUrl);
    const match=/^\/captures\/record_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.(?:jpe?g|png|webp)$/i.exec(row?.images?.now??'');
    if(!row||!match)return;
    const generationId=match[1],file=path.join(root,generationId.slice(0,10),generationId,generationId+'_prompts.json');
    try {
      const stat=fs.statSync(file),stamp=stat.mtimeMs+':'+stat.size;
      let saved=cache.get(file);
      if(!saved||saved.stamp!==stamp){saved={stamp,doc:JSON.parse(fs.readFileSync(file,'utf8'))};cache.set(file,saved);if(cache.size>32)cache.delete(cache.keys().next().value!);}
      const doc=saved.doc;
      if(doc.captureId!==request.captureId||doc.generationId!==generationId||!Array.isArray(doc.scenes))return;
      const scenes=doc.scenes.filter((s:any)=>s.sceneKey===request.sceneKey);
      if(scenes.length!==1||scenes[0].letter!==letter.toUpperCase()||!String(scenes[0].file??'').startsWith(generationId+'_'+letter.toUpperCase()+'.'))return;
      const text=scenes[0].plannedDescription||scenes[0].predictionPrompt;
      if(typeof text!=='string'||!text.trim()||text.length>8000)return;
      return {...request,plannedDescription:text.trim()};
    } catch {return;}
  };
}
