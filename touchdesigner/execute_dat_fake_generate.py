"""
Execute DAT callbacks to trigger `fake_generate` in `td_capture_listener`.

Paste the contents of this file into an Execute DAT DAT in TouchDesigner
or open it here and copy into the DAT's editor.

Implemented callbacks:
- `onValueChange(channel, sampleIndex, val, prev)`
- `onTableChange(dat)`
- `onOffToOn(channel, sampleIndex, val, prev)`

The code will call `op('td_capture_listener').module.fake_generate()` if available.
Optionally the table's cell 0,0 can contain a scene key to pass through.
"""

def _call_fake(scene_key=None):
    try:
        listener = op('td_capture_listener')
        if listener is None:
            # Try a couple of common alternative names
            listener = op('td_capture_listener_dat') or op('td_capture_listener1')

        if listener is None:
            print('[Execute DAT] td_capture_listener not found')
            return False

        mod = getattr(listener, 'module', None)
        if mod is None or not hasattr(mod, 'fake_generate'):
            print('[Execute DAT] fake_generate not found on {}'.format(listener.path))
            return False

        # If this Execute DAT is attached to a CHOP slider that reports 0..1 but
        # the project expects 0..10, we scale elsewhere when calling.
        return mod.fake_generate(scene_key)
    except Exception as e:
        print('[Execute DAT] fake_generate call error:', e)
        return False


def onValueChange(channel, sampleIndex, val, prev):
    # Called for CHOP channel value changes. Trigger when button goes high.
    try:
        # Scale CHOP slider value from 0..1 to 0..10
        if val is None:
            return
        if val != prev:
            try:
                scaled = int(round(float(val) * 10.0))
            except Exception:
                scaled = None

            # If the listener exposes set_expected_image_count, call it
            listener = op('td_capture_listener')
            mod = getattr(listener, 'module', None) if listener is not None else None
            if scaled is not None and mod is not None and hasattr(mod, 'set_expected_image_count'):
                try:
                    mod.set_expected_image_count(scaled)
                except Exception as e:
                    print('[Execute DAT] set_expected_image_count error', e)

            # Trigger fake generate when value goes above zero
            if val and val != 0:
                _call_fake()
    except Exception as e:
        print('[Execute DAT] onValueChange error', e)
    return


def onTableChange(dat):
    # Called when a DAT table changes. If cell 0,0 has a scene key, use it.
    try:
        key = None
        if getattr(dat, 'numRows', 0) and getattr(dat, 'numCols', 0):
            try:
                cell = dat[0, 0]
                key = str(cell).strip() if cell is not None else None
            except Exception:
                key = None

        if key:
            _call_fake(key)
        else:
            _call_fake()
    except Exception as e:
        print('[Execute DAT] onTableChange error', e)
    return


def onOffToOn(channel, sampleIndex, val, prev):
    # Another common Execute DAT hook for toggle-style buttons.
    try:
        if val == 1:
            _call_fake()
    except Exception as e:
        print('[Execute DAT] onOffToOn error', e)
    return
