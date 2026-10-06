import json
import urllib.error
import urllib.request


SIGNAL_BASE_URL = 'http://127.0.0.1:3000/api/touchdesigner-stream'
DEFAULT_SESSION_ID = 'timewarp-local'
DEFAULT_WEBRTC_PATH = 'webrtc1'
TRACK_TABLE_OP = 'webrtc_tracks'
POLL_INTERVAL_MS = 500

_state = {
    'running': False,
    'session_id': DEFAULT_SESSION_ID,
    'webrtc_path': DEFAULT_WEBRTC_PATH,
    'callbacks_dat_path': '',
    'connection_id': None,
    'last_candidate_id': 0,
    'remote_offer_applied': False
}


def _debug(message):
    print('[TD WebRTC Receiver] {}'.format(message))


def _request_json(method, path, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'

    request = urllib.request.Request(
        SIGNAL_BASE_URL + path,
        data=data,
        headers=headers,
        method=method
    )

    with urllib.request.urlopen(request, timeout=2) as response:
        raw = response.read().decode('utf-8')
        return json.loads(raw) if raw else {}


def _get_webrtc_dat():
    webrtc_dat = op(_state['webrtc_path'])
    if webrtc_dat is None:
        raise ValueError('WebRTC DAT "{}" was not found.'.format(_state['webrtc_path']))
    return webrtc_dat


def _get_callbacks_dat():
    callbacks_dat_path = _state.get('callbacks_dat_path') or ''
    if callbacks_dat_path:
        callbacks_dat = op(callbacks_dat_path)
        if callbacks_dat is not None:
            return callbacks_dat

    try:
        callbacks_dat = _get_webrtc_dat().par.Callbacksdat.eval()
    except Exception:
        callbacks_dat = None

    if callbacks_dat is None:
        raise ValueError('Callbacks DAT could not be resolved.')

    _state['callbacks_dat_path'] = callbacks_dat.path
    return callbacks_dat


def _schedule_poll():
    if not _state['running']:
        return
    callbacks_dat = _get_callbacks_dat()
    run("op('{}').module.poll()".format(callbacks_dat.path), delayMilliSeconds=POLL_INTERVAL_MS)


def _ensure_track_table():
    table = op(TRACK_TABLE_OP)
    if table is None:
        return None

    if table.numRows == 0:
        table.appendRow(['connectionId', 'trackId', 'type'])

    return table


def start(session_id=DEFAULT_SESSION_ID, webrtc_path=DEFAULT_WEBRTC_PATH, callbacks_dat_path=''):
    stop(delete_session=False)

    _state['running'] = True
    _state['session_id'] = session_id or DEFAULT_SESSION_ID
    _state['webrtc_path'] = webrtc_path or DEFAULT_WEBRTC_PATH
    _state['callbacks_dat_path'] = callbacks_dat_path or ''
    _state['last_candidate_id'] = 0
    _state['remote_offer_applied'] = False

    webrtc_dat = _get_webrtc_dat()
    _state['connection_id'] = webrtc_dat.openConnection()
    _debug('Listening for browser offer on session "{}".'.format(_state['session_id']))
    poll()
    return _state['connection_id']


def start_default():
    callbacks_dat_path = _state.get('callbacks_dat_path') or ''
    if not callbacks_dat_path:
        try:
            callbacks_dat_path = _get_callbacks_dat().path
        except Exception:
            callbacks_dat_path = ''

    return start(DEFAULT_SESSION_ID, DEFAULT_WEBRTC_PATH, callbacks_dat_path)


def stop(delete_session=True):
    connection_id = _state.get('connection_id')

    if connection_id:
        try:
            _get_webrtc_dat().closeConnection(connection_id)
        except Exception as error:
            _debug('Ignoring close error: {}'.format(error))

    if delete_session and _state.get('session_id'):
        try:
            _request_json('DELETE', '/session/{}'.format(_state['session_id']))
        except Exception as error:
            _debug('Ignoring signaling cleanup error: {}'.format(error))

    _state['running'] = False
    _state['connection_id'] = None
    _state['callbacks_dat_path'] = ''
    _state['last_candidate_id'] = 0
    _state['remote_offer_applied'] = False


def is_running():
    return bool(_state.get('running'))


def status():
    return dict(_state)


def poll():
    if not _state['running'] or not _state.get('connection_id'):
        return

    try:
        if not _state['remote_offer_applied']:
            response = _request_json('GET', '/session/{}/offer'.format(_state['session_id']))
            offer = response.get('offer')
            if offer and offer.get('sdp'):
                webrtc_dat = _get_webrtc_dat()
                webrtc_dat.setRemoteDescription(_state['connection_id'], 'offer', offer['sdp'])
                webrtc_dat.createAnswer(_state['connection_id'])
                _state['remote_offer_applied'] = True
                _debug('Remote offer applied. Creating local answer.')

        response = _request_json(
            'GET',
            '/session/{}/candidates?target=touchdesigner&after={}'.format(
                _state['session_id'],
                _state['last_candidate_id']
            )
        )
        items = response.get('items', [])
        if items:
            webrtc_dat = _get_webrtc_dat()
            for item in items:
                candidate = item.get('candidate', {})
                webrtc_dat.addIceCandidate(
                    _state['connection_id'],
                    candidate.get('candidate', ''),
                    candidate.get('sdpMLineIndex', 0) or 0,
                    candidate.get('sdpMid', '')
                )
                _state['last_candidate_id'] = max(_state['last_candidate_id'], item.get('id', 0))
    except urllib.error.HTTPError as error:
        if error.code != 404:
            _debug('HTTP error while polling signaling API: {}'.format(error))
    except Exception as error:
        _debug('Polling error: {}'.format(error))
    finally:
        _schedule_poll()


def onOffer(webrtcDAT, connectionId, localSdp):
    webrtcDAT.setLocalDescription(connectionId, 'offer', localSdp, stereo=False)
    return


def onAnswer(webrtcDAT, connectionId, localSdp):
    webrtcDAT.setLocalDescription(connectionId, 'answer', localSdp, stereo=False)
    _request_json(
        'POST',
        '/session/{}/answer'.format(_state['session_id']),
        {
            'type': 'answer',
            'sdp': localSdp
        }
    )
    _debug('Local answer posted to signaling API.')
    return


def onNegotiationNeeded(webrtcDAT, connectionId):
    _debug('Negotiation needed for {}'.format(connectionId))
    return


def onIceCandidate(webrtcDAT, connectionId, candidate, lineIndex, sdpMid):
    _request_json(
        'POST',
        '/session/{}/candidates'.format(_state['session_id']),
        {
            'from': 'touchdesigner',
            'candidate': {
                'candidate': candidate,
                'sdpMLineIndex': lineIndex,
                'sdpMid': sdpMid
            }
        }
    )
    return


def onIceCandidateError(webrtcDAT, connectionId, errorText):
    _debug('ICE candidate error on {}: {}'.format(connectionId, errorText))
    return


def onTrack(webrtcDAT, connectionId, trackId, type):
    table = _ensure_track_table()
    if table is not None:
        table.appendRow([connectionId, trackId, type])
    _debug('Remote track received: {} ({})'.format(trackId, type))
    return


def onRemoveTrack(webrtcDAT, connectionId, trackId, type):
    _debug('Remote track removed: {} ({})'.format(trackId, type))
    return


def onDataChannel(webrtcDAT, connectionId, channelName):
    return


def onDataChannelOpen(webrtcDAT, connectionId, channelName):
    return


def onDataChannelClose(webrtcDAT, connectionId, channelName):
    return


def onData(webrtcDAT, connectionId, channelName, data):
    return


def onConnectionStateChange(webrtcDAT, connectionId, newState):
    _debug('Connection state changed: {}'.format(newState))
    return


def onSignalingStateChange(webrtcDAT, connectionId, newState):
    return


def onIceConnectionStateChange(webrtcDAT, connectionId, newState):
    _debug('ICE state changed: {}'.format(newState))
    return


def onIceGatheringStateChange(webrtcDAT, connectionId, newState):
    return
