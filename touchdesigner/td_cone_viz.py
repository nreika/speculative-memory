# -*- coding: utf-8 -*-
"""
"FUTURE CONE VISUALIZATION" for the Perform panel (/project1/ui_root).

A small live diagram under the heading in ui_root. Every generated scene has
its own SIGNED temporal distance in seconds (-600 .. +600; negative = past,
positive = future), so any mix is possible (three futures, two pasts and one
future, ...).

  * NOW stays in the centre of the time axis and shows the captured frame.
  * A scene with a negative distance sits on the LEFT, a positive one on the
    RIGHT. The horizontal offset grows with |distance| on a log-like scale:
        f = log(|d| / 5 s) / log(120)          (0 at 5 s, 1 at 10 min)
        x = NOW +- (95 + 105 * f) px           (95 px keeps 5 s clear of NOW)
  * Scenes on the same side are separated vertically so thumbnails never
    overlap: 1 scene at the axis, 2 scenes +-40 px, 3 scenes +72 / 0 / -72 px
    (order A, B, C from top to bottom).
  * Colours: A orange, B pink, C blue. Labels read like "A +30 s", "C -2 m".
  * LIVE: thumbnail positions, branch lines and labels follow the CURRENT
    slider values (/project1 Distancea/b/c) at all times. td_scene_distance
    calls refresh() from its parameter callback (immediate); the 150-500 ms
    tick is the fallback. The distance the displayed image was really
    generated with (capture.saved payload; while generating, what
    td_native_capture sent) stays visible but secondary: when it differs from
    the live value a small dim second label line "撮影時 -30 s" is added.
  * The strip at the bottom is a plain time axis (-10 m .. NOW .. +10 m) using
    the same log-like x mapping as the thumbnails.
  * While a generation runs, branches stay dim/empty (pulsing) until their
    image arrives from the server, then fill in. Images are shown as soon as
    the server reports them (td_capture_listener buffers them for the main
    display until the set is complete; this panel reads that buffer).

Everything lives in the container /project1/ui_root/cone_viz (created by
build(), idempotent): a GLSL TOP draws the lines/frames/scales, four Movie
File In TOPs hold the thumbnails (shown through small containers), Text COMPs
hold the labels. A 150-500 ms self-rescheduling loop (tick) updates it; per
tick it only reads a few dict values and writes parameters whose value
changed.

Source of the state: /project1/td_native_capture (phase, currentId,
sentDistances) and /project1/td_capture_listener (PENDING / SCENE_STATES). The
live controls are the custom pars Distancea / Distanceb / Distancec /
Presence / Tone on /project1 (page "Scene", driven by the sliders).

This DAT is file-synced (touchdesigner/td_cone_viz.py); it lives at
/project1/ui_root/cone_viz/script.
"""

import math
import os
import tempfile
import time

ROOT_PATH = '/project1/ui_root'
VIZ_NAME = 'cone_viz'
SETTINGS_PATH = '/project1'
CONTROLLER_PATH = '/project1/td_native_capture'
LISTENER_PATH = '/project1/td_capture_listener'
RECORD_TOP_PATH = '/project1/Record_t1'
GEN_TOP_PATHS = {'a': '/project1/Gen_a', 'b': '/project1/Gen_b', 'c': '/project1/Gen_c'}
SCENE_KEYS = {'a': 'gen_a', 'b': 'gen_b', 'c': 'gen_c'}   # server sceneKey per branch
DISTANCE_PARS = {'a': 'Distancea', 'b': 'Distanceb', 'c': 'Distancec'}
DEFAULT_DISTANCES = {'a': 30, 'b': 30, 'c': -30}
KEYS = ('a', 'b', 'c')
MINUS = u'−'
COLORS = {'a': (1.00, 0.62, 0.26), 'b': (0.93, 0.36, 0.58), 'c': (0.30, 0.65, 1.00)}

