# -*- coding: utf-8 -*-
"""
Scene descriptions for the 4 images (NOW and scenes A / B / C) on the Perform
panel (/project1/ui_root).

Four labelled text panels in the band under the main frames (left of it sits the
cost_display, above it the ui_root frames). On-screen order stays NOW, C, A, B:

  NOW       the scene-recognition result of the captured frame, as the model said it
  C         what the model described for scene C (gen_c), e.g. "C  PAST -2 m 00 s"
  A         ... for scene A (gen_a), e.g. "A  FUTURE +30 s"
  B         ... for scene B (gen_b), e.g. "B  FUTURE +30 s"

Every scene has its own signed temporal distance (negative = past, positive =
future); the title shows the distance the displayed image was really generated
with, taken from its own capture.saved payload (payload['distanceSecSigned'],
set by td_capture_listener; fallback: distanceSigned true -> distanceSec is
signed, otherwise the old rule gen_c = past, gen_a / gen_b = future). A panel
without a known distance shows just "C  PAST" / "A  FUTURE" / "B  FUTURE".

Only the content text is shown. The server sends the model's scenario
description (never the image-prompt boilerplate such as QUALITY_SUFFIX / hard
rules) in the capture.saved datagram: sceneText (per image), nowText (same on
every image of a capture) and distanceSec. td_capture_listener calls
on_capture_payload() as soon as such a datagram arrives (before its own
"wait until all images are there" buffering), so the text appears together with
the Cone figure. A new captureId clears the four panels first.

Long text is scrollable: every body is a Text COMP (type multiline) with a vertical
scrollbar (always shown; mouse wheel or drag).

Everything lives in the container /project1/ui_root/scene_text (created by
build(), idempotent). This DAT is file-synced (touchdesigner/td_scene_text.py);
it lives at /project1/ui_root/scene_text/script.
"""

ROOT_PATH = '/project1/ui_root'
BOX_NAME = 'scene_text'

# ui_root coordinates (= /project1 pixels), origin bottom-left. Band y 40..280
# (2026-10-16): above the number-button bar (0..35), below the row of output images
# (ui_root/gen_view_*, y 284..416) that sits under the Future Cone frame (y>=420).
# x starts right of cost_display (8..~270); the right edge stays 4 px inside the
# 1280 px display so nothing is clipped.
BOX_X, BOX_Y, BOX_W, BOX_H = 280, 40, 996, 240
GAP = 6
LABEL_H = 18
FONT = 'Yu Gothic UI'
BODY_FONT_SIZE = 12
LABEL_FONT_SIZE = 12

_RESERVED = '—'                                   # em dash: nothing received yet
_WAIT = '—'

# order on screen: NOW, C, A, B (panel key 'past' = scene C, kept for the existing operator names p_past)
PANELS = (
    ('now', 'NOW', (0.92, 0.92, 0.92)),
    ('past', 'C', (0.30, 0.65, 1.00)),
    ('a', 'A', (1.00, 0.62, 0.26)),
    ('b', 'B', (0.93, 0.36, 0.58)),
)
SCENE_KEY_TO_PANEL = {'gen_a': 'a', 'gen_b': 'b', 'gen_c': 'past'}
DEFAULT_WORD = {'past': 'PAST', 'a': 'FUTURE', 'b': 'FUTURE'}   # until a distance is known
DEFAULT_DISTANCES = {'past': -30, 'a': 30, 'b': 30}
MINUS = u'−'

# Hand-typed extras per scene, mixed into the prompt for that scene. The lower half of
# panels C / A / B (as tall as the scene description above it) holds two multi-line fields:
#   'in'   継続     sent with every capture until edited
#   'in1'  次回のみ  sent with the next capture only, then cleared (get_extras(consume=True),
#                   called by td_native_capture when a capture starts)
# Both go to the server as one string per scene: '継続 / 次回のみ'.
EXTRA_PANELS = ('past', 'a', 'b')
PANEL_TO_SCENE_KEY = {v: k for k, v in SCENE_KEY_TO_PANEL.items()}
INPUT_H = (BOX_H - LABEL_H) // 2
EXTRA_FIELDS = (('in', u'継続'), ('in1', u'次回のみ'))     # top, bottom
EXTRA_JOIN = u' / '

