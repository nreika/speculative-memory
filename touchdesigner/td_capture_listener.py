import json
import collections
import threading
from datetime import datetime

try:
    from urllib.request import urlopen
    from urllib.parse import urlparse
except ImportError:
    from urllib2 import urlopen
    from urlparse import urlparse

SCRIPT_DAT_PATH = me.path
MOVIE_FILE_IN_OPS = {
    'gen_a': ('Gen_a', 'moviefilein_scene_a'),
    'gen_b': ('Gen_b', 'moviefilein_scene_b'),
    'gen_c': ('Gen_c', 'moviefilein_scene_c'),
    'gen_d': ('Gen_d', 'moviefilein_scene_d'),
    'gen_e': ('Gen_e', 'moviefilein_scene_e'),
    'gen_f': ('Gen_f', 'moviefilein_scene_f'),
    'gen_g': ('Gen_g', 'moviefilein_scene_g'),
    'gen_h': ('Gen_h', 'moviefilein_scene_h'),
    'gen_i': ('Gen_i', 'moviefilein_scene_i'),
    'gen_j': ('Gen_j', 'moviefilein_scene_j'),
}
LEGACY_SCENE_KEY_MAP = {
    'sceneA': 'gen_a',
    'sceneB': 'gen_b',
    'sceneC': 'gen_c',
    'sceneD': 'gen_d',
    'sceneE': 'gen_e',
    'sceneF': 'gen_f',
    'sceneG': 'gen_g',
    'sceneH': 'gen_h',
    'sceneI': 'gen_i',
    'sceneJ': 'gen_j',
}
ORIGINAL_MOVIE_FILE_IN_OP = ('Record_t1', 'record_original', 'moviefilein_original')
INFO_TABLE_OP = 'capture_info'
READY_FADE_TIMER_OP = '/project1/timer2'
# Two-machine setup: /project1 custom page "Network" (td_native_capture.install_network_parameters()):
# Serverurl (default http://127.0.0.1:3000) and Imagesource (file | url, default file).
# file = the Movie File In TOPs read the absolute paths in the message (server on this PC).
# url  = they read http://<server>/captures/... instead (server on another PC).
DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:3000'
NETWORK_SETTINGS_COMP_PATH = '/project1'
LATEST_CAPTURES_PATH = '/api/latest-captures'
AUTO_RECOVER_FROM_MANIFEST = True
RELOAD_RETRY_FRAMES = (1, 6)
DEFAULT_IMAGE_COUNT = 3
MIN_IMAGE_COUNT = 1
MAX_IMAGE_COUNT = 10
CONTROLLER_DAT_PATH = '/project1/td_native_capture'
# Captures announced by generation.started are held back and displayed only as
# a complete set (on generation.completed, or once every expected scene has
# arrived), so the images of a capture that gets cancelled half way never reach
# the Movie File In TOPs. Captures without lifecycle messages (old senders) are
# displayed image by image as before.
DEFER_DISPLAY_UNTIL_COMPLETE = True
# Switchable from the panel: /project1 par Displaytiming (Capture page, created by
# install_display_timing_parameter()): 'all' = hold back until the set is complete
# (the behaviour above), 'each' = show every image as soon as it is saved. Without
# the par, DEFER_DISPLAY_UNTIL_COMPLETE decides.
DISPLAY_TIMING_PAR = 'Displaytiming'
DISPLAY_TIMING_MENU = (('all', u'3枚そろってから一斉に'), ('each', u'1枚ずつ（完成しだい）'))
# A failed capture (e.g. ComfyUI error on image 2) shows nothing by default;
# True shows the images it did deliver (the old behaviour).
SHOW_PARTIAL_ON_FAILURE = False

# Gemini cost display. The server sends {type:"usage.updated", ...} on UDP 9989
# after every Gemini call (logs/usage.jsonl has the per-call detail). The
# numbers go to two places on /project1: read-only Str pars Costtoday /
# Costtotal on the Capture page, and a Text COMP "cost_display" that shows on
# the operator panel (/perform). Both are created idempotently by
# install_cost_display(). Panel coordinates are /project1 pixels, origin
# bottom-left. Placed in the bottom-left free band between the number-button
# bar (y 0..40) and the lowest ui_root frame (starts at y=135): x=8, y=70,
# 268x26 (the scene text panels start at x=280, see td_scene_text.py). (The top-left corner is taken by the Mode selector.)
COST_SETTINGS_COMP_PATH = '/project1'
COST_DISPLAY_NAME = 'cost_display'
COST_DISPLAY_GEOMETRY = {'x': 8, 'y': 91, 'w': 268, 'h': 16}   # row above it: overlay buttons (td_display_overlay)
COST_DISPLAY_FONT = 'Yu Gothic UI'
COST_DISPLAY_FONT_SIZE = 12
USAGE_API_PATH = '/api/usage'

# Scene description panels (NOW / PAST / FUTURE A / FUTURE B), see td_scene_text.py.
SCENE_TEXT_SCRIPT_PATH = '/project1/ui_root/scene_text/script'

