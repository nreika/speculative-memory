"""Human-editable CSV timeline; paths are relative to the CSV, never to TD.

collect() checks the whole file and returns every problem as
{row, column?, message, severity}; row is the 1-based CSV line (header = 1,
0 = the file as a whole). parse()/load() keep the single-ValueError API."""
import csv
import io
import re
from pathlib import Path

from scenario_engine import validate, rectangle, number, reference_ids, CAPTION_CHANNELS

COLUMNS = ('seconds','action','target','value','source_rect','target_rect','fit','opacity','feather_px','instruction')
REQUIRED = COLUMNS[:4]
SCENES = ('A','B','C')
META = ('instructions','scenario','loop')
OUTPUTS = {'output_source':'source','output_image':'contentId','output_visible':'visible','output_labels':'labels','output_subtitles':'subtitles','output_fade':'fadeMode','output_fade_sec':'fadeDurationMs','output_black_sec':'blackHoldMs','output_face_blur':'blurEnabled','output_blur_px':'blurStrength','output_delay_sec':'delaySec','output_scene':'scene'}
ACTIONS = META+('end','layout','scene_mode','prompt','one_shot','clear_prompt','image','clear_image','mode','interval_sec','presence','tone','empty_person','distance','person_refs','person_refs_once','pause','resume','generate','note')
MAX_CUES = 1000
MAX_IMAGE = 8*1024*1024
MAX_IMAGES = 24*1024*1024
# Engine messages name camelCase fields; map them back to the CSV column.
HINTS = (('sourceRect','source_rect'),('source_rect','source_rect'),('targetRect','target_rect'),('target_rect','target_rect'),
         ('featherPx','feather_px'),('opacity','opacity'),('image fit','fit'),('instruction','instruction'),('output target','target'),
         ('layout','value'),('display scene','value'),('output','value'),('must contain text','value'))

class FormatIssue(ValueError):
    """A row problem attributed to one CSV column."""
    def __init__(self, message, column=None):
        super().__init__(message)
        self.column = column

def _hint(message):
    return next((col for key,col in HINTS if key in message), None)

def _num(text, label, low, high, column='value'):
    try:
        return number(float(text), label, low, high)
    except (ValueError, TypeError):
        raise FormatIssue('%s must be a number from %g to %g (got "%s")'%(label,low,high,text), column) from None

def rect(text, label):
    try:
        return rectangle([float(v.strip()) for v in text.split('|')], label)
    except (ValueError, TypeError):
        raise FormatIssue(label + ' must be x|y|width|height (0..1) inside the image', label) from None

