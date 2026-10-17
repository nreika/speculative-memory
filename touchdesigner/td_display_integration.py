"""Display-only controls for the merged TouchDesigner project.

Never requests a capture or calls a generation service.
"""

import random

ROOT = '/project1'
DEFAULT_LAYOUT = ('display_a', 'display_b', 'display_c', 'display_now')
WINDOWS = ('window1', 'window2', 'window3', 'window4')
_pending_hide = None


def _node(name):
    node = op(ROOT + '/' + name)
    if node is None:
        raise RuntimeError('Missing display operator: ' + name)
    return node


def cancel_pending():
    global _pending_hide
    if _pending_hide is not None:
        try:
            _pending_hide.kill()
        except Exception:
            pass
        _pending_hide = None


def show():
    # Stays shown until the next batch (instant black + fade-in in td_capture_listener) or HIDE.
    cancel_pending()
    _node('fade_state').par.const0value = 1


def fade_out():
    global _pending_hide
    _pending_hide = None
    _node('fade_state').par.const0value = 0


def hide():
    cancel_pending()
    _node('fade_state').par.const0value = 0
    _node('fade_lag').par.resetpulse.pulse()


def _apply_layout(sources):
    for window, source in zip(WINDOWS, sources):
        node = _node(window)
        node.par.winop.expr = None
        node.par.winop.val = ROOT + '/' + source


def shuffle():
    sources = list(DEFAULT_LAYOUT)
    random.shuffle(sources)
    _apply_layout(sources)


def reset_layout():
    _apply_layout(DEFAULT_LAYOUT)


def on_start():
    # A fresh review copy always stays in manual mode and starts hidden.
    # This changes only the merged project's own parameter.
    _node('td_native_capture')  # Fail clearly if the generation base is absent.
    op(ROOT).par.Capturemode = 'manual'
    hide()
    cone = op(ROOT + '/ui_root/cone_viz/script')
    if cone is not None:
        # Replace saved, stale "GENERATING" UI with the current idle state.
        cone.module.adopt_existing()
        cone.module.refresh(force=True)
        cone.module.start()


def cook_fade():
    _node('fade_lag').cook(force=True)
