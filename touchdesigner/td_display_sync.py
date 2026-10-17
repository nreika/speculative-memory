# -*- coding: utf-8 -*-
"""
Pure helpers for the TouchDesigner display sync (no TouchDesigner API in here).

td_capture_listener.py calls these to
  * fetch GET /api/latest-prediction and GET /api/action-history (run on a worker thread),
  * turn the JSON into rows / text for the DATs on /project1
    (scenario_current, observation_current, history_current, scenario_latest, action_log),
  * decide when the display fade-in has to be (re)played.

Keep this file free of `op()`, `me`, `run()` so `python -I tests/test_display_sync.py` can test it.
In TD it lives next to the listener as the file-synced DAT /project1/td_display_sync.
"""

import json
import time
from datetime import datetime, timedelta

try:
    from urllib.request import Request, urlopen
except ImportError:  # pragma: no cover (TD always has py3)
    from urllib2 import Request, urlopen

LATEST_PREDICTION_PATH = '/api/latest-prediction'
ACTION_HISTORY_PATH = '/api/action-history'
RESET_HISTORY_PATH = '/api/reset-history'
HISTORY_LIMIT = 50
PREDICTION_RETRIES = 3          # latest-prediction may trail capture.saved by a moment
PREDICTION_RETRY_WAIT_SEC = 1.0

SCENARIO_HEADER = ['sceneKey', 'label', 'text']
HISTORY_HEADER = ['time(JST)', 'captureId', 'observation', 'hasPerson']

NOW_MARK = u'■ 現在'   # "■ 現在"
SCENE_MARK = u'●'               # "●"


# --- HTTP (worker thread; plain urllib) -------------------------------------------

def http_json(url, timeout=3.0, data=None):
    """GET (data None) or POST JSON. Returns (status, parsed_json_or_None). Never raises."""
    try:
        if data is None:
            request = Request(url)
        else:
            request = Request(
                url,
                data=json.dumps(data).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
            )
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode('utf-8')
            status = getattr(response, 'status', 200)
        return status, (json.loads(body) if body else None)
    except Exception as exc:  # HTTPError (404 etc.), URLError, bad JSON ...
        status = getattr(exc, 'code', 0) or 0
        return status, None


# --- formatting -------------------------------------------------------------------

def normalize_latest_prediction(data, known_scene_keys=()):
    """latest-prediction JSON -> {'captureId', 'observation', 'rows': [[sceneKey, label, text], ...]} or None."""
    if not isinstance(data, dict):
        return None
    rows = []
    for index, scene in enumerate(data.get('scenarios') or []):
        if not isinstance(scene, dict):
            continue
        scene_key = str(scene.get('sceneKey') or '')
        if not scene_key:
            scene_key = known_scene_keys[index] if index < len(known_scene_keys) else 'gen_{}'.format(index)
        rows.append([scene_key, str(scene.get('label') or ''), str(scene.get('text') or '')])
    return {
        'captureId': str(data.get('captureId') or ''),
        'observation': str(data.get('observation') or ''),
        'rows': rows,
    }


def scenario_table_rows(rows):
    return [list(SCENARIO_HEADER)] + [list(row) for row in rows]


def format_scenario_latest(capture_id, observation, rows):
    """Readable text of the newest capture: [captureId], ■ 現在, ● ラベル (sceneKey)."""
    blocks = ['[captureId: {}]'.format(capture_id or '<unknown>')]
    if observation:
        blocks.append(u'{}\n{}'.format(NOW_MARK, observation))
    for scene_key, label, text in rows:
        blocks.append(u'{} {} ({})\n{}'.format(SCENE_MARK, label or scene_key, scene_key, text))
    return '\n\n'.join(blocks) + '\n'