# 'dist': signed seconds per panel key of the capture shown (None = unknown)
_S = {'cur': None, 'dist': {}, 'text': {}}


def _debug(message):
    print('[TD Scene Text] {}'.format(message))


def _box():
    return op('{}/{}'.format(ROOT_PATH, BOX_NAME))


def format_signed(distance):
    """'+30 s', '-2 m 00 s' (real minus sign), '+10 m 00 s'."""
    distance = float(distance)
    sign = MINUS if distance < 0 else '+'
    magnitude = abs(distance)
    if magnitude < 60:
        return u'{}{:g} s'.format(sign, round(magnitude, 1))
    minutes, seconds = divmod(int(round(magnitude)), 60)
    return u'{}{} m {:02d} s'.format(sign, minutes, seconds)


def signed_from_payload(payload, key):
    """Signed distance of a capture.saved payload for panel `key`, or None."""
    value = payload.get('distanceSecSigned')
    if value is None:
        raw = payload.get('distanceSec')
        if raw is None or isinstance(raw, bool):
            return None
        try:
            value = float(raw)
        except Exception:
            return None
        if payload.get('distanceSigned') is not True:
            value = -abs(value) if key == 'past' else abs(value)
    try:
        value = float(value)
    except Exception:
        return None
    return None if value != value else value


def _title(key, base, distance):
    """'NOW', 'A  FUTURE +30 s', 'C  PAST -2 m 00 s'; without a distance 'A  FUTURE'."""
    if key == 'now':
        return base
    if distance is None:
        return u'{}  {}'.format(base, DEFAULT_WORD[key])
    return u'{}  {} {}'.format(base, 'PAST' if float(distance) < 0 else 'FUTURE', format_signed(distance))


def build():
    """Create / refresh the four panels (idempotent). Returns the container path."""
    root = op(ROOT_PATH)
    if root is None:
        raise ValueError('ui_root not found: {}'.format(ROOT_PATH))
    box = root.op(BOX_NAME)
    if box is None:
        box = root.create(containerCOMP, BOX_NAME)
    box.par.x, box.par.y, box.par.w, box.par.h = BOX_X, BOX_Y, BOX_W, BOX_H
    box.par.hmode = 'fixed'
    box.par.vmode = 'fixed'
    box.par.layer = 5
    box.par.display = True
    box.par.bgalpha = 0.0
    box.par.alignorder = 0
    box.nodeX = -400
    box.nodeY = -1500

    pw = (BOX_W - GAP * (len(PANELS) - 1)) / float(len(PANELS))
    for i, (key, base, color) in enumerate(PANELS):
        pname = 'p_' + key
        panel = box.op(pname)
        if panel is None:
            panel = box.create(containerCOMP, pname)
        panel.par.hmode = panel.par.vmode = 'fixed'
        panel.par.x = i * (pw + GAP)
        panel.par.y = 0
        panel.par.w = pw
        panel.par.h = BOX_H
        panel.par.bgcolorr = panel.par.bgcolorg = panel.par.bgcolorb = 0.06
        panel.par.bgalpha = 1.0
        panel.par.borderar, panel.par.borderag, panel.par.borderab = color
        panel.par.borderaalpha = 0.9
        panel.par.borderbr, panel.par.borderbg, panel.par.borderbb = color
        panel.par.borderbalpha = 0.9
        panel.par.leftborder = panel.par.rightborder = 1
        panel.par.topborder = panel.par.bottomborder = 1
        panel.par.display = True
        panel.nodeX = i * 200
        panel.nodeY = 0

        lb = panel.op('lb')
        if lb is None:
            lb = panel.create(textCOMP, 'lb')
        lb.par.hmode = lb.par.vmode = 'fixed'
        lb.par.x, lb.par.y, lb.par.w, lb.par.h = 0, BOX_H - LABEL_H, pw, LABEL_H
        lb.par.font = FONT
        lb.par.fontsize = LABEL_FONT_SIZE
        lb.par.fontcolorr, lb.par.fontcolorg, lb.par.fontcolorb = color
        lb.par.alignx = 'left'
        lb.par.aligny = 'center'
        lb.par.textpaddingl = 6
        lb.par.bgalpha = 0.0
        lb.par.editmode = 'locked'
        lb.par.enable = False
        lb.par.text = _title(key, base, None)
        lb.nodeX, lb.nodeY = 0, 0

        input_h = INPUT_H if key in EXTRA_PANELS or key == 'now' else 0
        if key in EXTRA_PANELS:
            _build_input(panel, pw, color)
        elif key == 'now':
            _build_summary(panel, pw, color)

        tx = panel.op('tx')
        if tx is None:
            tx = panel.create(textCOMP, 'tx')
        tx.par.hmode = tx.par.vmode = 'fixed'
        tx.par.x, tx.par.y, tx.par.w, tx.par.h = 0, input_h, pw, BOX_H - LABEL_H - input_h
        tx.par.font = FONT
        tx.par.fontsize = BODY_FONT_SIZE
        tx.par.fontcolorr = tx.par.fontcolorg = tx.par.fontcolorb = 0.92
        tx.par.alignx = 'left'
        tx.par.aligny = 'top'
        tx.par.type = 'multiline'   # 'string' ignores line breaks
        tx.par.wordwrap = True
        tx.par.textpaddingl = 6
        tx.par.textpaddingr = 6
        tx.par.bgalpha = 0.0
        tx.par.editmode = 'locked'
        tx.par.enable = True        # must take the mouse (wheel / scrollbar drag)
        tx.par.mousewheel = True    # wheel scrolling
        tx.par.pvscrollbar = 'on'
        tx.par.phscrollbar = 'off'
        tx.par.scrollbarthickness = 10
        tx.par.text = _WAIT
        tx.nodeX, tx.nodeY = 200, 0
    return box.path


