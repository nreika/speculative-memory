import type {Detection} from './lightPeopleDetector';
export interface PeopleEditRegion {
 width:number;
 height:number;
 rectangles:Array<{x:number;y:number;width:number;height:number}>;
 sourceEvidence?:{method:'cpu'|'cpu-head-corroborated';originalStrongCount:number;persons:Detection['persons']};
}
type HeadBox=[number,number,number,number]|null|undefined;
/** Low-confidence MODEL boxes are usable only when the independent head observations locate every person. */
function sourcePeople(detection:Detection,expected:number,size:{width:number;height:number},heads:HeadBox[]):{persons:Detection['persons'];method:'cpu'|'cpu-head-corroborated'}|undefined {
 if(detection.count===expected&&detection.persons.length===expected)return {persons:detection.persons,method:'cpu'};
 if(detection.count>=expected||heads.length!==expected||!detection.candidates?.length)return;
 const boxes=heads.map(head=>head&&head.length===4&&head.every(n=>Number.isFinite(n)&&n>=0&&n<=1000)&&head[2]>head[0]&&head[3]>head[1]?[head[0]*size.width/1000,head[1]*size.height/1000,head[2]*size.width/1000,head[3]*size.height/1000]:null);
 if(boxes.some(h=>!h))return;
 const pool=[...detection.persons,...detection.candidates].filter(p=>p.score>=.15&&p.box.length===4&&p.box.every(Number.isFinite)&&p.box[0]>=0&&p.box[1]>=0&&p.box[2]<=size.width&&p.box[3]<=size.height&&p.box[2]>p.box[0]&&p.box[3]>p.box[1]);
 const matches=(p:Detection['persons'][number])=>boxes.flatMap((h,i)=>{
  if(!h)return [];
  const [l,t,r,b]=p.box,cx=(h[0]+h[2])/2,cy=(h[1]+h[3])/2;
  const overlap=Math.max(0,Math.min(r,h[2])-Math.max(l,h[0]))*Math.max(0,Math.min(b,h[3])-Math.max(t,h[1]));
  return cx>=l&&cx<=r&&cy>=t&&cy<=b&&overlap/((h[2]-h[0])*(h[3]-h[1]))>=.5?[i]:[];
 });
 const selected=boxes.map((_,i)=>pool.filter(p=>{const m=matches(p);return m.length===1&&m[0]===i;}).sort((a,b)=>b.score-a.score)[0]);
 if(selected.some(p=>!p))return;
 // Do not silently discard a strong detection or assign one body to two heads.
 if(detection.persons.some(p=>!selected.some(s=>s.box.every((v,i)=>v===p.box[i]))))return;
 for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++)if(selected[i].box.every((v,k)=>v===selected[j].box[k]))return;
 return {persons:selected,method:'cpu-head-corroborated'};
}
/** Preserve space for a pose change while preventing new bodies elsewhere in the room. */
export function peopleEditRegion(detection:Detection|null,expected:number,size:{width:number;height:number}|null,action:string,heads:HeadBox[]=[]):PeopleEditRegion|undefined {
 if(!detection||!size||!Number.isInteger(expected)||expected<1)return;
 if(![size.width,size.height].every(n=>Number.isInteger(n)&&n>0&&n<=16384))return;
 // A local window must not pin people down when the requested action changes location.
 if(/\b(?:walk\w*|leav\w*|cross\w*|run(?:s|ning)?|step(?:s|ping)?)\b|\bmov(?:e|es|ing)\s+(?:to|toward|across)/i.test(action))return;
 const selected=sourcePeople(detection,expected,size,heads);if(!selected)return;
 // A seated detector box may cover only a cropped upper body. Its own height
 // cannot bound a standing person's head, so transitions use the full vertical
 // image extent within the same horizontal corridor.
 const verticalTransition=/\b(?:stand(?:s|ing)?(?:\s+up)?|stood\s+up|ris(?:e|es|ing)|get(?:s|ting)?\s+up|got\s+up|sit(?:s|ting)?(?:\s+down)?|sat\s+down|take(?:s)?\s+a\s+seat|taking\s+a\s+seat)\b/i.test(action);
 // Explicit high-hand actions need room above a short seated body detection.
 // A nearby cup or a low hand raise does not imply an overhead movement.
 const highHands=/\b(?:hands?|arms?)\b/i.test(action)&&/\b(?:overhead|above\s+(?:the\s+)?(?:head|shoulders?)(?:\s+(?:level|height))?|(?:at|to)\s+(?:the\s+)?shoulder[ -](?:level|height)|shoulder[ -](?:high|level))\b/i.test(action);
 const verticalGesture=/\bcheer(?:s|ed|ing)?\b/i.test(action)||highHands;
 const fullHeight=verticalTransition||verticalGesture;
 const rectangles=[];
 for(const person of selected.persons){
  const [left,top,right,bottom]=person.box;
  if(![left,top,right,bottom].every(Number.isFinite)||right<=left||bottom<=top||left<0||top<0||right>size.width||bottom>size.height)return;
  const bw=right-left,bh=bottom-top;
  const x=Math.max(0,Math.floor(left-Math.max(32,bw*.3)));
  const y=fullHeight ? 0 : Math.max(0,Math.floor(top-Math.max(32,bh*.22)));
  const x2=Math.min(size.width,Math.ceil(right+Math.max(32,bw*.3)));
  const y2=fullHeight ? size.height : Math.min(size.height,Math.ceil(bottom+Math.max(24,bh*.1)));
  if(x2<=x||y2<=y)return;
  rectangles.push({x,y,width:x2-x,height:y2-y});
 }
 return {...size,rectangles,sourceEvidence:{method:selected.method,originalStrongCount:detection.count,persons:selected.persons}};
}

