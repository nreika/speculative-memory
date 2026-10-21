"""Resident face-box worker (2026-10-21): the one-shot detector (browser-face-boxes.py) costs ~1 s per image, almost all of it Python +
OpenCV start-up, and every new screen image waited for it (slow-response ~1000 ms on the screens). This wrapper keeps one process alive
and runs the SAME one-shot script body for every request line, so the detection result is identical.
Protocol: one JSON line {"image": "<base64>"} in, one JSON line out (the one-shot script's output). argv[1] = path of the one-shot script."""
import sys, io, json, types

script = sys.argv[1]
code = compile(open(script, encoding='utf-8').read(), script, 'exec')
real_in, real_out = sys.stdin.buffer, sys.stdout
ERROR = json.dumps({'status': 'error', 'boxes': []})
while True:
    line = real_in.readline()
    if not line:
        break
    if not line.strip():
        continue
    captured = io.StringIO()
    old_in, old_out = sys.stdin, sys.stdout
    sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(line))
    sys.stdout = captured
    try:
        exec(code, {'__name__': '__main__', '__file__': script})
    except SystemExit:
        pass
    except Exception:
        captured.write(ERROR)
    finally:
        sys.stdin, sys.stdout = old_in, old_out
    lines = [l for l in captured.getvalue().splitlines() if l.strip()]
    real_out.write((lines[-1] if lines else ERROR) + '\n')
    real_out.flush()