def _build_input(panel, pw, color):
    """The two extras fields (see EXTRA_FIELDS) in the lower half of a scene panel, each
    with a small caption at its top right. Keeps their text."""
    fh = INPUT_H // len(EXTRA_FIELDS)
    for i, (name, caption) in enumerate(EXTRA_FIELDS):
        y = 2 + (len(EXTRA_FIELDS) - 1 - i) * fh
        field = _build_field(panel, name, 2, y, pw - 4, fh - 2, color, once=(name == 'in1'))
        cap = panel.op(name + '_cap') or panel.create(textCOMP, name + '_cap')
        cap.par.hmode = cap.par.vmode = 'fixed'
        cap.par.x, cap.par.y, cap.par.w, cap.par.h = pw - 70, y + fh - 16, 64, 13
        cap.par.font = FONT
        cap.par.fontsize = 9
        cap.par.fontcolorr, cap.par.fontcolorg, cap.par.fontcolorb = [0.75 * c for c in color]
        cap.par.alignx = 'right'
        cap.par.aligny = 'center'
        cap.par.bgalpha = 0.0
        cap.par.editmode = 'locked'
        cap.par.enable = False
        cap.par.text = caption
        cap.par.layer = 2
        cap.nodeX, cap.nodeY = 600, -150 * i
    st = panel.op(STATUS_NAME) or panel.create(textCOMP, STATUS_NAME)
    st.par.hmode = st.par.vmode = 'fixed'
    y = 2 + (len(EXTRA_FIELDS) - 1) * fh            # top field (継続)
    st.par.x, st.par.y, st.par.w, st.par.h = 6, y + 3, pw - 14, 13          # bottom-right of the field (clear of typed text)
    st.par.font = FONT
    st.par.fontsize = 9
    st.par.fontcolorr, st.par.fontcolorg, st.par.fontcolorb = STATUS_COLOR
    st.par.alignx = 'right'
    st.par.aligny = 'center'
    st.par.bgalpha = 0.0
    st.par.editmode = 'locked'
    st.par.enable = False
    st.par.layer = 2
    st.nodeX, st.nodeY = 800, 0
    if not st.par.text.eval():
        st.par.text = ''


