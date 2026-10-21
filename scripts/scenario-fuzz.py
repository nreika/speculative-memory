"""No-LLM/no-GPU scenario fuzzer for the live local server. Reports only; never fixes.
Usage: python scripts/scenario-fuzz.py --seed 1 --runs 30 [--budget-min 20]
Only touches screen-9 / screen-10, never uses mode/generate rows. Restores baseline at the end."""
import json, random, time, uuid, argparse, pathlib, datetime, copy, urllib.request, urllib.error, socket, traceback

ap = argparse.ArgumentParser()
ap.add_argument('--seed', type=int, default=1); ap.add_argument('--runs', type=int, default=3)
ap.add_argument('--base', default='http://127.0.0.1:3000'); ap.add_argument('--budget-min', type=float, default=22)
ap.add_argument('--types', default='ABC')
a = ap.parse_args()
H = {'X-Control-Request': '1', 'Content-Type': 'application/json', 'Origin': a.base}
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
rng = random.Random(a.seed)
SCREENS = ('screen-9', 'screen-10')
VIOL = []; STAMP = datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
OUTDIR = pathlib.Path('logs/scenario-fuzz'); OUTDIR.mkdir(parents=True, exist_ok=True)
logf = open(OUTDIR / f'{STAMP}.jsonl', 'w', encoding='utf-8')
CUR = {'run': 0, 'type': '-', 'ops': []}

def log(kind, **kw):
    rec = {'t': round(time.time(), 2), 'run': CUR['run'], 'kind': kind, **kw}
    logf.write(json.dumps(rec, ensure_ascii=False) + '\n'); logf.flush()

def viol(inv, msg, **kw):
    v = {'run': CUR['run'], 'type': CUR['type'], 'invariant': inv, 'msg': msg, 'ops': list(CUR['ops'][-40:]), **kw}
    VIOL.append(v); log('violation', invariant=inv, msg=msg)