# Free area under the "FUTURE CONE VISUALIZATION" heading (ui_root coordinates,
# origin bottom-left). 2026-10-16 layout: the cone frame spans x 281..1276, y 420..688
# (heading at y 658), between the narrowed LIVE CAMERA / WORLD PARAMETER column on the
# left and the right edge; the output images sit in a row below it (y 284..416).
# Horizontal spread (X_*) and vertical layout (AXIS_Y, SLOT_OFFSETS, thumbnails) are
# scaled separately to fill that wide area. The shader takes X_NEAR / X_FAR from here.
VIZ_X, VIZ_Y, VIZ_W, VIZ_H = 288, 424, 980, 228
THUMB_W, THUMB_H = 72, 40
CX = VIZ_W / 2.0
AXIS_Y = 120.0           # height of NOW / the time axis inside the panel
X_NEAR, X_FAR = 200.0, 420.0   # thumbnail offset from NOW for 5 s and for 10 min
LANE_Y = 22.0            # plain time axis strip at the bottom
LANE_HALF = X_FAR
SUB_H = 11
MIN_ABS, MAX_ABS = 5.0, 600.0
LABEL_W = 90
SLOT_OFFSETS = {1: (0.0,), 2: (36.0, -36.0), 3: (58.0, 0.0, -58.0)}

IDLE_MS, ACTIVE_MS = 500, 150
SHADER = '''// Future cone: axis, branches, thumbnail frames, bottom time axis. Pixel coordinates, y up.
uniform vec4 uNow;   // x, y of NOW; z, w: thumbnail half width / half height
uniform vec4 uS0;    // scene A: x, y, brightness 0..1 (dim until the image arrives), w: 1 if used
uniform vec4 uS1;    // scene B
uniform vec4 uS2;    // scene C
uniform vec4 uLane;  // x: axis centre x, y: axis y, z: axis half length, w: NOW brightness
out vec4 fragColor;

float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float line(vec2 p, vec2 a, vec2 b, float w) { return 1.0 - smoothstep(w - 0.7, w + 0.7, seg(p, a, b)); }
float frame(vec2 p, vec2 c, vec2 hs, float w) {
  vec2 d = abs(p - c) - hs;
  float o = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  return 1.0 - smoothstep(w - 0.7, w + 0.7, abs(o));
}

void main() {
  vec2 res = uTDOutputInfo.res.zw;
  vec2 p = vUV.xy * res;
  vec2 now = uNow.xy;
  vec2 th = uNow.zw;
  vec3 cA = vec3(1.00, 0.62, 0.26);
  vec3 cB = vec3(0.93, 0.36, 0.58);
  vec3 cC = vec3(0.30, 0.65, 1.00);
  vec3 col = vec3(0.0);

  // time axis through NOW with ticks at 5 s and 10 min on both sides
  float xf = __X_FAR__, xn = __X_NEAR__;
  col = mix(col, vec3(0.55), line(p, vec2(now.x - xf, now.y), vec2(now.x + xf, now.y), 0.6) * 0.30);
  for (int i = 0; i < 2; i++) {
    float x = (i == 0) ? xn : xf;
    float h = (i == 0) ? 4.0 : 7.0;
    col = mix(col, vec3(0.55), line(p, vec2(now.x - x, now.y - h), vec2(now.x - x, now.y + h), 0.6) * 0.45);
    col = mix(col, vec3(0.55), line(p, vec2(now.x + x, now.y - h), vec2(now.x + x, now.y + h), 0.6) * 0.45);
  }

  // branches (dim until their image arrives); uS*.w = 0 hides an unused branch
  float a0 = mix(0.22, 1.0, uS0.z) * uS0.w;
  float a1 = mix(0.22, 1.0, uS1.z) * uS1.w;
  float a2 = mix(0.22, 1.0, uS2.z) * uS2.w;
  col = mix(col, cA, line(p, now, uS0.xy, 1.5) * a0);
  col = mix(col, cB, line(p, now, uS1.xy, 1.5) * a1);
  col = mix(col, cC, line(p, now, uS2.xy, 1.3) * a2);

  // frames around the thumbnails
  col = mix(col, cA, frame(p, uS0.xy, th + 1.5, 1.0) * a0);
  col = mix(col, cB, frame(p, uS1.xy, th + 1.5, 1.0) * a1);
  col = mix(col, cC, frame(p, uS2.xy, th + 1.5, 1.0) * a2);
  col = mix(col, vec3(0.92), frame(p, now, th + 1.5, 1.0) * mix(0.35, 1.0, uLane.w));

  // plain time axis at the bottom: same x mapping as the thumbnails
  // (ticks at 5, 10, 30, 60, 120, 300, 600 s on both sides, NOW tick in the middle)
  vec2 lc = uLane.xy;
  float lh = uLane.z;
  col = mix(col, vec3(0.5), line(p, vec2(lc.x - lh, lc.y), vec2(lc.x + lh, lc.y), 0.5) * 0.30);
  col = mix(col, vec3(0.7), line(p, vec2(lc.x, lc.y - 5.0), vec2(lc.x, lc.y + 5.0), 0.6) * 0.55);
  float tk[7] = float[7](0.0, 0.1448, 0.3743, 0.5191, 0.6638, 0.8552, 1.0);
  for (int i = 0; i < 7; i++) {
    float dx = xn + (xf - xn) * tk[i];
    float hh = (i == 0 || i == 3 || i == 6) ? 4.5 : 2.5;
    col = mix(col, vec3(0.5), line(p, vec2(lc.x - dx, lc.y - hh), vec2(lc.x - dx, lc.y + hh), 0.5) * 0.40);
    col = mix(col, vec3(0.5), line(p, vec2(lc.x + dx, lc.y - hh), vec2(lc.x + dx, lc.y + hh), 0.5) * 0.40);
  }

  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
'''

