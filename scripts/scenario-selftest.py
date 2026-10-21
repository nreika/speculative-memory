"""Scenario self-test: runs one scenario CSV on the live server and checks it without Claude.

Usage (main PC, repo root):
  python scripts/scenario-selftest.py scripts/operator-scenario/examples/SCN-TEST-NOGEN-001.csv
  python scripts/scenario-selftest.py <csv> --base http://127.0.0.1:3000 --slack 3

What it does
  1. Saves a baseline (screen outputs, generation settings, scenario id).
  2. Uploads the CSV, loads it and presses Play (same API as MAIN).
  3. Polls every second until the scenario ends (or end time + 60 s).
  4. For every output_* / distance / presence / tone row, checks the value was seen within --slack seconds of its time.
  5. After the end, checks outputs and settings are back to the baseline.
  6. Writes a Markdown report to logs/scenario-selftest/<time>_<scenario>.md and prints a one-line verdict.
A scenario without a "mode" row does not generate images, so it uses no GPU and no LLM.
"""
import csv, json, sys, time, uuid, argparse, pathlib, datetime, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('csv'); ap.add_argument('--base', default='http://127.0.0.1:3000'); ap.add_argument('--slack', type=float, default=3.0)
a = ap.parse_args()
H = {'X-Control-Request': '1', 'Content-Type': 'application/json', 'Origin': a.base}
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def call(path, body=None):
    req = urllib.request.Request(a.base + path, data=None if body is None else json.dumps(body).encode(), headers=H, method='GET' if body is None else 'POST')
    with op.open(req, timeout=30) as r: return json.load(r)

def action(name, data=None):
    return call('/api/td-control/action', {'action': name, 'data': data or {}, 'requestId': uuid.uuid4().hex})

def snapshot():
    st = call('/api/td-control/state'); outs = call('/api/browser-outputs')
    screens = {o['id']: {'source': o.get('source'), 'visible': o.get('visible'), 'labels': o.get('labels'), 'subtitles': o.get('subtitles'),
                         'fadeMode': o.get('fadeMode'), 'faceBlur': (o.get('faceBlur') or {}).get('enabled')} for o in outs['outputs']}
    s = st['settings']; sc = s.get('scenes', {})
    settings = {'presence': s.get('presence'), 'tone': s.get('tone'), 'mode': s.get('mode'), 'intervalSec': s.get('intervalSec'),
                **{f'{k.upper()}.{f}': sc.get(k, {}).get(f) for k in 'abc' for f in ('distanceSec', 'presence', 'tone')}}
    return {'screens': screens, 'settings': settings, 'scenario': st.get('scenario', {}), 'hold': st.get('submissionHold'), 'phase': st['capture']['phase']}

rows = list(csv.DictReader(open(a.csv, encoding='utf-8-sig')))
end_at = max((float(r['seconds']) for r in rows if r['action'] == 'end'), default=max(float(r['seconds']) for r in rows))
OUT = {'output_source': ('source', str), 'output_visible': ('visible', lambda v: v.lower() == 'true'), 'output_labels': ('labels', lambda v: v.lower() == 'true'),
       'output_subtitles': ('subtitles', lambda v: v.lower() == 'true'), 'output_fade': ('fadeMode', str), 'output_face_blur': ('faceBlur', lambda v: v.lower() == 'true')}
SET = {'distance': 'distanceSec', 'presence': 'presence', 'tone': 'tone'}
expect = []
for r in rows:
    t, act, tgt, val = float(r['seconds']), r['action'], (r['target'] or '').strip(), (r['value'] or '').strip()
    if act in OUT: expect.append((t, f'{tgt}.{OUT[act][0]}', ('screens', tgt, OUT[act][0]), OUT[act][1](val)))
    elif act in SET:
        key = f'{tgt.upper()}.{SET[act]}' if tgt else SET[act]
        expect.append((t, key, ('settings', key), float(val)))

base = snapshot()
text = open(a.csv, encoding='utf-8-sig').read(); name = pathlib.Path(a.csv).name
up = call('/api/td-control/scenario-upload', {'csv': {'name': name, 'text': text}, 'assets': []})
action('scenario.load', {'file': up['file']}); action('scenario.play')
t0 = time.time(); timeline = []; ended_at = None
while time.time() - t0 < end_at + 60:
    snap = snapshot(); el = time.time() - t0; timeline.append((el, snap))
    if el > 2 and not snap['scenario'].get('ownsLayout') and ended_at is None: ended_at = el
    if ended_at is not None and el > ended_at + 4: break
    time.sleep(1)

def value(snap, path):
    cur = snap
    for p in path: cur = (cur or {}).get(p)
    return cur

checks = []
for t, label, path, want in expect:
    seen = [el for el, s in timeline if t - 1 <= el <= t + a.slack and value(s, path) is not None and (abs(value(s, path) - want) < 1e-6 if isinstance(want, float) else value(s, path) == want)]
    checks.append((t, label, want, bool(seen), round(seen[0] - t, 1) if seen else None))
final = timeline[-1][1]
restore = []
for kind in ('screens', 'settings'):
    for k, v in base[kind].items():
        if final[kind].get(k) != v: restore.append(f'{kind}.{k}: before {v} / after {final[kind].get(k)}')
ok_rows = sum(1 for c in checks if c[3]); ended_ok = ended_at is not None and abs(ended_at - end_at) <= a.slack + 2
verdict = 'PASS' if ok_rows == len(checks) and not restore and ended_ok else 'FAIL'
outdir = pathlib.Path('logs/scenario-selftest'); outdir.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now().strftime('%Y-%m-%d_%H-%M-%S'); report = outdir / f'{stamp}_{name}.md'
lines = [f'# Scenario self-test {verdict}: {name}', '', f'- started {stamp}, end row at {end_at:.0f} s, scenario ended at {ended_at if ended_at is None else round(ended_at,1)} s',
         f'- timed rows matched: {ok_rows}/{len(checks)}', f'- restore after end: {"OK" if not restore else str(len(restore)) + " differences"}', '',
         '| time | target | expected | seen | delay s |', '|---|---|---|---|---|']
lines += [f'| {t:.0f} | {l} | {w} | {"yes" if s else "NO"} | {d if d is not None else "-"} |' for t, l, w, s, d in checks]
if restore: lines += ['', '## Not restored', ''] + [f'- {x}' for x in restore]
report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(f'{verdict}  rows {ok_rows}/{len(checks)}  restore {"OK" if not restore else len(restore)}  ended {"OK" if ended_ok else "NO"}  report {report}')
