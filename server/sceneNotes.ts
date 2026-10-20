// Per-capture, per-scene notes for the MAIN scene panels ("what happened to A/B/C in this generation").
// In memory; keeps the last few captures. Scene 'all' notes are shown in every panel.
export type SceneNoteKind='info'|'warn'|'error';
export type SceneNote={at:string;kind:SceneNoteKind;text:string};
type Entry={captureId:string;startedAt:string;endedAt?:string;result?:string;notes:Record<'a'|'b'|'c'|'all',SceneNote[]>};
const entries:Entry[]=[];
const MAX_CAPTURES=6,MAX_NOTES=12;
const sceneOf=(key:string):'a'|'b'|'c'|'all'=>{const m=/([abc])$/i.exec(key);return key==='all'||!m?'all':m[1].toLowerCase() as 'a'|'b'|'c';};
const find=(captureId:string)=>entries.find(e=>e.captureId===captureId);
export const sceneNotes={
  start(captureId:string){if(find(captureId))return;entries.unshift({captureId,startedAt:new Date().toISOString(),notes:{a:[],b:[],c:[],all:[]}});entries.length=Math.min(entries.length,MAX_CAPTURES);},
  add(captureId:string,scene:string,text:string,kind:SceneNoteKind='info'){
    const e=find(captureId);if(!e)return;const list=e.notes[sceneOf(scene)];
    list.push({at:new Date().toISOString(),kind,text:String(text||'').replace(/\s+/g,' ').slice(0,400)});
    if(list.length>MAX_NOTES)list.shift();
  },
  end(captureId:string,result:string){const e=find(captureId);if(e){e.endedAt=new Date().toISOString();e.result=result;}},
  /** Newest capture first: the running one (if any) and the last finished one. */
  snapshot(){const running=entries.find(e=>!e.endedAt)??null,finished=entries.find(e=>e.endedAt)??null;const copy=(e:Entry|null)=>e?JSON.parse(JSON.stringify(e)):null;return {running:copy(running),finished:copy(finished)};},
};
