# -*- coding: utf-8 -*-
"""
TouchDesigner-native capture + capture-mode controller.

Grabs one frame straight from a TOP (the live camera) and hands it to the
local generation server (POST /api/generate), which runs Gemini/VLM +
ComfyUI/Qwen and broadcasts the finished images back over UDP 9989 to
td_capture_listener.py. No browser in the loop.

This DAT is also the single place that decides WHEN to capture. Three modes,
read from custom parameters on /project1 (page "Capture", see
install_capture_parameters()), with module defaults when those do not exist:

  timer   every Captureinterval seconds (default 90) a fresh frame is taken
          and saved as a record (captures/record_<timestamp>.jpg), so the
          time-lapse has no gaps. If the pipeline is idle, a generation starts
          from that frame; if a generation is running, the frame is only
          recorded (POST /api/capture/record) and the running generation is
          left alone. A generation that finishes between ticks does not start
          another one: the next tick that finds the pipeline idle does.
  chain   start the next capture as soon as the server reports the previous
          one completed (all images delivered). After a failure, retry after
          CHAIN_RETRY_SECONDS.
  manual  only the manual control (start_generation_btn / key 1).

The manual control works in every mode. Pressed while a generation is running,
it starts a fresh capture; the server cancels the running one (Gemini call
abandoned, ComfyUI prompts dequeued / interrupted), and the listener drops its
images, so a cancelled capture is never displayed.

Generation state comes from the server's explicit lifecycle messages on UDP
9989 (generation.started / .completed / .cancelled / .failed, each with the
captureId), which td_capture_listener forwards to on_server_message().

Wiring (see touchdesigner/README.md, "Capture modes"):
  - timer1 (Timer CHOP) is the heartbeat: its callbacks DAT (timer1_callbacks,
    synced to td_auto_capture_timer.py) calls heartbeat() on every cycle.
    Use a 1 second cycle so timing / mode changes react within a second.
  - td_capture_panel_controls.request_capture() calls manual_capture().
  - td_capture_listener.onReceive() calls on_server_message().

Threading: only the HTTP request runs on a background thread, and that thread
never touches the TouchDesigner API; it posts its result to a deque that the
main thread drains in heartbeat() / on_server_message().
"""

import collections
import json
import os
import tempfile
import threading
import time

try:
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError
except ImportError:  # py2 (older TD)
    from urllib2 import Request, urlopen, HTTPError

# --- config ---------------------------------------------------------------
SERVER_BASE_URL = 'http://127.0.0.1:3000'
SERVER_URL = SERVER_BASE_URL + '/api/generate'
CAMERA_TOP_PATH = 'camera'          # TOP to capture the current frame from
GENERATION_COUNT_OP_PATH = '/project1/generation_count'   # optional CHOP/parameter
SETTINGS_COMP_PATH = '/project1'     # holds the "Capture" custom parameter page
PANEL_CONTROLS_DAT_PATH = '/project1/td_capture_panel_controls'  # legacy browser-path fallback
DEFAULT_IMAGE_COUNT = 3
REQUEST_TIMEOUT_SECONDS = 900        # 3 x Qwen passes can take minutes
SAVE_FORMAT = '.jpg'                 # .jpg keeps the POST body small

DEFAULT_MODE = 'timer'               # used when /project1 has no Capturemode parameter
DEFAULT_INTERVAL_SECONDS = 90.0      # used when /project1 has no Captureinterval parameter
MIN_INTERVAL_SECONDS = 5.0
CHAIN_RETRY_SECONDS = 10.0           # chain mode: wait after a failed capture before retrying
REQUEST_STALL_SECONDS = 30.0         # "requested" without generation.started -> give up
MAX_BUSY_SECONDS = 600.0             # watchdog: never stay "busy" longer than this
MODES = ('timer', 'chain', 'manual')
# -----------------------------------------------------------------------------

_results = collections.deque()      # filled by worker threads, drained on the main thread