# Display sync (ported from the September version): DATs on /project1 filled when a batch completes,
# the display fade-in via /project1/fade_state + fade_lag, and reset_history(). Pure helpers live in
# td_display_sync.py (file-synced DAT /project1/td_display_sync); see install_display_sync().
DISPLAY_SYNC_DAT_PATH = '/project1/td_display_sync'
DISPLAY_COMP_PATH = '/project1'
FADE_MODE_PAR = 'Fademode'            # Display page: legacy_timer2 | fade_state
FADE_MODES = ('legacy_timer2', 'fade_state')
DEFAULT_FADE_MODE = 'fade_state'
FADE_STATE_OP_PATH = '/project1/fade_state'     # Constant CHOP, const0name 'fade' (0 = black, 1 = shown)
FADE_LAG_OP_PATH = '/project1/fade_lag'         # Lag CHOP on fade_state; export its output to the display COMP's opacity
FADE_EXEC_DAT_PATH = '/project1/start_display_exec'   # optional: cancel_pending() stops the SHOW button's auto fade-out
FADE_LAG_SECONDS = 0.8
FADE_REARM_HOLD_MS = None             # None -> derive from fade_lag down time; or an int (ms)
SCENARIO_CURRENT_DAT_PATH = '/project1/scenario_current'        # Table: sceneKey / label / text
OBSERVATION_CURRENT_DAT_PATH = '/project1/observation_current'  # Text: what the camera saw
HISTORY_CURRENT_DAT_PATH = '/project1/history_current'          # Table: time(JST) / captureId / observation / hasPerson, newest first
SCENARIO_LATEST_DAT_PATH = '/project1/scenario_latest'          # Text: readable newest capture
ACTION_LOG_DAT_PATH = '/project1/action_log'                    # Text: GET /api/action-history text
DISPLAY_DAT_SPECS = (
    (SCENARIO_CURRENT_DAT_PATH, 'tableDAT', -400, -1300),
    (OBSERVATION_CURRENT_DAT_PATH, 'textDAT', -400, -1400),
    (HISTORY_CURRENT_DAT_PATH, 'tableDAT', -400, -1500),
    (SCENARIO_LATEST_DAT_PATH, 'textDAT', -400, -1600),
    (ACTION_LOG_DAT_PATH, 'textDAT', -400, -1700),
)
DISPLAY_SYNC_POLL_FRAMES = 15
DISPLAY_SYNC_POLL_MAX = 160           # x 15 frames: gives up after ~40 s at 60 fps

KNOWN_SCENE_KEYS = tuple(sorted(MOVIE_FILE_IN_OPS))


def _debug(message):
    print('[TD Capture Listener] {}'.format(message))


def _new_scene_state(capture_id=''):
    return {
        'ready': False,
        'label': '',
        'captureId': capture_id,
        'targetPath': '',
        'sourcePath': '',
        'savedAt': '',
        'payload': {},
    }


SCENE_STATES = {scene_key: _new_scene_state() for scene_key in KNOWN_SCENE_KEYS}
BATCH_STATE = {
    'captureId': '',
    'receivedSceneKeys': set(),
    'expectedImageCount': DEFAULT_IMAGE_COUNT,
    'isReady': False,
    'completedAt': '',
    'fadeTriggered': False,
}
# The capture currently being generated: its images wait here until complete.
PENDING = {
    'captureId': '',
    'expectedImageCount': DEFAULT_IMAGE_COUNT,
    'payloads': {},
    'completed': False,
}
LIFECYCLE_CAPTURE_IDS = []   # captures announced by generation.started (bounded)
CANCELLED_CAPTURE_IDS = []   # captures cancelled by the server (bounded)
DISPLAYED_CAPTURE_IDS = []   # captures whose set has been displayed (bounded)
_display_results = collections.deque()   # filled by worker threads, drained on the main thread
DISPLAY_SYNC_STATE = {'lastSyncId': None, 'lastFadeId': None, 'pending': 0, 'pollScheduled': False, 'pendingRun': None}


def _utc_timestamp():
    return '{}Z'.format(datetime.utcnow().isoformat())


def _td_op(name):
    return op(name) if name else None


def _resolve_op_name(op_name_or_names):
    if isinstance(op_name_or_names, (tuple, list)):
        for candidate in op_name_or_names:
            if candidate and op(candidate) is not None:
                return candidate
        return op_name_or_names[0] if op_name_or_names else ''
    return op_name_or_names


def _normalize_scene_key(scene_key):
    normalized = str(scene_key or '').strip()
    if normalized in MOVIE_FILE_IN_OPS:
        return normalized
    if normalized in LEGACY_SCENE_KEY_MAP:
        return LEGACY_SCENE_KEY_MAP[normalized]
    return normalized.lower()


def _clamp_image_count(value):
    try:
        numeric_value = int(round(float(value)))
    except Exception:
        return DEFAULT_IMAGE_COUNT

    return max(MIN_IMAGE_COUNT, min(MAX_IMAGE_COUNT, numeric_value))


def _expected_scene_count():
    return min(
        len(KNOWN_SCENE_KEYS),
        _clamp_image_count(BATCH_STATE.get('expectedImageCount', DEFAULT_IMAGE_COUNT))
    )


def _server_base_url():
    comp = op(NETWORK_SETTINGS_COMP_PATH)
    par = getattr(comp.par, 'Serverurl', None) if comp is not None else None
    value = str(par.eval()).strip() if par is not None else ''
    return (value or DEFAULT_SERVER_BASE_URL).rstrip('/')


def _use_image_urls():
    comp = op(NETWORK_SETTINGS_COMP_PATH)
    par = getattr(comp.par, 'Imagesource', None) if comp is not None else None
    return par is not None and str(par.eval()).strip().lower() == 'url'


def _image_url(payload, keys):
    """HTTP URL for an image of the message, rebuilt on Serverurl (so a wrong PUBLIC_BASE_URL on the
    server does not matter): Serverurl + the path part of the message URL. '' when the message has none.
    No cache-buster query: the server's image filenames carry a timestamp, so every capture has a new URL."""
    raw = _resolve_path(payload, keys)
    if not raw:
        return ''
    path = urlparse(raw).path if '://' in raw else raw
    if not path.startswith('/'):
        path = '/' + path
    return _server_base_url() + path


def _pulse_reload(target_op_path):
    target_op = op(target_op_path)
    if target_op and getattr(target_op.par, 'reloadpulse', None) is not None:
        target_op.par.reloadpulse.pulse()


def _reload_movie(op_name, file_path):
    movie = _td_op(_resolve_op_name(op_name))
    if not movie:
        return False

    movie.par.file = file_path
    _pulse_reload(movie.path)

    for delay_frames in RELOAD_RETRY_FRAMES:
        run(
            "mod = op({!r}).module if op({!r}) else None\n"
            "mod._pulse_reload({!r}) if mod else None".format(
                SCRIPT_DAT_PATH,
                SCRIPT_DAT_PATH,
                movie.path
            ),
            delayFrames=delay_frames
        )
    return True


