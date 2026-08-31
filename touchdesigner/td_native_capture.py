# -*- coding: utf-8 -*-
"""
Phase 2 - TouchDesigner-native capture.

Grabs one frame straight from a TOP (the live camera, e.g. a Video Device In TOP)
and hands it to the local generation server, which runs the VLM + ComfyUI/Qwen
pipeline and broadcasts the finished images back over UDP - exactly the payloads
td_capture_listener.py already understands. No browser in the loop.

Setup in TouchDesigner
----------------------
1. Camera:   Video Device In TOP  ->  name it 'camera'  (or set CAMERA_TOP_PATH)
2. This file: put it in a Text DAT named 'td_native_capture'
3. Trigger:  a Timer CHOP (cycle = 30s). In its Callbacks DAT `onCycle`:
       op('td_native_capture').module.capture()
   (replaces the old  op('td_capture_panel_controls').module.request_capture()  )
4. Keep td_capture_listener.py on the UDP In DAT as before - unchanged.

The server does the rest: POST /api/generate -> captures/ + UDP notify.
"""

import json
import os
import tempfile
import threading

try:
    from urllib.request import Request, urlopen
except ImportError:  # py2 (older TD)
    from urllib2 import Request, urlopen

# --- config ---------------------------------------------------------------
SERVER_URL = 'http://127.0.0.1:3000/api/generate'
CAMERA_TOP_PATH = 'camera'          # TOP to capture the current frame from
GENERATION_COUNT_OP_PATH = '/project1/generation_count'   # optional CHOP/parameter
DEFAULT_IMAGE_COUNT = 3
REQUEST_TIMEOUT_SECONDS = 900        # 3 x Qwen passes can take minutes
SAVE_FORMAT = '.jpg'                 # .jpg keeps the POST body small
# -----------------------------------------------------------------------------

_busy_lock = threading.Lock()
_busy = {'value': False}


def _debug(message):
    print('[TD Native Capture] {}'.format(message))


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


def _post(data_url, image_count):
    body = json.dumps({
        'image': data_url,
        'imageCount': image_count,
        'sceneTime': _local_iso_now(),
    }).encode('utf-8')
    request = Request(SERVER_URL, data=body, headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode('utf-8') or '{}')


def _local_iso_now():
    from datetime import datetime
    return datetime.now().strftime('%Y-%m-%dT%H:%M:%S')


def _run(data_url, image_count):
    try:
        _debug('frame sent ({} b64 chars), requesting {} scenes...'.format(len(data_url), image_count))
        result = _post(data_url, image_count)
        _debug('server done: captureId={} count={}'.format(
            result.get('captureId'), result.get('count')))
    except Exception as exc:
        _debug('capture failed: {}'.format(exc))
    finally:
        with _busy_lock:
            _busy['value'] = False


def capture():
    """Call this from the Timer CHOP onCycle callback (or a button).

    The frame is grabbed here on the main TD thread; only the (slow) HTTP
    request runs on a background thread.
    """
    with _busy_lock:
        if _busy['value']:
            _debug('still generating the previous set - skipping this cycle')
            return
        _busy['value'] = True

    try:
        data_url = _grab_frame_b64()
        count = _image_count()
    except Exception as exc:
        _debug('frame grab failed: {}'.format(exc))
        with _busy_lock:
            _busy['value'] = False
        return

    threading.Thread(target=_run, args=(data_url, count), daemon=True).start()
    return True
