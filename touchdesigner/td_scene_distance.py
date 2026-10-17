# -*- coding: utf-8 -*-
"""
Per-scene TEMPORAL DISTANCE controls on the Perform panel (WORLD PARAMETER).

Each generated scene has its own signed distance in seconds, -600 .. +600
(negative = past, positive = future). Real state = the custom parameters
Distancea / Distanceb / Distancec on /project1 (page "Scene"); defaults
+30 / +30 / -30 (= the old single FUTURE DISTANCE N: A +N, B +N, C -N).

  scene a (gen_a, orange)  <-> slider1          <-> Distancea
  scene b (gen_b, pink)    <-> slider_dist_b    <-> Distanceb
  scene c (gen_c, blue)    <-> slider_dist_c    <-> Distancec

(slider4 / slider5 are NOT used here: they drive the output fade length
 (slider4 -> select2 -> math3 -> timer3 length) and brightness (slider5 -> math2).)

Slider mapping (symmetric, log-like): the slider centre (u = 0.5) is the sign
boundary. With t = 2 * (u - 0.5):  |d| = 5 s * 120 ** |t|  (centre -> 5 s,
ends -> 600 s), sign = - for u < 0.5, + otherwise; then snapped to tidy values:
5 s steps below 60 s, 10 s steps up to 180 s, 30 s steps above.

Both directions are kept in sync by the Parameter Execute DAT
/project1/scene_distance_exec (td_scene_distance_exec.py): moving a slider
writes the (snapped) parameter, and setting the parameter from Python moves
the slider knob. A guard flag stops the echo. The value text next to every
slider (/project1/dist_val_a|b|c) reads like "+30 s  FUTURE" or
"-2 m 00 s  PAST".

The old Futuredistance parameter stays as a legacy value; no slider drives it.

This DAT is file-synced (touchdesigner/td_scene_distance.py);
it lives at /project1/td_scene_distance.

Every Distance* change also calls refresh() of the cone figure
(ui_root/cone_viz/script), so the figure follows the sliders immediately.
"""

import math

SETTINGS_PATH = '/project1'
KEYS = ('a', 'b', 'c')
PAR_NAMES = {'a': 'Distancea', 'b': 'Distanceb', 'c': 'Distancec'}
SLIDER_PATHS = {'a': '/project1/slider1', 'b': '/project1/slider_dist_b', 'c': '/project1/slider_dist_c'}
VALUE_PATHS = {'a': '/project1/dist_val_a', 'b': '/project1/dist_val_b', 'c': '/project1/dist_val_c'}
DEFAULTS = {'a': 30.0, 'b': 30.0, 'c': -30.0}
MIN_ABS = 5.0
MAX_ABS = 600.0
RATIO = MAX_ABS / MIN_ABS     # 120: |d| runs 5 .. 600 s over half the slider

CONE_SCRIPT_PATH = '/project1/ui_root/cone_viz/script'

MINUS = u'−'              # real minus sign, same as the cone / text panels

_sync = {'busy': False}


# --- pure helpers ----------------------------------------------------------------

def clamp_distance(value):
    """|d| >= 5 (sign kept, 0 -> +5), |d| <= 600."""
    value = float(value)
    sign = -1.0 if value < 0 else 1.0
    return sign * max(MIN_ABS, min(MAX_ABS, abs(value)))


def snap_abs(magnitude):
    """5 s steps below 1 min, 10 s steps up to 3 min, 30 s steps above."""
    magnitude = float(magnitude)
    if magnitude < 60.0:
        step = 5.0
    elif magnitude <= 180.0:
        step = 10.0
    else:
        step = 30.0
    return max(MIN_ABS, min(MAX_ABS, round(magnitude / step) * step))


def slider_to_distance(u):
    u = max(0.0, min(1.0, float(u)))
    t = abs(2.0 * (u - 0.5))
    magnitude = snap_abs(MIN_ABS * RATIO ** t)
    return -magnitude if u < 0.5 else magnitude