def _resolve_path(payload, keys):
    for key in keys:
        value = payload.get(key, '')
        if value:
            return value
    return ''


def _fetch_latest_manifest():
    try:
        with urlopen(_server_base_url() + LATEST_CAPTURES_PATH, timeout=1.0) as response:
            raw_body = response.read().decode('utf-8')
    except Exception:
        return {}

    try:
        return json.loads(raw_body) if raw_body else {}
    except Exception:
        return {}


def _reset_batch(capture_id='', expected_image_count=DEFAULT_IMAGE_COUNT):
    BATCH_STATE.update({
        'captureId': capture_id or '',
        'receivedSceneKeys': set(),
        'expectedImageCount': _clamp_image_count(expected_image_count),
        'isReady': False,
        'completedAt': '',
        'fadeTriggered': False,
    })

    for scene_key in KNOWN_SCENE_KEYS:
        SCENE_STATES[scene_key] = _new_scene_state(capture_id or '')


def _register_scene(capture_id, scene_key, saved_at, expected_image_count):
    capture_id = capture_id or ''
    if capture_id != BATCH_STATE['captureId']:
        _reset_batch(capture_id, expected_image_count)
    else:
        BATCH_STATE['expectedImageCount'] = _clamp_image_count(expected_image_count)

    if scene_key in SCENE_STATES:
        BATCH_STATE['receivedSceneKeys'].add(scene_key)

    BATCH_STATE['isReady'] = len(BATCH_STATE['receivedSceneKeys']) >= _expected_scene_count()
    if BATCH_STATE['isReady']:
        BATCH_STATE['completedAt'] = saved_at or _utc_timestamp()


def _sync_info_table(payload, target_path):
    table = _td_op(INFO_TABLE_OP)
    if not table:
        return

    normalized_scene_key = _normalize_scene_key(payload.get('sceneKey', ''))
    rows = [
        ['key', 'value'],
        ['sceneKey', normalized_scene_key],
        ['label', payload.get('label', '')],
        ['captureId', payload.get('captureId', '')],
        ['filename', payload.get('filename', '')],
        ['savedAt', payload.get('savedAt', '')],
        ['targetPath', target_path],
        ['latestImagePath', payload.get('latestImageNormalizedPath', '')],
        ['sourceImagePath', payload.get('sourceImageNormalizedPath', '')],
        ['batch.captureId', BATCH_STATE['captureId']],
        ['batch.receivedSceneKeys', ','.join(sorted(BATCH_STATE['receivedSceneKeys']))],
        ['batch.receivedSceneCount', len(BATCH_STATE['receivedSceneKeys'])],
        ['batch.expectedSceneCount', _expected_scene_count()],
        ['batch.isReady', int(BATCH_STATE['isReady'])],
        ['batch.completedAt', BATCH_STATE['completedAt']],
    ]

    for scene_key in KNOWN_SCENE_KEYS:
        state = SCENE_STATES[scene_key]
        rows.extend([
            ['{}.ready'.format(scene_key), int(bool(state['ready']))],
            ['{}.label'.format(scene_key), state['label']],
            ['{}.targetPath'.format(scene_key), state['targetPath']],
            ['{}.savedAt'.format(scene_key), state['savedAt']],
        ])

    table.clear()
    for row in rows:
        table.appendRow(row)


def _apply_capture_payload(payload):
    scene_key = _normalize_scene_key(payload.get('sceneKey', ''))
    if scene_key not in SCENE_STATES:
        return False

    target_path = _resolve_path(
        payload,
        ('latestImagePath', 'latestImageNormalizedPath', 'absolutePath', 'normalizedPath')
    )
    source_path = _resolve_path(
        payload,
        ('sourceImageAbsolutePath', 'sourceImageNormalizedPath')
    )
    if _use_image_urls():
        target_path = _image_url(payload, ('latestImageUrl', 'url'))
        source_path = _image_url(payload, ('nowUrl', 'sourceImageUrl'))
    if not target_path and not source_path:
        _debug('TimeWarp bridge: missing image paths')
        return False

    if target_path and not _reload_movie(MOVIE_FILE_IN_OPS.get(scene_key, ''), target_path):
        _debug('TimeWarp bridge: missing operator for scene {}'.format(scene_key))

    if source_path and not _reload_movie(ORIGINAL_MOVIE_FILE_IN_OP, source_path):
        _debug('TimeWarp bridge: missing operator for original image')

    _register_scene(
        payload.get('captureId', ''),
        scene_key,
        payload.get('savedAt', ''),
        payload.get('expectedImageCount', DEFAULT_IMAGE_COUNT)
    )
    state = SCENE_STATES[scene_key]
    state.update({
        'ready': True,
        'label': payload.get('label', ''),
        'captureId': payload.get('captureId', ''),
        'targetPath': target_path,
        'sourcePath': source_path,
        'savedAt': payload.get('savedAt', ''),
        'payload': payload,
    })
    _sync_info_table(payload, target_path or source_path)
    return True

def _start_ready_fade():
    timer_op = _td_op(READY_FADE_TIMER_OP)
    if not timer_op:
        _debug('TimeWarp bridge: missing ready fade timer {}'.format(READY_FADE_TIMER_OP))
        return False

    initialize_par = getattr(timer_op.par, 'initialize', None)
    start_par = getattr(timer_op.par, 'start', None)
    if initialize_par is not None:
        initialize_par.pulse()
    if start_par is None:
        _debug('TimeWarp bridge: timer {} is missing start pulse'.format(READY_FADE_TIMER_OP))
        return False

    start_par.pulse()
    return True


def _show_display_windows():
    """td_display_integration.show() opens window1..4 (display_a/b/c/now) if the DAT exists."""
    display = _td_op('/project1/td_display_integration')
    if display is None:
        return
    try:
        display.module.show()
    except Exception as exc:
        _debug('display windows not shown: {}'.format(exc))