def _apply(action, row, cue, used, plan):
    """Fills one cue from a data row; raises FormatIssue on the first problem in that row."""
    target=row['target'];value=row['value']
    def blank_target():
        if target:raise FormatIssue(action+' target must be blank','target')
    def scene_target():
        if target not in SCENES:raise FormatIssue(action+' target must be A, B or C','target')
    if action=='end':pass
    elif action=='scenario':
        if not value:raise FormatIssue('Scenario ID cannot be empty','value')
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',value):raise FormatIssue('Scenario ID must be 1-128 characters of A-Z a-z 0-9 _ . : -','value')
        plan['id']=value
    elif action=='instructions':plan['participantInstructions']=value
    elif action=='loop':
        if value not in ('true','false'):raise FormatIssue('loop is true or false','value')
        plan['loop']=value=='true'
    elif action=='layout':
        blank_target()
        cue['layout']=[v.strip() for v in value.split('|')]
    elif action.startswith('output_'):
        if action not in OUTPUTS:raise FormatIssue('Unknown output action: '+action+' (allowed: '+', '.join(OUTPUTS)+')','action')
        key=OUTPUTS[action]
        if target in CAPTION_CHANNELS and key not in ('labels','subtitles'):
            raise FormatIssue(action+' target must be screen-N; '+target+' accepts only output_labels / output_subtitles','target')
        if key in ('visible','labels','subtitles','blurEnabled'):
            if value not in ('true','false'):raise FormatIssue(action+' is true or false','value')
            value=value=='true'
        elif key in ('fadeDurationMs','blackHoldMs'):
            ms=_num(value,action,0,10)*1000
            if abs(ms-round(ms))>0.000001:raise FormatIssue(action+' requires millisecond precision','value')
            value=int(round(ms))
        elif key=='blurStrength':
            if not re.fullmatch(r'\d{1,2}',value) or int(value)>40:raise FormatIssue('output_blur_px is a whole number from 0 to 40','value')
            value=int(value)
        elif key=='delaySec':value=_num(value,'output_delay_sec',0,86400)
        patch={'faceBlur':{'enabled' if key=='blurEnabled' else 'strengthPx':value}} if key in ('blurEnabled','blurStrength') else {key:value}
        if key=='contentId':patch['source']='fixed'
        cue['outputs']=[{'id':target,'patch':patch}]
    elif action=='scene_mode':
        scene_target()
        if value not in ('asset_only','people_and_assets','default'):raise FormatIssue('scene_mode value is asset_only, people_and_assets or default','value')
        cue['sceneModes']={target:value}
    elif action in ('prompt','one_shot','clear_prompt','image','clear_image'):
        scene_target()
        if action in ('clear_prompt','clear_image') and value:raise FormatIssue(action+' needs an empty value','value')
        if action in ('prompt','one_shot','image') and not value:raise FormatIssue(action+' value cannot be empty','value')
        if action=='image':
            used.update(COLUMNS[4:])
            fit=row.get('fit') or 'cover'
            if fit not in ('cover','contain'):raise FormatIssue('fit is cover or contain','fit')
            cue['images']={target:[{'id':cue['id'],'image':value,
                'sourceRect':rect(row.get('source_rect') or '0|0|1|1','source_rect'),
                'targetRect':rect(row.get('target_rect') or '0|0|1|1','target_rect'),
                'fit':fit,
                'opacity':_num(row.get('opacity') or '1','opacity',0,1,'opacity'),
                'featherPx':_num(row.get('feather_px') or '24','feather_px',0,256,'feather_px'),
                'instruction':row.get('instruction') or ''}]}
        elif action=='clear_image':cue['images']={target:[]}
        else:cue['oneShot' if action=='one_shot' else 'prompts']={target:'' if action=='clear_prompt' else value}
    elif action in ('mode','interval_sec','presence','tone','empty_person'):
        blank_target()
        if action=='mode':
            if value not in ('manual','timer','chain'):raise FormatIssue('mode is manual, timer or chain','value')
            cue['settings']={'mode':value}
        elif action=='interval_sec':cue['settings']={'intervalSec':_num(value,'interval_sec',5,3600)}
        elif action=='empty_person':cue['settings']={'emptyRoomPersonChance':_num(value,'empty_person',0,1)}
        else:cue['settings']={action:_num(value,action,0,1)}
    elif action in ('distance','person_refs','person_refs_once'):
        scene_target()
        if action=='distance':field,item='distanceSec',_num(value,'distance',-3600,3600)
        else:
            field='continuousPersonReferenceIds' if action=='person_refs' else 'oneShotPersonReferenceIds'
            try:item=reference_ids([v.strip() for v in value.split('|')] if value else [])
            except ValueError as exc:raise FormatIssue(str(exc),'value') from None
        cue['settings']={'scenes':{target.lower():{field:item}}}
    elif action in ('pause','resume','generate'):
        blank_target()
        if value:raise FormatIssue(action+' needs an empty value','value')
        if action=='generate':cue['generate']=True
        else:cue['hold']=action
    elif action=='note':
        blank_target()
        cue['note']=value
    else:raise FormatIssue('Unknown action: '+action+' (allowed: '+', '.join(ACTIONS)+', output_*)','action')

