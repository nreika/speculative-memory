# -*- coding: utf-8 -*-
"""
Two-PC link status on the operator panel: メインPC / ComfyUI / Ollama.

Three small Text COMPs in /project1/link_status (above the SHOW / HIDE / SHUFFLE /
RESET buttons). Every POLL_SECONDS a worker thread checks
  メインPC  GET <Serverurl>/api/capture/status        (Node server on the main PC)
  ComfyUI   GET <Serverurl>/api/health -> {comfyui: bool}  (the server reaches ComfyUI
            on its own PC; ComfyUI listens on 127.0.0.1 only, so the laptop cannot)
  Ollama    GET http://127.0.0.1:11434/api/tags        (this PC)
and the main thread colours the labels: green = OK, red = down, grey = unknown
(e.g. the server has no /api/health yet).

This DAT is file-synced (td_link_status.py); it lives at /project1/td_link_status.
build() creates the panel and starts polling (idempotent); start() restarts polling.
"""

import json
import threading
from urllib.request import Request, urlopen

ROOT = '/project1'
PANEL_NAME = 'link_status'
PANEL_GEOMETRY = (8, 136, 268, 26)       # /project1 pixels, origin bottom-left
DEFAULT_SERVER = 'http://127.0.0.1:3000'
OLLAMA_URL = 'http://127.0.0.1:11434/api/tags'
POLL_SECONDS = 5.0
TIMEOUT = 3.0
ITEMS = (('main', u'メインPC'), ('comfy', u'ComfyUI'), ('ollama', u'Ollama'))
COLORS = {True: (0.35, 0.85, 0.45), False: (1.0, 0.35, 0.35), None: (0.5, 0.5, 0.5)}
MARK = {True: u'●', False: u'×', None: u'?'}

_S = {'result': {'main': None, 'comfy': None, 'ollama': None}, 'busy': False, 'run': None, 'token': 0}


def _server():
    par = getattr(op(ROOT).par, 'Serverurl', None)
    value = str(par.eval()).strip() if par is not None else ''
    return (value or DEFAULT_SERVER).rstrip('/')


def _get(url):
    with urlopen(Request(url), timeout=TIMEOUT) as response:
        return response.status if hasattr(response, 'status') else 200, response.read()


def _check(server):
    """Worker thread (no TD API)."""
    result = {'main': False, 'comfy': None, 'ollama': False}
    try:
        code, _ = _get(server + '/api/capture/status')
        result['main'] = code == 200
    except Exception:
        result['main'] = False
    if result['main']:
        try:
            code, raw = _get(server + '/api/health')
            body = json.loads(raw.decode('utf-8'))
            value = body.get('comfyui')
            if isinstance(value, dict):
                value = value.get('ok', value.get('reachable'))
            result['comfy'] = bool(value) if value is not None else None
        except Exception:
            result['comfy'] = None       # no /api/health (yet) or not JSON
    try:
        code, _ = _get(OLLAMA_URL)
        result['ollama'] = code == 200
    except Exception:
        result['ollama'] = False
    _S['result'] = result
    _S['busy'] = False


def _render():
    panel = op(ROOT).op(PANEL_NAME)
    if panel is None:
        return
    for key, label in ITEMS:
        t = panel.op(key)
        if t is None:
            continue
        state = _S['result'].get(key)
        text = u'{} {}'.format(label, MARK[state])
        if t.par.text.eval() != text:
            t.par.text = text
        r, g, b = COLORS[state]
        t.par.fontcolorr, t.par.fontcolorg, t.par.fontcolorb = r, g, b


def tick(token):
    """Main thread, every POLL_SECONDS: draw the last result and start the next check."""
    if token != _S['token']:
        return                           # an older loop after start() / a reload
    _render()
    if not _S['busy']:
        _S['busy'] = True
        threading.Thread(target=_check, args=(_server(),), daemon=True).start()
    _S['run'] = run("op({!r}).module.tick({})".format(ROOT + '/td_link_status', token),
                    delayMilliSeconds=int(POLL_SECONDS * 1000))


def start():
    _S['token'] += 1
    _S['busy'] = False
    tick(_S['token'])
    return 'polling every {:g}s'.format(POLL_SECONDS)


def status():
    return dict(_S['result'])


def build():
    root = op(ROOT)
    panel = root.op(PANEL_NAME) or root.create(containerCOMP, PANEL_NAME)
    x, y, w, h = PANEL_GEOMETRY
    panel.par.hmode = panel.par.vmode = 'fixed'
    panel.par.x, panel.par.y, panel.par.w, panel.par.h = x, y, w, h
    panel.par.bgalpha = 0.0
    panel.par.display = True
    cost = root.op('cost_display')
    font = cost.par.font.eval() if cost is not None else 'Yu Gothic UI'
    size = cost.par.fontsize.eval() if cost is not None else 14
    if cost is not None:
        panel.nodeX, panel.nodeY = cost.nodeX, cost.nodeY - 150
    cw = w / float(len(ITEMS))
    for i, (key, label) in enumerate(ITEMS):
        t = panel.op(key) or panel.create(textCOMP, key)
        t.par.hmode = t.par.vmode = 'fixed'
        t.par.x, t.par.y, t.par.w, t.par.h = int(i * cw), 0, int(cw), h
        t.par.font = font
        t.par.fontsize = size
        t.par.alignx = 'left'
        t.par.aligny = 'center'
        t.par.textpaddingl = 0 if i == 0 else 4
        t.par.bgalpha = 0.0
        t.par.editmode = 'locked'
        t.par.text = u'{} {}'.format(label, MARK[None])
        t.nodeX, t.nodeY = i * 200, 0
    start()
    return panel.path


# Restart polling shortly after this DAT is (re)loaded (e.g. when the .toe opens).
try:
    run("op({!r}).module.start() if op({!r}) is not None else None".format(
        ROOT + '/td_link_status', ROOT + '/' + PANEL_NAME), delayFrames=5)
except Exception:
    pass