_S = {
    'cur': None,                 # captureId this panel currently shows
    'filled': {'a': False, 'b': False, 'c': False},
    'cap': {'a': None, 'b': None, 'c': None},   # signed seconds each branch was generated with (None = unknown)
    'paths': {},                 # last file set per branch ('now', 'a', 'b', 'c')
    'last': {},                  # last values written to parameters (change detection)
    'loop': None,
}
_LOOP_TOKEN = '{:.6f}'.format(time.time())


def _debug(message):
    print('[TD Cone Viz] {}'.format(message))


# --- distances / geometry --------------------------------------------------------

def normalize_distance(value):
    """Signed seconds clamped like the server request: |d| in 5..600, sign kept, 0 -> +5."""
    try:
        value = float(value)
    except Exception:
        value = 0.0
    sign = -1.0 if value < 0 else 1.0
    return sign * max(MIN_ABS, min(MAX_ABS, abs(value)))


def payload_distance(payload, key):
    """Signed distance of one capture.saved payload, or None when it carries none.

    New servers send distanceSigned: true and a signed distanceSec; old ones an
    unsigned N for all three images (gen_c = past). td_capture_listener already
    stores the result as payload['distanceSecSigned']; this is the fallback.
    """
    if not isinstance(payload, dict):
        return None
    value = payload.get('distanceSecSigned')
    if value is None:
        raw = payload.get('distanceSec')
        if raw is None:
            return None
        try:
            raw = float(raw)
        except Exception:
            return None
        if payload.get('distanceSigned') is True:
            value = raw
        else:
            is_past = key == 'c' or str(payload.get('sceneKey', '')) in ('gen_c', 'sceneC')
            value = -abs(raw) if is_past else abs(raw)
    try:
        return normalize_distance(value)
    except Exception:
        return None


def read_controls():
    """({a,b,c: live signed seconds}, presence, tone) from /project1, with the defaults."""
    comp = op(SETTINGS_PATH)
    dist = {}
    for key in KEYS:
        value = DEFAULT_DISTANCES[key]
        par = getattr(comp.par, DISTANCE_PARS[key], None) if comp is not None else None
        if par is not None:
            try:
                value = float(par.eval())
            except Exception:
                pass
        dist[key] = normalize_distance(value)
    other = [0.3, 0.3]
    for i, name in enumerate(('Presence', 'Tone')):
        par = getattr(comp.par, name, None) if comp is not None else None
        if par is not None:
            try:
                other[i] = float(par.eval())
            except Exception:
                pass
    return dist, max(0.0, min(1.0, other[0])), max(0.0, min(1.0, other[1]))