def _issue(row, message, column=None, severity='error'):
    out={'row':row,'message':message,'severity':severity}
    if column:out['column']=column
    return out

def _image_file(base, value, cache):
    """Problem with an image path relative to the CSV folder, or None."""
    if '\\' in value or ':' in value or value.startswith('/') or Path(value).is_absolute():
        return 'Image path must be relative to the CSV folder and use /'
    asset=(base/value).resolve()
    try:inside=asset!=base and asset.relative_to(base) is not None
    except ValueError:inside=False
    if not inside:return 'Image path leaves the CSV folder: '+value
    if not asset.name.lower().endswith('.png'):return 'Image must be a .png file: '+value
    if not asset.is_file():return 'Image file not found: '+value
    if asset not in cache:
        cache[asset]=asset.stat().st_size
        if cache[asset]>MAX_IMAGE:return 'Image exceeds 8 MB: '+value
        if sum(cache.values())>MAX_IMAGES:return 'Scenario images exceed 24 MB in total'
    return None

def collect(text, scenario_id='SCN-001', base=None):
    """Returns (plan or None, issues). plan is None whenever any issue is an error.
    base, when given, is the CSV folder: image rows must name an existing PNG inside it."""
    issues=[]
    err=lambda row,msg,col=None:issues.append(_issue(row,msg,col))
    warn=lambda row,msg,col=None:issues.append(_issue(row,msg,col,'warning'))
    reader=csv.DictReader(io.StringIO(text.lstrip('﻿')), strict=True)
    try:fields=reader.fieldnames
    except csv.Error as exc:
        err(1,'CSV syntax error in header: %s'%exc);return None,issues
    if not fields:
        err(1,'CSV is empty; the header must be seconds,action,target,value');return None,issues
    for name in sorted({f for f in fields if fields.count(f)>1}):err(1,'Duplicate column: '+name,name)
    for name in fields:
        if name not in COLUMNS:err(1,'Unknown column: "%s" (allowed: %s)'%(name,','.join(COLUMNS)),name)
    for name in REQUIRED:
        if name not in fields:err(1,'Missing required column: '+name,name)
    if issues:return None,issues
    plan={'version':1,'id':scenario_id,'loop':False,'cues':[]}
    cues=[];metadata={};notes={};used_columns=set();previous=None;end=None;images={}
    base=Path(base).resolve() if base is not None else None
    try:
        for raw in reader:
            line=reader.line_num
            if None in raw:
                err(line,'Wrong number of columns: %d expected, %d found'%(len(fields),len(fields)+len(raw[None])));continue
            if any(v is None for v in raw.values()):
                err(line,'Wrong number of columns: %d expected, %d found'%(len(fields),sum(v is not None for v in raw.values())));continue
            row={k:v.strip() for k,v in raw.items()}
            if not any(row.values()):continue
            used_columns.update(k for k,v in row.items() if v)
            seconds=None
            try:seconds=_num(row['seconds'],'seconds',0,86400,'seconds')
            except FormatIssue as exc:err(line,str(exc),'seconds')
            action=row['action']
            if not action:
                err(line,'action is empty','action');continue
            cue={'id':'row-%04d'%line,'atSec':seconds if seconds is not None else 0.0}
            used={'seconds','action','target','value'}
            try:
                if action in META or action=='end':
                    first=metadata.get(action)
                    if first:raise FormatIssue('Duplicate %s row (first at row %d); use it once'%(action,first),'action')
                    metadata[action]=line
                    if action in META and seconds not in (None,0):raise FormatIssue(action+' must be at second 0','seconds')
                    if row['target']:raise FormatIssue(action+' target must be blank','target')
                    if action=='end':
                        if row['value']:raise FormatIssue('end needs an empty value; put the duration in seconds','value')
                        if seconds is not None:end=(seconds,line)
                _apply(action,row,cue,used,plan)
                if len(cue)>2:validate({'version':1,'id':'row-check','cues':[cue]})  # per-cue engine checks, attributed to this row
            except FormatIssue as exc:err(line,str(exc),exc.column)
            except (ValueError,TypeError) as exc:err(line,str(exc),_hint(str(exc)))
            else:
                if len(cue)>2 and seconds is not None:cues.append((cue,line))
            extra=[k for k,v in row.items() if v and k not in used]
            if extra:err(line,'Image columns are only for image rows: '+','.join(extra),extra[0])
            if action=='note' and row['value']:
                if row['value'] in notes:warn(line,'Duplicate note (same text as row %d)'%notes[row['value']],'value')
                else:notes[row['value']]=line
            if action=='image' and row['value'] and base is not None:
                problem=_image_file(base,row['value'],images)
                if problem:err(line,problem,'value')
            if seconds is not None and action not in META and action!='end':
                if previous is not None and seconds<previous[0]:
                    warn(line,'seconds %g is earlier than row %d (%g); cues run in time order'%(seconds,previous[1],previous[0]),'seconds')
                previous=(seconds,line)
    except csv.Error as exc:
        err(reader.line_num,'CSV syntax error (quotes or delimiters): %s; rows after this were not checked'%exc)
    rows_ok=not errors_of(issues)
    if len(cues)>MAX_CUES:err(0,'At most %d cues (found %d)'%(MAX_CUES,len(cues)))
    if not cues and rows_ok:err(0,'Scenario needs at least one cue row (only metadata/end found)')
    if end is None:
        if 'end' not in metadata:warn(0,'No end row; duration defaults to the last cue time')
        if plan['loop'] and cues and max(c['atSec'] for c,_ in cues)>=1:err(metadata.get('loop',0),'loop true needs an end row after the last cue','action')
    else:
        duration,end_line=end
        if duration<=0:err(end_line,'end must be after second 0','seconds')
        for cue,line in cues:
            if cue['atSec']>duration:err(line,'Cue at %gs is after end (%gs, row %d)'%(cue['atSec'],duration,end_line),'seconds')
            elif plan['loop'] and cue['atSec']>=duration:err(line,'Cue at %gs is at the loop end (%gs); looping cues must be before end'%(cue['atSec'],duration),'seconds')
        plan['durationSec']=duration
    for name in fields[4:]:
        if name not in used_columns:warn(1,'Optional column %s is never used and can be removed'%name,name)
    if errors_of(issues):return None,issues
    plan['cues']=[cue for cue,_ in cues]
    try:return validate(plan),issues
    except (ValueError,TypeError) as exc:
        err(0,str(exc));return None,issues