def distance_to_slider(distance):
    d = clamp_distance(distance)
    t = math.log(abs(d) / MIN_ABS) / math.log(RATIO)
    # at least 0.005 away from the centre so that -5 s and +5 s sit on their own side of the sign boundary
    return 0.5 + (0.5 if d >= 0 else -0.5) * max(0.005, min(1.0, t))


def format_signed(distance):
    """'+30 s', '-2 m 00 s' (real minus), '+10 m 00 s'."""
    distance = float(distance)
    sign = MINUS if distance < 0 else '+'
    magnitude = abs(distance)
    if magnitude < 60.0:
        return u'{}{:g} s'.format(sign, round(magnitude, 1))
    minutes = int(magnitude // 60)
    seconds = int(round(magnitude - 60 * minutes))
    if seconds == 60:
        minutes, seconds = minutes + 1, 0
    return u'{}{} m {:02d} s'.format(sign, minutes, seconds)


def word(distance):
    return 'PAST' if float(distance) < 0 else 'FUTURE'


def format_value(distance):
    return u'{}  {}'.format(format_signed(distance), word(distance))


# --- parameters / widgets ---------------------------------------------------------

def _par(key):
    comp = op(SETTINGS_PATH)
    return getattr(comp.par, PAR_NAMES[key], None) if comp is not None else None


def get_distance(key):
    par = _par(key)
    try:
        return float(par.eval())
    except Exception:
        return DEFAULTS[key]


def set_distance(key, seconds):
    """Set a scene distance from Python (also moves the slider and the text)."""
    par = _par(key)
    if par is None:
        raise ValueError('parameter missing: ' + PAR_NAMES[key])
    par.val = float(seconds)
    sync_widgets(key)
    return get_distance(key)


def reset_defaults():
    for key in KEYS:
        set_distance(key, DEFAULTS[key])


def sync_widgets(key):
    """Parameter -> slider knob + value text (never writes the parameter)."""
    distance = get_distance(key)
    slider = op(SLIDER_PATHS[key])
    if slider is not None:
        target = distance_to_slider(distance)
        if abs(float(slider.par.value0.eval()) - target) > 0.0005:
            _sync['busy'] = True
            try:
                slider.par.value0 = target
            finally:
                _sync['busy'] = False
    text = op(VALUE_PATHS[key])
    if text is not None:
        shown = format_value(distance)
        if text.par.text.eval() != shown:
            text.par.text = shown


def refresh_all():
    for key in KEYS:
        sync_widgets(key)


# --- callbacks (called by scene_distance_exec) --------------------------------------

def on_slider(key, u):
    """A slider moved: write the snapped distance.

    No echo: Parameter Execute callbacks arrive a frame late, so the guard flag
    alone is not enough. A knob that already sits where the parameter says it
    should (within 0.001) is our own sync, not a user move, and is ignored;
    this also keeps a value set from Python that is not on the snap grid.
    """
    if _sync['busy']:
        return
    par = _par(key)
    if par is None:
        return
    try:
        if abs(float(u) - distance_to_slider(par.eval())) < 0.001:
            return
    except Exception:
        pass
    distance = slider_to_distance(u)
    if abs(float(par.eval()) - distance) > 1e-6:
        par.val = distance
    sync_widgets(key)       # snaps the knob to the tidy value and refreshes the text


def on_change(par, prev=None):
    """Called for every value change of Distance* on /project1 or value0 of the 3 sliders."""
    owner_path = par.owner.path
    if par.name == 'value0':
        for key in KEYS:
            if SLIDER_PATHS[key] == owner_path:
                on_slider(key, par.eval())
        return
    for key in KEYS:
        if PAR_NAMES[key] == par.name:
            sync_widgets(key)
            notify_cone()


def notify_cone():
    """Redraw the cone figure right away (it follows the live Distance* values)."""
    try:
        viz = op(CONE_SCRIPT_PATH)
        if viz is not None:
            viz.module.refresh()
    except Exception as exc:
        print('[TD Scene Distance] cone refresh failed: {}'.format(exc))