# Why the server did not use a scene's extras (capture.saved payload
# 'extrasStatus': {'gen_b': 'ignored: frame empty', ...}), shown in small orange
# type left of the 継続 caption until the next capture.
STATUS_NAME = 'in_status'
STATUS_COLOR = (1.0, 0.62, 0.26)
STATUS_REASONS = {'frame empty': u'無人のため'}


def extras_status_label(status):
    """'ignored: frame empty' -> '無人のため未使用'; 'applied…' -> '' (nothing to flag)."""
    status = str(status or '').strip()
    if not status or status.lower().startswith('applied'):
        return ''
    if status.lower().startswith('ignored'):
        reason = status.split(':', 1)[1].strip() if ':' in status else ''
        return STATUS_REASONS.get(reason.lower(), reason + u' ' if reason else u'') + u'未使用'
    return status


def set_extras_status(statuses):
    """statuses: {'gen_b': 'ignored: frame empty'} or None (clears every panel)."""
    box = _box()
    if box is None:
        return
    statuses = statuses if isinstance(statuses, dict) else {}
    for key in EXTRA_PANELS:
        st = box.op('p_{}/{}'.format(key, STATUS_NAME))
        if st is None:
            continue
        text = extras_status_label(statuses.get(PANEL_TO_SCENE_KEY[key]))
        if st.par.text.eval() != text:
            st.par.text = text


# NOW panel, lower half: read-only summary of the situation so far (capture.saved
# payload 'historySummary', ~200 Japanese characters, refreshed with every capture).
SUMMARY_NAME = 'sum'
SUMMARY_CAPTION = u'これまで'


def _build_summary(panel, pw, color):
    field = panel.op(SUMMARY_NAME)
    if field is None:
        field = panel.create(textCOMP, SUMMARY_NAME)
        field.par.text = _WAIT
    field.par.hmode = field.par.vmode = 'fixed'
    field.par.x, field.par.y, field.par.w, field.par.h = 2, 2, pw - 4, INPUT_H - 2
    field.par.font = FONT
    field.par.fontsize = BODY_FONT_SIZE
    field.par.fontcolorr = field.par.fontcolorg = field.par.fontcolorb = 0.85
    field.par.alignx = 'left'
    field.par.aligny = 'top'
    field.par.type = 'multiline'
    field.par.wordwrap = True
    field.par.textpaddingl = 4
    field.par.textpaddingr = 4
    field.par.textpaddingt = 14
    field.par.bgcolorr = field.par.bgcolorg = field.par.bgcolorb = 0.09
    field.par.bgalpha = 1.0
    field.par.borderar, field.par.borderag, field.par.borderab = color
    field.par.borderaalpha = 0.35
    field.par.leftborder = field.par.rightborder = 1
    field.par.topborder = field.par.bottomborder = 1
    field.par.editmode = 'locked'
    field.par.enable = True          # mouse wheel scrolling
    field.par.mousewheel = True
    field.par.pvscrollbar = 'on'
    field.par.phscrollbar = 'off'
    field.par.scrollbarthickness = 8
    field.nodeX, field.nodeY = 400, 0
    cap = panel.op(SUMMARY_NAME + '_cap') or panel.create(textCOMP, SUMMARY_NAME + '_cap')
    cap.par.hmode = cap.par.vmode = 'fixed'
    cap.par.x, cap.par.y, cap.par.w, cap.par.h = 6, INPUT_H - 16, 80, 13
    cap.par.font = FONT
    cap.par.fontsize = 9
    cap.par.fontcolorr, cap.par.fontcolorg, cap.par.fontcolorb = [0.75 * c for c in color]
    cap.par.alignx = 'left'
    cap.par.aligny = 'center'
    cap.par.bgalpha = 0.0
    cap.par.editmode = 'locked'
    cap.par.enable = False
    cap.par.text = SUMMARY_CAPTION
    cap.par.layer = 2
    cap.nodeX, cap.nodeY = 600, 0
    return field