def log_fraction(distance):
    """0 at 5 s .. 1 at 10 min (log scale on |distance|)."""
    magnitude = max(MIN_ABS, min(MAX_ABS, abs(float(distance))))
    return math.log(magnitude / MIN_ABS) / math.log(MAX_ABS / MIN_ABS)


def thumb_x(distance):
    sign = -1.0 if float(distance) < 0 else 1.0
    return CX + sign * (X_NEAR + (X_FAR - X_NEAR) * log_fraction(distance))


def layout(distances):
    """Thumbnail centres {key: (x, y)} (+ 'now') for {key: signed seconds}.

    Left side = negative distances, right side = positive. Scenes on one side
    are stacked in the order A, B, C from top to bottom.
    """
    centers = {'now': (CX, AXIS_Y)}
    for negative in (True, False):
        side = [k for k in KEYS if distances.get(k) is not None and (float(distances[k]) < 0) == negative]
        offsets = SLOT_OFFSETS.get(len(side), ())
        for key, dy in zip(side, offsets):
            centers[key] = (thumb_x(distances[key]), AXIS_Y + dy)
    return centers


def format_short(distance):
    """'+30 s', '-2 m', '+1 m 30 s' (real minus sign)."""
    distance = float(distance)
    sign = MINUS if distance < 0 else '+'
    magnitude = abs(distance)
    if magnitude < 60:
        return u'{}{:g} s'.format(sign, round(magnitude, 1))
    minutes, seconds = divmod(int(round(magnitude)), 60)
    return u'{}{} m {} s'.format(sign, minutes, seconds) if seconds else u'{}{} m'.format(sign, minutes)


def format_seconds(sec):
    """Unsigned length ('30 s', '2 min', '1 min 30 s')."""
    sec = int(round(sec))
    if sec >= 60:
        minutes, rest = divmod(sec, 60)
        return '{} min {} s'.format(minutes, rest) if rest else '{} min'.format(minutes)
    return '{} s'.format(sec)


# --- building ------------------------------------------------------------------

def _viz():
    return op('{}/{}'.format(ROOT_PATH, VIZ_NAME))


def _label_specs(centers, shown):
    """{label name: (text, centre x, y, width)} for NOW and the used scenes (live distances)."""
    now_x, now_y = centers['now']
    specs = {'lb_now': ('NOW', now_x, now_y - THUMB_H / 2 - 15, 40)}
    for key in KEYS:
        if key in centers and shown.get(key) is not None:
            x, y = centers[key]
            specs['lb_' + key] = ('{} {}'.format(key.upper(), format_short(shown[key])),
                                  x, y - THUMB_H / 2 - 15, LABEL_W)
    return specs


