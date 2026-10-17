# -*- coding: utf-8 -*-
"""
Manual / Auto buttons (/project1/modeChooser) + interval slider, wired to the
real capture mode.

The real state is the custom parameter /project1 Capturemode ('timer' |
'chain' | 'manual') and Captureinterval (seconds). This module only displays
it and requests changes; the capture logic stays in td_native_capture.py and the
mode change goes through td_capture_panel_controls.request_capture_mode().

  Manual   -> Capturemode 'manual' at once. Cancels a pending Auto confirmation.
  Auto     -> first press only ARMS a confirmation (message, nothing starts).
              A second press within CONFIRM_SECONDS switches to 'timer'.
              No second press: the confirmation expires, the message goes away.
  display  -> the highlighted button always follows the real Capturemode
              (manual -> Manual, timer/chain -> Auto), also when it is changed
              from the parameter page or a script. Merely armed != Auto.
  status   -> while timer/chain runs, a persistent red text says so
              (paid captures are running). Nothing extra in manual.
  interval -> slider 30..600 s (step 5) writes Captureinterval; shown live.
              Writing it never changes the mode, so manual stays idle.

Wiring (all in /project1):
  td_mode_chooser            this DAT (file-synced)
  td_mode_chooser_exec       Execute DAT, onStart -> start()
  modeChooser                par Runofftoon = on_press(index)
  mode_extras                container: lbl, slider, val, msg
  mode_extras/slider         its parexec calls on_slider(value0)
A 250 ms self-scheduled loop (like td_native_capture) keeps the display in
sync and expires the confirmation.
"""

import time

CHOOSER_PATH = '/project1/modeChooser'
EXTRAS_PATH = '/project1/mode_extras'
SETTINGS_PATH = '/project1'
CONTROLS_DAT_PATH = '/project1/td_capture_panel_controls'

CONFIRM_SECONDS = 10.0
MIN_INTERVAL = 30.0      # a capture + generation takes ~60-75 s; shorter is pointless
MAX_INTERVAL = 600.0
STEP = 5.0
DEFAULT_INTERVAL = 90.0
YEN_PER_CAPTURE = 5      # Gemini, rough
CAPTURE_SECONDS = 70.0   # ticks while a generation runs only record a photo, no paid call
POLL_MS = 250

DRY_RUN = False          # tests only: record apply calls instead of changing the mode
_dry_calls = []

_state = {'armedAt': None, 'syncing': False, 'started': False}
_LOOP_TOKEN = '{:.6f}'.format(time.time())

COLOR_ARMED = (1.0, 0.8, 0.2)
COLOR_RUNNING = (1.0, 0.4, 0.35)


# --- pure helpers (testable without touching the project) ------------------------

def mode_index(mode):
    """Radio index for a real Capturemode: manual -> 0 (Manual), timer/chain -> 1 (Auto)."""
    return 1 if str(mode).strip().lower() in ('timer', 'chain') else 0


def fmt_sec(seconds):
    seconds = float(seconds)
    return str(int(round(seconds))) if abs(seconds - round(seconds)) < 0.05 else '{:.1f}'.format(seconds)


def hourly_yen(interval):
    paid_captures = 3600.0 / max(float(interval), CAPTURE_SECONDS)
    return int(round(paid_captures * YEN_PER_CAPTURE / 10.0)) * 10


def confirm_message(interval):
    return u'タイマー撮影を開始します（{}秒ごと・1時間 約{}円）。もう一度 Auto を押すと開始'.format(
        fmt_sec(interval), hourly_yen(interval))


def status_message(mode, interval):
    mode = str(mode).strip().lower()
    if mode == 'timer':
        return u'自動撮影中（timer・{}秒）'.format(fmt_sec(interval))
    if mode == 'chain':
        return u'自動撮影中（chain）'
    return ''


def quantize_interval(value):
    value = round(float(value) / STEP) * STEP
    return max(MIN_INTERVAL, min(MAX_INTERVAL, value))


def slider_to_interval(u):
    return quantize_interval(MIN_INTERVAL + float(u) * (MAX_INTERVAL - MIN_INTERVAL))


def interval_to_slider(interval):
    u = (float(interval) - MIN_INTERVAL) / (MAX_INTERVAL - MIN_INTERVAL)
    return max(0.0, min(1.0, u))


