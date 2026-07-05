CONTROL_DAT_PATH = '/project1/td_capture_panel_controls'


def _debug(message):
    print('[TD Auto Capture Timer] {}'.format(message))


def _request_capture():
    controls = op(CONTROL_DAT_PATH)
    if controls is None:
        _debug('Control DAT not found: {}'.format(CONTROL_DAT_PATH))
        return

    try:
        controls.module.request_capture()
    except Exception as exc:
        _debug('request_capture failed: {}'.format(exc))


def onInitialize(timerOp, callCount):
    return 0


def onReady(timerOp):
    return


def onStart(timerOp):
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
    _request_capture()
    return


def onDone(timerOp, segment, interrupt):
    return


def onSubrangeStart(timerOp):
    return