def build():
    """Create /project1/ui_root/cone_viz and everything in it (idempotent)."""
    root = op(ROOT_PATH)
    if root is None:
        raise ValueError('ui_root not found: ' + ROOT_PATH)
    viz = root.op(VIZ_NAME)
    if viz is None:
        viz = root.create(containerCOMP, VIZ_NAME)
    viz.par.hmode = 'fixed'
    viz.par.vmode = 'fixed'
    viz.par.x, viz.par.y, viz.par.w, viz.par.h = VIZ_X, VIZ_Y, VIZ_W, VIZ_H
    viz.par.align = 'none'
    viz.par.bgcolorr = viz.par.bgcolorg = viz.par.bgcolorb = 0.0
    viz.par.bgalpha = 1.0
    viz.nodeX, viz.nodeY = 0, 0

    # the drawing
    pixel = viz.op('cone_lines_pixel') or viz.create(textDAT, 'cone_lines_pixel')
    pixel.text = SHADER.replace('__X_FAR__', '{:.1f}'.format(X_FAR)).replace('__X_NEAR__', '{:.1f}'.format(X_NEAR))
    glsl = viz.op('cone_lines') or viz.create(glslTOP, 'cone_lines')
    glsl.par.pixeldat = pixel.path
    glsl.par.outputresolution = 'custom'
    glsl.par.resolutionw, glsl.par.resolutionh = VIZ_W, VIZ_H
    glsl.par.format = 'rgba8fixed'
    glsl.seq.vec.numBlocks = 5
    for index, name in enumerate(('uNow', 'uS0', 'uS1', 'uS2', 'uLane')):
        getattr(glsl.par, 'vec{}name'.format(index)).val = name
    viz.par.top = glsl.path
    viz.par.topfill = 'native'

    # thumbnails: movie in -> small container that shows it when filled
    for i, key in enumerate(('now', 'a', 'b', 'c')):
        mv = viz.op('mv_' + key) or viz.create(moviefileinTOP, 'mv_' + key)
        mv.nodeX, mv.nodeY = 200 * i, -200
        th = viz.op('th_' + key) or viz.create(containerCOMP, 'th_' + key)
        th.par.hmode = 'fixed'
        th.par.vmode = 'fixed'
        th.par.w, th.par.h = THUMB_W, THUMB_H
        th.par.bgalpha = 0.0
        th.par.topfill = 'best'
        th.nodeX, th.nodeY = 200 * i, -400

    # labels
    old_label = viz.op('lb_past')
    if old_label is not None:
        old_label.par.display = False       # replaced by lb_c (kept, not deleted)
    for name in ('lb_now', 'lb_a', 'lb_b', 'lb_c', 'lb_sa', 'lb_sb', 'lb_sc', 'lb_status', 'lb_info',
                 'lb_axl', 'lb_axr', 'lb_ax1l', 'lb_ax1r', 'lb_ax5l', 'lb_ax5r', 'lb_axn'):
        lb = viz.op(name) or viz.create(textCOMP, name)
        lb.par.hmode = 'fixed'
        lb.par.vmode = 'fixed'
        lb.par.bgalpha = 0.0
        lb.par.fontsize = 11
        lb.par.fontcolorr = lb.par.fontcolorg = lb.par.fontcolorb = 0.85
        lb.par.alignx = 'center'
        lb.par.aligny = 'center'
        lb.par.wordwrap = False
        lb.par.display = True
    viz.op('lb_status').par.alignx = 'left'
    viz.op('lb_info').par.alignx = 'left'
    viz.op('lb_status').par.fontcolorg = 0.75
    viz.op('lb_status').par.fontcolorb = 0.4
    viz.op('lb_info').par.fontcolorr = viz.op('lb_info').par.fontcolorg = viz.op('lb_info').par.fontcolorb = 0.6
    for key in KEYS:
        lb = viz.op('lb_' + key)
        lb.par.fontcolorr, lb.par.fontcolorg, lb.par.fontcolorb = COLORS[key]
    for key in KEYS:                        # second line "撮影時 ...": small and dim
        lb = viz.op('lb_s' + key)
        lb.par.fontsize = 9
        lb.par.fontcolorr, lb.par.fontcolorg, lb.par.fontcolorb = [0.6 * c for c in COLORS[key]]
    old_next = viz.op('lb_next')
    if old_next is not None:
        old_next.par.display = False        # "next capture" scale removed (kept, not deleted)
    one_min = X_NEAR + (X_FAR - X_NEAR) * 0.5191
    for name, text, dx in (('lb_axl', MINUS + '10 m', -X_FAR), ('lb_ax1l', MINUS + '1 m', -one_min),
                           ('lb_ax5l', MINUS + '5 s', -X_NEAR), ('lb_axn', 'NOW', 0.0),
                           ('lb_ax5r', '+5 s', X_NEAR), ('lb_ax1r', '+1 m', one_min),
                           ('lb_axr', '+10 m', X_FAR)):
        lb = viz.op(name)
        lb.par.text = text
        lb.par.fontsize = 9
        lb.par.fontcolorr = lb.par.fontcolorg = lb.par.fontcolorb = 0.5
        lb.par.alignx = 'center'
        lb.par.w, lb.par.h = 40, 12
        lb.par.x = CX + dx - 20
        lb.par.y = LANE_Y - 19
    _S['last'] = {}
    adopt_existing()
    refresh(force=True)
    start()
    return viz.path


