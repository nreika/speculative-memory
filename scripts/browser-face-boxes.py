"""CPU face boxes only; stdin bytes, no network. Reads one local model file (YuNet ONNX) when present.
2026-10-21: YuNet (OpenCV zoo, face_detection_yunet_2023mar.onnx) replaces the Haar cascades as the primary detector:
on the venue outputs it found faces in 51/60 images vs 36 for the cascades. Model path: env FACE_YUNET_MODEL or
<repo>/../speculative-memory_data/models/yunet/. If the model is missing, the old cascades run as before."""
import os,json,sys,time,base64
os.environ['OPENCV_IO_MAX_IMAGE_PIXELS']='40000000'
try:
 import cv2,numpy as np
 cv2.setNumThreads(2)
except ImportError:
 print(json.dumps({'status':'unavailable','boxes':[]}));sys.exit(0)
def accept_face(kind, weight):
 # Cascade-specific stage margin, not a calibrated probability. No coordinate/size exclusions.
 return bool(np.isfinite(weight) and weight >= (3.5 if kind == 'frontal' else 20.0 if kind == 'frontal-alt2' else 0.5))

try:
 q=json.loads(sys.stdin.buffer.read(45*1024*1024));raw=base64.b64decode(q['image'],validate=True)
 if len(raw)>24*1024*1024:raise ValueError('Image too large')
 img=cv2.imdecode(np.frombuffer(raw,dtype=np.uint8),cv2.IMREAD_COLOR)
 if img is None:raise ValueError('Image decode failed')
 h,w=img.shape[:2]
 if w*h>40000000:raise ValueError('Image dimensions exceed limit')
 started=time.perf_counter();gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
 scale=min(1.0,1280/max(w,h));small=cv2.resize(gray,None,fx=scale,fy=scale) if scale<1 else gray
 # 2026-10-20: the default cascade missed clear frontal faces under the venue's backlight; alt2 on an equalized frame finds them
 # (weights ~55) and stayed silent on empty-room frames.
 equalized=cv2.equalizeHist(small)
 classifiers=[('frontal',False,'haarcascade_frontalface_default.xml'),('frontal-alt2',False,'haarcascade_frontalface_alt2.xml'),('profile',False,'haarcascade_profileface.xml'),('profile',True,'haarcascade_profileface.xml')]
 boxes=[]
 model=os.environ.get('FACE_YUNET_MODEL') or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),'speculative-memory_data','models','yunet','face_detection_yunet_2023mar.onnx')
 method='opencv-haar-frontal-alt2-profile-margin-v3'
 if os.path.isfile(model) and hasattr(cv2,'FaceDetectorYN'):
  colour=cv2.resize(img,None,fx=scale,fy=scale) if scale<1 else img
  H,W=colour.shape[:2]
  yunet=cv2.FaceDetectorYN.create(model,'',(W,H),0.6,0.3,5000)
  _,faces=yunet.detect(colour)
  for f in ([] if faces is None else faces):
   x,y,bw,bh=[float(v) for v in f[:4]]
   x0,y0=max(0.0,x),max(0.0,y);x1,y1=min(float(W),x+bw),min(float(H),y+bh)
   if x1-x0<2 or y1-y0<2:continue
   boxes.append({'x':x0/W,'y':y0/H,'width':(x1-x0)/W,'height':(y1-y0)/H})
  classifiers=[]
  method='opencv-yunet-2023mar-v1'
 for kind,flip,xml in classifiers:
  cascade=cv2.CascadeClassifier(cv2.data.haarcascades+xml)
  if cascade.empty():raise ValueError('Missing bundled face cascade')
  base=equalized if kind=='frontal-alt2' else small
  frame=cv2.flip(base,1) if flip else base
  rectangles, reject_levels, weights = cascade.detectMultiScale3(frame,scaleFactor=1.1,minNeighbors=4 if kind=='frontal-alt2' else 6,minSize=(28,28),outputRejectLevels=True)
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
 print(json.dumps({'status':'detected' if keep else 'no-faces','width':w,'height':h,'boxes':keep,'detectorMs':(time.perf_counter()-started)*1000,'method':method}))
except Exception:
 print(json.dumps({'status':'error','boxes':[]}))

