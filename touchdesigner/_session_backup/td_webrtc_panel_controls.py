RECEIVER_DAT_PATH = '/project1/webrtc1_callbacks1'
WEBRTC_DAT_PATH = '/project1/webrtc1'
SESSION_ID = 'timewarp-local'

START_BUTTON_PATH = '/project1/start_stream_btn'
STOP_BUTTON_PATH = '/project1/stop_stream_btn'
STREAM_KEYBOARD_OP_PATHS = ('/project1/keyboardin1',)
START_STREAM_KEY_CHANNELS = ('0', 'k0', 'num0', 'numpad0')
STOP_STREAM_KEY_CHANNELS = ('9', 'k9', 'num9', 'numpad9')


def _debug(message):
    print('[TD WebRTC Controls] {}'.format(message))


def _receiver_dat():
    receiver_dat = op(RECEIVER_DAT_PATH)
    if receiver_dat is None:
        raise ValueError('Receiver DAT "{}" was not found.'.format(RECEIVER_DAT_PATH))
    return receiver_dat


def _receiver_module():
    return _receiver_dat().module


def start_stream():
    receiver_dat = _receiver_dat()
    _debug('Starting WebRTC receiver.')
    return _receiver_module().start(SESSION_ID, WEBRTC_DAT_PATH, receiver_dat.path)


def stop_stream():
    _debug('Stopping WebRTC receiver.')
    return _receiver_module().stop()


def _channel_name(channel):
    try:
        return str(channel.name).lower()
    except Exception:
        return ''


def _channel_owner_path(channel):
    owner = getattr(channel, 'owner', None)
    return getattr(owner, 'path', '') if owner is not None else ''


def _matches_keyboard_channel(channel, channel_names):
    channel_name = _channel_name(channel)
    if channel_name not in channel_names:
        return False

    owner_path = _channel_owner_path(channel)
    return not STREAM_KEYBOARD_OP_PATHS or owner_path in STREAM_KEYBOARD_OP_PATHS


def _handle_panel_off_to_on(panelValue):
    owner_path = panelValue.owner.path

    if owner_path == START_BUTTON_PATH:
        return start_stream()
    if owner_path == STOP_BUTTON_PATH:
        return stop_stream()

    return


def _handle_chop_off_to_on(channel):
    if _matches_keyboard_channel(channel, START_STREAM_KEY_CHANNELS):
        _debug(
            'Starting WebRTC receiver from key "{}" on {}.'.format(
                _channel_name(channel),
                _channel_owner_path(channel) or '<unknown>'
            )
        )
        return start_stream()

    if _matches_keyboard_channel(channel, STOP_STREAM_KEY_CHANNELS):
        _debug(
            'Stopping WebRTC receiver from key "{}" on {}.'.format(
                _channel_name(channel),
                _channel_owner_path(channel) or '<unknown>'
            )
        )
        return stop_stream()

    return


def onReceive(dat, rowIndex, message, bytes, peer):
    _debug(
        'This DAT is a Panel Execute callback, not a UDP In callback. '
        'Assign td_capture_listener.py to your UDP In DAT Callbacks DAT.'
    )
    return


def onOffToOn(*args):
    if len(args) == 1:
        return _handle_panel_off_to_on(args[0])
    if len(args) >= 4:
        return _handle_chop_off_to_on(args[0])
    return


def whileOn(*args):
    return


def onOnToOff(*args):
    return


def whileOff(*args):
    return


def onValueChange(*args):
    return
