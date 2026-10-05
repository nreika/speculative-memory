# Timer CHOP callbacks for /project1/timer1 (DAT: timer1_callbacks, synced to this file).
#
# timer1 is now only the HEARTBEAT of the capture controller in
# td_native_capture.py; it no longer decides when to capture. Every cycle calls
# heartbeat(), which applies the selected capture mode (timer / chain / manual,
# custom parameters on /project1, page "Capture"), runs the Timer-mode interval
# (Captureinterval, default 90s, ticks skipped while a generation is running)
# and the Chain-mode retry, and picks up results from the HTTP worker thread.
#
# Recommended timer1 settings: Length 1 (second), Cycle On, Cycle Limit Off,
# Play On (then press Start once). A longer Length still works, but every
# timing decision is then only as precise as one cycle.

NATIVE_CAPTURE_DAT_PATH = '/project1/td_native_capture'


def _debug(message):
    print('[TD Auto Capture Timer] {}'.format(message))


def _heartbeat():
    native = op(NATIVE_CAPTURE_DAT_PATH)
    if native is None:
        _debug('capture controller DAT not found: {}'.format(NATIVE_CAPTURE_DAT_PATH))
        return
    try:
        native.module.heartbeat()
    except Exception as exc:
        _debug('heartbeat failed: {}'.format(exc))


def onInitialize(timerOp, callCount):
    return 0


def onReady(timerOp):
    return


def onStart(timerOp):
    _heartbeat()
    return


def onTimerPulse(timerOp, segment):
    return


def whileTimerActive(timerOp, segment, cycle, fraction):
    return


def onSegmentEnter(timerOp, segment, interrupt):
    return


def onSegmentExit(timerOp, segment, interrupt):
    return


def onCycleStart(timerOp, segment, cycle):
    return


def onCycleEndAlert(timerOp, segment, cycle, alertSegment, alertDone, interrupt):
    return


def onCycle(timerOp, segment, cycle):
    _heartbeat()
    return


def onDone(timerOp, segment, interrupt):
    _heartbeat()
    return


def onSubrangeStart(timerOp):
    return
