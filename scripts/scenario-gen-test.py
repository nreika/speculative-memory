"""Generation scenario check (type G) on the live server. Uses local backends only (no paid API). Images=1.
Usage: python scripts/scenario-gen-test.py --kind timer|chain [--end 150] [--interval 45]
Writes logs/scenario-fuzz/<stamp>-G.json and prints a summary. Restores nothing itself except pausing generation at the end."""
import json, time, uuid, argparse, copy, pathlib, datetime, urllib.request, urllib.error
ap = argparse.ArgumentParser(); ap.add_argument('--kind', default='timer'); ap.add_argument('--end', type=int, default=150)
ap.add_argument('--interval', type=int, default=45); ap.add_argument('--text', default='人物が両手を上げる'); ap.add_argument('--dist', type=int, default=-90); ap.add_argument('--tone', default='')
a = ap.parse_args()
B = 'http://127.0.0.1:3000'; H = {'X-Control-Request': '1', 'Content-Type': 'application/json', 'Origin': B}
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path, body=None, timeout=30):
    req = urllib.request.Request(B + path, None if body is None else json.dumps(body).encode(), H, method='GET' if body is None else 'POST')
    try:
        with op.open(req, timeout=timeout) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, {'raw': e.read().decode('utf-8', 'replace')[:300]}
def act(n, d=None, base=None):
    b = {'action': n, 'data': d or {}, 'requestId': uuid.uuid4().hex}
    if base: b['baseRevision'] = base
    return call('/api/td-control/action', b)
st = lambda: call('/api/td-control/state')[1]
def outs(): return {x['id']: x for x in call('/api/browser-outputs')[1]['outputs'] if x['id'] in ('screen-9', 'screen-10')}
s0 = st(); o0 = copy.deepcopy(outs()); settings0 = copy.deepcopy(s0['settings'])
assert s0['submissionHold'] is True, 'pause generation first'
assert settings0['imageCount'] == 1 and settings0['vlmBackend'] == 'local' and settings0['imageBackend'] == 'local', settings0
q = lambda t: '"' + t + '"' if (',' in t or '"' in t) else t
rows = [(0, 'scenario', '', f'G-{a.kind}'), (0, 'mode', '', a.kind)]
if a.kind == 'timer': rows.append((0, 'interval_sec', '', str(a.interval)))
rows += [(1, 'resume', '', ''), (2, 'one_shot', 'A', a.text), (2, 'output_source', 'screen-9', 'a'), (a.end // 2, 'distance', 'A', str(a.dist)), (a.end, 'end', '', '')]
if a.tone: rows.insert(-1, (3, 'tone', 'A', a.tone))
csv = 'seconds,action,target,value\n' + ''.join(f'{t},{k},{g},{q(v)}\n' for t, k, g, v in rows)
print(csv)
up = call('/api/td-control/scenario-upload', {'csv': {'name': f'gen-{a.kind}-{int(time.time())}.csv', 'text': csv}, 'assets': []})
assert up[0] < 400, up
print('load', act('scenario.load', {'file': up[1]['file']})[0])
start_iso = datetime.datetime.utcnow().isoformat()
t0 = time.time(); print('play', act('scenario.play')[0])
tl = []
while time.time() - t0 < a.end + 200:
    s = st(); sc = s['scenario']; tl.append({'el': round(time.time() - t0, 1), 'own': sc.get('ownsLayout'), 'scn': sc.get('elapsedSec'), 'phase': s['capture']['phase'], 'cid': s['capture']['captureId'],
        'a': s['settings']['scenes']['a']['distanceSec'], 'oneShot': s['settings']['scenes']['a']['oneShot'], 'mode': s['settings']['mode'], 'hold': s['submissionHold'], 's9': outs()['screen-9']['source']})
    if time.time() - t0 > 5 and not sc.get('ownsLayout') and s['capture']['phase'] == 'idle': break
    time.sleep(2)
time.sleep(3); s1 = st(); o1 = outs()
ev = [json.loads(l) for l in open('logs/capture-events.jsonl', encoding='utf-8') if l.strip()]
ev = [e for e in ev if (e.get('startedAt') or '') >= start_iso and e.get('result')]
out = {'csv': csv, 'timeline': tl, 'events': ev, 'settings_before': settings0, 'settings_after': s1['settings'], 'hold_after': s1['submissionHold'],
       'outputs_same': {k: o0[k] == o1[k] for k in o0}, 'errors': s1.get('errors')}
pathlib.Path('logs/scenario-fuzz').mkdir(parents=True, exist_ok=True)
fn = f'logs/scenario-fuzz/{datetime.datetime.now():%Y-%m-%d_%H-%M-%S}-G.json'; pathlib.Path(fn).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
print('settings restored:', {k: (settings0[k], s1['settings'][k]) for k in settings0 if settings0[k] != s1['settings'][k]})
print('hold after', s1['submissionHold'], 'outputs same', out['outputs_same'], 'errors', s1.get('errors')); print(act('generation.pause')[0], 'file', fn)
for e in ev: print(e.get('captureId'), e.get('startedAt'), e.get('result'), e.get('executionSource'), (e.get('skipReason') or e.get('errorMessage') or ''))
