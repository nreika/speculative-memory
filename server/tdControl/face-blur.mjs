// Rendering only: stored source and generated images remain unchanged.
export function faceBlurKey(content,view){
 return JSON.stringify([view?.faceBlur?.enabled===true,view?.faceBlur?.strengthPx??12,content?.faceRegions??[]]);
}
export function faceBlurNotice(content,view){
 if(view?.faceBlur?.enabled!==true||!content)return '';
 if(content.faceRegionStatus==='no-faces')return 'Face blur: no face detected';
 if(['unavailable','error'].includes(content.faceRegionStatus))return 'Face blur unavailable · original image shown';
 return '';
}
// Elliptical blur area centred on each detected face box: as wide as the box and slightly taller
// (faces are taller than wide), so it no longer spills into the background like the old padded rectangle.
export const FACE_BLUR_RX=0.5,FACE_BLUR_RY=0.56;
export function faceBlurRegions(content,width,height){
 if(!Array.isArray(content?.faceRegions))return [];
 return content.faceRegions.flatMap(box=>{
  if(!box||!['x','y','width','height'].every(key=>Number.isFinite(box[key]))||box.width<=0||box.height<=0||box.x<0||box.y<0||box.x>=1||box.y>=1||box.width>1||box.height>1)return [];
  const cx=(box.x+box.width/2)*width,cy=(box.y+box.height/2)*height;
  const rx=box.width*FACE_BLUR_RX*width,ry=box.height*FACE_BLUR_RY*height;
  return [{cx,cy,rx,ry}];
 });
}
export function faceBlurImage(image,content,view){
 const strength=view?.faceBlur?.strengthPx??12;
 if(view?.faceBlur?.enabled!==true||!Number.isInteger(strength)||strength<=0||strength>40)return image.src;
 const width=image.naturalWidth,height=image.naturalHeight,regions=faceBlurRegions(content,width,height);
 if(!width||!height||!regions.length)return image.src;
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const ctx=canvas.getContext('2d');if(!ctx||!('filter' in ctx))throw Error('Face blur is unavailable in this browser');
 ctx.drawImage(image,0,0);
 for(const box of regions){
  ctx.save();ctx.beginPath();ctx.ellipse(box.cx,box.cy,box.rx,box.ry,0,0,Math.PI*2);ctx.clip();
  ctx.filter=`blur(${strength}px)`;ctx.drawImage(image,0,0);ctx.restore();
 }
 return canvas.toDataURL('image/png');
}