/** Standard ComfyUI nodes only. Sample inside the region and restore original pixels outside it. */
export function applyPeopleEditRegion(wf:Record<string,any>,region:PeopleEditRegion):void {
 const validSize=(n:number)=>Number.isInteger(n)&&n>0&&n<=16384;
 if(!validSize(region.width)||!validSize(region.height)||!region.rectangles.length||region.rectangles.length>16)throw new Error('Invalid person edit region');
 wf['90']={class_type:'SolidMask',inputs:{value:0,width:region.width,height:region.height}};
 let last='90';
 region.rectangles.forEach((r,i)=>{
  if(![r.x,r.y,r.width,r.height].every(Number.isInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>region.width||r.y+r.height>region.height)throw new Error('Person edit rectangle outside source');
  const solid=String(110+i*3),feather=String(111+i*3),join=String(112+i*3);
  wf[solid]={class_type:'SolidMask',inputs:{value:1,width:r.width,height:r.height}};
  const featherSize=Math.min(24,Math.floor(Math.min(r.width,r.height)/4));
  wf[feather]={class_type:'FeatherMask',inputs:{mask:[solid,0],left:r.x?featherSize:0,top:r.y?featherSize:0,right:r.x+r.width<region.width?featherSize:0,bottom:r.y+r.height<region.height?featherSize:0}};
  wf[join]={class_type:'MaskComposite',inputs:{destination:[last,0],source:[feather,0],x:r.x,y:r.y,operation:'add'}};
  last=join;
 });
 wf['94']={class_type:'MaskToImage',inputs:{mask:[last,0]}};
 wf['95']={class_type:'FluxKontextImageScale',inputs:{image:['94',0]}};
 wf['96']={class_type:'ImageToMask',inputs:{image:['95',0],channel:'red'}};
 wf['97']={class_type:'SetLatentNoiseMask',inputs:{samples:['50',0],mask:['96',0]}};
 wf['60'].inputs.latent_image=['97',0];
 wf['98']={class_type:'GetImageSize',inputs:{image:['75',0]}};
 // The source and mask must use the same center crop as Qwen's conditioning.
 wf['99']={class_type:'ImageScale',inputs:{image:['20',0],upscale_method:'lanczos',width:['98',0],height:['98',1],crop:'disabled'}};
 wf['100']={class_type:'ImageCompositeMasked',inputs:{destination:['99',0],source:['75',0],x:0,y:0,resize_source:false,mask:['96',0]}};
 wf['80'].inputs.images=['100',0];
}