def format_jst(at):
    """'2026-10-15T14:47:06' (server: already JST, no zone) -> '2026-10-15 14:47:06'.
    A trailing 'Z' / '+00:00' marks UTC and is converted to JST."""
    raw = str(at or '').strip()
    if not raw:
        return ''
    is_utc = raw.endswith('Z') or raw.endswith('+00:00')
    stamp = raw.replace('Z', '').replace('+00:00', '').split('.')[0].replace('T', ' ')
    try:
        parsed = datetime.strptime(stamp, '%Y-%m-%d %H:%M:%S')
    except Exception:
        return raw
    if is_utc:
        parsed = parsed + timedelta(hours=9)
    return parsed.strftime('%Y-%m-%d %H:%M:%S')


def history_table_rows(history):
    """action-history JSON -> header + rows, newest first."""
    items = history.get('items') if isinstance(history, dict) else None
    entries = [item for item in (items or []) if isinstance(item, dict)]
    entries.sort(key=lambda item: format_jst(item.get('at', '')), reverse=True)
    rows = [list(HISTORY_HEADER)]
    for item in entries:
        rows.append([
            format_jst(item.get('at', '')),
            str(item.get('captureId') or ''),
            str(item.get('observation') or ''),
            1 if item.get('hasPerson') else 0,
        ])
    return rows


def action_log_text(history):
    text = history.get('text') if isinstance(history, dict) else ''
    return str(text or '')


# --- fade decisions ---------------------------------------------------------------

def should_trigger_fade(last_capture_id, capture_id):
    """True unless this captureId already played its fade (an empty id always plays)."""
    return not (capture_id and last_capture_id == capture_id)


def fade_out_hold_ms(current, lag_down_sec, override_ms=None):
    """How long to keep the fade at 0 so fade_lag has fallen to black before it is raised again."""
    if override_ms is not None:
        return float(override_ms)
    try:
        return max(0.0, float(current)) * float(lag_down_sec) * 1000.0 + 120.0
    except Exception:
        return 1600.0


def fade_action(visible):
    """'refade' = drop to 0, then raise after the hold (replay from black); 'raise' = just raise."""
    return 'refade' if visible else 'raise'


# --- one fetch for a finished batch (worker thread) -------------------------------

def fetch_display_data(base_url, capture_id, known_scene_keys=(), history_limit=HISTORY_LIMIT, sleep=time.sleep):
    """GET latest-prediction (+ retries until its captureId matches) and action-history.

    Returns {'captureId', 'prediction': normalized-or-None, 'history': json-or-None, 'errors': [str]}.
    prediction is None when the server has none (404) or only an older capture's after the retries.
    """
    base = str(base_url or '').rstrip('/')
    result = {'captureId': capture_id or '', 'prediction': None, 'history': None, 'errors': []}

    for attempt in range(PREDICTION_RETRIES):
        status, data = http_json(base + LATEST_PREDICTION_PATH, timeout=3.0)
        normalized = normalize_latest_prediction(data, known_scene_keys) if status == 200 else None
        if normalized is not None and (not capture_id or normalized['captureId'] in ('', capture_id)):
            result['prediction'] = normalized
            break
        if status not in (0, 200, 404):
            result['errors'].append('latest-prediction HTTP {}'.format(status))
            break
        if attempt + 1 < PREDICTION_RETRIES:
            sleep(PREDICTION_RETRY_WAIT_SEC)
    if result['prediction'] is None:
        result['errors'].append('latest-prediction unavailable for {}'.format(capture_id or '<unknown>'))

    status, history = http_json('{}{}?limit={}'.format(base, ACTION_HISTORY_PATH, int(history_limit)), timeout=3.0)
    if status == 200 and isinstance(history, dict):
        result['history'] = history
    else:
        result['errors'].append('action-history unavailable (HTTP {})'.format(status))
    return result


def post_reset_history(base_url):
    """POST /api/reset-history -> {'ok': bool, 'archived': path-or-None, 'status': int}.
    Server answers {ok: true, archivedTo: <relative path>|null} (older drafts: success/archived)."""
    status, data = http_json(str(base_url or '').rstrip('/') + RESET_HISTORY_PATH, timeout=5.0, data={})
    body = data if isinstance(data, dict) else {}
    flag = body.get('ok', body.get('success', False))
    return {
        'ok': status == 200 and bool(flag),
        'status': status,
        'archived': body.get('archivedTo', body.get('archived')),
    }
