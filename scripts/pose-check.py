"""Experiment (2026-10-21): can CPU pose estimation (YOLOv8n-pose) flag malformed generated images?
Usage: python scripts/pose-check.py   (CPU only, writes to ../speculative-memory_data/experiments/pose-check/)
Not wired into the server."""
import os,sys,json,csv,math,base64,subprocess
import cv2,numpy as np
from ultralytics import YOLO
REPO=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA=os.path.join(os.path.dirname(REPO),'speculative-memory_data')
GEN=os.path.join(DATA,'generations','2026-10-21')
OUT=os.path.join(DATA,'experiments','pose-check')
CAP=os.path.join(REPO,'captures')
YUNET=os.path.join(DATA,'models','yunet','face_detection_yunet_2023mar.onnx')
HANDPY=os.path.expanduser('~/claude-code/runtime-face-detector/Scripts/python.exe')
HANDM=os.path.join(DATA,'models','hand_landmarker.task')
def g(i,x):return (os.path.join(GEN,f'2026-10-21_{i}',f'2026-10-21_{i}_{x}.png'),os.path.join(GEN,f'2026-10-21_{i}',f'2026-10-21_{i}_NOW.jpg'))
def c(t,now):return (os.path.join(CAP,f'Gen_a_2026-10-21_{t}.png'),os.path.join(CAP,f'record_2026-10-21_{now}.jpg'))
S=[]  # (label, group, name, gen, now)
def add(lab,grp,name,pair):S.append((lab,grp,name,pair[0],pair[1]))
# anatomy-bad (core)
add('bad','core','12-52-30A',c('12-52-30','12-51-39'));add('bad','core','12-53-52A',c('12-53-52','12-53-11'))
add('bad','core','12-30-24B',g('12-30-24','B'));add('bad','core','11-55-32B',g('11-55-32','B'));add('bad','core','11-21-19A',g('11-21-19','A'))
# other bad (qa-watch: framing / plausibility / extra standing person), not necessarily anatomical
for i,x in [('12-39-48','C'),('12-54-26','A'),('12-54-26','B'),('13-01-36','A'),('13-06-25','B'),('13-06-25','C')]:add('bad','other',i+x,g(i,x))
good=[('12-33-06','A'),('12-41-49','A'),('12-41-49','C'),('12-47-33','A'),('12-47-33','B'),('12-47-33','C'),('12-53-11','A'),('12-53-11','B'),('12-53-11','C'),('12-59-09','A'),('12-59-09','C'),('13-05-04','A'),
('11-11-14','A'),('11-12-19','A'),('11-13-18','A'),('11-18-16','A'),('11-19-10','A'),('11-20-12','A'),('11-23-32','A'),('11-24-30','A'),('11-25-27','A'),('11-26-29','A'),('11-28-48','A')]
for i,x in good:add('good','good',i+x,g(i,x))
model=YOLO(os.path.join(REPO,'models','yolo','yolov8n-pose.pt'))
def faces(img):
    H,W=img.shape[:2];d=cv2.FaceDetectorYN.create(YUNET,'',(W,H),0.6,0.3,5000);_,f=d.detect(img)
    return [] if f is None else [tuple(float(v) for v in r[:4])+(float(r[14]),) for r in f]
def hands(path):
    try:
        raw=base64.b64encode(open(path,'rb').read()).decode()
        r=subprocess.run([HANDPY,'-u',os.path.join(REPO,'scripts','hand-count.py'),HANDM],input=json.dumps({'image':raw}).encode(),capture_output=True,timeout=120)
        j=json.loads(r.stdout.decode().strip().splitlines()[-1]);return j.get('count') if j.get('status') not in ('unavailable','error') else None
    except Exception:return None
def pose(img):
    r=model.predict(img,imgsz=960,conf=0.25,device='cpu',verbose=False)[0]
    P=[]
    if r.boxes is None:return P
    for b,k,cf,s in zip(r.boxes.xyxy.cpu().numpy(),r.keypoints.xy.cpu().numpy(),r.keypoints.conf.cpu().numpy(),r.boxes.conf.cpu().numpy()):
        P.append({'box':b.tolist(),'xy':k,'cf':cf,'score':float(s)})
    return P
ARMS={'L':(5,7,9),'R':(6,8,10)}
def arm(p,side):
    s,e,w=ARMS[side];xy,cf=p['xy'],p['cf']
    u=float(np.linalg.norm(xy[s]-xy[e]));f=float(np.linalg.norm(xy[e]-xy[w]));d=float(np.linalg.norm(xy[s]-xy[w]))
    v1=xy[s]-xy[e];v2=xy[w]-xy[e];den=np.linalg.norm(v1)*np.linalg.norm(v2)
    ang=float(math.degrees(math.acos(np.clip(np.dot(v1,v2)/den,-1,1)))) if den>1e-6 else None
    return {'u':u,'f':f,'ratio':u/f if f>1e-6 else None,'angle':ang,'reach':d<=1.1*(u+f),'conf':[float(cf[s]),float(cf[e]),float(cf[w])],'ok':bool(min(cf[s],cf[e],cf[w])>=0.3)}
