import json
import re
from datetime import datetime, timedelta

try:
    from urllib.request import Request, urlopen
except ImportError:
    from urllib2 import Request, urlopen

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
LATEST_CAPTURES_URL = 'http://127.0.0.1:3000/api/latest-captures'
AUTO_RECOVER_FROM_MANIFEST = True
AUTO_FADE_IN_ON_CAPTURE_READY = True
DISPLAY_FADE_STATE_OP_PATH = '/project1/fade_state'
DISPLAY_FADE_EXEC_DAT_PATH = '/project1/start_display_exec'
DISPLAY_FADE_LAG_OP_PATH = '/project1/fade_lag'
FADE_REARM_HOLD_MS = None  # None -> derive from fade_lag down time; or set an int (ms)

# --- Text ingestion (scenarios / analysis) --------------------------------
SCENARIO_LOG_DAT_PATH = '/project1/scenario_log'            # full prediction_data.md
ACTION_LOG_DAT_PATH = '/project1/action_log'                # full action_log.jsonl
SCENARIO_CURRENT_DAT_PATH = '/project1/scenario_current'    # table: sceneKey / label / text
OBSERVATION_CURRENT_DAT_PATH = '/project1/observation_current'  # current "what the person is doing"
HISTORY_CURRENT_DAT_PATH = '/project1/history_current'      # table: at / captureId / observation (newest first)
SCENARIO_LATEST_DAT_PATH = '/project1/scenario_latest'      # readable text of the newest capture only
PREDICTION_LOG_FILE = r'C:/Users/81808/Desktop/speculative-memory-main/captures/prediction_data.md'
ACTION_LOG_FILE = r'C:/Users/81808/Desktop/speculative-memory-main/captures/action_log.jsonl'
LATEST_PREDICTION_URL = 'http://127.0.0.1:3000/api/latest-prediction'  # optional (phase 2)
RESET_HISTORY_URL = 'http://127.0.0.1:3000/api/reset-history'          # Stream Deck history reset
RELOAD_RETRY_FRAMES = (1, 6)
DEFAULT_IMAGE_COUNT = 3
MIN_IMAGE_COUNT = 1
MAX_IMAGE_COUNT = 10

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
}
_LAST_FADE_CAPTURE_ID = {'value': None}
_PENDING_FADE_REARM = {'run': None}


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
    if not LATEST_CAPTURES_URL:
        return {}

    try:
        with urlopen(LATEST_CAPTURES_URL, timeout=1.0) as response:
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


def resync_latest_scenes(expected_capture_id=''):
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
        payloads.append(payload)

    payloads.sort(
        key=lambda item: item.get('sceneIndex', 0)
        if isinstance(item.get('sceneIndex', 0), int)
        else 0
    )
    for payload in payloads:
        _apply_capture_payload(payload)
    return bool(payloads)


def _display_currently_visible():
    fade_lag = op(DISPLAY_FADE_LAG_OP_PATH)
    if fade_lag is not None and getattr(fade_lag, 'numChans', 0) > 0:
        return fade_lag['chan1'] > 0.001

    fade_state = op(DISPLAY_FADE_STATE_OP_PATH)
    return fade_state is not None and fade_state.par.const0value.eval() > 0.5


def _fade_out_hold_ms(fade_lag):
    if FADE_REARM_HOLD_MS is not None:
        return FADE_REARM_HOLD_MS
    try:
        lag_down = fade_lag.par.lag2.eval()
        current = fade_lag['chan1'] if getattr(fade_lag, 'numChans', 0) > 0 else 1.0
        return max(0.0, current) * lag_down * 1000.0 + 120.0
    except Exception:
        return 1600.0


def _kill_pending_fade_rearm():
    pending = _PENDING_FADE_REARM.get('run')
    if pending is not None:
        try:
            pending.kill()
        except Exception:
            pass
    _PENDING_FADE_REARM['run'] = None