_state = {
    'initialized': False,
    'mode': None,                    # last mode seen by heartbeat()
    'currentId': '',                 # capture TD considers current ('' = none)
    'phase': 'idle',                 # idle | requested | generating
    'phaseSince': 0.0,
    'source': '',                    # timer | chain | manual (what started currentId)
    'lastTickAt': 0.0,               # timer mode: time of the last tick (or mode entry)
    'chainDueAt': 0.0,               # chain mode: when to start the next capture (0 = not scheduled)
    'lastRecordText': '',            # timer mode: HH:MM:SS of the last record-only tick (this generation)
    'statusText': '',
}
_cancelled_ids = collections.OrderedDict()   # captureIds TD abandoned or the server cancelled
_mode_override = {'mode': None, 'interval': None}


def _debug(message):
    print('[TD Capture] {}'.format(message))


def _now():
    return time.time()


# --- settings -----------------------------------------------------------------

def _settings_comp():
    return op(SETTINGS_COMP_PATH)


def _custom_par(name):
    comp = _settings_comp()
    if comp is None:
        return None
    return getattr(comp.par, name, None)


def get_mode():
    if _mode_override['mode']:
        return _mode_override['mode']
    par = _custom_par('Capturemode')
    if par is not None:
        try:
            value = str(par.eval()).strip().lower()
            if value in MODES:
                return value
        except Exception:
            pass
    return DEFAULT_MODE


def get_interval():
    if _mode_override['interval']:
        return max(MIN_INTERVAL_SECONDS, float(_mode_override['interval']))
    par = _custom_par('Captureinterval')
    if par is not None:
        try:
            return max(MIN_INTERVAL_SECONDS, float(par.eval()))
        except Exception:
            pass
    return DEFAULT_INTERVAL_SECONDS


def set_mode(mode, interval=None):
    """Switch mode from Python (textport / other DATs).

    Writes the /project1 custom parameters when they exist, otherwise keeps an
    in-memory override (lost when this DAT reloads).
    """
    mode = str(mode).strip().lower()
    if mode not in MODES:
        raise ValueError('mode must be one of {}'.format(MODES))
    par = _custom_par('Capturemode')
    if par is not None:
        par.val = mode
        _mode_override['mode'] = None
    else:
        _mode_override['mode'] = mode
    if interval is not None:
        ipar = _custom_par('Captureinterval')
        if ipar is not None:
            ipar.val = float(interval)
            _mode_override['interval'] = None
        else:
            _mode_override['interval'] = float(interval)
    heartbeat()
    return status()


def install_capture_parameters(target_path=SETTINGS_COMP_PATH):
    """Create the "Capture" custom page on /project1 (idempotent).

    Capturemode (menu timer/chain/manual, default timer), Captureinterval
    (seconds, default 90), Capturestatus (read-only text written by this DAT).
    """
    comp = op(target_path)
    if comp is None:
        raise ValueError('settings COMP not found: {}'.format(target_path))
    page = None
    for candidate in comp.customPages:
        if candidate.name == 'Capture':
            page = candidate
            break
    if page is None:
        page = comp.appendCustomPage('Capture')

    if getattr(comp.par, 'Capturemode', None) is None:
        par = page.appendMenu('Capturemode', label='Capture Mode')[0]
        par.menuNames = list(MODES)
        par.menuLabels = ['Timer (every N s, skip while busy)', 'Chain (next after completion)', 'Manual only']
        par.default = DEFAULT_MODE
        par.val = DEFAULT_MODE
    if getattr(comp.par, 'Captureinterval', None) is None:
        par = page.appendFloat('Captureinterval', label='Timer Interval (s)')[0]
        par.default = DEFAULT_INTERVAL_SECONDS
        par.val = DEFAULT_INTERVAL_SECONDS
        par.min = MIN_INTERVAL_SECONDS
        par.clampMin = True
        par.normMin = 10
        par.normMax = 300
    if getattr(comp.par, 'Capturestatus', None) is None:
        par = page.appendStr('Capturestatus', label='Capture Status')[0]
        par.readOnly = True
    _write_status(force=True)
    return [p.name for p in page.pars]