def set_summary(text):
    """Show the situation summary under NOW (keeps the old one when text is empty)."""
    box = _box()
    field = box.op('p_now/' + SUMMARY_NAME) if box is not None else None
    text = str(text or '').strip()
    if field is None or not text:
        return False
    if field.par.text.eval() != text:
        field.par.text = text
    return True


def _build_field(panel, name, x, y, w, h, color, once=False):
    field = panel.op(name)
    if field is None:
        field = panel.create(textCOMP, name)
        field.par.text = ''
    field.par.hmode = field.par.vmode = 'fixed'
    field.par.x, field.par.y, field.par.w, field.par.h = x, y, w, h
    field.par.font = FONT
    field.par.fontsize = BODY_FONT_SIZE
    field.par.fontcolorr = field.par.fontcolorg = field.par.fontcolorb = 0.95
    field.par.alignx = 'left'
    field.par.aligny = 'top'
    field.par.type = 'multiline'
    field.par.wordwrap = True
    field.par.textpaddingl = 4
    field.par.textpaddingr = 4
    field.par.bgcolorr = field.par.bgcolorg = field.par.bgcolorb = 0.12 if once else 0.16
    field.par.bgalpha = 1.0
    field.par.borderar, field.par.borderag, field.par.borderab = color
    field.par.borderaalpha = 0.6
    field.par.leftborder = field.par.rightborder = 1
    field.par.topborder = field.par.bottomborder = 1
    field.par.editmode = 'editable'
    field.par.enable = True
    field.par.borderaalpha = 0.35 if once else 0.6
    field.nodeX, field.nodeY = 400, -150 if once else 0
    return field


def get_extras(consume=False):
    """{'gen_a': '継続 / 次回のみ', ...} for every scene with text in either field (main thread).
    consume=True (a capture is starting) clears the 次回のみ fields after reading them."""
    box = _box()
    out = {}
    if box is None:
        return out
    for key in EXTRA_PANELS:
        parts = []
        for name, _caption in EXTRA_FIELDS:
            field = box.op('p_{}/{}'.format(key, name))
            if field is None:
                continue
            text = str(field.par.text.eval() or '').strip()
            if text:
                parts.append(text)
                if consume and name == 'in1':
                    field.par.text = ''
        if parts:
            out[PANEL_TO_SCENE_KEY[key]] = EXTRA_JOIN.join(parts)
    return out


def set_extras(gen_a=None, gen_b=None, gen_c=None, once=False):
    """Set the 継続 fields (once=True: the 次回のみ fields) from Python.
    None leaves a field as is, '' clears it."""
    box = _box()
    name = 'in1' if once else 'in'
    for scene_key, value in (('gen_a', gen_a), ('gen_b', gen_b), ('gen_c', gen_c)):
        if value is None or box is None:
            continue
        field = box.op('p_{}/{}'.format(SCENE_KEY_TO_PANEL[scene_key], name))
        if field is not None:
            field.par.text = value
    return get_extras()


def _set_text(key, text, distance=None):
    """Set the body of one panel. `distance` (signed seconds) updates that panel's title."""
    box = _box()
    if box is None:
        return False
    base = [p for p in PANELS if p[0] == key][0][1]
    panel = box.op('p_' + key)
    if panel is None:
        return False
    if distance is not None:
        _S['dist'][key] = distance
    text = str(text or '').strip() or _WAIT
    tx = panel.op('tx')
    shown = text    # type 'multiline' + wordwrap wraps CJK text natively
    if tx.par.text.eval() != shown:
        tx.par.text = shown
    lb = panel.op('lb')
    title = _title(key, base, _S['dist'].get(key))
    if lb.par.text.eval() != title:
        lb.par.text = title
    _S['text'][key] = text
    return True


def _distance_map(distance):
    """None, a dict {past|c, a, b: signed seconds}, or one number N (legacy: a/b +N, c -N)."""
    if distance is None:
        return {}
    if isinstance(distance, dict):
        out = {}
        for k, v in distance.items():
            out['past' if k in ('c', 'gen_c') else k] = float(v)
        return out
    n = abs(float(distance))
    return {'past': -n, 'a': n, 'b': n}


