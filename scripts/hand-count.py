"""CPU hand boxes only (MediaPipe HandLandmarker); stdin JSON {image:base64}, argv[1] = local hand_landmarker.task.
No network, no filesystem writes; the model file is the only file read."""
import os,json,sys,time,base64
os.environ['OPENCV_IO_MAX_IMAGE_PIXELS']='40000000'
os.environ.setdefault('GLOG_minloglevel','2');os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL','2')
try:
 import cv2,numpy as np
 cv2.setNumThreads(2)
 import mediapipe as mp
 from mediapipe.tasks.python import BaseOptions
 from mediapipe.tasks.python.vision import HandLandmarker,HandLandmarkerOptions,RunningMode
except Exception:
 print(json.dumps({'status':'unavailable','hands':[],'count':0}));sys.exit(0)
MAX_HANDS=8
# Palm-detection / landmark-presence confidence and the wrist mask radius (x hand size). Tuned on the 2026-10-19
# extra-hand regression set (3 hands on the positives, 2 on the negatives for detect 0.15-0.3, radius 0.3-0.4).
CONF=float(os.environ.get('HAND_CONFIDENCE','0.25'))
WRIST=float(os.environ.get('HAND_WRIST_MASK','0.3'))
PASSES=2
def overlap(a,b):
 area=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
 A=(a[2]-a[0])*(a[3]-a[1]);B=(b[2]-b[0])*(b[3]-b[1])
 return max(area/(A+B-area),area/min(A,B)) if A>0 and B>0 else 1.0
try:
 model=sys.argv[1] if len(sys.argv)>1 else ''
 if not model or not os.path.isfile(model):
  print(json.dumps({'status':'unavailable','hands':[],'count':0}));sys.exit(0)
 with open(model,'rb') as f:buf=f.read()
 q=json.loads(sys.stdin.buffer.read(45*1024*1024));raw=base64.b64decode(q['image'],validate=True)
 if len(raw)>24*1024*1024:raise ValueError('Image too large')
 img=cv2.imdecode(np.frombuffer(raw,dtype=np.uint8),cv2.IMREAD_COLOR)
 if img is None:raise ValueError('Image decode failed')
 h,w=img.shape[:2]
 if w*h>40000000:raise ValueError('Image dimensions exceed limit')
 started=time.perf_counter()
 scale=min(1.0,1536/max(w,h));small=cv2.resize(img,None,fx=scale,fy=scale,interpolation=cv2.INTER_AREA) if scale<1 else img
 rgb=cv2.cvtColor(small,cv2.COLOR_BGR2RGB);H,W=rgb.shape[:2]
 opts=HandLandmarkerOptions(base_options=BaseOptions(model_asset_buffer=buf),running_mode=RunningMode.IMAGE,num_hands=MAX_HANDS,min_hand_detection_confidence=CONF,min_hand_presence_confidence=CONF,min_tracking_confidence=CONF)
 keep=[]
 # The palm detector suppresses a hand that touches a stronger one. Run the frame and its mirror; after each pass grey
 # out every found hand (landmark hull + a small disk on its wrist, so a watch/forearm is not re-read as a hand) and run
 # again. Boxes from all passes are merged by IoU / containment.
 with HandLandmarker.create_from_options(opts) as lm:
  for flip in (False,True):
   work=np.ascontiguousarray(rgb[:,::-1] if flip else rgb)
   for _ in range(PASSES):
    res=lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=work))
    if not res.hand_landmarks:break
    work=work.copy()
    for marks,cats in zip(res.hand_landmarks,res.handedness):
     pts=np.array([[p.x*W,p.y*H] for p in marks],dtype=np.float64)
     cv2.fillConvexPoly(work,cv2.convexHull(pts.astype(np.int32)),(127,127,127))
     size=max(np.ptp(pts[:,0]),np.ptp(pts[:,1]))
     cv2.circle(work,(int(pts[0][0]),int(pts[0][1])),max(1,int(size*WRIST)),(127,127,127),-1)
     if flip:pts[:,0]=W-pts[:,0]
     b=(max(0.0,pts[:,0].min()/W),max(0.0,pts[:,1].min()/H),min(1.0,pts[:,0].max()/W),min(1.0,pts[:,1].max()/H))
     if b[2]-b[0]<=0 or b[3]-b[1]<=0:continue
     if not any(overlap(b,k['b'])>0.4 for k in keep):keep.append({'b':b,'score':float(cats[0].score) if cats else 0.0})
 if len(keep)>32:raise ValueError('Too many hand candidates')
 hands=[{'x':k['b'][0],'y':k['b'][1],'w':k['b'][2]-k['b'][0],'h':k['b'][3]-k['b'][1],'score':k['score']} for k in keep]
 print(json.dumps({'status':'detected' if hands else 'no-hands','width':w,'height':h,'hands':hands,'count':len(hands),'detectorMs':(time.perf_counter()-started)*1000,'method':'mediapipe-hand-landmarker-mirror-mask-v1'}))
except Exception:
 print(json.dumps({'status':'error','hands':[],'count':0}))