def _trigger_ready_fade_if_needed():
    if not BATCH_STATE['isReady'] or BATCH_STATE['fadeTriggered']:
        return

    capture_id = BATCH_STATE['captureId']
    _request_display_sync(capture_id)       # DATs first (never raises)
    _show_display_windows()                 # open the 4 output windows (both fade modes)
    if _fade_mode() == 'fade_state':
        if _trigger_display_fade_in(capture_id):
            BATCH_STATE['fadeTriggered'] = True
        return
    if _start_ready_fade():
        BATCH_STATE['fadeTriggered'] = True
        _debug('TimeWarp bridge: ready fade started for capture {}'.format(capture_id))


# --- display sync: DATs, fade-in, reset_history --------------------------------------

def _display_sync_module():
    dat = op(DISPLAY_SYNC_DAT_PATH)
    return dat.module if dat is not None else None


def _fade_mode():
    """'fade_state' or 'legacy_timer2'. Without the Fademode par (install_display_sync not run yet) or
    without the fade_state CHOP the old timer2 pulse is used, so an un-upgraded project behaves as before."""
    comp = op(DISPLAY_COMP_PATH)
    par = getattr(comp.par, FADE_MODE_PAR, None) if comp is not None else None
    if par is None:
        return 'legacy_timer2'
    try:
        value = str(par.eval()).strip().lower()
    except Exception:
        value = DEFAULT_FADE_MODE
    if value not in FADE_MODES:
        value = DEFAULT_FADE_MODE
    if value == 'fade_state' and op(FADE_STATE_OP_PATH) is None:
        return 'legacy_timer2'
    return value


def _display_currently_visible():
    fade_lag = op(FADE_LAG_OP_PATH)
    if fade_lag is not None and getattr(fade_lag, 'numChans', 0) > 0:
        return fade_lag['chan1'] > 0.001
    fade_state = op(FADE_STATE_OP_PATH)
    return fade_state is not None and fade_state.par.const0value.eval() > 0.5


def _kill_pending_fade_rearm():
    pending = DISPLAY_SYNC_STATE.get('pendingRun')
    if pending is not None:
        try:
            pending.kill()
        except Exception:
            pass
    DISPLAY_SYNC_STATE['pendingRun'] = None


def _raise_fade_state():
    DISPLAY_SYNC_STATE['pendingRun'] = None
    fade_state = op(FADE_STATE_OP_PATH)
    if fade_state is not None:
        fade_state.par.const0value = 1


def _trigger_display_fade_in(capture_id):
    """Play the display fade-in once per captureId. True when handled (or already handled)."""
    sync = _display_sync_module()
    if sync is not None and not sync.should_trigger_fade(DISPLAY_SYNC_STATE['lastFadeId'], capture_id):
        return True
    fade_state = op(FADE_STATE_OP_PATH)
    if fade_state is None:
        _debug('Fade state CHOP not found: {}'.format(FADE_STATE_OP_PATH))
        return False
    DISPLAY_SYNC_STATE['lastFadeId'] = capture_id

    # Stop the SHOW button's auto fade-out so the new batch stays up.
    display_exec = op(FADE_EXEC_DAT_PATH)
    if display_exec is not None:
        try:
            display_exec.module.cancel_pending()
        except Exception:
            pass
    _kill_pending_fade_rearm()

    visible = _display_currently_visible()
    action = sync.fade_action(visible) if sync is not None else ('refade' if visible else 'raise')
    if action == 'refade':
        # Showing already: drop to black, then raise after the lag has fallen (replay from black).
        fade_lag = op(FADE_LAG_OP_PATH)
        fade_state.par.const0value = 0
        if fade_lag is not None:
            fade_lag.cook(force=True)
        try:
            current = fade_lag['chan1'] if fade_lag.numChans > 0 else 1.0
            lag_down = fade_lag.par.lag2.eval()
        except Exception:
            current, lag_down = 1.0, FADE_LAG_SECONDS
        hold_ms = sync.fade_out_hold_ms(current, lag_down, FADE_REARM_HOLD_MS) if sync is not None else 1600.0
        DISPLAY_SYNC_STATE['pendingRun'] = run(
            "op({!r}).module._raise_fade_state()".format(SCRIPT_DAT_PATH),
            delayMilliSeconds=hold_ms
        )
        _debug('Display re-fade for capture {} (hold {:.0f}ms).'.format(capture_id or '<unknown>', hold_ms))
    else:
        fade_state.par.const0value = 1
        _debug('Display fade-in for capture {}.'.format(capture_id or '<unknown>'))
    return True


def _request_display_sync(capture_id):
    """Start the HTTP fetch for a completed batch on a worker thread (once per captureId; never raises)."""
    try:
        sync = _display_sync_module()
        if sync is None:
            return False
        if capture_id and DISPLAY_SYNC_STATE['lastSyncId'] == capture_id:
            return False
        DISPLAY_SYNC_STATE['lastSyncId'] = capture_id
        base = _server_base_url()
        keys = KNOWN_SCENE_KEYS

        def work():
            try:
                _display_results.append(('data', sync.fetch_display_data(base, capture_id, keys)))
            except Exception as exc:
                _display_results.append(('error', str(exc)))

        DISPLAY_SYNC_STATE['pending'] += 1
        threading.Thread(target=work, daemon=True).start()
        _schedule_display_poll()
        return True
    except Exception as exc:
        _debug('display sync not started: {}'.format(exc))
        return False


def _schedule_display_poll(tries=0):
    if DISPLAY_SYNC_STATE['pollScheduled']:
        return
    DISPLAY_SYNC_STATE['pollScheduled'] = True
    run(
        "op({!r}).module._poll_display_results({})".format(SCRIPT_DAT_PATH, tries),
        delayFrames=DISPLAY_SYNC_POLL_FRAMES
    )