def show(now=None, past=None, a=None, b=None, distance=None):
    """Set the four texts directly (None leaves a panel as is).

    distance: dict {'c': -120, 'a': 30, 'b': 30} of signed seconds per scene (or a single
    number N = old behaviour A +N, B +N, C -N).
    """
    _S['dist'].update(_distance_map(distance))
    for key, value in (('now', now), ('past', past), ('a', a), ('b', b)):
        if value is not None:
            _set_text(key, value)
    for key in ('past', 'a', 'b'):      # refresh the titles of untouched panels
        _set_text(key, _S['text'].get(key, _WAIT))


def clear(distance=None):
    _S['text'] = {}
    _S['dist'] = _distance_map(distance)
    for key in ('now', 'past', 'a', 'b'):
        _set_text(key, _WAIT)


def on_capture_payload(payload):
    """Called by td_capture_listener for every capture.saved datagram. Never raises."""
    try:
        if _box() is None:
            return
        scene_text = payload.get('sceneText')
        now_text = payload.get('nowText')
        if scene_text is None and now_text is None:
            return                      # old server: nothing to show
        capture_id = str(payload.get('captureId', '') or '')
        if capture_id != _S['cur']:
            _S['cur'] = capture_id
            clear()
            set_test_banner(capture_id if is_test_payload(payload) else '')
            _S['xs'] = {}
            _S['obs'] = False
        if 'obstructed' in payload:
            _S['obs'] = payload.get('obstructed') is True
        set_obstructed(_S.get('obs'))
        if isinstance(payload.get('extrasStatus'), dict):
            _S.setdefault('xs', {}).update(payload['extrasStatus'])
        set_extras_status(_S.get('xs'))
        if now_text is not None and str(now_text).strip():
            _set_text('now', now_text)
            set_icons('now', payload, image=False)
        set_summary(payload.get('historySummary'))
        key = SCENE_KEY_TO_PANEL.get(str(payload.get('sceneKey', '')))
        if key is not None and scene_text is not None:
            # this panel's own distance, from this image's payload (signed)
            _set_text(key, scene_text, signed_from_payload(payload, key))
            set_icons(key, payload, image=True)
    except Exception as exc:
        _debug('update failed: {}'.format(exc))


# Test captures (main PC checks with stored images) may be shown, but marked: a red strip
# "テスト画像使用中" over the top of the output-image row until a real capture arrives.
TEST_BANNER_NAME = 'test_banner'
TEST_BANNER_GEOMETRY = (280, 396, 996, 20)        # ui_root coordinates (top of gen_view_*)


def is_test_payload(payload):
    """True for captures that did not come from this TD's camera: test:true, source 'test',
    or a captureId that is not 'td-…' (e.g. extras-test-9, claude-test-…)."""
    if payload.get('test') is True or str(payload.get('source') or '') == 'test':
        return True
    capture_id = str(payload.get('captureId') or '')
    return bool(capture_id) and not capture_id.startswith('td-')


def set_test_banner(capture_id):
    """Show the banner for a test capture (capture_id), hide it with ''."""
    root = op(ROOT_PATH)
    if root is None:
        return
    t = root.op(TEST_BANNER_NAME)
    if t is None:
        if not capture_id:
            return
        t = root.create(textCOMP, TEST_BANNER_NAME)
        t.nodeX, t.nodeY = 2400, -1700
    x, y, w, h = TEST_BANNER_GEOMETRY
    t.par.hmode = t.par.vmode = 'fixed'
    t.par.x, t.par.y, t.par.w, t.par.h = x, y, w, h
    t.par.font = FONT
    t.par.fontsize = 13
    t.par.fontcolorr = t.par.fontcolorg = t.par.fontcolorb = 1.0
    t.par.bgcolorr, t.par.bgcolorg, t.par.bgcolorb = 0.75, 0.1, 0.1
    t.par.bgalpha = 0.9
    t.par.alignx = 'center'
    t.par.aligny = 'center'
    t.par.editmode = 'locked'
    t.par.enable = False
    t.par.layer = 20
    t.par.text = u'テスト画像使用中（{}）'.format(capture_id) if capture_id else ''
    t.par.display = bool(capture_id)


