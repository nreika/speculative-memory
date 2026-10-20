"""Validated, deterministic cue clock. No TD, network, threads or image I/O."""
import copy
import math
import re
import time
import uuid

SCENES = {'A': 'gen_a', 'B': 'gen_b', 'C': 'gen_c',
          'gen_a': 'gen_a', 'gen_b': 'gen_b', 'gen_c': 'gen_c'}
DISPLAYS = {'A': 'display_a', 'B': 'display_b', 'C': 'display_c', 'NOW': 'display_now',
            **{v: v for v in ('display_a', 'display_b', 'display_c', 'display_now')}}

def number(value, label, low=0, high=86400):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(label + ' is out of range')
    return float(value)

def rectangle(value, label):
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(label + ' must be [x,y,width,height]')
    r = [number(v, label, 0, 1) for v in value]
    if r[2] <= 0 or r[3] <= 0 or r[0]+r[2] > 1.00000001 or r[1]+r[3] > 1.00000001:
        raise ValueError(label + ' exceeds the image')
    return r

def scene_map(value, label, images=False):
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object')
    out = {}
    for key, item in value.items():
        if key not in SCENES or SCENES[key] in out:
            raise ValueError('Unknown or duplicate scene: ' + key)
        if not images:
            if not isinstance(item, str) or len(item) > 8000:
                raise ValueError(label + ' must contain text')
            out[SCENES[key]] = item.strip()
            continue
        if not isinstance(item, list) or len(item) > 8:
            raise ValueError('At most 8 image elements per scene')
        elements = []
        ids = set()
        for element in item:
            if not isinstance(element, dict) or set(element)-{'id','image','sourceRect','targetRect','fit','opacity','featherPx','instruction'}:
                raise ValueError('Invalid image element fields')
            e = copy.deepcopy(element)
            if not isinstance(e.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',e['id']) or e['id'] in ids:
                raise ValueError('Image element needs a unique ID')
            ids.add(e['id'])
            if not isinstance(e.get('image'), str) or not e['image']:
                raise ValueError('Image element needs an image path')
            e['sourceRect'] = rectangle(e.get('sourceRect', [0,0,1,1]), 'sourceRect')
            e['targetRect'] = rectangle(e.get('targetRect', [0,0,1,1]), 'targetRect')
            e['fit'] = e.get('fit', 'cover')
            if e['fit'] not in ('cover','contain'):
                raise ValueError('Unknown image fit')
            e['opacity'] = number(e.get('opacity', 1), 'opacity', 0, 1)
            e['featherPx'] = number(e.get('featherPx', 24), 'featherPx', 0, 256)
            if not e['featherPx'].is_integer():raise ValueError('featherPx must be an integer')
            e['instruction'] = e.get('instruction', '')
            if not isinstance(e['instruction'], str) or len(e['instruction']) > 2000:
                raise ValueError('Invalid image instruction')
            elements.append(e)
        out[SCENES[key]] = elements
    return out

CAPTION_CHANNELS = ('current-now','current-a','current-b','current-c','control-output-1','control-output-2','control-output-3','control-output-4')

def output_patches(rows):
    import re
    allowed = {'source','contentId','delaySec','scene','visible','labels','subtitles','fadeMode','fadeDurationMs','blackHoldMs','faceBlur'}
    if not isinstance(rows,list) or not 0<len(rows)<=64:raise ValueError('Invalid output patches')
    ids=set()
    for row in rows:
        if not isinstance(row,dict) or set(row)!={'id','patch'} or not isinstance(row['id'],str) or not (re.fullmatch(r'screen-[1-9][0-9]{0,2}',row['id']) or row['id'] in CAPTION_CHANNELS) or row['id'] in ids:raise ValueError('Invalid output target: use screen-N, or for output_labels / output_subtitles also '+', '.join(CAPTION_CHANNELS))
        ids.add(row['id']);p=row['patch']
        if row['id'] in CAPTION_CHANNELS:
            if not isinstance(p,dict) or not p or set(p)-{'labels','subtitles'} or any(not isinstance(v,bool) for v in p.values()):raise ValueError('Invalid output target: '+row['id']+' accepts only output_labels / output_subtitles (true or false)')
            continue
        if not isinstance(p,dict) or not p or set(p)-allowed:raise ValueError('Invalid output patch')
        if 'source' in p and p['source'] not in ('now','a','b','c','actual-past','generated-history','fixed','td-1','td-2','td-3','td-4'):raise ValueError('Invalid output source')
        if 'contentId' in p and (not isinstance(p['contentId'],str) or not p['contentId'] or len(p['contentId'])>256 or any(ord(x)<32 for x in p['contentId'])):raise ValueError('Invalid output image ID')
        if 'scene' in p and p['scene'] not in ('a','b','c','any'):raise ValueError('Invalid output scene')
        if any(k in p and not isinstance(p[k],bool) for k in ('visible','labels','subtitles')):raise ValueError('Invalid output boolean')
        if 'fadeMode' in p and p['fadeMode'] not in ('original','crossfade','none'):raise ValueError('Invalid output fade')
        if 'delaySec' in p:number(p['delaySec'],'delaySec',0,86400)
        for k in ('fadeDurationMs','blackHoldMs'):
            if k in p and (isinstance(p[k],bool) or not isinstance(p[k],int) or not 0<=p[k]<=10000):raise ValueError('Invalid output timing')
        if 'faceBlur' in p:
            b=p['faceBlur']
            if not isinstance(b,dict) or set(b)-{'enabled','strengthPx'} or 'enabled' in b and not isinstance(b['enabled'],bool) or 'strengthPx' in b and (isinstance(b['strengthPx'],bool) or not isinstance(b['strengthPx'],int) or not 0<=b['strengthPx']<=40):raise ValueError('Invalid output blur')
    return rows

UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', re.I)
MAX_SCENE_PERSON_REFERENCES = 15

def reference_ids(value):
    if not isinstance(value, list) or len(value) > MAX_SCENE_PERSON_REFERENCES or any(not isinstance(v, str) or not UUID.fullmatch(v) for v in value):
        raise ValueError('person reference IDs must be up to %d UUIDs joined by |' % MAX_SCENE_PERSON_REFERENCES)
    ids = [v.lower() for v in value]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate person reference IDs')
    return ids

def settings_patch(p):
    """One control-panel setting per cue, shaped like a settings.apply patch."""
    ranges = {'intervalSec': (5, 3600), 'presence': (0, 1), 'tone': (0, 1), 'emptyRoomPersonChance': (0, 1)}
    if not isinstance(p, dict) or len(p) != 1:
        raise ValueError('Invalid scenario setting')
    (key, value), = p.items()
    if key == 'mode':
        if value not in ('manual', 'timer', 'chain'):
            raise ValueError('mode is manual, timer or chain')
        return {key: value}
    if key in ranges:
        return {key: number(value, key, *ranges[key])}
    if key != 'scenes' or not isinstance(value, dict) or len(value) != 1:
        raise ValueError('Invalid scenario setting')
    (scene, row), = value.items()
    if scene not in ('a', 'b', 'c') or not isinstance(row, dict) or len(row) != 1:
        raise ValueError('Invalid scenario scene setting')
    (field, item), = row.items()
    if field == 'distanceSec':
        item = number(item, 'distanceSec', -3600, 3600)
    elif field in ('continuousPersonReferenceIds', 'oneShotPersonReferenceIds'):
        item = reference_ids(item)
    else:
        raise ValueError('Invalid scenario scene setting')
    return {'scenes': {scene: {field: item}}}

def validate(document):
    if not isinstance(document, dict) or set(document)-{'version','id','name','durationSec','loop','cues','participantInstructions'}:
        raise ValueError('Unknown scenario fields')
    if type(document.get('version')) is not int or document.get('version') != 1:
        raise ValueError('Expected scenario version 1')
    if not isinstance(document.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',document['id']):
        raise ValueError('Scenario needs an ID')
    if not isinstance(document.get('name', document['id']), str):
        raise ValueError('Scenario name must be text')
    if not isinstance(document.get('loop', False), bool):
        raise ValueError('loop must be true or false')
    cues = document.get('cues')
    if not isinstance(cues, list) or not 1 <= len(cues) <= 1000:
        raise ValueError('Scenario needs 1..1000 cues')
    out = copy.deepcopy(document)
    out['loop'] = document.get('loop', False)
    out['name'] = document.get('name', document['id'])
    if not isinstance(document.get('participantInstructions', ''), str):
        raise ValueError('participantInstructions must be text')
    out['cues'] = []
    ids = set()
    for cue in cues:
        if not isinstance(cue, dict) or set(cue)-{'id','atSec','prompts','oneShot','images','layout','generate','note','sceneModes','outputs','settings','hold'}:
            raise ValueError('Unknown cue fields')
        c = copy.deepcopy(cue)
        if not isinstance(c.get('id'), str) or not c['id'] or c['id'] in ids:
            raise ValueError('Cues need unique IDs')
        ids.add(c['id'])
        c['atSec'] = number(c.get('atSec'), 'atSec')
        for field in ('prompts','oneShot','images'):
            if field in c:
                c[field] = scene_map(c[field], field, images=field=='images')
        if 'sceneModes' in c:
            c['sceneModes']=scene_map(c['sceneModes'],'sceneModes')
            if any(v not in ('asset_only','people_and_assets','default') for v in c['sceneModes'].values()):raise ValueError('scene_mode is asset_only, people_and_assets or default')
        if 'outputs' in c:
            c['outputs'] = output_patches(c['outputs'])
        if 'settings' in c:
            c['settings'] = settings_patch(c['settings'])
        if 'hold' in c and c['hold'] not in ('pause', 'resume'):
            raise ValueError('hold is pause or resume')
        if 'settings' in c and 'hold' in c:
            raise ValueError('A cue changes one setting or the hold, not both')
        if 'layout' in c:
            if not isinstance(c['layout'], list) or len(c['layout']) != 4:
                raise ValueError('layout must list DISPLAY 1..4')
            try:c['layout'] = [DISPLAYS[k] for k in c['layout']]
            except (KeyError, TypeError):raise ValueError('Unknown display scene') from None
            if len(set(c['layout'])) != 4:
                raise ValueError('layout must contain A/B/C/NOW exactly once')
        if not isinstance(c.get('generate', False), bool):
            raise ValueError('generate must be true or false')
        if 'note' in c and not isinstance(c['note'], str):
            raise ValueError('note must be text')
        if not any(k in c for k in ('prompts','oneShot','images','layout','note','sceneModes','outputs','settings','hold')) and not c.get('generate'):
            raise ValueError('Empty cue: ' + c['id'])
        out['cues'].append(c)
    out['cues'].sort(key=lambda c:c['atSec'])  # stable at equal times
    out['durationSec'] = number(document.get('durationSec', max(1,out['cues'][-1]['atSec'])), 'durationSec', .001)
    if out['cues'][-1]['atSec'] > out['durationSec'] or out['loop'] and out['cues'][-1]['atSec'] >= out['durationSec']:
        raise ValueError('Cue lies beyond the duration or at a loop boundary')
    return out

class Timeline:
    def __init__(self, document, clock=time.monotonic):
        self.plan = validate(document)
        self.clock = clock
        self.state = 'ready'
        self.run_id = ''
        self.accumulated = 0.0
        self.anchor = 0.0
        self.cycle = 0
        self.cursor = 0
        self.prompts = {}
        self.images = {}
        self.scene_modes = {}
        self.pending = {}
        self.layout = None
        self.applied = []
        self.journal = []

    def elapsed(self):
        return self.accumulated + (max(0,self.clock()-self.anchor) if self.state=='running' else 0)

    def _reset_cues(self):
        self.cursor=0;self.prompts={};self.images={};self.pending={};self.layout=None;self.applied=[]
        self.scene_modes={}

    def start(self):
        self.run_id = uuid.uuid4().hex
        self.accumulated=0;self.anchor=self.clock();self.cycle=0;self.journal=[]
        self._reset_cues();self.state='running'
        return self.advance()

    def pause(self):
        if self.state=='running':
            self.accumulated=self.elapsed();self.state='paused'

    def resume(self):
        if self.state=='paused':self.anchor=self.clock();self.state='running'

    def stop(self):
        self.accumulated=self.elapsed();self.state='stopped';self._reset_cues()

    def advance(self):
        if self.state!='running':return []
        elapsed=self.elapsed();duration=self.plan['durationSec']
        cycle=int(elapsed//duration) if self.plan['loop'] else 0
        if cycle!=self.cycle:
            self.cycle=cycle;self._reset_cues()
        offset=elapsed%duration if self.plan['loop'] else min(elapsed,duration)
        due=[]
        cues=self.plan['cues']
        while self.cursor<len(cues) and cues[self.cursor]['atSec']<=offset:
            cue=cues[self.cursor];self.cursor+=1
            self.prompts.update(cue.get('prompts',{}))
            self.images.update(copy.deepcopy(cue.get('images',{})))
            for scene,mode in cue.get('sceneModes',{}).items():
                if mode=='default':self.scene_modes.pop(scene,None)
                else:self.scene_modes[scene]=mode
            for scene,text in cue.get('oneShot',{}).items():
                if text:self.pending['%d:%s:%s'%(cycle,cue['id'],scene)]=(scene,text)
            if 'layout' in cue:self.layout=list(cue['layout'])
            self.applied.append(cue['id'])
            event={'cue':copy.deepcopy(cue),'cycle':cycle,'elapsedSec':elapsed,
                   'lateSec':max(0,offset-cue['atSec'])}
            due.append(event)
            self.journal.append({k:v for k,v in event.items() if k!='cue'}|{'cueId':cue['id']})
            self.journal=self.journal[-100:]
        if not self.plan['loop'] and elapsed>=duration:
            self.accumulated=duration;self.state='completed'
        return due

    def snapshot(self):
        if self.state in ('ready','stopped'):return None
        prompts=dict(self.prompts)
        for scene,text in self.pending.values():
            prompts[scene]='\n'.join(filter(None,(prompts.get(scene,''),text)))
        return {'scenarioId':self.plan['id'],'runId':self.run_id,'elapsedSec':round(self.elapsed(),3),
                'cycle':self.cycle,'cueIds':list(self.applied),'prompts':prompts,
                'images':copy.deepcopy(self.images),'receipt':list(self.pending),'sceneModes':dict(self.scene_modes)}

    def acknowledge(self, run_id, receipt):
        if run_id!=self.run_id:return
        for token in receipt:self.pending.pop(token,None)