def _poll_display_results(tries=0):
    """Main thread: drain the worker results; keep polling while a request is outstanding."""
    DISPLAY_SYNC_STATE['pollScheduled'] = False
    while _display_results:
        try:
            kind, value = _display_results.popleft()
        except IndexError:
            break
        DISPLAY_SYNC_STATE['pending'] = max(0, DISPLAY_SYNC_STATE['pending'] - 1)
        try:
            if kind == 'data':
                _apply_display_data(value)
            elif kind == 'reset':
                _finish_reset_history(value)
            else:
                _debug('display sync failed: {}'.format(value))
        except Exception as exc:
            _debug('display sync apply failed: {}'.format(exc))
    if DISPLAY_SYNC_STATE['pending'] > 0 and tries < DISPLAY_SYNC_POLL_MAX:
        _schedule_display_poll(tries + 1)
    elif DISPLAY_SYNC_STATE['pending'] > 0:
        DISPLAY_SYNC_STATE['pending'] = 0
        _debug('display sync: gave up waiting for the server')


def _set_table(path, rows):
    table = op(path)
    if table is None:
        return False
    table.clear()
    for row in rows:
        table.appendRow(row)
    return True


def _set_text(path, text):
    dat = op(path)
    if dat is None:
        return False
    dat.text = text
    return True


def _apply_display_data(result):
    """Main thread: write a fetch_display_data() result into the DATs."""
    sync = _display_sync_module()
    if sync is None or not isinstance(result, dict):
        return
    prediction = result.get('prediction')
    history = result.get('history')
    if prediction is not None:
        _set_table(SCENARIO_CURRENT_DAT_PATH, sync.scenario_table_rows(prediction['rows']))
        _set_text(OBSERVATION_CURRENT_DAT_PATH, prediction['observation'])
        _set_text(
            SCENARIO_LATEST_DAT_PATH,
            sync.format_scenario_latest(
                prediction['captureId'] or result.get('captureId', ''), prediction['observation'], prediction['rows']
            )
        )
    if history is not None:
        _set_table(HISTORY_CURRENT_DAT_PATH, sync.history_table_rows(history))
        _set_text(ACTION_LOG_DAT_PATH, sync.action_log_text(history))
    for message in result.get('errors', []):
        _debug('display sync: {}'.format(message))
    _debug('Display DATs updated for capture {} ({} scenario rows, {} history rows).'.format(
        result.get('captureId') or '<unknown>',
        len(prediction['rows']) if prediction else 0,
        len(history.get('items', [])) if isinstance(history, dict) else 0
    ))


def _clear_display_dats():
    for path in (SCENARIO_CURRENT_DAT_PATH, HISTORY_CURRENT_DAT_PATH):
        table = op(path)
        if table is not None:
            table.clear()
    for path in (OBSERVATION_CURRENT_DAT_PATH, SCENARIO_LATEST_DAT_PATH, ACTION_LOG_DAT_PATH):
        _set_text(path, '')


def reset_history():
    """Archive the server history (POST /api/reset-history) and, when that succeeds, clear the TD side:
    batch state, pending images, fade (fade_state -> 0), the display DATs and the scene text panels.

    Callable from td_capture_panel_controls.py / a Keyboard In DAT (Shift+Ctrl+Alt+n). The HTTP call
    runs on a worker thread; the TD side is cleared a few frames later, on the main thread.
    Returns True when the request was started.
    """
    sync = _display_sync_module()
    if sync is None:
        _debug('reset_history: {} not found (file-sync td_display_sync.py)'.format(DISPLAY_SYNC_DAT_PATH))
        return False
    base = _server_base_url()

    def work():
        try:
            _display_results.append(('reset', sync.post_reset_history(base)))
        except Exception as exc:
            _display_results.append(('reset', {'ok': False, 'status': 0, 'archived': None, 'error': str(exc)}))

    DISPLAY_SYNC_STATE['pending'] += 1
    threading.Thread(target=work, daemon=True).start()
    _schedule_display_poll()
    return True


def _finish_reset_history(outcome):
    if not outcome.get('ok'):
        _debug('reset_history failed (HTTP {} {}); TD side left as it is.'.format(
            outcome.get('status'), outcome.get('error', '')))
        return
    DISPLAY_SYNC_STATE['lastSyncId'] = None
    DISPLAY_SYNC_STATE['lastFadeId'] = None
    _kill_pending_fade_rearm()
    _reset_pending()
    _reset_batch('', DEFAULT_IMAGE_COUNT)
    del DISPLAYED_CAPTURE_IDS[:]
    fade_state = op(FADE_STATE_OP_PATH)
    if fade_state is not None:
        fade_state.par.const0value = 0
    _clear_display_dats()
    try:
        box = op(SCENE_TEXT_SCRIPT_PATH)
        if box is not None:
            box.module.clear()
    except Exception as exc:
        _debug('scene text not cleared: {}'.format(exc))
    _debug('History reset complete (archived: {}).'.format(outcome.get('archived') or '(nothing)'))


def install_display_sync():
    """Create the display-sync operators on /project1 (idempotent; run once after copying the py, then Ctrl+S).

    custom par Display/Fademode (menu legacy_timer2 | fade_state, default fade_state);
    Constant CHOP fade_state (const0name 'fade', value 0) -> Lag CHOP fade_lag (0.8 s up / 0.8 s down);
    DATs scenario_current, history_current (Table) and observation_current, scenario_latest,
    action_log (Text). Wiring fade_lag's output to a display COMP's opacity stays a manual TD step.
    """
    comp = op(DISPLAY_COMP_PATH)
    if comp is None:
        raise ValueError('settings COMP not found: {}'.format(DISPLAY_COMP_PATH))
    page = None
    for candidate in comp.customPages:
        if candidate.name == 'Display':
            page = candidate
            break
    if page is None:
        page = comp.appendCustomPage('Display')
    if getattr(comp.par, FADE_MODE_PAR, None) is None:
        par = page.appendMenu(FADE_MODE_PAR, label='Fade Mode')[0]
        par.menuNames = list(FADE_MODES)
        par.menuLabels = ['Legacy (timer2 pulse)', 'fade_state / fade_lag']
        par.default = DEFAULT_FADE_MODE
        par.val = DEFAULT_FADE_MODE

    fade_state = op(FADE_STATE_OP_PATH)
    if fade_state is None:
        fade_state = comp.create(constantCHOP, FADE_STATE_OP_PATH.rsplit('/', 1)[-1])
        fade_state.nodeX, fade_state.nodeY = -400, -1100
        fade_state.par.const0name = 'fade'
        fade_state.par.const0value = 0
    fade_lag = op(FADE_LAG_OP_PATH)
    if fade_lag is None:
        fade_lag = comp.create(lagCHOP, FADE_LAG_OP_PATH.rsplit('/', 1)[-1])
        fade_lag.nodeX, fade_lag.nodeY = -200, -1100
        fade_lag.par.lag1 = FADE_LAG_SECONDS
        fade_lag.par.lag2 = FADE_LAG_SECONDS
    if not fade_lag.inputs:
        fade_lag.inputConnectors[0].connect(fade_state)

    created = []
    for path, op_type, x, y in DISPLAY_DAT_SPECS:
        if op(path) is None:
            dat = comp.create(tableDAT if op_type == 'tableDAT' else textDAT, path.rsplit('/', 1)[-1])
            dat.nodeX, dat.nodeY = x, y
            created.append(dat.name)
    _debug('install_display_sync: created {}'.format(created or 'nothing (all present)'))
    return [FADE_MODE_PAR, fade_state.path, fade_lag.path] + created


