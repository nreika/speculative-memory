"""Public-gate face blur: stdin JSON {image(base64), regions[{x,y,width,height} normalized], strengthPx, format}
-> stdout JSON {image(base64)}. Same ellipse as server/tdControl/face-blur.mjs (center of box, rx=0.5*w, ry=0.56*h),
Gaussian sigma = strengthPx (CSS blur radius). Reads/writes no files; the original image is never modified."""
import os,json,sys,base64
os.environ['OPENCV_IO_MAX_IMAGE_PIXELS']='40000000'
try:
 import cv2,numpy as np
 cv2.setNumThreads(2)
except ImportError:
 print(json.dumps({'error':'unavailable'}));sys.exit(0)
try:
 q=json.loads(sys.stdin.buffer.read(45*1024*1024))
 raw=base64.b64decode(q['image'],validate=True)
 if len(raw)>24*1024*1024:raise ValueError('too large')
 img=cv2.imdecode(np.frombuffer(raw,dtype=np.uint8),cv2.IMREAD_UNCHANGED)
 if img is None:raise ValueError('decode failed')
 h,w=img.shape[:2]
 strength=float(q.get('strengthPx',12))
 if not (0<strength<=40):raise ValueError('strength')
 blurred=cv2.GaussianBlur(img,(0,0),sigmaX=strength,sigmaY=strength)
 mask=np.zeros((h,w),dtype=np.uint8)
 regions=q.get('regions') or []
 if len(regions)>64:raise ValueError('regions')
 for b in regions:
  bx,by,bw,bh=(float(b[k]) for k in ('x','y','width','height'))
  cx,cy=(bx+bw/2)*w,(by+bh/2)*h
  rx,ry=max(1,int(round(bw*0.5*w))),max(1,int(round(bh*0.56*h)))
  cv2.ellipse(mask,(int(round(cx)),int(round(cy))),(rx,ry),0,0,360,255,-1)
 sel=mask>0
 out=img.copy();out[sel]=blurred[sel]
 fmt=q.get('format','png')
 ext={'png':'.png','jpeg':'.jpg','webp':'.webp'}[fmt]
 params=[cv2.IMWRITE_JPEG_QUALITY,92] if fmt=='jpeg' else ([cv2.IMWRITE_WEBP_QUALITY,92] if fmt=='webp' else [])
 ok,enc=cv2.imencode(ext,out,params)
 if not ok:raise ValueError('encode failed')
 sys.stdout.write(json.dumps({'image':base64.b64encode(enc.tobytes()).decode('ascii')}))
except Exception as e:
 print(json.dumps({'error':type(e).__name__}))
