import {validateBrowserOutputs,validateChannelCaptions,BROWSER_OUTPUT_FADE_CHANNELS,type BrowserOutputConfig,type BrowserOutputFaceBlur,type BrowserOutputChannelCaptions}from'./browserOutputs';
export interface ScenarioOutputPatch{id:string;patch:Partial<Omit<BrowserOutputConfig,'id'|'label'|'fade'|'faceBlur'>>&{faceBlur?:Partial<BrowserOutputFaceBlur>}}
interface Config{revision:string;outputs:BrowserOutputConfig[];channelCaptions?:BrowserOutputChannelCaptions}
interface Store{configuration(force?:boolean):Promise<Config>;update(raw:unknown):Promise<Config>;setScenarioPreview(owner:string,baseRevision:string,outputs:unknown,channelCaptions?:unknown):Promise<void>;clearScenarioPreview(owner:string):void}
/** Fixed scenes (current-*) and routing slots (control-output-N) accept only the Label/Text switches. */
const isChannel=(id:unknown)=>typeof id==='string'&&(BROWSER_OUTPUT_FADE_CHANNELS as readonly string[]).includes(id);
export class ScenarioOutputConflict extends Error{readonly statusCode=409;}
const fields=['source','contentId','delaySec','scene','visible','labels','subtitles','fadeMode','fadeDurationMs','blackHoldMs','faceBlur'];
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function validateScenarioOutputPatches(raw:unknown):ScenarioOutputPatch[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>64)throw Error('Invalid scenario output patches');const ids=new Set<string>();
 return raw.map(v=>{
 if(plain(v)&&isChannel(v.id)){if(Object.keys(v).some(k=>!['id','patch'].includes(k))||ids.has(v.id)||!plain(v.patch)||!Object.keys(v.patch).length||Object.keys(v.patch).some(k=>!['labels','subtitles'].includes(k))||Object.values(v.patch).some(x=>typeof x!=='boolean'))throw Error('Invalid scenario channel caption patch');ids.add(v.id);return structuredClone(v)as ScenarioOutputPatch;}
 if(!plain(v)||Object.keys(v).some(k=>!['id','patch'].includes(k))||typeof v.id!=='string'||!/^screen-[1-9][0-9]{0,2}$/.test(v.id)||ids.has(v.id)||!plain(v.patch)||!Object.keys(v.patch).length||Object.keys(v.patch).some(k=>!fields.includes(k)))throw Error('Invalid scenario output patch');ids.add(v.id);
 const p=v.patch;validateBrowserOutputs([{id:v.id,label:'validation',source:'a',delaySec:0,scene:'any',visible:true,labels:true,subtitles:true,...p,...(p.source==='fixed'&&!('contentId'in p)?{contentId:'deferred-existing-content'}:{})}]);return structuredClone(v)as ScenarioOutputPatch;});
}
/** Uses only revisioned BrowserOutputsStore configuration/update. Never calls generation. */
export function createOperatorScenarioOutputs(store:Store){
 let active:{runId:string;preview:boolean;baseline?:BrowserOutputConfig[];revision?:string;outputs?:BrowserOutputConfig[];changed:boolean;captionsBaseline:BrowserOutputChannelCaptions;captions:BrowserOutputChannelCaptions;captionsChanged:boolean}|undefined,tail:Promise<unknown>=Promise.resolve();
 const queue=<T>(f:()=>Promise<T>)=>{const p=tail.then(f);tail=p.catch(()=>{});return p;};
 return{
 begin(input:{preview:boolean;runId:string}){return queue(async()=>{if(active)throw Error('Output mapping run already active');const c=await store.configuration(true);const captions=validateChannelCaptions(c.channelCaptions);active={...input,baseline:structuredClone(c.outputs),outputs:structuredClone(c.outputs),revision:c.revision,changed:false,captionsBaseline:structuredClone(captions),captions,captionsChanged:false};});},
 apply(raw:unknown){const patches=validateScenarioOutputPatches(raw);return queue(async()=>{if(!active)throw Error('No output mapping run');const c=await store.configuration(true);if(c.revision!==active.revision){store.clearScenarioPreview(active.runId);throw new ScenarioOutputConflict('Output mapping changed manually; scenario mapping paused');}
 const outputs=structuredClone(active.preview?active.outputs!:c.outputs),captions=structuredClone(active.preview?active.captions:validateChannelCaptions(c.channelCaptions)),channelPatches=patches.filter(item=>isChannel(item.id));
 for(const item of channelPatches)Object.assign(captions[item.id as keyof BrowserOutputChannelCaptions],item.patch);
 for(const item of patches.filter(item=>!isChannel(item.id))){const index=outputs.findIndex(o=>o.id===item.id);if(index<0)throw Error('Unknown scenario output '+item.id);const previous=outputs[index],next={...previous,...item.patch,faceBlur:{enabled:false,strengthPx:12,...previous.faceBlur,...item.patch.faceBlur}};if(item.patch.source&&item.patch.source!=='fixed')delete next.contentId;if(item.patch.source&&/^(now|a|b|c|td-[1-4])$/.test(item.patch.source)&&!Object.hasOwn(item.patch,'delaySec'))next.delaySec=0;if(item.patch.fadeMode!==undefined)next.fade=item.patch.fadeMode!=='none';outputs[index]=next;}
 const captionsChanged=active.captionsChanged||channelPatches.length>0;
 if(active.preview){await store.setScenarioPreview(active.runId,active.revision!,validateBrowserOutputs(outputs),captionsChanged?captions:undefined);active.outputs=outputs;active.captions=captions;active.captionsChanged=captionsChanged;active.changed=true;return;}
 const saved=await store.update({baseRevision:active.revision,requestId:'scenario-'+active.runId+'-'+active.revision,outputs:validateBrowserOutputs(outputs),...(channelPatches.length?{channelCaptions:captions}:{})});active.revision=saved.revision;active.captions=captions;active.captionsChanged=captionsChanged;active.changed=true;});},
 stop(){return queue(async()=>{if(!active)return;const run=active;active=undefined;if(run.preview){store.clearScenarioPreview(run.runId);return;}if(!run.changed)return;const current=await store.configuration(true);if(current.revision!==run.revision)throw new ScenarioOutputConflict('Output mapping changed manually; original mapping was not restored');await store.update({baseRevision:run.revision,requestId:'scenario-stop-'+run.runId,outputs:run.baseline,...(run.captionsChanged?{channelCaptions:run.captionsBaseline}:{})});});}
 };
}