build = install_display_sync


def signed_distance_sec(payload, scene_key=None):
    """Signed temporal distance (seconds, negative = past) of a capture.saved payload, or None.

    New servers send distanceSigned: true and a SIGNED distanceSec for each
    image. Older servers send an unsigned N for all three images with the sign
    implied by the scene (gen_c = past, gen_a / gen_b = future); that rule is
    the fallback when distanceSigned is missing or not true.
    """
    raw = payload.get('distanceSec')
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(raw)
    except Exception:
        return None
    if value != value:      # NaN
        return None
    if payload.get('distanceSigned') is True:
        return value
    key = scene_key or _normalize_scene_key(payload.get('sceneKey', ''))
    return -abs(value) if key == 'gen_c' else abs(value)


def _annotate_distance(payload):
    """Store the signed distance as payload['distanceSecSigned'] (cone / scene text read it)."""
    try:
        value = signed_distance_sec(payload)
        if value is not None:
            payload['distanceSecSigned'] = value
    except Exception as exc:
        _debug('distance not annotated: {}'.format(exc))
    return payload


def _scene_index(payload):
    value = payload.get('sceneIndex', 0)
    return value if isinstance(value, int) else 0


def _fetch_manifest_payloads(expected_capture_id=''):
    manifest = _fetch_latest_manifest()
    scenes = manifest.get('scenes', {}) if isinstance(manifest, dict) else {}
    payloads = []
    for payload in scenes.values():
        if not isinstance(payload, dict):
            continue
        normalized_scene_key = _normalize_scene_key(payload.get('sceneKey', ''))
        if normalized_scene_key not in MOVIE_FILE_IN_OPS:
            continue
        if expected_capture_id and payload.get('captureId', '') != expected_capture_id:
            continue
        payloads.append(_annotate_distance(payload))
    payloads.sort(key=_scene_index)
    return payloads


def resync_latest_scenes(expected_capture_id=''):
    payloads = _fetch_manifest_payloads(expected_capture_id)
    for payload in payloads:
        if _is_cancelled(payload.get('captureId', '')):
            continue
        if _is_deferred(payload.get('captureId', '')):
            _buffer_payload(payload)
        else:
            _apply_capture_payload(payload)
    return bool(payloads)


# --- Gemini cost display (usage.updated messages from the server) --------------

USAGE_STATE = {
    'todayJpy': None,
    'allTimeJpy': None,
    'todayCalls': 0,
    'allTimeCalls': 0,
    'lastJpy': 0.0,
    'purpose': '',
    'updatedAt': '',
}
_YEN = '\u00a5'
_KON = '\u4eca\u65e5'          # today
_RUIKEI = '\u7d2f\u8a08'       # cumulative
_KAI = '\u56de'                 # times (calls)
_LP = '\uff08'
_RP = '\uff09'


def _format_yen(value):
    if value is None:
        return _YEN + '--'
    try:
        value = float(value)
    except Exception:
        return _YEN + '--'
    if value < 100:
        return '{}{:,.1f}'.format(_YEN, value)
    return '{}{:,.0f}'.format(_YEN, value)


def _cost_texts():
    """(Costtoday par text, Costtotal par text, panel text)."""
    today = _format_yen(USAGE_STATE['todayJpy'])
    total = _format_yen(USAGE_STATE['allTimeJpy'])
    calls = int(USAGE_STATE['todayCalls'] or 0)
    par_today = '{} ({}{})'.format(today, calls, _KAI)
    par_total = total
    panel = 'Gemini {} {}{}{}{}{} / {} {}'.format(_KON, today, _LP, calls, _KAI, _RP, _RUIKEI, total)
    return par_today, par_total, panel


def install_cost_display():
    """Create the cost pars + the cost_display Text COMP on /project1 (idempotent)."""
    comp = op(COST_SETTINGS_COMP_PATH)
    if comp is None:
        raise ValueError('settings COMP not found: {}'.format(COST_SETTINGS_COMP_PATH))
    page = None
    for candidate in comp.customPages:
        if candidate.name == 'Capture':
            page = candidate
            break
    if page is None:
        page = comp.appendCustomPage('Capture')
    if getattr(comp.par, 'Costtoday', None) is None:
        par = page.appendStr('Costtoday', label='Gemini Cost Today')[0]
        par.readOnly = True
    if getattr(comp.par, 'Costtotal', None) is None:
        par = page.appendStr('Costtotal', label='Gemini Cost Total')[0]
        par.readOnly = True

    display = comp.op(COST_DISPLAY_NAME)
    if display is None:
        display = comp.create(textCOMP, COST_DISPLAY_NAME)
    g = COST_DISPLAY_GEOMETRY
    display.par.x = g['x']
    display.par.y = g['y']
    display.par.w = g['w']
    display.par.h = g['h']
    display.par.layer = 10          # in front of ui_root and the other panel children
    display.par.alignx = 'left'
    display.par.aligny = 'center'
    display.par.font = COST_DISPLAY_FONT
    display.par.fontsize = COST_DISPLAY_FONT_SIZE
    display.par.fontcolorr = 0.95
    display.par.fontcolorg = 0.95
    display.par.fontcolorb = 0.95
    display.par.textpaddingl = 8
    display.par.bgcolorr = 0.0
    display.par.bgcolorg = 0.0
    display.par.bgcolorb = 0.0
    display.par.bgalpha = 0.65
    display.par.editmode = 'locked'
    display.par.enable = False      # purely informational: never takes clicks
    display.par.display = True
    display.nodeX = -400
    display.nodeY = -1200
    _refresh_cost_display()
    return display.path


