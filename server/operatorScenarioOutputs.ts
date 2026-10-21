import {validateBrowserOutputs,validateChannelCaptions,BROWSER_OUTPUT_FADE_CHANNELS,type BrowserOutputConfig,type BrowserOutputFaceBlur,type BrowserOutputChannelCaptions}from'./browserOutputs';
export interface ScenarioOutputPatch{id:string;patch:Partial<Omit<BrowserOutputConfig,'id'|'label'|'fade'|'faceBlur'|'endFrame'|'sequenceStartedAtMs'>>&{faceBlur?:Partial<BrowserOutputFaceBlur>;endFrame?:number|null}}
interface Config{revision:string;outputs:BrowserOutputConfig[];channelCaptions?:BrowserOutputChannelCaptions}
interface Store{configuration(force?:boolean):Promise<Config>;update(raw:unknown):Promise<Config>;setScenarioPreview(owner:string,baseRevision:string,outputs:unknown,channelCaptions?:unknown):Promise<void>;clearScenarioPreview(owner:string):void}
/** Fixed scenes (current-*) and routing slots (control-output-N) accept only the Label/Text switches. */
const isChannel=(id:unknown)=>typeof id==='string'&&(BROWSER_OUTPUT_FADE_CHANNELS as readonly string[]).includes(id);
/** Kept for importers; no longer thrown: a manual mapping edit detaches the scenario instead of pausing it (2026-10-21). */
export class ScenarioOutputConflict extends Error{readonly statusCode=409;}
const SEQUENCE=['sequenceFolder','frameSec','startFrame','endFrame','loop'];
const fields=['source','contentId','delaySec','scene','visible','labels','subtitles','fadeMode','fadeDurationMs','blackHoldMs','faceBlur',...SEQUENCE];
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const DETACHED_WARNING='Mapping edited manually; scenario no longer controls outputs';
export function validateScenarioOutputPatches(raw:unknown):ScenarioOutputPatch[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>64)throw Error('Invalid scenario output patches');const ids=new Set<string>();
 return raw.map(v=>{
 if(plain(v)&&isChannel(v.id)){if(Object.keys(v).some(k=>!['id','patch'].includes(k))||ids.has(v.id)||!plain(v.patch)||!Object.keys(v.patch).length||Object.keys(v.patch).some(k=>!['labels','subtitles'].includes(k))||Object.values(v.patch).some(x=>typeof x!=='boolean'))throw Error('Invalid scenario channel caption patch');ids.add(v.id);return structuredClone(v)as ScenarioOutputPatch;}
 if(!plain(v)||Object.keys(v).some(k=>!['id','patch'].includes(k))||typeof v.id!=='string'||!/^screen-[1-9][0-9]{0,2}$/.test(v.id)||ids.has(v.id)||!plain(v.patch)||!Object.keys(v.patch).length||Object.keys(v.patch).some(k=>!fields.includes(k)))throw Error('Invalid scenario output patch');ids.add(v.id);
 const p=v.patch,sequence=SEQUENCE.some(k=>k in p);
 if(sequence&&'source'in p&&p.source!=='fixed-sequence')throw Error('Sequence fields require source fixed-sequence');
 const probe:Record<string,unknown>={id:v.id,label:'validation',source:'a',delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,...p,...(sequence&&!('source'in p)?{source:'fixed-sequence'}:{})};
 if(probe.endFrame===null)delete probe.endFrame;
 if(p.source==='fixed'&&!('contentId'in p))probe.contentId='deferred-existing-content';
 if(probe.source==='fixed-sequence'&&!('sequenceFolder'in p))probe.sequenceFolder='deferred';
 validateBrowserOutputs([probe]);return structuredClone(v)as ScenarioOutputPatch;});
}
function patched(previous:BrowserOutputConfig,patch:ScenarioOutputPatch['patch']):BrowserOutputConfig{
 const next:any={...previous,...patch,faceBlur:{enabled:false,strengthPx:12,...previous.faceBlur,...patch.faceBlur}};
 if(patch.source&&patch.source!=='fixed')delete next.contentId;
 if(patch.source&&patch.source!=='fixed-sequence')for(const k of [...SEQUENCE,'sequenceStartedAtMs'])delete next[k];
 if(next.endFrame===null)delete next.endFrame;
 if(patch.source&&/^(now|a|b|c|td-[1-4]|fixed-sequence)$/.test(patch.source)&&!Object.hasOwn(patch,'delaySec'))next.delaySec=0;
 if(patch.fadeMode!==undefined)next.fade=patch.fadeMode!=='none';
 return next;
}
/** Uses only revisioned BrowserOutputsStore configuration/update. Never calls generation.
 * A manual mapping edit during a run detaches the scenario: later applies do nothing and Stop restores nothing; warn is called once. */