def match(p,Q):
    if not Q:return None
    cx=lambda b:((b[0]+b[2])/2,(b[1]+b[3])/2)
    a=cx(p['box']);return min(Q,key=lambda q:math.hypot(a[0]-cx(q['box'])[0],a[1]-cx(q['box'])[1]))
def big(P,H):return [p for p in P if p['score']>=0.5 and (p['box'][3]-p['box'][1])>0.15*H]
def inbox(f,b):cx,cy=f[0]+f[2]/2,f[1]+f[3]/2;return b[0]<=cx<=b[2] and b[1]<=cy<=b[3]
SK=[(5,7),(7,9),(6,8),(8,10),(5,6),(5,11),(6,12),(11,12),(0,1),(0,2),(1,3),(2,4)]
def draw(img,P,F,tag):
    im=img.copy()
    for p in P:
        b=[int(v) for v in p['box']];cv2.rectangle(im,(b[0],b[1]),(b[2],b[3]),(0,255,255),2);cv2.putText(im,f"{p['score']:.2f}",(b[0],max(14,b[1]-4)),0,0.6,(0,255,255),2)
        for a,bb in SK:
            if p['cf'][a]>0.3 and p['cf'][bb]>0.3:cv2.line(im,tuple(int(v) for v in p['xy'][a]),tuple(int(v) for v in p['xy'][bb]),(0,255,0),3)
        for k in range(17):
            if p['cf'][k]>0.3:cv2.circle(im,tuple(int(v) for v in p['xy'][k]),4,(0,0,255) if k in (7,8,9,10) else (255,0,0),-1)
    for f in F:cv2.rectangle(im,(int(f[0]),int(f[1])),(int(f[0]+f[2]),int(f[1]+f[3])),(255,0,255),2)
    cv2.putText(im,tag,(8,24),0,0.8,(255,255,255),3);cv2.putText(im,tag,(8,24),0,0.8,(0,0,0),1)
    return im
os.makedirs(os.path.join(OUT,'annotated'),exist_ok=True)
rows=[]
for lab,grp,name,gp,npth in S:
    gi=cv2.imread(gp);ni=cv2.imread(npth)
    if gi is None or ni is None:print('MISSING',name,gp,npth);continue
    ni=cv2.resize(ni,(gi.shape[1],gi.shape[0]))
    H=gi.shape[0]
    Pg,Pn=pose(gi),pose(ni);Fg,Fn=faces(gi),faces(ni)
    Bg,Bn=big(Pg,H),big(Pn,H)
    r={'name':name,'label':lab,'group':grp,'n_people':len(Bg),'n_now':len(Bn)}
    lowc=[];rdev=[];angs=[];reach_fail=0;faceflag=0
    for p in Bg:
        q=match(p,Bn)
        for sd in 'LR':
            a=arm(p,sd)
            if p['cf'][ARMS[sd][0]]>=0.5:lowc.append(min(a['conf'][1],a['conf'][2]))
            if a['ok']:
                if not a['reach']:reach_fail+=1
                if a['angle'] is not None:angs.append(a['angle'])
                if q is not None:
                    an=arm(q,sd)
                    if an['ok'] and an['ratio'] and a['ratio']:rdev.append(abs(math.log(a['ratio']/an['ratio'])))
        fg=[f for f in Fg if inbox(f,p['box'])]
        qf=[f for f in Fn if q is not None and inbox(f,q['box'])]
        if fg and not qf:faceflag=1
    r['min_elbow_wrist_conf']=round(min(lowc),3) if lowc else ''
    r['rule_lowconf']=int(bool(lowc) and min(lowc)<0.3)
    r['rule_unreachable']=int(reach_fail>0)
    r['max_ratio_dev_pct']=round((math.exp(max(rdev))-1)*100,1) if rdev else ''
    r['rule_ratio40']=int(bool(rdev) and math.exp(max(rdev))-1>0.4)
    r['min_elbow_angle']=round(min(angs),1) if angs else ''
    r['rule_angle15']=int(bool(angs) and min(angs)<15)
    r['rule_extra_person']=int(len(Bg)>len(Bn))
    r['faces_gen']=len(Fg);r['faces_now']=len(Fn);r['rule_face_on_back']=faceflag
    r['hands_gen']=hands(gp);r['hands_now']=hands(npth)
    r['rule_hands']=int(r['hands_gen'] is not None and r['hands_gen']>2*max(1,len(Bg)))
    rows.append(r);print(name,lab,{k:v for k,v in r.items() if k.startswith('rule') or k.startswith('n_')},flush=True)
    if lab=='bad':
        a=draw(gi,Pg,Fg,f'{name} GEN ({lab})');b=draw(ni,Pn,Fn,'NOW')
        cv2.imwrite(os.path.join(OUT,'annotated',name+'.jpg'),cv2.resize(np.hstack([a,b]),None,fx=0.6,fy=0.6),[cv2.IMWRITE_JPEG_QUALITY,85])
with open(os.path.join(OUT,'per-image.csv'),'w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(rows[0].keys()));w.writeheader();w.writerows(rows)
json.dump(rows,open(os.path.join(OUT,'per-image.json'),'w'))