# --- state -----------------------------------------------------------------------

def _controller_module():
    comp = op(CONTROLLER_PATH)
    return comp.module if comp is not None else None


def _listener_module():
    comp = op(LISTENER_PATH)
    return comp.module if comp is not None else None


def _usable(path):
    """An image path the Movie File In can load: an existing file, or an http(s) URL
    (Imagesource=url, server on another PC - the file is not on this disk)."""
    path = str(path or '')
    return path.startswith(('http://', 'https://')) or (bool(path) and os.path.exists(path))


def _set_movie(key, path, force_reload=False):
    viz = _viz()
    mv = viz.op('mv_' + key) if viz is not None else None
    if mv is None:
        return False
    path = path or ''
    if _S['paths'].get(key) != path or force_reload:
        mv.par.file = path
        if path:
            try:
                mv.par.reloadpulse.pulse()
            except Exception:
                pass
        _S['paths'][key] = path
    th = viz.op('th_' + key)
    if th is not None:
        th.par.top = mv.path if path else ''
    return True


def adopt_existing():
    """Show the images that are currently loaded in the main display (and the distances they carry)."""
    for key, top_path in GEN_TOP_PATHS.items():
        top = op(top_path)
        path = str(top.par.file.eval()) if top is not None and hasattr(top.par, 'file') else ''
        has = _usable(path)
        _set_movie(key, path if has else '')
        _S['filled'][key] = has
    rec = op(RECORD_TOP_PATH)
    rec_path = str(rec.par.file.eval()) if rec is not None and hasattr(rec.par, 'file') else ''
    _set_movie('now', rec_path if _usable(rec_path) else '')
    ctl = _controller_module()
    _S['cur'] = ctl._state['currentId'] if ctl is not None else ''
    listener = _listener_module()
    for key in KEYS:
        distance = None
        if _S['filled'][key] and listener is not None:
            try:
                state = listener.SCENE_STATES.get(SCENE_KEYS[key]) or {}
                if state.get('ready'):
                    distance = payload_distance(state.get('payload'), key)
            except Exception:
                distance = None
        _S['cap'][key] = distance


def _frame_path():
    ctl = _controller_module()
    ext = getattr(ctl, 'SAVE_FORMAT', '.jpg') if ctl is not None else '.jpg'
    return os.path.join(tempfile.gettempdir(), 'td_specmem_frame' + ext)


def _arrived(listener, scene_key, capture_id):
    """(image file, payload) of this scene for the current capture; ('', None) while not yet there."""
    if listener is None or not capture_id:
        return '', None
    try:
        pending = listener.PENDING
        if pending.get('captureId') == capture_id and scene_key in pending.get('payloads', {}):
            payload = pending['payloads'][scene_key]
            return listener._resolve_path(
                payload, ('latestImagePath', 'latestImageNormalizedPath', 'absolutePath', 'normalizedPath')), payload
        state = listener.SCENE_STATES.get(scene_key) or {}
        if state.get('ready') and state.get('captureId') == capture_id:
            return state.get('targetPath', ''), state.get('payload')
    except Exception:
        pass
    return '', None