def _trigger_display_fade_in(capture_id):
    if not AUTO_FADE_IN_ON_CAPTURE_READY:
        return

    if capture_id and _LAST_FADE_CAPTURE_ID['value'] == capture_id:
        return
    _LAST_FADE_CAPTURE_ID['value'] = capture_id

    # Cancel the SHOW button's auto fade-out so the new batch stays up.
    display_exec = op(DISPLAY_FADE_EXEC_DAT_PATH)
    if display_exec is not None:
        try:
            display_exec.module.cancel_pending()
        except Exception:
            pass

    _kill_pending_fade_rearm()

    fade_state = op(DISPLAY_FADE_STATE_OP_PATH)
    if fade_state is None:
        _debug('Fade state CHOP not found: {}'.format(DISPLAY_FADE_STATE_OP_PATH))
        return

    fade_lag = op(DISPLAY_FADE_LAG_OP_PATH)

    if _display_currently_visible():
        # Already showing: drop to 0 first so the fade-in replays from black.
        # (With fade_lag down time near 0 this is an instant cut, then fade in.)
        fade_state.par.const0value = 0
        if fade_lag is not None:
            fade_lag.cook(force=True)
        hold_ms = _fade_out_hold_ms(fade_lag)
        _PENDING_FADE_REARM['run'] = run(
            "op({!r}).module._raise_fade_state()".format(SCRIPT_DAT_PATH),
            delayMilliSeconds=hold_ms
        )
        _debug(
            'Display re-fade for capture batch {} (hold {:.0f}ms).'.format(
                capture_id or '<unknown>', hold_ms
            )
        )
    else:
        fade_state.par.const0value = 1
        _debug('Display fade-in for capture batch {}.'.format(capture_id or '<unknown>'))


def _raise_fade_state():
    _PENDING_FADE_REARM['run'] = None
    fade_state = op(DISPLAY_FADE_STATE_OP_PATH)
    if fade_state is not None:
        fade_state.par.const0value = 1


def _reload_text_dat(path):
    text_dat = op(path)
    if text_dat is not None and getattr(text_dat.par, 'loadonstartpulse', None) is not None:
        text_dat.par.loadonstartpulse.pulse()


def _read_prediction_md():
    log_dat = op(SCENARIO_LOG_DAT_PATH)
    if log_dat is not None and log_dat.text:
        return log_dat.text
    try:
        with open(PREDICTION_LOG_FILE, 'r', encoding='utf-8') as handle:
            return handle.read()
    except Exception:
        return ''


def _parse_prediction_md_section(md_text, capture_id):
    """Return (observation, [(label, text), ...]) for the capture_id block."""
    lines = md_text.splitlines()
    target = '- captureId: {}'.format(capture_id)
    start = None
    for index, line in enumerate(lines):
        if line.strip() == target:
            start = index
            break
    if start is None:
        return '', []

    items = []
    observation_buf = []
    section = None          # None -> 'observation' -> 'prediction'
    label = None
    buffer = []
    for line in lines[start + 1:]:
        if line.startswith('## Capture'):
            break
        stripped = line.strip()
        if re.match(r'###\s*Observation\s*$', stripped):
            section = 'observation'
            observation_buf = []
            continue
        match = re.match(r'###\s*Prediction_Data\s*\(([^)]*)\)(?:\s*-\s*(.*))?\s*$', stripped)
        if match:
            if label is not None:
                items.append((label, '\n'.join(buffer).strip()))
            section = 'prediction'
            label = (match.group(2) or match.group(1) or '').strip()
            buffer = []
        elif section == 'prediction' and label is not None:
            buffer.append(line)
        elif section == 'observation':
            observation_buf.append(line)
    if label is not None:
        items.append((label, '\n'.join(buffer).strip()))
    return '\n'.join(observation_buf).strip(), items


def _fetch_latest_prediction(capture_id):
    """Phase 2: structured current batch text from the server. Optional."""
    if not LATEST_PREDICTION_URL:
        return None
    try:
        with urlopen(LATEST_PREDICTION_URL, timeout=1.0) as response:
            data = json.loads(response.read().decode('utf-8'))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if capture_id and str(data.get('captureId', '')) not in ('', str(capture_id)):
        return None
    return data


def _update_scenario_dats(capture_id):
    _reload_text_dat(SCENARIO_LOG_DAT_PATH)
    _reload_text_dat(ACTION_LOG_DAT_PATH)

    table = op(SCENARIO_CURRENT_DAT_PATH)
    observation_dat = op(OBSERVATION_CURRENT_DAT_PATH)

    server_data = _fetch_latest_prediction(capture_id)

    rows = []
    observation = ''
    if server_data:
        observation = str(server_data.get('observation', '') or '')
        for index, scene in enumerate(server_data.get('scenarios', []) or []):
            if not isinstance(scene, dict):
                continue
            scene_key = scene.get('sceneKey') or (
                KNOWN_SCENE_KEYS[index] if index < len(KNOWN_SCENE_KEYS) else 'gen_{}'.format(index)
            )
            rows.append([scene_key, scene.get('label', ''), scene.get('text', '')])

    if not rows:
        # Fall back to parsing the accumulating markdown document.
        md_observation, md_items = _parse_prediction_md_section(_read_prediction_md(), capture_id)
        if not observation:
            observation = md_observation
        for index, (label, text) in enumerate(md_items):
            scene_key = KNOWN_SCENE_KEYS[index] if index < len(KNOWN_SCENE_KEYS) else 'gen_{}'.format(index)
            rows.append([scene_key, label, text])

    if table is not None:
        table.clear()
        table.appendRow(['sceneKey', 'label', 'text'])
        for row in rows:
            table.appendRow(row)

    if observation_dat is not None and observation:
        observation_dat.text = observation

    _update_history_dat()
    _update_scenario_latest_dat(capture_id, observation, rows)

    _debug(
        'Text ingest for capture {}: {} scenario rows{}.'.format(
            capture_id or '<unknown>',
            len(rows),
            ', observation set' if observation else ''
        )
    )