# --- reading / writing the real state --------------------------------------------

def _par(name):
    comp = op(SETTINGS_PATH)
    return getattr(comp.par, name, None) if comp is not None else None


def get_mode():
    par = _par('Capturemode')
    try:
        value = str(par.eval()).strip().lower()
        if value in ('timer', 'chain', 'manual'):
            return value
    except Exception:
        pass
    return 'manual'


def get_interval():
    par = _par('Captureinterval')
    try:
        return float(par.eval())
    except Exception:
        return DEFAULT_INTERVAL


def _apply_mode(mode):
    if DRY_RUN:
        _dry_calls.append(mode)
        return
    op(CONTROLS_DAT_PATH).module.request_capture_mode(mode)


# --- button handlers ---------------------------------------------------------------

def on_press(index):
    """Called by modeChooser (Runofftoon) with the pressed item's index."""
    index = int(index)
    now = time.time()
    if index == 0:
        _state['armedAt'] = None
        if get_mode() != 'manual':
            _apply_mode('manual')
    else:
        if get_mode() != 'manual':
            pass  # already automatic: nothing to confirm
        elif _state['armedAt'] is not None and now - _state['armedAt'] <= CONFIRM_SECONDS:
            _state['armedAt'] = None
            _apply_mode('timer')
        else:
            _state['armedAt'] = now
    refresh()


def on_slider(value):
    """Slider (normalised 0..1) moved: write Captureinterval. Never touches the mode."""
    if _state['syncing']:
        return
    par = _par('Captureinterval')
    if par is None:
        return
    new_value = slider_to_interval(value)
    if abs(new_value - get_interval()) > 0.01:
        par.val = new_value
    refresh()


# --- display -------------------------------------------------------------------------

def _set_text(name, text, color=None):
    extras = op(EXTRAS_PATH)
    comp = extras.op(name) if extras is not None else None
    if comp is None:
        return
    if comp.par.text.eval() != text:
        comp.par.text = text
    if color is not None:
        comp.par.fontcolorr, comp.par.fontcolorg, comp.par.fontcolorb = color


def refresh():
    now = time.time()
    mode = get_mode()
    interval = get_interval()

    if _state['armedAt'] is not None and (mode != 'manual' or now - _state['armedAt'] > CONFIRM_SECONDS):
        _state['armedAt'] = None

    chooser = op(CHOOSER_PATH)
    if chooser is not None:
        idx = mode_index(mode)
        if int(chooser.par.Value1.eval()) != idx:
            chooser.par.Value1 = idx

    if _state['armedAt'] is not None:
        _set_text('msg', confirm_message(interval), COLOR_ARMED)
    else:
        _set_text('msg', status_message(mode, interval), COLOR_RUNNING)

    _set_text('val', u'{} 秒'.format(fmt_sec(interval)))
    extras = op(EXTRAS_PATH)
    slider = extras.op('slider') if extras is not None else None
    if slider is not None:
        target = interval_to_slider(interval)
        if abs(float(slider.par.value0.eval()) - target) > 0.0005:
            _state['syncing'] = True
            try:
                slider.par.value0 = target
            finally:
                _state['syncing'] = False


def state():
    return {'mode': get_mode(), 'interval': get_interval(),
            'armed': _state['armedAt'] is not None, 'dryRun': DRY_RUN, 'dryCalls': list(_dry_calls)}


# --- self-scheduled loop ---------------------------------------------------------------

def _schedule():
    try:
        run("m = op({!r}).module if op({!r}) else None\n"
            "m._loop_tick({!r}) if m else None".format(me.path, me.path, _LOOP_TOKEN),
            delayMilliSeconds=POLL_MS)
    except Exception as exc:
        print('[TD Mode Chooser] could not schedule: {}'.format(exc))


def _loop_tick(token):
    if token != _LOOP_TOKEN:
        start()  # this loop belongs to an older version of the module: let the current one run
        return
    try:
        refresh()
    except Exception as exc:
        print('[TD Mode Chooser] refresh failed: {}'.format(exc))
    finally:
        _schedule()


def start():
    if _state['started']:
        return
    _state['started'] = True
    refresh()
    _schedule()