def refresh(force=False):
    """Read pipeline state + controls, update thumbnails, lines and labels."""
    viz = _viz()
    if viz is None:
        return 'idle'
    ctl = _controller_module()
    listener = _listener_module()
    phase = ctl._state['phase'] if ctl is not None else 'idle'
    cid = ctl._state['currentId'] if ctl is not None else ''
    running = phase != 'idle'
    live, presence, tone = read_controls()

    override = _S.get('override')
    if override:
        # preview mode (simulate()): fake phase, arrivals and distances, no pipeline involved
        phase, cid = override['phase'], 'simulated'
        running = phase != 'idle'
        if override.get('live'):
            live = dict(override['live'])
        for key in KEYS:
            want = key in override['filled']
            if want != _S['filled'][key]:
                _set_movie(key, override['paths'].get(key, '') if want else '')
                _S['filled'][key] = want
            _S['cap'][key] = override['dist'].get(key)
    else:
        if cid != _S['cur'] and cid and running:
            # a new capture started: show its captured frame. The branches keep showing
            # the previous images (their frames blink, see 'bright' below) until the new
            # images arrive; until then they use what the request was sent with.
            _S['cur'] = cid
            sent = ctl._state.get('sentDistances') if ctl is not None else None
            for index, key in enumerate(KEYS):
                _S['filled'][key] = False
                _S['cap'][key] = normalize_distance(sent[index]) if sent and len(sent) > index else live[key]
            frame = _frame_path()
            _set_movie('now', frame if os.path.exists(frame) else '', force_reload=True)
        elif cid != _S['cur'] and not running:
            _S['cur'] = cid

        for key in KEYS:
            if not _S['filled'][key] and cid:
                path, payload = _arrived(listener, SCENE_KEYS[key], cid)
                if _usable(path):
                    _set_movie(key, path)
                    _S['filled'][key] = True
                    distance = payload_distance(payload, key)
                    if distance is not None:
                        _S['cap'][key] = distance

    # everything in the figure follows the LIVE slider values; the distance the
    # displayed image was generated with only adds the small "撮影時" line when it differs
    shown = dict(live)
    unknown = [k.upper() for k in KEYS if _S['cap'][k] is None]
    subs = {}
    for key in KEYS:
        cap = _S['cap'][key]
        if cap is not None and abs(cap - live[key]) > 0.5:
            subs[key] = u'撮影時 {}'.format(format_short(cap))
    centers = layout(shown)

    pulse = 0.5 + 0.5 * math.sin(time.time() * 5.0)
    bright = {}
    for key in KEYS:
        if _S['filled'][key]:
            bright[key] = 1.0
        elif running:
            bright[key] = pulse                  # "being made": the frame blinks over the previous image
        else:
            bright[key] = 0.0
    now_bright = 1.0 if (_S['paths'].get('now') or running) else 0.0

    last = _S['last']
    glsl = viz.op('cone_lines')
    vectors = [('now', (CX, AXIS_Y, THUMB_W / 2.0, THUMB_H / 2.0))]
    for key in KEYS:
        x, y = centers.get(key, (0.0, 0.0))
        vectors.append(('s' + key, (round(x, 1), y, round(bright[key], 2), 1.0)))
    vectors.append(('lane', (CX, LANE_Y, LANE_HALF, now_bright)))
    for index, (name, vals) in enumerate(vectors):
        if force or last.get(name) != vals:
            last[name] = vals
            for axis, component in zip('xyzw', vals):
                getattr(glsl.par, 'vec{}value{}'.format(index, axis)).val = component

    # positions of thumbnails and labels (only when the layout changed)
    gkey = tuple(sorted((k, round(v[0], 1), v[1]) for k, v in centers.items())) + tuple(
        (k, shown[k]) for k in KEYS) + tuple(sorted(subs.items()))
    if force or last.get('gkey') != gkey:
        last['gkey'] = gkey
        for key in ('now',) + KEYS:
            th = viz.op('th_' + key)
            if key in centers:
                cx, cy = centers[key]
                th.par.x, th.par.y = cx - THUMB_W / 2.0, cy - THUMB_H / 2.0
                th.par.display = True
            else:
                th.par.display = False
        specs = _label_specs(centers, shown)
        for name in ('lb_now', 'lb_a', 'lb_b', 'lb_c'):
            lb = viz.op(name)
            if name in specs:
                text, cx, y, w = specs[name]
                lb.par.text = text
                lb.par.w, lb.par.h = w, 14
                lb.par.x, lb.par.y = cx - w / 2.0, y
                lb.par.display = True
            else:
                lb.par.display = False
        for key in KEYS:
            lb = viz.op('lb_s' + key)
            if key in subs and key in centers:
                cx, cy = centers[key]
                lb.par.text = subs[key]
                lb.par.w, lb.par.h = LABEL_W, SUB_H
                lb.par.x, lb.par.y = cx - LABEL_W / 2.0, cy - THUMB_H / 2.0 - 15 - SUB_H
                lb.par.display = True
            else:
                lb.par.display = False

    filled = sum(1 for k in KEYS if _S['filled'][k])
    if phase == 'requested':
        status = 'SENDING FRAME ...'
    elif phase == 'generating':
        status = 'GENERATING  {}/3'.format(filled) if filled else 'GENERATING  (planning) 0/3'
    else:
        status = 'idle' if not cid else 'last capture  {}/3'.format(filled)
    if unknown:
        info = 'captured: {} unknown   presence {:.2f}   tone {:.2f}'.format(
            '/'.join(unknown), presence, tone)
    else:
        info = 'captured  ' + '   '.join('{} {}'.format(k.upper(), format_short(_S['cap'][k])) for k in KEYS) + \
            '     presence {:.2f}  tone {:.2f}'.format(presence, tone)
    if force or last.get('status') != status:
        last['status'] = status
        lb = viz.op('lb_status')
        lb.par.text = status
        lb.par.w, lb.par.h, lb.par.x, lb.par.y = 300, 14, 6, VIZ_H - 18
    if force or last.get('info') != info:
        last['info'] = info
        lb = viz.op('lb_info')
        lb.par.text = info
        lb.par.w, lb.par.h, lb.par.x, lb.par.y = 480, 14, 6, VIZ_H - 33
    return phase


