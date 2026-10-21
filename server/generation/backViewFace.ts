/**
 * Mechanical back-view check (2026-10-21), independent of the VLM: the original photo shows a person from behind (no face), the
 * generated photo must not show a face either. The face detector (scripts/browser-face-boxes.py, YuNet) runs on the NOW frame
 * once per capture and on every candidate; more faces in the candidate than in a faceless original reject it.
 */
import {spawn} from 'node:child_process';
import path from 'node:path';

export type FaceCounter=(imageDataUrl:string)=>Promise<number|null>;

/** Face count of a data-URL image through the Python worker; null when the detector is unavailable or fails. */
export const countFacesWithWorker:FaceCounter=(imageDataUrl)=>new Promise(resolve=>{
  const m=/^data:image\/[^;]+;base64,(.+)$/.exec(imageDataUrl);if(!m)return resolve(null);
  const python=process.env.FACE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','claude-code/runtime-face-detector/Scripts/python.exe');
  const worker=path.resolve('scripts/browser-face-boxes.py');
  let output='',done=false;
  const finish=(value:number|null)=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
  let child:ReturnType<typeof spawn>;
  try{child=spawn(python,['-u',worker],{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{return resolve(null);}
  const timer=setTimeout(()=>{child.kill();finish(null);},8000);
  child.stderr?.resume();child.on('error',()=>finish(null));child.stdin?.on('error',()=>finish(null));
  child.stdout?.on('data',chunk=>{output+=String(chunk);if(output.length>100000){child.kill();finish(null);}});
  child.on('close',()=>{try{const r=JSON.parse(output);finish(r&&(r.status==='detected'||r.status==='no-faces')&&Array.isArray(r.boxes)?r.boxes.length:null);}catch{finish(null);}});
  child.stdin?.end(JSON.stringify({image:m[1]}));
});

export interface BackViewVerdict{ok:boolean|null;reason:string;defect?:string}

/** Only an otherwise acceptable image can be rejected; an unavailable detector never rejects. */
export async function withBackViewFace<T extends BackViewVerdict>(verdict:T,sourceFaces:Promise<number|null>,candidate:string,count:FaceCounter=countFacesWithWorker):Promise<T>{
  if(verdict.ok!==true)return verdict;
  const [source,out]=await Promise.all([sourceFaces,count(candidate)]);
  if(source===null||out===null||source>0||out<=0)return verdict;
  return {...verdict,ok:false,defect:'face_on_back_view',reason:`face_on_back_view: the original shows no face (person seen from behind) but the finished image shows ${out}`};
}