# --- frame grab + HTTP --------------------------------------------------------

def _image_count():
    count_op = op(GENERATION_COUNT_OP_PATH)
    if count_op is None:
        return DEFAULT_IMAGE_COUNT
    try:
        if getattr(count_op, 'numChans', 0):
            return max(1, min(10, int(round(count_op.chans()[0].eval()))))
        par = getattr(getattr(count_op, 'par', None), 'value0', None)
        if par is not None:
            return max(1, min(10, int(round(par.eval()))))
    except Exception:
        pass
    return DEFAULT_IMAGE_COUNT


def _grab_frame_b64():
    cam = op(CAMERA_TOP_PATH)
    if cam is None:
        raise ValueError('Camera TOP not found: {}'.format(CAMERA_TOP_PATH))

    tmp_path = os.path.join(tempfile.gettempdir(), 'td_specmem_frame' + SAVE_FORMAT)
    # TOP.save() writes the current frame to disk (jpg/png by extension).
    saved = cam.save(tmp_path, asynchronous=False)
    path = saved if isinstance(saved, str) and saved else tmp_path

    with open(path, 'rb') as handle:
        raw = handle.read()

    import base64
    mime = 'image/jpeg' if SAVE_FORMAT == '.jpg' else 'image/png'
    return 'data:{};base64,{}'.format(mime, base64.b64encode(raw).decode('ascii'))


def _local_iso_now():
    from datetime import datetime
    return datetime.now().strftime('%Y-%m-%dT%H:%M:%S')


_id_counter = [0]


def _new_capture_id():
    _id_counter[0] += 1
    return 'td-{}-{}'.format(int(_now() * 1000), _id_counter[0])


