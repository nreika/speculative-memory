"""Persistent CPU detector. JSON lines over stdio; image bytes stay on this PC."""
import os, sys, json, time, base64, io
from pathlib import Path
os.environ['TORCH_HOME']=os.environ.get('PEOPLE_DETECTOR_CACHE',str(Path.home()/'GitHub/speculative-memory_data/models/person-detector'))
import torch
from PIL import Image
from torchvision.models.detection import ssdlite320_mobilenet_v3_large, SSDLite320_MobileNet_V3_Large_Weights
torch.set_num_threads(2)
weights=SSDLite320_MobileNet_V3_Large_Weights.DEFAULT
model=ssdlite320_mobilenet_v3_large(weights=weights,progress=False).eval()
transform=weights.transforms()
with torch.inference_mode():
 for line in sys.stdin:
  request={}
  try:
   request=json.loads(line)
   started=time.perf_counter()
   image=Image.open(io.BytesIO(base64.b64decode(request['image'],validate=True))).convert('RGB')
   pred=model([transform(image)])[0]
   persons=[{'score':round(float(s),4),'box':[round(float(v),1) for v in b]} for l,s,b in zip(pred['labels'],pred['scores'],pred['boxes']) if int(l)==1 and float(s)>=.5]
   candidates=[{'score':round(float(s),4),'box':[round(float(v),1) for v in b]} for l,s,b in zip(pred['labels'],pred['scores'],pred['boxes']) if int(l)==1 and float(s)>=.15]
   result={'id':request['id'],'count':len(persons),'persons':persons,'candidates':candidates,'inferenceMs':round((time.perf_counter()-started)*1000,2)}
  except Exception as error:
   result={'id':request.get('id'),'error':str(error)}
  print(json.dumps(result),flush=True)