def _refresh_cost_display():
    par_today, par_total, panel = _cost_texts()
    comp = op(COST_SETTINGS_COMP_PATH)
    if comp is None:
        return False
    for name, text in (('Costtoday', par_today), ('Costtotal', par_total)):
        par = getattr(comp.par, name, None)
        if par is not None:
            try:
                par.val = text
            except Exception as exc:
                _debug('cost par {} not updated: {}'.format(name, exc))
    display = comp.op(COST_DISPLAY_NAME)
    if display is not None:
        try:
            if display.par.text.eval() != panel:
                display.par.text = panel
        except Exception as exc:
            _debug('cost display not updated: {}'.format(exc))
    return True


def _handle_usage(payload):
    """usage.updated -> store the numbers, refresh the pars and the panel text."""
    for key in ('todayJpy', 'allTimeJpy', 'lastJpy', 'todayCalls', 'allTimeCalls'):
        if key in payload:
            USAGE_STATE[key] = payload.get(key)
    USAGE_STATE['purpose'] = str(payload.get('purpose', '') or '')
    USAGE_STATE['updatedAt'] = _utc_timestamp()
    try:
        comp = op(COST_SETTINGS_COMP_PATH)
        if comp is not None and comp.op(COST_DISPLAY_NAME) is None:
            install_cost_display()      # first message after a TD restart / fresh project
        else:
            _refresh_cost_display()
    except Exception as exc:
        _debug('cost display error: {}'.format(exc))


def _fetch_usage_snapshot():
    try:
        with urlopen(_server_base_url() + USAGE_API_PATH, timeout=0.5) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception:
        return {}


def _bootstrap_cost_display():
    """Runs a few frames after this DAT loads/reloads (never raises)."""
    try:
        snapshot = _fetch_usage_snapshot()
        today = snapshot.get('today', {}) if isinstance(snapshot, dict) else {}
        total = snapshot.get('allTime', {}) if isinstance(snapshot, dict) else {}
        if isinstance(today, dict) and 'jpy' in today:
            USAGE_STATE['todayJpy'] = today.get('jpy')
            USAGE_STATE['todayCalls'] = today.get('calls', 0)
        if isinstance(total, dict) and 'jpy' in total:
            USAGE_STATE['allTimeJpy'] = total.get('jpy')
            USAGE_STATE['allTimeCalls'] = total.get('calls', 0)
        install_cost_display()
    except Exception as exc:
        _debug('cost display bootstrap failed: {}'.format(exc))


# --- capture lifecycle (generation.* messages from the server) ----------------

def _controller_module():
    controller = op(CONTROLLER_DAT_PATH)
    return controller.module if controller is not None else None


def _remember(id_list, capture_id, limit=50):
    if capture_id and capture_id not in id_list:
        id_list.append(capture_id)
        del id_list[:-limit]


def _is_cancelled(capture_id):
    if not capture_id:
        return False
    if capture_id in CANCELLED_CAPTURE_IDS:
        return True
    controller = _controller_module()
    try:
        return bool(controller and controller.is_stale_capture(capture_id))
    except Exception:
        return False


def _display_all_at_once():
    comp = op(NETWORK_SETTINGS_COMP_PATH)
    par = getattr(comp.par, DISPLAY_TIMING_PAR, None) if comp is not None else None
    if par is None:
        return DEFER_DISPLAY_UNTIL_COMPLETE
    return str(par.eval()) != 'each'


def install_display_timing_parameter(target_path=NETWORK_SETTINGS_COMP_PATH):
    """Add the Displaytiming menu (all | each, default all) to the Capture page. Idempotent."""
    comp = op(target_path)
    if comp is None:
        raise ValueError('COMP not found: {}'.format(target_path))
    if getattr(comp.par, DISPLAY_TIMING_PAR, None) is None:
        page = next((p for p in comp.customPages if p.name == 'Capture'), None) or comp.appendCustomPage('Capture')
        par = page.appendMenu(DISPLAY_TIMING_PAR, label='Display Timing')[0]
        par.menuNames = [name for name, _ in DISPLAY_TIMING_MENU]
        par.menuLabels = [label for _, label in DISPLAY_TIMING_MENU]
        par.default = 'all' if DEFER_DISPLAY_UNTIL_COMPLETE else 'each'
        par.val = par.default
    return getattr(comp.par, DISPLAY_TIMING_PAR).eval()


def _is_deferred(capture_id):
    return _display_all_at_once() and bool(capture_id) and capture_id in LIFECYCLE_CAPTURE_IDS


def _reset_pending(capture_id='', expected_image_count=DEFAULT_IMAGE_COUNT):
    PENDING.update({
        'captureId': capture_id or '',
        'expectedImageCount': _clamp_image_count(expected_image_count),
        'payloads': {},
        'completed': False,
    })


def _buffer_payload(payload):
    capture_id = payload.get('captureId', '')
    scene_key = _normalize_scene_key(payload.get('sceneKey', ''))
    if scene_key not in SCENE_STATES:
        return False
    if capture_id != PENDING['captureId']:
        _reset_pending(capture_id, payload.get('expectedImageCount', DEFAULT_IMAGE_COUNT))
    PENDING['payloads'][scene_key] = payload
    return True


def _pending_is_complete():
    expected = min(len(KNOWN_SCENE_KEYS), PENDING['expectedImageCount'])
    return len(PENDING['payloads']) >= expected