# capture.saved 'obstructed': true (describe judged the camera view blocked) -> a red note in the
# NOW panel's header row. No field / false -> nothing shown.
OBSTRUCTED_NAME = 'obs'
OBSTRUCTED_TEXT = u'カメラが遮られている可能性'


def set_obstructed(flag):
    box = _box()
    panel = box.op('p_now') if box is not None else None
    if panel is None:
        return
    t = panel.op(OBSTRUCTED_NAME)
    if t is None:
        if not flag:
            return
        t = panel.create(textCOMP, OBSTRUCTED_NAME)
        t.nodeX, t.nodeY = 800, -200
    t.par.hmode = t.par.vmode = 'fixed'
    pw = panel.par.w.eval()
    t.par.x, t.par.y, t.par.w, t.par.h = 40, panel.par.h.eval() - 18, pw - 64, 18
    t.par.font = FONT
    t.par.fontsize = 11
    t.par.fontcolorr, t.par.fontcolorg, t.par.fontcolorb = 1.0, 0.3, 0.3
    t.par.bgalpha = 0.0
    t.par.alignx = 'right'
    t.par.aligny = 'center'
    t.par.editmode = 'locked'
    t.par.enable = False
    t.par.layer = 3
    text = OBSTRUCTED_TEXT if flag else ''
    if t.par.text.eval() != text:
        t.par.text = text
    t.par.display = bool(flag)


# Server alert (UDP field 'alert', e.g. ComfyUI timeouts / auto-restart): a red strip over the
# output-image row, just under the test banner. '' / None hides it.
ALERT_NAME = 'alert_banner'
ALERT_GEOMETRY = (280, 376, 996, 20)              # ui_root coordinates


def alert_text(alert):
    """str or {'message'|'text'|'title': …, 'level': …} -> one display line ('' = none)."""
    if isinstance(alert, dict):
        if alert.get('active') is False or alert.get('cleared'):
            return ''
        alert = alert.get('message') or alert.get('text') or alert.get('title') or ''
    text = str(alert or '').strip()
    return u'⚠ ' + ' '.join(text.split()) if text else ''


def set_alert(alert):
    root = op(ROOT_PATH)
    if root is None:
        return
    text = alert_text(alert)
    t = root.op(ALERT_NAME)
    if t is None:
        if not text:
            return
        t = root.create(textCOMP, ALERT_NAME)
        t.nodeX, t.nodeY = 2400, -1850
    x, y, w, h = ALERT_GEOMETRY
    t.par.hmode = t.par.vmode = 'fixed'
    t.par.x, t.par.y, t.par.w, t.par.h = x, y, w, h
    t.par.font = FONT
    t.par.fontsize = 13
    t.par.fontcolorr = t.par.fontcolorg = t.par.fontcolorb = 1.0
    t.par.bgcolorr, t.par.bgcolorg, t.par.bgcolorb = 0.85, 0.15, 0.1
    t.par.bgalpha = 0.92
    t.par.alignx = 'center'
    t.par.aligny = 'center'
    t.par.editmode = 'locked'
    t.par.enable = False
    t.par.layer = 21
    if t.par.text.eval() != text:
        t.par.text = text
    t.par.display = bool(text)


BACKEND_WORD = {'local': u'ローカル', 'gemini': u'Gemini'}


def backend_line(payload, image=True):
    """'［認識 ローカル qwen3-vl:4b-instruct / 生成 ローカル qwen-image-edit］' from the
    capture.saved fields vlmBackend / vlmModel / imageBackend / imageModel ('' if absent)."""
    parts = []
    for label, b_key, m_key in ((u'認識', 'vlmBackend', 'vlmModel'), (u'生成', 'imageBackend', 'imageModel')):
        if label == u'生成' and not image:
            continue
        backend = str(payload.get(b_key) or '')
        model = str(payload.get(m_key) or '')
        if not backend and not model:
            continue
        parts.append(u' '.join(p for p in (label, BACKEND_WORD.get(backend, backend), model) if p))
    return u'［{}］'.format(u' / '.join(parts)) if parts else u''


