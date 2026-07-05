# TouchDesigner Setup

This project now supports two different TouchDesigner integrations:

1. Browser camera to TouchDesigner over WebRTC for live video
2. Saved prediction image notifications over UDP when files are written into `captures`

## Live Browser Camera Feed (WebRTC)

Use this when the browser should keep the webcam and TouchDesigner should receive the same live feed remotely.

### TouchDesigner network

1. Create a `WebRTC DAT` named `webrtc1`
2. Create a `Text DAT` and paste in `td_webrtc_receiver.py`
3. Point the `WebRTC DAT` `Callbacks DAT` parameter to that script
4. Optional: create a `Table DAT` named `webrtc_tracks` to log remote tracks
5. Create a `Video Stream In TOP`
6. Set the TOP to use the `WebRTC DAT` connection once the remote track appears
7. In the browser app, open the `TouchDesigner_Bridge` panel and press `START_WEBRTC_STREAM`
8. In TouchDesigner, run `op('td_webrtc_receiver').module.start('timewarp-local', 'webrtc1')`

### Optional: Start/Stop Buttons

If you want to start and stop the receiver without typing into Textport, add a tiny control panel:

1. Create two `Button COMP`s named `start_stream_btn` and `stop_stream_btn`
2. Set both buttons to a momentary type
3. Create a `Panel Execute DAT`
4. Paste in `td_webrtc_panel_controls.py`
5. In the `Panel Execute DAT` parameters:
   - `Panels`: `/project1/start_stream_btn /project1/stop_stream_btn`
   - `Panel Value`: `state`
   - `Off to On`: `On`
6. Edit the constants at the top of `td_webrtc_panel_controls.py` if your paths differ

If you want to reuse one file across multiple manual capture inputs, use `td_capture_panel_controls.py` for both the button and keyboard callbacks.

If your `Panels` field is easier to use with one button at a time, use two `Panel Execute DAT`s instead:

- `start_stream_exec` monitors `/project1/start_stream_btn`
- `stop_stream_exec` monitors `/project1/stop_stream_btn`
- both can use the same `td_webrtc_panel_controls.py`
- keep `Panel Value` as `state` and `Off to On` as `On`

With the defaults in this repository:

- pressing `start_stream_btn` runs:
  `op('/project1/webrtc1_callbacks1').module.start('timewarp-local', '/project1/webrtc1', '/project1/webrtc1_callbacks1')`
- pressing `stop_stream_btn` runs:
  `op('/project1/webrtc1_callbacks1').module.stop()`

You can also map the same stream controls to `Keyboard In CHOP`:

1. Create a `Keyboard In CHOP` named `keyboardin1`
2. Create a `CHOP Execute DAT`
3. Paste in `td_webrtc_panel_controls.py`
4. In the `CHOP Execute DAT` parameters:
   - `CHOP`: `/project1/keyboardin1`
   - `Off to On`: `On`
   - `While On`: `Off`
   - `On to Off`: `Off`
   - `Value Change`: `Off`
5. Press `0` to start the stream
6. Press `9` to stop the stream

With the defaults in this repository, the script listens for `0` / `9` and also accepts `k0` / `k9`, `num0` / `num9`, or `numpad0` / `numpad9` if your `Keyboard In CHOP` names them that way. If your channel names differ, edit `START_STREAM_KEY_CHANNELS` or `STOP_STREAM_KEY_CHANNELS`.

### Signaling API

The receiver script polls the local Node server:

- `GET /api/touchdesigner-stream/session/<sessionId>/offer`
- `POST /api/touchdesigner-stream/session/<sessionId>/answer`
- `GET /api/touchdesigner-stream/session/<sessionId>/candidates?target=touchdesigner`
- `POST /api/touchdesigner-stream/session/<sessionId>/candidates`

Default session ID:

- `timewarp-local`

### Notes

- This setup lets the browser keep `getUserMedia()` ownership, which avoids webcam conflicts
- The sample script is meant for local experimentation and should be a good base if you later want to harden reconnection logic
- If TouchDesigner runs on another machine, you may need extra WebRTC network configuration such as STUN/TURN

## Saved Prediction Image Notifications (UDP)

This project can notify TouchDesigner in real time whenever a new prediction image is written into `captures`.

## What the server sends

The Node server sends one UDP JSON message per saved image to `127.0.0.1:9989` by default.

Each message contains:

- The scene key (`gen_a` to `gen_j`)
- The expected image count for the current capture batch
- The saved image path
- A normalized forward-slash path for Windows
- The newest timestamped file path for that scene
- The label and timestamp

## TouchDesigner network

1. Add a `UDP In DAT`
2. Set `Port` to `9989`
3. Set `Row/Callback Format` to `One Per Message`
4. Create a `Text DAT` and paste in `td_capture_listener.py`
5. Point the `UDP In DAT` `Callbacks DAT` parameter at that script
6. Create `Movie File In TOP` operators for the scene slots you want to support:
   `Gen_a` to `Gen_j` (or legacy names `moviefilein_scene_a` to `moviefilein_scene_j`)
   If you only use up to 3 images, `Gen_a` to `Gen_c` are enough.
7. Create one more `Movie File In TOP` named `record_original` (or legacy name `moviefilein_original`) if you also want to display the captured source image
8. Optional: keep a fallback single `Movie File In TOP` named `moviefilein1`
9. Optional: create a `Table DAT` named `capture_info`