def _flush_pending(capture_id, completed):
    """Display the buffered set of `capture_id` at once, then the ready fade."""
    if PENDING['captureId'] != capture_id or not PENDING['payloads']:
        return False
    payloads = sorted(PENDING['payloads'].values(), key=_scene_index)
    _reset_pending()
    _remember(DISPLAYED_CAPTURE_IDS, capture_id)
    for payload in payloads:
        _apply_capture_payload(payload)
    if completed and BATCH_STATE['captureId'] == capture_id:
        # The server says this is everything (it may have planned fewer
        # scenarios than requested), so the set counts as ready.
        BATCH_STATE['expectedImageCount'] = _clamp_image_count(len(payloads))
        BATCH_STATE['isReady'] = len(BATCH_STATE['receivedSceneKeys']) >= _expected_scene_count()
        if BATCH_STATE['isReady'] and not BATCH_STATE['completedAt']:
            BATCH_STATE['completedAt'] = _utc_timestamp()
    _trigger_ready_fade_if_needed()
    _debug('TimeWarp bridge: displayed capture {} ({} images)'.format(capture_id, len(payloads)))
    return True


def _handle_lifecycle(payload):
    msg_type = payload.get('type', '')
    capture_id = str(payload.get('captureId', '') or '')

    controller = _controller_module()
    if controller is not None:
        try:
            if msg_type == 'server.ready':
                controller.ensure_running()
            else:
                controller.on_server_message(payload)
        except Exception as exc:
            _debug('capture controller error: {}'.format(exc))

    if msg_type == 'generation.started':
        _remember(LIFECYCLE_CAPTURE_IDS, capture_id)
        if PENDING['captureId'] != capture_id:
            _reset_pending(capture_id, payload.get('imageCount', DEFAULT_IMAGE_COUNT))
    elif msg_type == 'generation.completed':
        if capture_id in DISPLAYED_CAPTURE_IDS:
            return
        if PENDING['captureId'] != capture_id or not _pending_is_complete():
            if AUTO_RECOVER_FROM_MANIFEST:
                # A capture.saved datagram went missing: fill in from the manifest.
                for item in _fetch_manifest_payloads(capture_id):
                    _buffer_payload(item)
        _flush_pending(capture_id, completed=True)
    elif msg_type == 'generation.cancelled':
        _remember(CANCELLED_CAPTURE_IDS, capture_id)
        if PENDING['captureId'] == capture_id:
            _debug('TimeWarp bridge: dropped {} buffered image(s) of cancelled capture {}'.format(
                len(PENDING['payloads']), capture_id))
            _reset_pending()
    elif msg_type == 'generation.failed':
        if PENDING['captureId'] == capture_id:
            if SHOW_PARTIAL_ON_FAILURE:
                _flush_pending(capture_id, completed=False)
            else:
                _reset_pending()


def _update_scene_text(payload):
    """Hand sceneText / nowText of a capture.saved datagram to /project1/ui_root/scene_text (never raises)."""
    try:
        box = op(SCENE_TEXT_SCRIPT_PATH)
        if box is not None:
            box.module.on_capture_payload(payload)
    except Exception as exc:
        _debug('scene text not updated: {}'.format(exc))


def _handle_alert(payload, msg_type):
    """Server 'alert' field (ComfyUI timeouts, auto-restart …) -> red strip via td_scene_text.set_alert.
    Shown while datagrams carry an alert; cleared by an empty alert or by a generation.completed
    without one. No field on other datagrams -> nothing changes. Never raises."""
    try:
        if 'alert' in payload:
            alert = payload.get('alert')
        elif msg_type == 'generation.completed':
            alert = None
        else:
            return
        box = op(SCENE_TEXT_SCRIPT_PATH)
        if box is not None and hasattr(box.module, 'set_alert'):
            box.module.set_alert(alert)
    except Exception as exc:
        _debug('alert not shown: {}'.format(exc))


def onReceive(dat, rowIndex, message, bytes, peer):
    try:
        payload = json.loads(message)
    except Exception as exc:
        _debug('TimeWarp bridge: invalid JSON {}'.format(exc))
        return

    if not isinstance(payload, dict):
        _debug('TimeWarp bridge: unsupported payload')
        return

    msg_type = str(payload.get('type', ''))
    _handle_alert(payload, msg_type)
    if msg_type == 'usage.updated':
        _handle_usage(payload)
        return
    if msg_type.startswith('generation.') or msg_type == 'server.ready':
        _handle_lifecycle(payload)
        return

    capture_id = payload.get('captureId', '')
    if _is_cancelled(capture_id):
        _debug('TimeWarp bridge: ignoring image of cancelled capture {}'.format(capture_id))
        return

    _annotate_distance(payload)   # payload['distanceSecSigned'] for the cone and the text panels
    _update_scene_text(payload)   # NOW/PAST/FUTURE text panels (td_scene_text.py); shown on arrival

    if PENDING['captureId'] == capture_id and PENDING['payloads'] and not _is_deferred(capture_id):
        # Displaytiming switched to 'each' while images of this capture were held back.
        _flush_pending(capture_id, completed=False)

    if _is_deferred(capture_id):
        if not _buffer_payload(payload):
            _debug('TimeWarp bridge: unsupported capture payload')
            return
        if _pending_is_complete():
            _flush_pending(capture_id, completed=False)
        return

    # Untracked capture (no generation.started seen): display image by image.
    if not _apply_capture_payload(payload):
        _debug('TimeWarp bridge: unsupported capture payload')
        return

    if AUTO_RECOVER_FROM_MANIFEST and not BATCH_STATE['isReady']:
        resync_latest_scenes(payload.get('captureId', ''))

    _trigger_ready_fade_if_needed()


# Create / refresh the cost display shortly after this DAT is (re)loaded.
try:
    run('op({!r}).module._bootstrap_cost_display()'.format(SCRIPT_DAT_PATH), delayFrames=3)
except Exception as _exc:
    _debug('cost display bootstrap not scheduled: {}'.format(_exc))
