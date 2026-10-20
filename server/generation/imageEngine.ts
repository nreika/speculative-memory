import type {PersonInfo} from './peopleDescribe';
import type {PeopleEditRegion} from './peopleEditRegion';
import {uniqueActionPerson} from './fidelity';
export type LocalImageEngine='qwen2511'|'qwen21-turbo'|'qwen21-turbo-candidate';
export function resolveLocalImageEngine(body:Record<string,unknown>,env:NodeJS.ProcessEnv=process.env):LocalImageEngine {
 const value=body.imageEngine??defaultLocalImageEngine(env);
 if(value==='qwen2511')return value;
 if(value==='qwen21-turbo'){if(defaultLocalImageEngine(env)!=='qwen21-turbo')throw Error('Production Turbo is not configured');return value;}
 if(value!=='qwen21-turbo-candidate')throw Error('Unknown imageEngine');
 if(body.test!==true||body.recordHistory!==false)throw Error('Turbo candidate requires explicit test:true and recordHistory:false');
 if(env.TURBO_CANDIDATE_ENABLED!=='true')throw Error('Turbo candidate test engine is disabled');
 if(body.imageBackend!==undefined&&body.imageBackend!=='local')throw Error('Turbo candidate requires local imageBackend');
 return value;
}
export function defaultLocalImageEngine(env:NodeJS.ProcessEnv=process.env):'qwen2511'|'qwen21-turbo'{
 const value=env.LOCAL_IMAGE_ENGINE;
 if(!value||value==='qwen2511')return 'qwen2511';
 if(value==='qwen21-turbo')return value;
 throw Error('Invalid LOCAL_IMAGE_ENGINE');
}
export function isTurboEngine(value:LocalImageEngine){return value!=='qwen2511';}
export type XYWH=[number,number,number,number];
export function productionTurboSourceContext(people:PersonInfo[],region:PeopleEditRegion|undefined,size:{width:number;height:number}|null,action:string){
 if(!size||!region?.sourceEvidence||!people.length||people.length>2||region.sourceEvidence.persons.length!==people.length)throw Error('Turbo candidate source people evidence incomplete');
 const actor=uniqueActionPerson(action,people);if(!actor)throw Error('Turbo candidate actor is ambiguous');
 const bodies=region.sourceEvidence.persons;
 const heads=people.map(p=>{const h=p.headBox;if(!h||h.length!==4||!h.every(Number.isFinite)||h[2]<=h[0]||h[3]<=h[1])return null;return [h[0]*size.width/1000,h[1]*size.height/1000,(h[2]-h[0])*size.width/1000,(h[3]-h[1])*size.height/1000]as XYWH;});
 if(heads.some(h=>!h))throw Error('Turbo candidate requires observed head boxes for source protection');
 const index=people.indexOf(actor),head=heads[index]!;
 const cx=head[0]+head[2]/2,cy=head[1]+head[3]/2;
 const matches=bodies.filter(p=>cx>=p.box[0]&&cx<=p.box[2]&&cy>=p.box[1]&&cy<=p.box[3]);
 const body=people.length===1?bodies[0]:matches.length===1?matches[0]:null;
 if(!body)throw Error('Turbo candidate source head/body match is ambiguous');
 const [l,t,r,b]=body.box;
 return {sourceActors:[{id:'source-person-'+index,box:[l,t,r-l,b-t]as XYWH,attached:[head]}],protectedBoxes:heads.filter((_,i)=>i!==index)as XYWH[],sourceEvidenceComplete:true,expectedPeople:people.length};
}

/** Candidate opt-in remains separate from production request/history flags. */
export function turboSourceContext(...args:Parameters<typeof productionTurboSourceContext>){return {test:true as const,...productionTurboSourceContext(...args)};}
export function selectSceneImageEngine(engine:LocalImageEngine,args:Parameters<typeof productionTurboSourceContext>,unsupportedReason?:string){
 if(engine==='qwen2511')return {engine};
 try{if(unsupportedReason)throw Error(unsupportedReason);const context=productionTurboSourceContext(...args);return {engine,context};}
 catch(error){if(engine==='qwen21-turbo-candidate')throw error;return {engine,fullFrameReason:(error as Error).message};}
}

/** Active local service; the retired service is never probed as the current engine. */
export function selectedLocalImageUrl(env:NodeJS.ProcessEnv=process.env){
 return (defaultLocalImageEngine(env)==='qwen21-turbo'?(env.TURBO_CANDIDATE_URL||'http://127.0.0.1:8001'):(env.COMFYUI_URL||'http://127.0.0.1:8000')).replace(/\/$/,'');
}