def call(path, body=None, timeout=15, raw=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(a.base + path, data=data, headers=H, method='GET' if data is None else 'POST')
    t0 = time.time()
    try:
        with op.open(req, timeout=timeout) as r: code, txt = r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e: code, txt = e.code, e.read().decode('utf-8', 'replace')
    except (socket.timeout, TimeoutError, urllib.error.URLError) as e: code, txt = 0, 'EXC ' + repr(e)
    dt = time.time() - t0
    try: js = json.loads(txt)
    except Exception: js = None
    if code >= 500 or code == 0 or dt > 10:
        viol(1, f'{path} -> HTTP {code} in {dt:.1f}s: {txt[:200]}')
    return code, js, txt, dt

def action(name, data=None, base=None):
    CUR['ops'].append(f'{time.strftime("%H:%M:%S")} {name} {json.dumps(data or {}, ensure_ascii=False)[:120]}')
    body = {'action': name, 'data': data or {}, 'requestId': uuid.uuid4().hex}
    if base: body['baseRevision'] = base
    return call('/api/td-control/action', body)

def state(): return call('/api/td-control/state')[1] or {}
def outs(): return call('/api/browser-outputs')[1] or {}

def snap_settings(s):
    sc = s.get('scenes', {})
    d = {k: s.get(k) for k in ('presence', 'tone', 'emptyRoomPersonChance')}
    for k in 'abc':
        for f in ('distanceSec', 'presence', 'tone'): d[f'{k}.{f}'] = sc.get(k, {}).get(f)
    return d

def snap(st=None, o=None):
    st = st or state(); o = o or outs()
    sc = {x['id']: {'source': x.get('source'), 'visible': x.get('visible'), 'labels': x.get('labels'), 'subtitles': x.get('subtitles'),
          'fadeMode': x.get('fadeMode'), 'fadeDurationMs': x.get('fadeDurationMs'), 'faceBlur': (x.get('faceBlur') or {}).get('enabled'),
          'blurPx': (x.get('faceBlur') or {}).get('strengthPx')} for x in o.get('outputs', []) if x['id'] in SCREENS}
    return {'screens': sc, 'settings': snap_settings(st.get('settings', {})), 'hold': st.get('submissionHold'),
            'scn': st.get('scenario', {}), 'phase': st.get('capture', {}).get('phase'), 'errors': st.get('errors') or []}

# ---------- baseline
B_STATE = state(); B_OUTS = outs(); BASE = snap(B_STATE, B_OUTS)
B_FILE = B_STATE['scenario'].get('file') or (B_STATE['scenario'].get('scenarioId') and B_STATE['scenario']['scenarioId'] + '.csv')
rc = B_STATE.get('remoteCamera') or {}; rp = B_STATE.get('replay') or {}
B_INPUT = 'remote-device' if rc.get('selected') else 'cycle' if rp.get('cycle') else rp.get('setId') or 'camera'
B_OUT_CFG = {x['id']: copy.deepcopy(x) for x in B_OUTS['outputs'] if x['id'] in SCREENS}
(OUTDIR / f'{STAMP}.baseline.json').write_text(json.dumps({'scenario_file': B_FILE, 'input': B_INPUT, 'hold': BASE['hold'],
    'outputs': B_OUT_CFG, 'settings': B_STATE['settings']}, ensure_ascii=False, indent=1), encoding='utf-8')
log('baseline', file=B_FILE, input=B_INPUT, hold=BASE['hold'])

def restore_outputs():
    o = outs(); new = [copy.deepcopy(B_OUT_CFG[x['id']]) if x['id'] in B_OUT_CFG else x for x in o['outputs']]
    body = {k: o[k] for k in ('channelFadeModes', 'channelFadeTimings', 'channelFaceBlurs', 'channelCaptions') if k in o}
    body.update({'baseRevision': o['revision'], 'outputs': new, 'requestId': uuid.uuid4().hex})
    return call('/api/browser-outputs', body)

def settings_patch_from(vals):
    p = {}
    for k, v in vals.items():
        if v is None: continue
        if '.' in k:
            s, f = k.split('.'); p.setdefault('scenes', {}).setdefault(s, {})[f] = v
        else: p[k] = v
    return p

def restore_settings():
    st = state(); cur = snap_settings(st['settings'])
    want = {k: v for k, v in BASE['settings'].items() if cur.get(k) != v}
    p = settings_patch_from(want)
    if p: return action('settings.apply', p, st['settingsRevision'])

# ---------- generators
def fmt(v): return '%g' % v

def gen_valid(n=None):
    rows = [(0, 'scenario', '', f'FUZZ-{a.seed}-{CUR["run"]}')]
    end = rng.randint(8, 25); n = n or rng.randint(4, 15)
    kinds = ['output_source', 'output_visible', 'output_labels', 'output_subtitles', 'output_fade', 'output_fade_sec', 'output_face_blur', 'output_blur_px',
             'distance', 'presence', 'tone', 'one_shot', 'prompt', 'pause', 'resume', 'empty_person', 'note']
    times = [rng.randint(0, end - 1) for _ in range(n)]
    if n > 3 and rng.random() < .6: times[1] = times[0]
    for t in times:
        k = rng.choice(kinds); s = rng.choice(SCREENS)
        if k == 'output_source': r = (t, k, s, rng.choice(['now', 'a', 'b', 'c', 'actual-past', 'generated-history']))
        elif k in ('output_visible', 'output_labels', 'output_subtitles', 'output_face_blur'): r = (t, k, s, rng.choice(['true', 'false']))
        elif k == 'output_fade': r = (t, k, s, rng.choice(['original', 'crossfade', 'none']))
        elif k == 'output_fade_sec': r = (t, k, s, fmt(round(rng.uniform(0, 3), 1)))
        elif k == 'output_blur_px': r = (t, k, s, str(rng.randint(0, 40)))
        elif k == 'distance': r = (t, k, rng.choice('ABC'), str(rng.randint(-600, 600)))
        elif k in ('presence', 'tone'): r = (t, k, rng.choice(['', 'A', 'B', 'C']), fmt(round(rng.random(), 2)))
        elif k in ('one_shot', 'prompt'): r = (t, k, rng.choice('ABC'), rng.choice(['a quiet room', 'fuzz test text', '静かな部屋']))
        elif k in ('pause', 'resume'): r = (t, k, '', '')
        elif k == 'empty_person': r = (t, k, '', fmt(round(rng.random(), 2)))
        else: r = (t, k, '', 'fuzz note')
        rows.append(r)
    rows.append((end, 'end', '', ''))
    rows.sort(key=lambda r: r[0])
    return rows, end


JA={'output_source':'映す画像','output_visible':'表示/非表示','output_labels':'ラベル','output_subtitles':'字幕','output_fade':'フェード方式','output_fade_sec':'フェード秒',
    'output_face_blur':'顔ぼかし','output_blur_px':'ぼかし強さ','distance':'時間距離','presence':'Presence','tone':'Tone','one_shot':'One shot 指示','prompt':'Continuous 指示',
    'pause':'一時停止','resume':'再開','empty_person':'無人時の人物確率','note':'メモ'}
def describe(rows, end, kind):
    import collections
    c=collections.Counter(JA.get(r[1],r[1]) for r in rows if r[1] not in ('scenario','end'))
    same=len([r for r in rows if r[1] not in ('scenario','end')])-len({r[0] for r in rows if r[1] not in ('scenario','end')})
    parts=', '.join(f'{k}×{n}' for k,n in c.most_common())
    return f'{kind}: {end}秒のシナリオ / {parts}' + (f' / 同じ秒に重なる行 {same}' if same>0 else '')

def to_csv(rows, nl='\n'):
    def q(c):
        c = str(c); return '"' + c.replace('"', '""') + '"' if any(ch in c for ch in ',"\n') else c
    return nl.join(['seconds,action,target,value'] + [','.join(q(c) for c in r) for r in rows]) + nl

E5 = (5, 'end', '', '')
BROKEN = [
 ('unknown_action', True, lambda: to_csv([(0, 'explode', 'screen-9', 'x'), E5])),
 ('bad_target_99', True, lambda: to_csv([(0, 'output_source', 'screen-99', 'a'), E5])),
 ('bad_target_D', True, lambda: to_csv([(0, 'distance', 'D', '10'), E5])),
 ('range_distance', True, lambda: to_csv([(0, 'distance', 'A', '99999'), E5])),
 ('range_presence', True, lambda: to_csv([(0, 'presence', '', '7'), E5])),
 ('range_blur', True, lambda: to_csv([(0, 'output_blur_px', 'screen-9', '500'), E5])),
 ('nonnumeric_sec', True, lambda: to_csv([('abc', 'output_visible', 'screen-9', 'true'), E5])),
 ('negative_sec', True, lambda: to_csv([(-5, 'output_visible', 'screen-9', 'true'), E5])),
 ('missing_end', False, lambda: to_csv([(0, 'output_visible', 'screen-9', 'true')])),
 ('empty_value', True, lambda: to_csv([(0, 'output_source', 'screen-9', ''), E5])),
 ('extra_column', False, lambda: 'seconds,action,target,value\n0,output_visible,screen-9,true,EXTRA\n5,end,,\n'),
 ('bom', False, lambda: '﻿' + to_csv([(0, 'output_visible', 'screen-9', 'true'), E5])),
 ('crlf', False, lambda: to_csv([(0, 'output_visible', 'screen-9', 'true'), E5], '\r\n')),
 ('japanese_note', False, lambda: to_csv([(0, 'note', '', '日本語のメモ　テスト'), E5])),
 ('long_text', False, lambda: to_csv([(0, 'prompt', 'A', 'x' * 200000), E5])),
 ('long_note', False, lambda: to_csv([(0, 'note', '', 'あ' * 5000), E5])),
 ('empty_file', True, lambda: ''),
 ('header_only', False, lambda: 'seconds,action,target,value\n'),
 ('binary_junk', True, lambda: '\x00\x01\x02,,,\n\xff\xfe'),
 ('bad_bool', True, lambda: to_csv([(0, 'output_visible', 'screen-9', 'maybe'), E5])),
 ('bad_fade', True, lambda: to_csv([(0, 'output_fade', 'screen-9', 'wipe'), E5])),
 ('huge_time', False, lambda: to_csv([(0, 'note', '', 'x'), (1e9, 'end', '', '')])),
 ('nan_time', True, lambda: to_csv([('nan', 'note', '', 'x'), E5])),
 ('dup_end', False, lambda: to_csv([(0, 'note', '', 'x'), E5, (6, 'end', '', '')])),
 ('csv_quote_break', True, lambda: 'seconds,action,target,value\n0,note,,"unterminated\n5,end,,\n'),
]

def upload(name, text):
    return call('/api/td-control/scenario-upload', {'csv': {'name': name, 'text': text}, 'assets': []}, timeout=20)

def wait_idle(maxs=45):
    t0 = time.time()
    while time.time() - t0 < maxs:
        sc = state().get('scenario', {})
        if not sc.get('ownsLayout') and sc.get('state') not in ('running', 'paused'): return True
        time.sleep(1)
    return False

def check_restore(pre, label, skip_settings=(), hold=None):
    time.sleep(1.5)
    post = snap()
    for s in SCREENS:
        if post['screens'].get(s) != pre['screens'].get(s):
            viol(3, f'{label}: {s} not restored: before {pre["screens"].get(s)} after {post["screens"].get(s)}')
    for k, v in pre['settings'].items():
        if k in skip_settings: continue
        pv = post['settings'].get(k)
        if pv != v and not (isinstance(v, (int, float)) and isinstance(pv, (int, float)) and abs(pv - v) < 1e-6):
            viol(3, f'{label}: setting {k} not restored: before {v} after {pv}')
    want_hold = pre['hold'] if hold is None else hold
    if post['hold'] != want_hold: viol(3, f'{label}: submissionHold expected {want_hold} (before {pre["hold"]}) after {post["hold"]}')
    return post

def force_clean():
    action('scenario.stop'); wait_idle(15)
    restore_outputs(); restore_settings()
    if state().get('submissionHold') != BASE['hold']:
        action('generation.pause' if BASE['hold'] else 'generation.resume')

class ErrWatch:
    def __init__(self):
        self.base = {json.dumps(e, sort_keys=True) for e in (state().get('errors') or [])}; self.first = {}
    def poll(self, st):
        now = time.time(); cur = {json.dumps(e, sort_keys=True): e for e in (st.get('errors') or [])}
        for k, e in cur.items():
            if k not in self.base: self.first.setdefault(k, (now, e))
        for k in list(self.first):
            if k not in cur: del self.first[k]
    def report(self, label):
        for k, (t, e) in self.first.items():
            if time.time() - t > 15: viol(4, f'{label}: new persistent error {e}')
            self.base.add(k)

OUTKEY = {'output_source': 'source', 'output_visible': 'visible', 'output_labels': 'labels', 'output_subtitles': 'subtitles', 'output_fade': 'fadeMode',
          'output_face_blur': 'faceBlur', 'output_blur_px': 'blurPx', 'output_fade_sec': 'fadeDurationMs'}
SETKEY = {'distance': 'distanceSec', 'presence': 'presence', 'tone': 'tone'}

def expectations(rows):
    ex = []
    for t, act, tgt, val in rows:
        if act in OUTKEY:
            k = OUTKEY[act]
            v = val == 'true' if k in ('visible', 'labels', 'subtitles', 'faceBlur') else int(val) if k == 'blurPx' else int(round(float(val) * 1000)) if k == 'fadeDurationMs' else val
            ex.append((float(t), ('screens', tgt, k), v, f'{t}s {act} {tgt} {val}'))
        elif act in SETKEY:
            key = f'{tgt.lower()}.{SETKEY[act]}' if tgt else SETKEY[act]
            ex.append((float(t), ('settings', key), float(val), f'{t}s {act} {tgt} {val}'))
    out = []
    for i, e in enumerate(ex):
        if any(f[1] == e[1] and e[0] <= f[0] < e[0] + 3.5 for f in ex[i + 1:]): continue
        out.append(e)
    return out

def val_at(s, path):
    cur = s
    for p in path: cur = cur.get(p) if isinstance(cur, dict) else None
    return cur

def eq(x, w):
    if isinstance(w, float): return isinstance(x, (int, float)) and abs(x - w) < 1e-6
    return x == w

stats = {'A': 0, 'B': 0, 'C': 0}; T_START = time.time()

def start_scenario(rows, name, nl='\n'):
    up = upload(name, to_csv(rows, nl))
    if up[0] >= 400 or not (up[1] or {}).get('file') or (up[1] or {}).get('ok') is False:
        viol('A-upload', f'valid scenario refused: HTTP {up[0]} {up[2][:300]}', csv=to_csv(rows)); return False
    l = action('scenario.load', {'file': up[1]['file']})
    if l[0] >= 400 or (l[1] or {}).get('ok') is False:
        viol('A-load', f'valid scenario load refused: HTTP {l[0]} {l[2][:300]}', csv=to_csv(rows)); return False
    return True

def run_A():
    rows, end = gen_valid(); csvtext = to_csv(rows)
    log('plan', summary=describe(rows, end, '通常シナリオ'), csv=csvtext)
    pre = snap(); ew = ErrWatch()
    if not start_scenario(rows, f'fuzz-{a.seed}-{CUR["run"]}.csv'): return
    p = action('scenario.play')
    if p[0] >= 400: viol('A-play', f'play refused {p[2][:200]}', csv=csvtext)
    t0 = time.time(); tl = []; ended = None; cap_bad = False
    while time.time() - t0 < end + 12:
        st = state(); o = outs(); s = snap(st, o); el = time.time() - t0
        tl.append((el, s)); ew.poll(st)
        if s['phase'] in ('requested', 'generating') and s['scn'].get('ownsLayout') and pre['phase'] not in ('requested', 'generating') and not cap_bad:
            cap_bad = True; viol(6, f'capture phase {s["phase"]} at {el:.1f}s during no-mode scenario', csv=csvtext)
        if el > 2 and not s['scn'].get('ownsLayout') and ended is None: ended = el
        if ended is not None and el > ended + 3: break
        time.sleep(0.6)
    if ended is None:
        viol(2, f'scenario still owns layout {end + 12}s after play (end row {end}s)', csv=csvtext); force_clean(); return
    if ended > end + 10: viol(2, f'ended late {ended:.1f}s vs end {end}', csv=csvtext)
    last = tl[-1][1]['scn']
    if last.get('state') in ('running', 'paused'): viol(2, f'state {last.get("state")} after ownsLayout false', csv=csvtext)
    for t, path, want, desc in expectations(rows):
        seen = [el for el, s in tl if t - 1 <= el <= t + 3 and eq(val_at(s, path), want)]
        if not seen and t + 3 < ended + 0.1:
            viol(5, f'row not observed within 3s: {desc} (saw {[val_at(s, path) for el, s in tl if t - 1 <= el <= t + 3][:4]})', csv=csvtext)
    time.sleep(1); ew.poll(state()); ew.report('A')
    cues = [r[1] for r in rows if r[1] in ('pause', 'resume') and r[0] < end]
    check_restore(pre, 'A', hold=(cues[-1] == 'pause') if cues else False)  # spec: natural end enables generation unless CSV's last cue is pause
    force_clean()

def run_B():
    pre = snap(); file_before = pre['scn'].get('file')
    name, must, mk = rng.choice(BROKEN); text = mk()
    log('plan', summary=f'壊れたCSV: {name}（{"弾かれるべき" if must else "受け付けてよい"}）', csv=text[:2000])
    CUR['ops'].append('broken:' + name)
    up = upload(f'fuzzb-{a.seed}-{CUR["run"]}.csv', text)
    accepted = up[0] < 300 and (up[1] or {}).get('ok') is not False and bool((up[1] or {}).get('file'))
    log('broken', name=name, code=up[0], accepted=accepted, resp=up[2][:300])
    if must and accepted: viol('B-accepted', f'broken CSV "{name}" accepted by upload (HTTP {up[0]})', csv=text[:600])
    if accepted:
        l = action('scenario.load', {'file': up[1]['file']})
        if must and l[0] < 300 and (l[1] or {}).get('ok') is not False:
            viol('B-load-accepted', f'broken CSV "{name}" loaded OK', csv=text[:600])
    if rng.random() < .3:
        for raw in (b'{not json', b'[]', b'{"csv":{"name":"../../evil.csv","text":"a"},"assets":[]}', b'{"csv":null}'):
            c = call('/api/td-control/scenario-upload', raw=raw)
            log('rawupload', code=c[0], resp=c[2][:150])
    if B_FILE:
        r = action('scenario.load', {'file': B_FILE})
        if r[0] >= 400: viol('B-usable', f'reloading baseline scenario failed HTTP {r[0]} {r[2][:200]}')
    st = state().get('scenario', {})
    if B_FILE and st.get('file') != file_before: viol('B-usable', f'loaded file now {st.get("file")} expected {file_before}')
    if st.get('ownsLayout'): viol(2, 'ownsLayout true after broken upload/load only')
    check_restore(pre, 'B')

def run_C():
    rows, end = gen_valid(rng.randint(6, 12)); csvtext = to_csv(rows)
    log('plan', summary=describe(rows, end, '再生中の連打操作つき'), csv=csvtext)
    rows2, _ = gen_valid(5)
    pre = snap(); ew = ErrWatch()
    if not start_scenario(rows, f'fuzzc-{a.seed}-{CUR["run"]}.csv'): return
    other = upload(f'fuzzc2-{a.seed}-{CUR["run"]}.csv', to_csv(rows2))[1] or {}
    action('scenario.play')
    t0 = time.time(); touched = set()
    while time.time() - t0 < end + 4:
        time.sleep(rng.uniform(0.3, 2.0))
        c = rng.choice(['pause', 'resume', 'stop', 'play', 'load', 'settings', 'input', 'double', 'dblstop'])
        if c == 'pause': action('scenario.pause')
        elif c in ('resume', 'play'): action('scenario.play')
        elif c == 'stop': action('scenario.stop')
        elif c == 'double': action('scenario.play'); action('scenario.play')
        elif c == 'dblstop': action('scenario.stop'); action('scenario.stop')
        elif c == 'load' and other.get('file'): action('scenario.load', {'file': other['file']})
        elif c == 'settings':
            st = state(); k = rng.choice(['presence', 'tone', 'a.distanceSec', 'b.distanceSec', 'c.presence'])
            v = round(rng.random(), 2) if 'distance' not in k else rng.randint(-600, 600)
            action('settings.apply', settings_patch_from({k: v}), st.get('settingsRevision')); touched.add(k)
        elif c == 'input': action('input.select', {'setId': rng.choice(['TSC-001', 'TSC-002', 'TSC-003', 'cycle', 'camera'])})
        ew.poll(state())
    action('scenario.stop')
    if not wait_idle(15): viol(2, 'scenario not idle 15s after final stop', csv=csvtext)
    time.sleep(1); ew.poll(state()); ew.report('C')
    post = snap()
    if post['scn'].get('ownsLayout'): viol(2, 'ownsLayout true after storm + stop', csv=csvtext)
    check_restore(pre, 'C', skip_settings=touched)
    action('input.select', {'setId': B_INPUT})
    force_clean()
    cur = snap()
    for k, v in BASE['settings'].items():
        if v is not None and cur['settings'].get(k) != v: viol('C-restore', f'could not restore setting {k}: {cur["settings"].get(k)} vs {v}')

try:
    for i in range(1, a.runs + 1):
        if time.time() - T_START > a.budget_min * 60: log('budget_stop', at=i); break
        CUR.update(run=i, type=rng.choice(list(a.types)), ops=[])
        t = CUR['type']; stats[t] += 1; log('run_start', type=t); t0 = time.time()
        try: {'A': run_A, 'B': run_B, 'C': run_C}[t]()
        except Exception as e:
            viol('script', f'exception {e!r}'); log('trace', tb=traceback.format_exc())
        log('run_end', type=t, sec=round(time.time() - t0, 1)); print(f'run {i}/{a.runs} {t} {time.time() - t0:.0f}s violations={len(VIOL)}', flush=True)
finally:
    CUR.update(run=0, type='restore', ops=[])
    action('scenario.stop'); wait_idle(15)
    ro = restore_outputs(); log('restore_outputs', code=ro[0])
    restore_settings()
    action('input.select', {'setId': B_INPUT})
    if B_FILE: action('scenario.load', {'file': B_FILE})
    if state().get('submissionHold') != BASE['hold']: action('generation.pause' if BASE['hold'] else 'generation.resume')
    time.sleep(1.5); fin = snap(); problems = []
    for s in SCREENS:
        if fin['screens'].get(s) != BASE['screens'].get(s): problems.append(f'{s}: {BASE["screens"].get(s)} -> {fin["screens"].get(s)}')
    for k, v in BASE['settings'].items():
        if fin['settings'].get(k) != v: problems.append(f'setting {k}: {v} -> {fin["settings"].get(k)}')
    if fin['hold'] != BASE['hold']: problems.append(f'hold {BASE["hold"]} -> {fin["hold"]}')
    if fin['scn'].get('file') != B_STATE['scenario'].get('file'): problems.append(f'scenario file {B_STATE["scenario"].get("file")} -> {fin["scn"].get("file")}')
    if fin['scn'].get('state') in ('running', 'paused'): problems.append(f'scenario state {fin["scn"].get("state")}')
    st = state(); inp = 'remote-device' if (st.get('remoteCamera') or {}).get('selected') else 'cycle' if (st.get('replay') or {}).get('cycle') else (st.get('replay') or {}).get('setId') or 'camera'
    if inp != B_INPUT: problems.append(f'input selection {B_INPUT} -> {inp}')
    md = [f'# Scenario fuzz {STAMP} (seed {a.seed})', '', f'- runs: A(valid)={stats["A"]} B(broken)={stats["B"]} C(storm)={stats["C"]}',
          f'- violations: {len(VIOL)}', f'- baseline restore: {"OK" if not problems else "DIFFERENCES"}']
    md += [f'  - {p}' for p in problems]
    md += ['', '## Violations', '']
    for v in VIOL:
        md += [f'### run {v["run"]} type {v["type"]} invariant {v["invariant"]}', '', v['msg'], '']
        if v.get('csv'): md += ['```csv', v['csv'][:1500], '```']
        if v['ops']: md += ['ops:', '```', '\n'.join(v['ops'][-15:]), '```']
    pathlib.Path(OUTDIR / f'{STAMP}.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print('SUMMARY', OUTDIR / f'{STAMP}.md', 'violations', len(VIOL), 'restore', 'OK' if not problems else problems)
