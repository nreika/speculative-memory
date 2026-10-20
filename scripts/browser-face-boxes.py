"""CPU face boxes only; stdin bytes, no filesystem/network/model downloads."""
import os,json,sys,time,base64
os.environ['OPENCV_IO_MAX_IMAGE_PIXELS']='40000000'
try:
 import cv2,numpy as np
 cv2.setNumThreads(2)
except ImportError:
 print(json.dumps({'status':'unavailable','boxes':[]}));sys.exit(0)
def accept_face(kind, weight):
 # Cascade-specific stage margin, not a calibrated probability. No coordinate/size exclusions.
 return bool(np.isfinite(weight) and weight >= (3.5 if kind == 'frontal' else 0.5))

try:
 q=json.loads(sys.stdin.buffer.read(45*1024*1024));raw=base64.b64decode(q['image'],validate=True)
 if len(raw)>24*1024*1024:raise ValueError('Image too large')
 img=cv2.imdecode(np.frombuffer(raw,dtype=np.uint8),cv2.IMREAD_COLOR)
 if img is None:raise ValueError('Image decode failed')
 h,w=img.shape[:2]
 if w*h>40000000:raise ValueError('Image dimensions exceed limit')
 started=time.perf_counter();gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
 scale=min(1.0,1280/max(w,h));small=cv2.resize(gray,None,fx=scale,fy=scale) if scale<1 else gray
 classifiers=[('frontal',False,'haarcascade_frontalface_default.xml'),('profile',False,'haarcascade_profileface.xml'),('profile',True,'haarcascade_profileface.xml')]
 boxes=[]
 for kind,flip,xml in classifiers:
  cascade=cv2.CascadeClassifier(cv2.data.haarcascades+xml)
  if cascade.empty():raise ValueError('Missing bundled face cascade')
  frame=cv2.flip(small,1) if flip else small
  rectangles, reject_levels, weights = cascade.detectMultiScale3(frame,scaleFactor=1.1,minNeighbors=6,minSize=(28,28),outputRejectLevels=True)
  for (x,y,bw,bh), weight in zip(rectangles,weights):
   if not accept_face(kind,float(weight)):continue
   if flip:x=small.shape[1]-x-bw
   boxes.append({'x':float(x)/scale/w,'y':float(y)/scale/h,'width':float(bw)/scale/w,'height':float(bh)/scale/h})
 def iou(a,b):
  area=max(0,min(a['x']+a['width'],b['x']+b['width'])-max(a['x'],b['x']))*max(0,min(a['y']+a['height'],b['y']+b['height'])-max(a['y'],b['y']))
  return area/(a['width']*a['height']+b['width']*b['height']-area)
 keep=[]
 for b in sorted(boxes,key=lambda b:b['width']*b['height'],reverse=True):
  if not any(iou(b,k)>.3 for k in keep):keep.append(b)
 if len(keep)>64:raise ValueError('Too many face candidates')
 print(json.dumps({'status':'detected' if keep else 'no-faces','width':w,'height':h,'boxes':keep,'detectorMs':(time.perf_counter()-started)*1000,'method':'opencv-haar-frontal-profile-margin-v2'}))
except Exception:
 print(json.dumps({'status':'error','boxes':[]}))