If you see `Cannot find function named: onReceive`, your `UDP In DAT` is pointing at the wrong script. The callback DAT for the UDP listener must be `td_capture_listener.py`, not `td_webrtc_panel_controls.py` or `td_capture_panel_controls.py`.

When a message arrives, the callback now does four things:

- It reloads the matching generated-image `Movie File In TOP` with the newest timestamped file.
- If `moviefilein_original` exists, it also reloads the captured source image.
- It tracks which scene keys have arrived for the current `captureId`.
- It raises a shared `ready` state only after the expected number of scene messages for that `captureId` have arrived.
- It updates `capture_info` with both the newest payload and per-scene ready state.
- If one UDP message is missed, it can recover the latest batch from `http://127.0.0.1:3000/api/latest-captures`.

By default, once all expected scene images for the same `captureId` arrive, TouchDesigner automatically starts revealing them. The reveal signal stays high for 5 seconds and then returns to `0`, so you can use a `Filter CHOP` to create a soft fade in and fade out. If `display_timing` exists, the listener reads `fade_seconds` and `hide_delay_seconds` from that CHOP instead of using the defaults.

If `ready_state_all` exists, the callback writes `value0 = 1` only when all requested timeline images for the current capture batch have arrived. This is useful for a single "all assets ready" lamp or for enabling your display buttons.

This is intentionally not tied to a specific scene key. The app saves all requested images in parallel, so there is no guaranteed rule like "when gen_c arrives, the batch is complete". Instead, `td_capture_listener.py` counts the received scene keys for each `captureId` and only flips `ready_state_all` high when all expected scene keys are present.

### Manual Display Buttons

To decide the reveal timing in TouchDesigner, add a small control panel:

1. Create a `Constant CHOP` named `generation_count`
2. Set `value0` to a number from `1` to `10`
3. Create a `Keyboard In CHOP` named `keyboardin1`
4. Turn on the CHOP so it outputs a `1` channel when you press the `1` key
5. Create a `CHOP Execute DAT`
6. Paste in `td_capture_panel_controls.py`
7. In the `CHOP Execute DAT` parameters:
   - `CHOP`: `/project1/keyboardin1`
   - `Off to On`: `On`
   - `While On`: `Off`
   - `On to Off`: `Off`
   - `Value Change`: `Off`
8. If your operator path differs, edit `START_GENERATION_KEYBOARD_OP_PATHS`
9. If you want a different key, edit `START_GENERATION_KEY_CHANNELS`

When you press the button or key, the script reads `/project1/generation_count` `value0`, clamps it to `1` through `10`, and sends that number to the browser app.

When `CONTROL_TRANSPORT` is set to `udp`, both the button and the `1` key send this UDP JSON packet to the local Node server. The script accepts channel names like `1`, `k1`, `num1`, and `numpad1`.

```json
{
  "type": "capture",
  "sessionId": "timewarp-local",
  "imageCount": 5
}
```

Default UDP control destination:

- host: `127.0.0.1`
- port: `9990`

The Node server listens for that packet, pushes the same internal capture command queue used by the HTTP endpoint, and the browser app polls that queue while its camera stream is ready. In other words, the UDP button or the `1` key triggers the same capture flow as the on-screen `Initiate_Scan` button.

If you want manual capture over HTTP, set `CONTROL_TRANSPORT = 'http'` in `td_capture_panel_controls.py`. In that mode the same button calls:

- `POST /api/touchdesigner-control/session/<sessionId>/capture`

### Auto Capture Timer

If you want automatic generation every 30 seconds, keep the responsibilities separate:

- `td_capture_panel_controls.py`: manual button / keyboard capture triggers
- `td_capture_listener.py`: UDP image receive + capture state updates
- `td_auto_capture_timer.py`: Timer CHOP callback that calls `request_capture()` on each cycle

Recommended setup:

1. Create a `Timer CHOP` named `timer1`
2. Set `Length` to `30`
3. Turn `Cycle` on
4. Create a `Text DAT` named `timer1_callbacks`
5. Set its `File` parameter to `td_auto_capture_timer.py`
6. Turn `Sync to File` on
7. Point the `Timer CHOP` `Callbacks DAT` parameter to `timer1_callbacks`
8. Start the timer once so it begins cycling

This keeps the auto-capture logic separate from the manual control callbacks, which makes the network easier to read and maintain.

## Notes

- The app now supports `1` to `10` timeline images per capture.
- The same source image is shared by all timeline messages in one capture batch, so `moviefilein_original` will keep showing the single captured frame for that prediction batch.
- Images are stored with timestamped names such as `Gen_a_1776160553565.png`.
- `captures/latest_scenes.json` keeps track of which timestamped file is currently newest for each scene.
- If a UDP packet is missed, you can recover the newest state from `captures/latest_scenes.json` or `http://localhost:3000/api/latest-captures`.

## GitHub Workflow

For GitHub-backed project management, keep the TouchDesigner-side source files in this `touchdesigner/` folder:

- `td_capture_listener.py`
- exported `.tox` components if you modularize the network
- `.toe` project checkpoints only when you want an intentional binary snapshot

The generated files in `captures/` are ignored by Git, so repository history stays focused on source files rather than prediction output images.








