"""CPU framing check (ORB features + RANSAC partial affine + Canny edge IoU); stdin JSON {source:base64,output:base64}.
Reports how the OUTPUT frame is zoomed/shifted/rotated relative to the SOURCE frame. No network, no filesystem access.
scale > 1: output is zoomed in; dx/dy: where the source centre lands in the output, as a fraction of width/height
(+dx = content moved right). edgeIou: dilated Canny edges, source vs output in the SAME (unaligned) frame, i.e. how
well the static structure (ceiling, shelves, desks) lines up as published; edgeIouAligned: after the estimated warp."""
import os,json,sys,time,base64,math
os.environ['OPENCV_IO_MAX_IMAGE_PIXELS']='40000000'
try:
 import cv2,numpy as np
 cv2.setNumThreads(2)
except Exception:
 print(json.dumps({'status':'unavailable'}));sys.exit(0)
WIDTH=640
def decode(b64):
 raw=base64.b64decode(b64,validate=True)
 if len(raw)>24*1024*1024:raise ValueError('Image too large')
 img=cv2.imdecode(np.frombuffer(raw,dtype=np.uint8),cv2.IMREAD_GRAYSCALE)
 if img is None:raise ValueError('Image decode failed')
 if img.shape[0]*img.shape[1]>40000000:raise ValueError('Image dimensions exceed limit')
 return img
def edges(g):
 e=cv2.Canny(cv2.GaussianBlur(g,(3,3),0),60,150)
 return cv2.dilate(e,np.ones((5,5),np.uint8))>0
def iou(a,b,mask):
 a=a&mask;b=b&mask;u=np.count_nonzero(a|b)
 return float(np.count_nonzero(a&b)/u) if u else 0.0
try:
 q=json.loads(sys.stdin.buffer.read(90*1024*1024))
 src=decode(q['source']);out=decode(q['output'])
 started=time.perf_counter()
 H=int(round(src.shape[0]*WIDTH/src.shape[1]))
 # Both frames on the same 640-wide grid (the output is compared in the source's aspect ratio).
 s=cv2.resize(src,(WIDTH,H),interpolation=cv2.INTER_AREA);o=cv2.resize(out,(WIDTH,H),interpolation=cv2.INTER_AREA)
 clahe=cv2.createCLAHE(2.0,(8,8));s=clahe.apply(s);o=clahe.apply(o)
 orb=cv2.ORB_create(nfeatures=4000,fastThreshold=10)
 ks,ds=orb.detectAndCompute(s,None);ko,do=orb.detectAndCompute(o,None)
 res={'status':'aligned','width':WIDTH,'height':H,'keypoints':[len(ks),len(ko)],'matches':0,'inliers':0,'inlierRatio':0.0,'scale':None,'dx':None,'dy':None,'rotationDeg':None}
 M=None
 if ds is not None and do is not None and len(ks)>=8 and len(ko)>=8:
  pairs=cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(ds,do,k=2)
  good=[p[0] for p in pairs if len(p)==2 and p[0].distance<0.8*p[1].distance]
  res['matches']=len(good)
  if len(good)>=8:
   a=np.float32([ks[m.queryIdx].pt for m in good]);b=np.float32([ko[m.trainIdx].pt for m in good])
   M,inl=cv2.estimateAffinePartial2D(a,b,method=cv2.RANSAC,ransacReprojThreshold=3.0,maxIters=4000,confidence=0.995)
   if M is not None and inl is not None:
    n=int(inl.sum());res['inliers']=n;res['inlierRatio']=round(n/len(good),4)
    sc=math.hypot(M[0,0],M[1,0]);rot=math.degrees(math.atan2(M[1,0],M[0,0]))
    c=np.array([WIDTH/2,H/2,1.0]);p=M@c
    res.update(scale=round(sc,4),rotationDeg=round(rot,3),dx=round(float(p[0]-c[0])/WIDTH,4),dy=round(float(p[1]-c[1])/H,4))
 if M is None:res['status']='no-alignment'
 es,eo=edges(s),edges(o);full=np.ones_like(es)
 res['edgeIou']=round(iou(es,eo,full),4)
 if M is not None:
  ws=cv2.warpAffine(s,M,(WIDTH,H));valid=cv2.warpAffine(np.full_like(s,255),M,(WIDTH,H))>0
  res['edgeIouAligned']=round(iou(edges(ws),eo,cv2.erode(valid.astype(np.uint8),np.ones((7,7),np.uint8))>0),4)
 res['ms']=round((time.perf_counter()-started)*1000)
 res['method']='orb-affine-partial-ransac-canny-v1'
 print(json.dumps(res))
except Exception as e:
 print(json.dumps({'status':'error'}))