def errors_of(issues):return [i for i in issues if i['severity']=='error']
def warnings_of(issues):return [i for i in issues if i['severity']=='warning']

def describe(issue):
    where='CSV row %d'%issue['row'] if issue['row'] else 'CSV'
    return '%s: %s'%(where,issue['message'])

def parse(text, scenario_id='SCN-001', base=None):
    """Single-error API: raises ValueError for the first error."""
    plan,issues=collect(text,scenario_id,base)
    errors=errors_of(issues)
    if errors:raise ValueError(describe(errors[0]))
    return plan

def check(path):
    """Full-file check of a CSV on disk, including referenced image files: (plan or None, issues)."""
    path=Path(path).resolve()
    if path.stat().st_size>2*1024*1024:return None,[_issue(0,'CSV exceeds 2 MB')]
    try:text=path.read_bytes().decode('utf-8-sig')
    except UnicodeDecodeError:return None,[_issue(0,'CSV must be UTF-8 text')]
    # One logical line per row so row numbers match a spreadsheet (CR CR LF appears after autocrlf).
    return collect(re.sub(r'\r+\n|\r','\n',text),path.stem,path.parent)

def load(path):
    plan,issues=check(path)
    errors=errors_of(issues)
    if errors:raise ValueError(describe(errors[0]))
    return plan,Path(path).resolve().parent