def _read_action_log_entries():
    text = ''
    log_dat = op(ACTION_LOG_DAT_PATH)
    if log_dat is not None and log_dat.text:
        text = log_dat.text
    if not text:
        try:
            with open(ACTION_LOG_FILE, 'r', encoding='utf-8') as handle:
                text = handle.read()
        except Exception:
            text = ''

    entries = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if isinstance(entry, dict) and entry.get('observation'):
            entries.append(entry)
    return entries


def _format_jst(iso_utc):
    try:
        stamp = str(iso_utc).replace('Z', '').split('.')[0]
        parsed = datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%S') + timedelta(hours=9)
        return parsed.strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return str(iso_utc or '')


def _update_history_dat():
    table = op(HISTORY_CURRENT_DAT_PATH)
    if table is None:
        return

    entries = _read_action_log_entries()
    table.clear()
    table.appendRow(['time', 'captureId', 'observation'])
    for entry in reversed(entries):  # newest first
        table.appendRow([
            _format_jst(entry.get('at', '')),
            entry.get('captureId', ''),
            entry.get('observation', ''),
        ])


def _update_scenario_latest_dat(capture_id, observation, rows):
    dat = op(SCENARIO_LATEST_DAT_PATH)
    if dat is None:
        return

    blocks = ['[captureId: {}]'.format(capture_id or '<unknown>')]
    if observation:
        blocks.append('■ 現在\n{}'.format(observation))
    for scene_key, label, text in rows:
        blocks.append('● {} ({})\n{}'.format(label or scene_key, scene_key, text))
    dat.text = '\n\n'.join(blocks) + '\n'


def reset_history():
    """Archive the accumulated history on the server and clear every TD-side view.

    Bound to a Stream Deck button (Shift+Ctrl+Alt+n) for demo turnover. If the
    server is unreachable the TD-side views are still cleared.
    """
    server_ok = False
    try:
        request = Request(
            RESET_HISTORY_URL,
            data=b'{}',
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urlopen(request, timeout=3.0) as response:
            result = json.loads(response.read().decode('utf-8'))
        server_ok = bool(result.get('success'))
        _debug('History archived on server: {}'.format(result.get('archived') or '(nothing)'))
    except Exception as exc:
        _debug('Server history reset failed ({}); clearing TD side only.'.format(exc))

    # TD-side batch / fade state
    _LAST_FADE_CAPTURE_ID['value'] = None
    _kill_pending_fade_rearm()
    _reset_batch('', DEFAULT_IMAGE_COUNT)

    # Reload the now-empty raw log DATs and clear the derived views.
    _reload_text_dat(SCENARIO_LOG_DAT_PATH)
    _reload_text_dat(ACTION_LOG_DAT_PATH)
    for table_path in (SCENARIO_CURRENT_DAT_PATH, HISTORY_CURRENT_DAT_PATH):
        table = op(table_path)
        if table is not None:
            table.clear()
    for text_path in (OBSERVATION_CURRENT_DAT_PATH, SCENARIO_LATEST_DAT_PATH):
        text_dat = op(text_path)
        if text_dat is not None:
            text_dat.text = ''

    _debug('History reset complete (server_ok={}).'.format(server_ok))
    return server_ok


def onReceive(dat, rowIndex, message, bytes, peer):
    try:
        payload = json.loads(message)
    except Exception as exc:
        _debug('TimeWarp bridge: invalid JSON {}'.format(exc))
        return

    if not _apply_capture_payload(payload):
        _debug('TimeWarp bridge: unsupported capture payload')
        return

    if AUTO_RECOVER_FROM_MANIFEST and not BATCH_STATE['isReady']:
        resync_latest_scenes(payload.get('captureId', ''))

    if BATCH_STATE['isReady']:
        _update_scenario_dats(BATCH_STATE['captureId'])
        _trigger_display_fade_in(BATCH_STATE['captureId'])