def _http_json(url, payload=None, timeout=5.0):
    """Returns (status, body_dict). Runs on worker threads only."""
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    headers = {'Content-Type': 'application/json'} if data is not None else {}
    request = Request(url, data=data, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode('utf-8') or '{}'
            return response.status if hasattr(response, 'status') else 200, json.loads(raw)
    except HTTPError as exc:
        try:
            body = json.loads(exc.read().decode('utf-8') or '{}')
        except Exception:
            body = {}
        return exc.code, body


def _run_generate(capture_id, data_url, image_count):
    """Worker thread: POST /api/generate. No TD API calls in here."""
    try:
        code, body = _http_json(SERVER_URL, {
            'image': data_url,
            'imageCount': image_count,
            'sceneTime': _local_iso_now(),
            'captureId': capture_id,
        }, timeout=REQUEST_TIMEOUT_SECONDS)
        if code == 200:
            _results.append({'type': 'generation.completed', 'captureId': capture_id, 'via': 'http',
                             'deliveredCount': body.get('count')})
        elif code == 409 or body.get('cancelled'):
            _results.append({'type': 'generation.cancelled', 'captureId': capture_id, 'via': 'http'})
        else:
            _results.append({'type': 'generation.failed', 'captureId': capture_id, 'via': 'http',
                             'error': body.get('error') or 'HTTP {}'.format(code)})
    except Exception as exc:
        _results.append({'type': 'generation.failed', 'captureId': capture_id, 'via': 'http',
                         'error': str(exc)})


def _run_record(data_url, recorded_text):
    """Worker thread: POST /api/capture/record (record-only frame)."""
    try:
        code, body = _http_json(SERVER_BASE_URL + '/api/capture/record', {'image': data_url}, timeout=30.0)
        if code == 200:
            _results.append({'type': 'record.saved', 'at': recorded_text,
                             'filename': (body.get('record') or {}).get('filename', '')})
        else:
            _results.append({'type': 'record.failed', 'at': recorded_text,
                             'error': body.get('error') or 'HTTP {}'.format(code)})
    except Exception as exc:
        _results.append({'type': 'record.failed', 'at': recorded_text, 'error': str(exc)})


def _run_status_sync():
    try:
        code, body = _http_json(SERVER_BASE_URL + '/api/capture/status', timeout=2.0)
        if code == 200:
            _results.append({'type': 'status.sync', 'active': body.get('active')})
    except Exception as exc:
        _results.append({'type': 'status.sync.failed', 'error': str(exc)})


def _run_cancel(capture_id):
    try:
        _http_json(SERVER_BASE_URL + '/api/capture/cancel', {'captureId': capture_id}, timeout=5.0)
    except Exception as exc:
        _results.append({'type': 'cancel.failed', 'captureId': capture_id, 'error': str(exc)})


def _spawn(target, *args):
    threading.Thread(target=target, args=args, daemon=True).start()


# --- state machine -------------------------------------------------------------

def _mark_cancelled(capture_id):
    if not capture_id:
        return
    _cancelled_ids[capture_id] = _now()
    while len(_cancelled_ids) > 50:
        _cancelled_ids.popitem(last=False)


def is_stale_capture(capture_id):
    """True for a capture TD abandoned or the server cancelled: never display it."""
    return bool(capture_id) and capture_id in _cancelled_ids


def current_capture_id():
    return _state['currentId']


def is_busy():
    return _state['phase'] != 'idle'


def _set_phase(phase, capture_id=None, source=None):
    _state['phase'] = phase
    _state['phaseSince'] = _now()
    if capture_id is not None:
        _state['currentId'] = capture_id
    if source is not None:
        _state['source'] = source
    _write_status()


def _write_status(force=False):
    mode = get_mode()
    if _state['phase'] == 'idle':
        text = '{} | idle'.format(mode)
    else:
        text = '{} | {} {} ({})'.format(mode, _state['phase'], _state['currentId'], _state['source'] or '?')
    if _state['lastRecordText']:
        text += ' | recorded {}'.format(_state['lastRecordText'])
    if text == _state['statusText'] and not force:
        return
    _state['statusText'] = text
    par = _custom_par('Capturestatus')
    if par is not None:
        try:
            par.val = text
        except Exception:
            pass


def status():
    return {
        'mode': get_mode(),
        'interval': get_interval(),
        'phase': _state['phase'],
        'captureId': _state['currentId'],
        'source': _state['source'],
        'busyFor': round(_now() - _state['phaseSince'], 1) if _state['phase'] != 'idle' else 0,
        'nextTimerTickIn': round(_state['lastTickAt'] + get_interval() - _now(), 1)
        if get_mode() == 'timer' else None,
        'chainDueIn': round(_state['chainDueAt'] - _now(), 1) if _state['chainDueAt'] else None,
    }


# Backup heartbeat: once this module is initialised it also ticks itself every
# LOOP_INTERVAL_MS via run(), so timing stays right even if timer1 is stopped or
# has a long cycle. The token makes a reloaded module (file sync) take over the
# loop instead of running two.
LOOP_INTERVAL_MS = 1000
_LOOP_TOKEN = '{:.6f}'.format(time.time())


def _schedule_loop():
    try:
        run(
            "m = op({!r}).module if op({!r}) else None\n"
            "m._loop_tick({!r}) if m else None".format(me.path, me.path, _LOOP_TOKEN),
            delayMilliSeconds=LOOP_INTERVAL_MS
        )
    except Exception as exc:
        _debug('could not schedule the backup heartbeat: {}'.format(exc))


def _loop_tick(token):
    if token != _LOOP_TOKEN:
        # A loop scheduled by a previous version of this module: stop it, and
        # make sure the current module runs its own.
        _ensure_initialized()
        return
    try:
        heartbeat()
    except Exception as exc:
        _debug('heartbeat failed: {}'.format(exc))
    finally:
        _schedule_loop()


def _ensure_initialized():
    if _state['initialized']:
        return
    _state['initialized'] = True
    _state['mode'] = get_mode()
    _state['lastTickAt'] = _now()
    _write_status(force=True)
    _schedule_loop()
    # Adopt a capture that may already be running (e.g. this DAT was reloaded
    # mid-generation), so Timer/Chain do not start a parallel one.
    _spawn(_run_status_sync)
    _debug('controller ready (mode={}, interval={}s)'.format(_state['mode'], get_interval()))


def ensure_running():
    """Start the controller (and its backup heartbeat) if it is not running yet."""
    _ensure_initialized()
    return status()


def _start_capture(source):
    """Grab a frame and start a capture. Returns the new captureId or None."""
    _ensure_initialized()
    previous_id = _state['currentId'] if is_busy() else ''
    capture_id = _new_capture_id()

    try:
        data_url = _grab_frame_b64()
        count = _image_count()
    except Exception as exc:
        _debug('frame grab failed ({}): {} - falling back to the browser path'.format(source, exc))
        return _start_remote_capture(source, capture_id, previous_id)

    if previous_id:
        # The server cancels it when this capture begins (latest wins); mark it
        # now so its images are dropped even if they are already in flight.
        _mark_cancelled(previous_id)
        _debug('{}: cancelling {} and restarting'.format(source, previous_id))

    _state['chainDueAt'] = 0.0
    _state['lastRecordText'] = ''
    _set_phase('requested', capture_id, source)
    _spawn(_run_generate, capture_id, data_url, count)
    _debug('{}: capture {} sent ({} b64 chars, {} scenes)'.format(source, capture_id, len(data_url), count))
    return capture_id


def _start_remote_capture(source, capture_id, previous_id):
    """Fallback: queue the capture for the browser app (old control path)."""
    controls = op(PANEL_CONTROLS_DAT_PATH)
    if controls is None or not hasattr(controls.module, 'request_remote_capture'):
        _debug('no fallback available ({} missing)'.format(PANEL_CONTROLS_DAT_PATH))
        return None
    try:
        controls.module.request_remote_capture(capture_id=capture_id, image_count=_image_count())
    except Exception as exc:
        _debug('remote capture request failed: {}'.format(exc))
        if source == 'chain':
            _state['chainDueAt'] = _now() + CHAIN_RETRY_SECONDS
        return None
    if previous_id:
        _mark_cancelled(previous_id)
    _state['chainDueAt'] = 0.0
    _set_phase('requested', capture_id, source)
    return capture_id


def record_only(source='timer'):
    """Grab a fresh frame and save it as a record without generating.

    Does not touch the running generation (no cancel, no queue).
    """
    _ensure_initialized()
    try:
        data_url = _grab_frame_b64()
    except Exception as exc:
        _debug('{}: record-only frame grab failed: {}'.format(source, exc))
        return None
    from datetime import datetime
    recorded_text = datetime.now().strftime('%H:%M:%S')
    _state['lastRecordText'] = recorded_text
    _write_status()
    _spawn(_run_record, data_url, recorded_text)
    _debug('{}: generation {} still running - frame recorded only ({})'.format(
        source, _state['currentId'], recorded_text))
    return recorded_text


def manual_capture():
    """Manual control (any mode). Cancels a running generation and starts over."""
    _ensure_initialized()
    if get_mode() == 'timer':
        _state['lastTickAt'] = _now()   # restart the timer countdown from this press
    return _start_capture('manual')


# Backwards compatible name (older callbacks call capture()).
capture = manual_capture


def cancel_current():
    """Stop the running generation without starting a new one."""
    _ensure_initialized()
    capture_id = _state['currentId'] if is_busy() else ''
    if not capture_id:
        return None
    _mark_cancelled(capture_id)
    _state['chainDueAt'] = 0.0
    _set_phase('idle')
    _spawn(_run_cancel, capture_id)
    _debug('cancel requested for {}'.format(capture_id))
    return capture_id


def _on_finished(capture_id, outcome, detail=''):
    if capture_id != _state['currentId'] or _state['phase'] == 'idle':
        return
    _set_phase('idle')
    _debug('capture {} {}{}'.format(capture_id, outcome, ' ({})'.format(detail) if detail else ''))
    mode = get_mode()
    if mode != 'chain':
        return
    if outcome == 'completed':
        _start_capture('chain')
    elif outcome == 'failed':
        _state['chainDueAt'] = _now() + CHAIN_RETRY_SECONDS
        _debug('chain: retrying in {:.0f}s'.format(CHAIN_RETRY_SECONDS))
    # cancelled: by a newer capture (its generation.started follows) or on
    # explicit request (stay idle until the next manual capture).


def on_server_message(payload):
    """Lifecycle message from the server (forwarded by td_capture_listener).

    Returns True when the message was a lifecycle message.
    """
    msg_type = str(payload.get('type', ''))
    if not msg_type.startswith('generation.') and msg_type not in ('status.sync', 'status.sync.failed',
                                                                     'cancel.failed', 'record.saved',
                                                                     'record.failed'):
        return False
    _ensure_initialized()
    capture_id = str(payload.get('captureId', '') or '')

    if msg_type == 'generation.started':
        if is_stale_capture(capture_id):
            return True
        if capture_id != _state['currentId'] and is_busy():
            # Another source (browser button) superseded ours.
            _mark_cancelled(_state['currentId'])
        if capture_id != _state['currentId'] or _state['phase'] != 'generating':
            _state['chainDueAt'] = 0.0
            _set_phase('generating', capture_id,
                       _state['source'] if capture_id == _state['currentId'] else str(payload.get('source', '')))
        return True

    if msg_type == 'generation.completed':
        _on_finished(capture_id, 'completed')
        return True

    if msg_type == 'generation.cancelled':
        _mark_cancelled(capture_id)
        _on_finished(capture_id, 'cancelled', payload.get('reason', ''))
        return True

    if msg_type == 'generation.failed':
        _on_finished(capture_id, 'failed', payload.get('error', ''))
        return True

    if msg_type == 'status.sync':
        active = payload.get('active') or None
        if active and active.get('captureId') and not is_busy():
            _set_phase('generating', str(active['captureId']), str(active.get('source', '')))
            _debug('adopted running capture {}'.format(active['captureId']))
        return True

    if msg_type == 'record.saved':
        _debug('record-only frame saved: {}'.format(payload.get('filename', '')))
        return True

    if msg_type == 'record.failed':
        _debug('record-only frame NOT saved ({}): {}'.format(payload.get('at', ''), payload.get('error', '')))
        return True

    if msg_type in ('status.sync.failed', 'cancel.failed'):
        _debug('{}: {}'.format(msg_type, payload.get('error', '')))
        return True
    return True


def _drain_results():
    while _results:
        try:
            item = _results.popleft()
        except IndexError:
            break
        on_server_message(item)


def heartbeat():
    """Call regularly from the main thread (timer1 onCycle, ideally every 1s)."""
    _ensure_initialized()
    _drain_results()
    now = _now()
    mode = get_mode()

    if mode != _state['mode']:
        _debug('mode {} -> {}'.format(_state['mode'], mode))
        _state['mode'] = mode
        _state['chainDueAt'] = 0.0
        _state['lastTickAt'] = now
        _write_status(force=True)
        if mode == 'chain' and not is_busy():
            _start_capture('chain')
            return

    # Watchdogs: a lost UDP message must not leave Timer/Chain stuck.
    if _state['phase'] == 'requested' and now - _state['phaseSince'] > REQUEST_STALL_SECONDS:
        _debug('capture {} never started on the server - giving up'.format(_state['currentId']))
        _on_finished(_state['currentId'], 'failed', 'no generation.started')
    elif _state['phase'] == 'generating' and now - _state['phaseSince'] > MAX_BUSY_SECONDS:
        _debug('capture {} busy for {:.0f}s - resetting'.format(_state['currentId'], now - _state['phaseSince']))
        _on_finished(_state['currentId'], 'failed', 'watchdog')

    if mode == 'timer':
        if now - _state['lastTickAt'] >= get_interval():
            _state['lastTickAt'] = now
            if is_busy():
                record_only('timer')
            else:
                _start_capture('timer')
    elif mode == 'chain':
        if _state['chainDueAt'] and now >= _state['chainDueAt'] and not is_busy():
            _state['chainDueAt'] = 0.0
            _start_capture('chain')

    _write_status()
