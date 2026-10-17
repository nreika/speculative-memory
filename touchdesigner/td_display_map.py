# -*- coding: utf-8 -*-
"""
Output map: which image (A / B / C / NOW) goes to which output window (DISPLAY 1..4).

A Script TOP (/project1/display_map_top) draws the map with OpenCV every frame, from
window1..4 par.winop (set by td_display_integration shuffle() / reset_layout()):
A / B / C / NOW down the left, DISPLAY 1..4 down the right, one coloured link each
(left to right). A DISPLAY label is bright when its window is open, dim when it is
closed. The picture is shown by the panel container /project1/ui_root/display_map,
under the WORLD PARAMETER frame (above the link status line, left of the NOW image).

This DAT is file-synced (td_display_map.py); it lives at /project1/td_display_map
and is also the Script TOP's callbacks DAT. build() creates both (idempotent).
"""

import numpy

ROOT = '/project1'
TOP_NAME = 'display_map_top'
PANEL_PARENT = '/project1/ui_root'
PANEL_NAME = 'display_map'
PANEL_GEOMETRY = (8, 166, 268, 102)       # ui_root coordinates, origin bottom-left
RES_W, RES_H = 536, 204                   # 2x the panel for crisp lines

SOURCES = (('display_a', 'A', (1.00, 0.62, 0.26)),
           ('display_b', 'B', (0.93, 0.36, 0.58)),
           ('display_c', 'C', (0.30, 0.65, 1.00)),
           ('display_now', 'NOW', (0.92, 0.92, 0.92)))
WINDOWS = ('window1', 'window2', 'window3', 'window4')

SRC_RIGHT = 84                            # source labels end here (right-aligned)
LINE_LEFT, LINE_RIGHT = 100, 330
DST_LEFT = 346                            # DISPLAY labels start here


def _row_y(index):
    return int(RES_H * (index + 0.5) / 4.0)


def mapping():
    """[(window index 0..3, source index 0..3 or None, is_open)]."""
    names = [s[0] for s in SOURCES]
    out = []
    for i, w in enumerate(WINDOWS):
        node = op(ROOT + '/' + w)
        if node is None:
            out.append((i, None, False))
            continue
        source = str(node.par.winop.eval() or '').rstrip('/').split('/')[-1]
        out.append((i, names.index(source) if source in names else None, bool(node.isOpen)))
    return out


def _bgr(rgb, scale=1.0):
    return tuple(int(255 * c * scale) for c in reversed(rgb))