# Backend icons at the top right of each panel's title row: left = recognition (vlm),
# right = image generation (C / A / B only). One letter in a small box: Q = Qwen (local),
# G = Gemini, '?' = something else. Hidden until a payload with the fields arrives.
ICON_SIZE = (16, 14)
ICON_GAP = 3
ICON_COLORS = {'Q': (0.80, 0.80, 0.80), 'G': (0.40, 0.70, 1.00), '?': (0.6, 0.6, 0.6)}


def icon_letter(backend, model):
    text = u'{} {}'.format(backend or '', model or '').lower()
    if 'gemini' in text:
        return 'G'
    if 'qwen' in text:
        return 'Q'
    return '?' if text.strip() else ''


def _icon(panel, name, slot, pw):
    t = panel.op(name) or panel.create(textCOMP, name)
    w, h = ICON_SIZE
    t.par.hmode = t.par.vmode = 'fixed'
    t.par.x = pw - 4 - (2 - slot) * w - (1 - slot) * ICON_GAP
    t.par.y = BOX_H - LABEL_H + (LABEL_H - h) / 2.0
    t.par.w, t.par.h = w, h
    t.par.font = FONT
    t.par.fontsize = 10
    t.par.alignx = 'center'
    t.par.aligny = 'center'
    t.par.bgalpha = 0.0
    t.par.leftborder = t.par.rightborder = t.par.topborder = t.par.bottomborder = 1
    t.par.editmode = 'locked'
    t.par.enable = False
    t.par.layer = 3
    t.nodeX, t.nodeY = 800, -150 * slot
    return t


def set_icons(key, payload, image=True):
    """Show the recognition / generation letters for panel `key` from a capture.saved payload."""
    box = _box()
    panel = box.op('p_' + key) if box is not None else None
    if panel is None:
        return
    pw = panel.width
    for slot, name, b_key, m_key in ((0, 'ic_v', 'vlmBackend', 'vlmModel'), (1, 'ic_g', 'imageBackend', 'imageModel')):
        letter = icon_letter(payload.get(b_key), payload.get(m_key)) if (image or slot == 0) else ''
        t = _icon(panel, name, slot if image else 1, pw)
        t.par.text = letter
        t.par.display = bool(letter)
        if letter:
            r, g, b = ICON_COLORS.get(letter, ICON_COLORS['?'])
            t.par.fontcolorr, t.par.fontcolorg, t.par.fontcolorb = r, g, b
            t.par.borderar, t.par.borderag, t.par.borderab = r, g, b
            t.par.borderaalpha = 0.9


def _with_backend(text, payload, image=True):
    line = backend_line(payload, image)
    return u'{}\n{}'.format(line, text) if line else text


SAMPLE_SHORT = {
    'now': '机の前に人が座っている。左奥に白いモニターが点いている。',
    'past': 'この人はキーボードに両手を置いていた。',
    'a': '立ち上がって椅子の後ろに立っている。',
    'b': '椅子を回して窓のほうを向いている。',
}


def simulate(long=False, distances=None):
    """Fill the panels with sample text (no server involved). long=True checks scrolling.

    distances: {'c': -120, 'a': 30, 'b': 600} signed seconds (default A +30, B +30, C -30).
    """
    s = dict(SAMPLE_SHORT)
    if long:
        filler = ''.join('{}、さらに左側の棚の物が少しずつ動いていく。'.format(i + 1) for i in range(14))
        s['past'] = s['past'] + filler
        s['a'] = s['a'] + filler
        s['now'] = s['now'] + filler
    show(now=s['now'], past=s['past'], a=s['a'], b=s['b'],
         distance=distances if distances is not None else {'c': -30, 'a': 30, 'b': 30})
    return 'ok'
