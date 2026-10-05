import json
from datetime import datetime

try:
    from urllib.request import urlopen
except ImportError:
    from urllib2 import urlopen

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
LATEST_CAPTURES_URL = 'http://127.0.0.1:3000/api/latest-captures'
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
# A failed capture (e.g. ComfyUI error on image 2) shows nothing by default;
# True shows the images it did deliver (the old behaviour).
SHOW_PARTIAL_ON_FAILURE = False

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


def _trigger_ready_fade_if_needed():
    if not BATCH_STATE['isReady'] or BATCH_STATE['fadeTriggered']:
        return

    if _start_ready_fade():
        BATCH_STATE['fadeTriggered'] = True
        _debug('TimeWarp bridge: ready fade started for capture {}'.format(BATCH_STATE['captureId']))

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
        payloads.append(payload)
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


def _is_deferred(capture_id):
    return DEFER_DISPLAY_UNTIL_COMPLETE and bool(capture_id) and capture_id in LIFECYCLE_CAPTURE_IDS


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
    if msg_type.startswith('generation.') or msg_type == 'server.ready':
        _handle_lifecycle(payload)
        return

    capture_id = payload.get('captureId', '')
    if _is_cancelled(capture_id):
        _debug('TimeWarp bridge: ignoring image of cancelled capture {}'.format(capture_id))
        return

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