export function createOperatorScenarioOutputs(store:Store,options:{warn?:(message:string)=>void}={}){
 let active:{runId:string;preview:boolean;baseline?:BrowserOutputConfig[];revision?:string;outputs?:BrowserOutputConfig[];changed:boolean;captionsBaseline:BrowserOutputChannelCaptions;captions:BrowserOutputChannelCaptions;captionsChanged:boolean;detached:boolean}|undefined,tail:Promise<unknown>=Promise.resolve();
 const queue=<T>(f:()=>Promise<T>)=>{const p=tail.then(f);tail=p.catch(()=>{});return p;};
 const detach=(run:NonNullable<typeof active>)=>{if(run.detached)return;run.detached=true;if(run.preview)store.clearScenarioPreview(run.runId);try{options.warn?.(DETACHED_WARNING);}catch{/* warning sink only */}};
 const conflict=(error:unknown)=>(error as {status?:number})?.status===409||(error as {statusCode?:number})?.statusCode===409;
 return{
 begin(input:{preview:boolean;runId:string}){return queue(async()=>{if(active)throw Error('Output mapping run already active');const c=await store.configuration(true);const captions=validateChannelCaptions(c.channelCaptions);active={...input,baseline:structuredClone(c.outputs),outputs:structuredClone(c.outputs),revision:c.revision,changed:false,captionsBaseline:structuredClone(captions),captions,captionsChanged:false,detached:false};});},
 apply(raw:unknown){const patches=validateScenarioOutputPatches(raw);return queue(async()=>{if(!active)throw Error('No output mapping run');const run=active;if(run.detached)return;const c=await store.configuration(true);if(c.revision!==run.revision){detach(run);return;}
 const outputs=structuredClone(run.preview?run.outputs!:c.outputs),captions=structuredClone(run.preview?run.captions:validateChannelCaptions(c.channelCaptions)),channelPatches=patches.filter(item=>isChannel(item.id));
 for(const item of channelPatches)Object.assign(captions[item.id as keyof BrowserOutputChannelCaptions],item.patch);
 for(const item of patches.filter(item=>!isChannel(item.id))){const index=outputs.findIndex(o=>o.id===item.id);if(index<0)throw Error('Unknown scenario output '+item.id);outputs[index]=patched(outputs[index],item.patch);}
 const captionsChanged=run.captionsChanged||channelPatches.length>0;
 try{
  if(run.preview){await store.setScenarioPreview(run.runId,run.revision!,validateBrowserOutputs(outputs),captionsChanged?captions:undefined);run.outputs=outputs;run.captions=captions;run.captionsChanged=captionsChanged;run.changed=true;return;}
  const saved=await store.update({baseRevision:run.revision,requestId:'scenario-'+run.runId+'-'+run.revision,outputs:validateBrowserOutputs(outputs),...(channelPatches.length?{channelCaptions:captions}:{})});run.revision=saved.revision;run.captions=captions;run.captionsChanged=captionsChanged;run.changed=true;
 }catch(error){if(conflict(error)&&(await store.configuration(true)).revision!==run.revision){detach(run);return;}throw error;}
 });},
 stop(){return queue(async()=>{if(!active)return;const run=active;active=undefined;if(run.preview){store.clearScenarioPreview(run.runId);return;}if(run.detached||!run.changed)return;const current=await store.configuration(true);if(current.revision!==run.revision){detach(run);return;}
  try{await store.update({baseRevision:run.revision,requestId:'scenario-stop-'+run.runId,outputs:run.baseline,...(run.captionsChanged?{channelCaptions:run.captionsBaseline}:{})});}catch(error){if(conflict(error)){detach(run);return;}throw error;}
 });}
 };
}