def simulate(phase=None, filled=(), distances=None, live=None):
    """Preview without a capture: simulate('generating', ('c', 'a')) / simulate() to end it.

    phase: 'requested' | 'generating' | 'idle'; filled: branches whose image has arrived
    (shown with the images currently loaded in Gen_a/Gen_b/Gen_c).
    distances: {'a': 30, 'b': 30, 'c': -30} or [a, b, c] = what the images were generated with;
    live: the slider settings to draw (default: the real parameters).
    """
    if phase is None:
        _S['override'] = None
        adopt_existing()
    else:
        paths = {}
        for key, top_path in GEN_TOP_PATHS.items():
            top = op(top_path)
            paths[key] = str(top.par.file.eval()) if top is not None else ''
        if distances is None:
            distances = dict(DEFAULT_DISTANCES)
        if not isinstance(distances, dict):
            distances = dict(zip(KEYS, distances))
        if live is not None and not isinstance(live, dict):
            live = dict(zip(KEYS, live))
        _S['override'] = {'phase': phase, 'filled': tuple(filled), 'paths': paths,
                          'dist': {k: normalize_distance(v) for k, v in distances.items()},
                          'live': {k: normalize_distance(v) for k, v in live.items()} if live else None}
    return refresh(force=True)


# --- loop ------------------------------------------------------------------------

def _schedule(ms):
    try:
        run("m = op({!r}).module if op({!r}) else None\nm._tick({!r}) if m else None".format(
            me.path, me.path, _LOOP_TOKEN), delayMilliSeconds=ms)
    except Exception as exc:
        _debug('could not schedule the loop: {}'.format(exc))


def _tick(token):
    if token != _LOOP_TOKEN:
        return              # an older version of this module: let it end
    phase = 'idle'
    try:
        phase = refresh()
    except Exception as exc:
        _debug('refresh failed: {}'.format(exc))
    _schedule(IDLE_MS if phase == 'idle' else ACTIVE_MS)


def start():
    """(Re)start the update loop; a reloaded module takes over from the old one."""
    _schedule(100)
    return _LOOP_TOKEN


# A reload of this DAT (file sync) refreshes the panel when it already exists.
try:
    if op('{}/{}'.format(ROOT_PATH, VIZ_NAME)) is not None and op('{}/{}/cone_lines'.format(ROOT_PATH, VIZ_NAME)) is not None:
        run('m = op({!r}).module\nm.adopt_existing()\nm.refresh(force=True)\nm.start()'.format(me.path), delayFrames=3)
except Exception as _exc:
    _debug('not started: {}'.format(_exc))
