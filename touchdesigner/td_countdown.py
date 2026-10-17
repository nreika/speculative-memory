# -*- coding: utf-8 -*-
"""
Countdown / elapsed-time line in the top bar (/project1/mode_extras/countdown).

  idle (timer / chain)   "次の生成まで 0:42"
  requested / generating "生成中 1:05 経過（2/3）"
  presence gate waiting  "人物待ち（検出で開始）"   paused: "無人のため停止中（検出で再開）"
  manual, idle           "手動モード"

The Text COMP's text parameter is an expression that calls text(absTime.seconds),
so it is re-evaluated about once a second. Reads only status() of td_native_capture
and PENDING of td_capture_listener; never raises.

This DAT is file-synced (td_countdown.py); it lives at /project1/td_countdown.
"""

CONTROLLER_PATH = '/project1/td_native_capture'
LISTENER_PATH = '/project1/td_capture_listener'
PARENT_PATH = '/project1/mode_extras'
TEXT_NAME = 'countdown'
MSG_W = 300                          # width left for the existing status line 'msg'
TEXT_X, TEXT_W = 540, 324


def _mmss(seconds):
    seconds = max(0, int(round(seconds)))
    return u'{}:{:02d}'.format(seconds // 60, seconds % 60)


def _received(capture_id):
    """'2/3' for the capture being generated, or ''. Held-back images (Displaytiming
    'all') are in PENDING; images shown one by one ('each') are in BATCH_STATE."""
    module = getattr(op(LISTENER_PATH), 'module', None)
    pending = getattr(module, 'PENDING', None) or {}
    if capture_id and pending.get('captureId') == capture_id and pending.get('expectedImageCount'):
        return u'{}/{}'.format(len(pending.get('payloads') or {}), pending['expectedImageCount'])
    batch = getattr(module, 'BATCH_STATE', None) or {}
    if capture_id and batch.get('captureId') == capture_id and batch.get('expectedImageCount'):
        return u'{}/{}'.format(len(batch.get('receivedSceneKeys') or ()), batch['expectedImageCount'])
    return ''


def text(_tick=None):
    try:
        status = op(CONTROLLER_PATH).module.status()
    except Exception:
        return u''
    phase = status.get('phase')
    if phase in ('requested', 'generating'):
        received = _received(status.get('captureId'))
        return u'生成中 {} 経過{}'.format(_mmss(status.get('busyFor') or 0),
                                       u'（{}）'.format(received) if received else u'')
    presence = status.get('presence')
    if presence == 'waiting':
        return u'人物待ち（検出で開始）'
    if presence == 'paused':
        return u'無人のため停止中（検出で再開）'
    mode = status.get('mode')
    due = status.get('nextTimerTickIn') if mode == 'timer' else status.get('chainDueIn') if mode == 'chain' else None
    if mode == 'manual':
        return u'手動モード'
    if due is None:
        return u'次の生成待ち'
    return u'次の生成まで {}'.format(_mmss(due))


def build():
    """Create / refresh the Text COMP in the top bar (idempotent). Returns its path."""
    parent = op(PARENT_PATH)
    msg = parent.op('msg')
    if msg is not None:
        msg.par.w = MSG_W
    t = parent.op(TEXT_NAME) or parent.create(textCOMP, TEXT_NAME)
    t.par.hmode = t.par.vmode = 'fixed'
    t.par.x, t.par.y, t.par.w, t.par.h = TEXT_X, 0, TEXT_W, 30
    if msg is not None:
        t.par.font = msg.par.font.eval()
        t.par.fontsize = msg.par.fontsize.eval()
    t.par.fontcolorr, t.par.fontcolorg, t.par.fontcolorb = 1.0, 0.85, 0.35
    t.par.alignx = 'left'
    t.par.aligny = 'center'
    t.par.bgalpha = 0.0
    t.par.editmode = 'locked'
    t.par.text.expr = "op('/project1/td_countdown').module.text(int(absTime.seconds))"
    t.nodeX, t.nodeY = 600, 0
    return t.path
