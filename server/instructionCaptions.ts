import fs from 'node:fs';
import path from 'node:path';

type Request = {captureId:string;sceneKey:string;imageUrl:string};
type Row = {captureId:string;images?:{now?:string;a?:string;b?:string;c?:string}};
/** Read-only projection: join the exact displayed capture/image to its saved generation instruction. */
/** '/captures/display/Gen_a_X.jpg' and '/captures/Gen_a_X.png' are the same image: compare by file stem. */
const stem=(url:unknown)=>String(url??'').split('/').pop()!.replace(/\.[A-Za-z0-9]+$/,'');
export function createInstructionCaptionLookup(root:string, rows:()=>Row[]) {
  const cache=new Map<string,{stamp:string;doc:any}>();
  return (request:Request): (Request & {plannedDescription:string;predictionPrompt?:string;imagePromptFull?:string;referenceNote?:string})|undefined => {
    if(!/^gen_[abc]$/.test(request.sceneKey))return;
    const letter=request.sceneKey.slice(-1) as 'a'|'b'|'c';
    const row=rows().find(r=>r.captureId===request.captureId&&!!r.images?.[letter]&&stem(r.images[letter])===stem(request.imageUrl));
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
      // MAIN shows the real action and the exact prompt that went to the image model (same archived object, not a copy).
      const scene=scenes[0],action=typeof scene.predictionPrompt==='string'&&scene.predictionPrompt.trim()?scene.predictionPrompt.trim().slice(0,2000):undefined;
      const full=typeof scene.imagePromptFull==='string'&&scene.imagePromptFull.trim()?scene.imagePromptFull.slice(0,20000):undefined;
      const refs=Number.isInteger(scene.identityReferenceCount)?`${scene.identityReferenceCount} identity reference image(s)${typeof scene.referenceImage==='string'?' ('+scene.referenceImage+')':''}${Array.isArray(scene.identityReferenceCrops)&&scene.identityReferenceCrops.length?'; crops: '+scene.identityReferenceCrops.map((c:any)=>`${c.width}x${c.height}@${c.x},${c.y}`).join(' ').slice(0,300):''}`:undefined;
      return {...request,plannedDescription:text.trim(),...(action?{predictionPrompt:action}:{}),...(full?{imagePromptFull:full}:{}),...(refs?{referenceNote:refs}:{})};
    } catch {return;}
  };
}
