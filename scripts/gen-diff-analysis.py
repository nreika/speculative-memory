"""How much does a generated scene differ from its NOW frame? Reads the saved generations (no server, no generation, no paid API).
For every scene with a saved NOW.jpg and image it computes the mean absolute grayscale difference (320x180) and the share of
pixels that changed by more than 25 levels, grouped by Tone band, Presence band, input set and time distance.
Usage: python scripts/gen-diff-analysis.py [--days 2026-10-21,2026-10-20] [--montage OUTDIR]
Montage (NOW | A | B | C per capture) is written to the given directory (people photos: keep it in speculative-memory_data/experiments)."""
import argparse, glob, json, os, re, sys, statistics
import cv2, numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--root', default=r'C:/Users/nmrei/GitHub/speculative-memory_data/generations')
ap.add_argument('--days', default='2026-10-21')
ap.add_argument('--montage', default='')
ap.add_argument('--extremes', default='')  # dir: NOW | scene side by side for the 3 biggest and 3 smallest diffs
ap.add_argument('--since', default='')  # e.g. 2026-10-21_12-00-00
a = ap.parse_args()

def gray(path):
    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    return None if img is None else cv2.resize(img, (320, 180), interpolation=cv2.INTER_AREA).astype(np.int16)

def band(t):
    return 'CALM<.15' if t < .15 else 'QUIET<.45' if t < .45 else 'LIVELY<.75' if t < .75 else 'BIG>=.75'

def pband(p):
    return 'P<.35' if p < .35 else 'P<.6' if p < .6 else 'P>=.6'

rows = []
for day in a.days.split(','):
    for pj in sorted(glob.glob(os.path.join(a.root, day, '*', '*_prompts.json'))):
        gid = os.path.basename(pj)[:-len('_prompts.json')]
        if a.since and gid < a.since: continue
        try: j = json.load(open(pj, encoding='utf-8'))
        except Exception: continue
        folder = os.path.dirname(pj)
        now = gray(os.path.join(folder, gid + '_NOW.jpg'))
        if now is None: continue
        prm = j.get('params') or {}
        st, sp = prm.get('sceneTone') or {}, prm.get('scenePresence') or {}
        m = re.match(r'(?:test-)?(TSC-\d+)', str(j.get('captureId', '')))
        sset = m.group(1) if m else 'live'
        for sc in j.get('scenes', []):
            f = sc.get('file')
            if not f or sc.get('skipped'): continue
            out = gray(os.path.join(folder, f))
            if out is None: continue
            d = np.abs(out - now)
            key = sc['sceneKey']
            tone = st.get(key, prm.get('tone', .3)); pres = sp.get(key, prm.get('presence', .3))
            rows.append(dict(gid=gid, set=sset, scene=key, tone=float(tone), presence=float(pres), dist=sc.get('distanceSec'),
                             mad=float(d.mean()), changed=float((d > 25).mean()), file=os.path.join(folder, f), now=os.path.join(folder, gid + '_NOW.jpg')))

def table(title, keyf):
    groups = {}
    for r in rows: groups.setdefault(keyf(r), []).append(r)
    print(f'\n== {title}')
    for k in sorted(groups):
        g = groups[k]
        print(f'{str(k):28s} n={len(g):4d}  mean abs diff {statistics.mean(x["mad"] for x in g):6.2f}  changed>25 {100*statistics.mean(x["changed"] for x in g):5.1f}%')

print(f'scenes analysed: {len(rows)}')
table('by Tone band', lambda r: band(r['tone']))
table('by Presence band', lambda r: pband(r['presence']))
table('by Tone band x Presence band', lambda r: band(r['tone']) + ' ' + pband(r['presence']))
table('by input set', lambda r: r['set'])
table('by input set x Tone band', lambda r: r['set'] + ' ' + band(r['tone']))
table('by time distance (s)', lambda r: r['dist'])

if a.montage:
    os.makedirs(a.montage, exist_ok=True)
    by = {}
    for r in rows: by.setdefault(r['gid'], []).append(r)
    done = 0
    for gid, g in sorted(by.items(), reverse=True):
        if len(g) < 3: continue
        tiles = [cv2.resize(cv2.imdecode(np.fromfile(g[0]['now'], dtype=np.uint8), 1), (480, 270))]
        for r in sorted(g, key=lambda x: x['scene'])[:3]:
            im = cv2.resize(cv2.imdecode(np.fromfile(r['file'], dtype=np.uint8), 1), (480, 270))
            cv2.putText(im, f"{r['scene']} T{r['tone']:.2f} P{r['presence']:.2f} d{r['mad']:.1f}", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 255, 255), 2)
            tiles.append(im)
        cv2.putText(tiles[0], f"NOW {g[0]['set']} {gid}", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 255, 255), 2)
        cv2.imencode('.jpg', np.hstack(tiles))[1].tofile(os.path.join(a.montage, f'{gid}_{g[0]["set"]}.jpg'))
        done += 1
        if done >= 12: break
    print(f'\nmontages written: {done} -> {a.montage}')

if a.extremes and rows:
    os.makedirs(a.extremes, exist_ok=True)
    ordered = sorted(rows, key=lambda r: r['mad'])
    for tag, picks in (('small', ordered[:3]), ('big', ordered[-3:][::-1])):
        for i, r in enumerate(picks, 1):
            n = cv2.resize(cv2.imdecode(np.fromfile(r['now'], dtype=np.uint8), 1), (640, 360))
            x = cv2.resize(cv2.imdecode(np.fromfile(r['file'], dtype=np.uint8), 1), (640, 360))
            cv2.putText(n, 'NOW ' + r['set'], (8, 28), cv2.FONT_HERSHEY_SIMPLEX, .8, (0, 255, 255), 2)
            cv2.putText(x, f"{r['scene']} T{r['tone']:.2f} P{r['presence']:.2f} diff {r['mad']:.1f}", (8, 28), cv2.FONT_HERSHEY_SIMPLEX, .8, (0, 255, 255), 2)
            cv2.imencode('.jpg', np.hstack([n, x]))[1].tofile(os.path.join(a.extremes, f"{tag}{i}_{r['gid']}_{r['scene']}.jpg"))
    print('extremes written ->', a.extremes)