def _text(img, label, x, cy, color, scale=0.8, align='left'):
    import cv2
    (w, h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
    left = x - w if align == 'right' else x
    cv2.putText(img, label, (int(left), int(cy + h / 2)), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)


def draw():
    import cv2
    img = numpy.zeros((RES_H, RES_W, 4), dtype=numpy.uint8)
    img[:, :, 3] = 255
    for i, (_name, label, rgb) in enumerate(SOURCES):
        _text(img, label, SRC_RIGHT, _row_y(i), _bgr(rgb) + (255,), 0.8, 'right')
    for wi, si, is_open in mapping():
        color = (235, 235, 235, 255) if is_open else (110, 110, 110, 255)
        _text(img, 'DISPLAY {}'.format(wi + 1), DST_LEFT, _row_y(wi), color, 0.7)
        if si is not None:
            cv2.line(img, (LINE_LEFT, _row_y(si)), (LINE_RIGHT, _row_y(wi)),
                     _bgr(SOURCES[si][2], 1.0 if is_open else 0.6) + (255,), 3, cv2.LINE_AA)
    # cv2 is BGRA top-down; TouchDesigner wants RGBA bottom-up
    rgba = img[::-1, :, [2, 1, 0, 3]]
    return numpy.ascontiguousarray(rgba)


# --- Script TOP callbacks -----------------------------------------------------

def onSetupParameters(scriptOp):
    return


def onCook(scriptOp):
    _ = absTime.frame        # cook every frame (follows shuffle / reset / window open)
    scriptOp.copyNumpyArray(draw())
    _report_if_changed()
    return


# --- display log: tell the server which image went to which DISPLAY ----------------
#
# Whenever the assignment (window1..4 winop), a window's open state, or the displayed
# capture (td_capture_listener BATCH_STATE, once ready) changes, POST
#   <Serverurl>/api/display-log
#   {captureId, at, reason: 'batch' | 'layout' | 'window', assignments: [
#       {display: 1, window: 'window1', source: 'display_b', scene: 'gen_b', open: false}, ...]}
# on a worker thread. The server adds it to logs/capture-events.jsonl. Failures are
# printed once per kind and never interrupt the drawing.

LISTENER_PATH = '/project1/td_capture_listener'
DISPLAY_LOG_PATH = '/api/display-log'
SOURCE_TO_SCENE = {'display_a': 'gen_a', 'display_b': 'gen_b', 'display_c': 'gen_c', 'display_now': 'now'}
_R = {'sig': None, 'layout': None, 'open': None, 'capture': None, 'warned': set()}


def _server():
    par = getattr(op(ROOT).par, 'Serverurl', None)
    value = str(par.eval()).strip() if par is not None else ''
    return (value or 'http://127.0.0.1:3000').rstrip('/')


def _shown_capture():
    module = getattr(op(LISTENER_PATH), 'module', None)
    batch = getattr(module, 'BATCH_STATE', None) or {}
    return str(batch.get('captureId') or '') if batch.get('isReady') else ''


def assignments():
    names = [s[0] for s in SOURCES]
    out = []
    for wi, si, is_open in mapping():
        source = names[si] if si is not None else ''
        out.append({'display': wi + 1, 'window': WINDOWS[wi], 'source': source,
                    'scene': SOURCE_TO_SCENE.get(source, ''), 'open': is_open})
    return out


def _post(url, payload):
    """Worker thread (no TD API)."""
    import json
    from urllib.request import Request, urlopen
    try:
        req = Request(url, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
        with urlopen(req, timeout=5) as response:
            response.read()
    except Exception as exc:
        kind = type(exc).__name__ + str(getattr(exc, 'code', ''))
        if kind not in _R['warned']:
            _R['warned'].add(kind)
            print('[TD Display Map] display-log not stored ({}): {}'.format(kind, exc))


def _report_if_changed():
    try:
        rows = assignments()
        layout = tuple(r['source'] for r in rows)
        opened = tuple(r['open'] for r in rows)
        capture = _shown_capture()
        sig = (layout, opened, capture)
        if sig == _R['sig']:
            return
        first = _R['sig'] is None
        reason = 'batch' if capture != _R['capture'] else 'layout' if layout != _R['layout'] else 'window'
        _R.update({'sig': sig, 'layout': layout, 'open': opened, 'capture': capture})
        if first or not capture:
            return              # start-up / nothing shown yet: nothing to log
        from datetime import datetime
        import threading
        payload = {'captureId': capture, 'at': datetime.now().astimezone().isoformat(timespec='seconds'),
                   'reason': reason, 'assignments': rows}
        threading.Thread(target=_post, args=(_server() + DISPLAY_LOG_PATH, payload), daemon=True).start()
    except Exception as exc:
        if 'report' not in _R['warned']:
            _R['warned'].add('report')
            print('[TD Display Map] display-log skipped: {}'.format(exc))


# --- setup ----------------------------------------------------------------------

def build():
    root = op(ROOT)
    top = root.op(TOP_NAME) or root.create(scriptTOP, TOP_NAME)
    top.par.callbacks = ROOT + '/td_display_map'
    top.par.outputresolution = 'custom'
    top.par.resolutionw, top.par.resolutionh = RES_W, RES_H
    me_dat = root.op('td_display_map')
    if me_dat is not None:
        top.nodeX, top.nodeY = me_dat.nodeX + 200, me_dat.nodeY

    parent = op(PANEL_PARENT)
    panel = parent.op(PANEL_NAME) or parent.create(containerCOMP, PANEL_NAME)
    panel.par.hmode = panel.par.vmode = 'fixed'
    panel.par.x, panel.par.y, panel.par.w, panel.par.h = PANEL_GEOMETRY
    panel.par.top = top.path
    panel.par.topfill = 'best'
    panel.par.bgalpha = 1.0
    panel.par.bgcolorr = panel.par.bgcolorg = panel.par.bgcolorb = 0.0
    panel.par.display = True
    panel.nodeX, panel.nodeY = 3400, -1500
    return panel.path
