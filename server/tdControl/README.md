# TD browser control integration

The laptop remains the TD runtime; this is its browser operator interface. No additional TD OPs/Execute DATs, new inference engine or replacement image registry.

## Laptop

`tools/start-browser-control.ps1 start` starts Python stdlib `bridge.py` on **127.0.0.1:8767 and <LAPTOP_TAILSCALE_IP>:8767 only**. TD2025 must be running with its loopback API at 127.0.0.1:9981. The project-side adapter is `SpeculativeMemory/td_browser_control.py`; validation is `browser_control_schema.py`. TD API executes the fixed loader on the main thread; request fields are quoted JSON data and cannot specify scripts/OP paths/shell commands. No camera/generation is started by opening the GUI or starting the bridge.

The bridge generates `.local/bridge-token.txt` once. This folder, logs and the receipt journal are private and **excluded from the deployment ZIP**. Transfer the token separately via Taildrop to the desktop's private data area; never print its contents or copy it into public assets or Git. The laptop development page uses an HttpOnly/SameSite=Strict cookie only through its loopback listener. Remote bridge API calls require the bearer token.

## Desktop Node mount (desktop owner integrates server.ts)

No npm dependencies. Set private startup ENV:

```
TD_CONTROL_BRIDGE_URL=http://<LAPTOP_TAILSCALE_IP>:8767
TD_CONTROL_BRIDGE_TOKEN_FILE=<absolute private token file outside public/Git directories>
TD_CONTROL_ALLOWED_HOSTS=localhost:3000,127.0.0.1:3000,<DESKTOP_TAILSCALE_IP>:3000
```

Unpack the code ZIP to a non-public directory. Mount the exported `installTdBrowserControl(app)` from `node-proxy.mjs` before broad SPA fallback handlers; it serves only the explicit public files. Do not expose its directory with express.static because it contains private runtime files on the laptop. A desktop copy contains code only, but keeping a whitelist avoids future accidental exposure.

```js
import {installTdBrowserControl} from '<absolute code directory>/node-proxy.mjs';
installTdBrowserControl(app); // assets default to module directory
```

It accepts only loopback and Tailscale peers, and Host localhost:3000, 127.0.0.1:3000 or <DESKTOP_TAILSCALE_IP>:3000. Forwarding uses the fixed laptop URL, server-side Bearer, no arbitrary URL or filesystem proxy. Mutation requires same-origin Origin, application/json and X-Control-Request: 1. Do not add CORS wildcard. If JSON middleware is mounted first, it must support **36 MB** for PNG asset imports; alternatively mount before JSON middleware (the proxy can read the bounded body stream itself).

## Routes

| Method | Route | Result |
|---|---|---|
| GET | `/control/` | English operator UI |
| GET | `/control/output/1` … `/4` | one browser output per device |
| GET | `/api/td-control/state` | actual TD settings/revision/runtime/scenario/history/layout |
| GET | `/api/td-control/input-preview` | current replay/camera JPEG data URL; does not consume a replay frame or start capture |
| GET | `/api/td-control/outputs` | existing td-a/b/c/now snapshots + routed output snapshots |
| GET | `/api/td-control/outputs/1` … `/4` | current assignment, visibility, subtitles/labels/fade |
| POST | `/api/td-control/action` | finite command + actual resulting state |
| POST | `/api/td-control/scenario-upload` | validated CSV + referenced PNGs saved under a NEW scenario folder |

POST action: `{action, data:{...}, requestId:<unique>, baseRevision:<for settings.apply>}`. Allowed actions: settings.apply; generation.resume/pause/generate/cancel; scenario.load/play/pause/stop; input.select; display.layout/shuffle/reset/show/hide; project.save. `settings.apply` only updates the supplied fields, validates the whole patch before mutating, rolls back on setter failure and rejects a stale revision (409). No reset-history/delete/quit/exec or arbitrary file selection endpoints. Scenario CSV load is restricted to the project's scenario library. Imports never overwrite existing files; CSV-relative PNGs travel with their CSV.

Generation pause stops automatic requests and lets the current generation finish. An explicit manual Generate applies pending valid edits, rejects busy/scenario-owned execution, and requests exactly one capture. If held, the TD adapter temporarily releases hold on the same TD main thread only to accept manual_capture, then restores the previous hold in finally. This does not enable timer/chain or cancel a prior generation. Live scenario Play still refuses while held; Preview runs without inference. Automatic operation requires explicit Enable. The held-manual path is covered by laptop unit tests; the 2026-10-18 actual GUI acceptance began unheld, generated one three-image capture in 71.4 seconds, and was paused afterward. Do not claim the held path was verified by that actual capture.

## Outputs and scope

Output adapters consume the existing **deployed test-scoped** `/api/displays/td-a,b,c,now` registry. They do not change captures or choose another run themselves. The new `/control/output/N` pages follow the current TD window1..4 assignments, including scenario layout cues, Show/Hide, Labels/Subtitles, and fade preference. Existing `/display/td-a` etc remain fixed scene URLs. Browser publication now follows TD's `Displaytiming`: `all` retains the previous complete batch until completion; `each` updates each saved scene independently and retains the previous image for unfinished or failed scenes. Every image keeps its own capture, scope and timestamps. The result CONE suppresses distances from a different capture than its NOW image. Timing is read from the private bridge with a short shared cache; errors retain the last confirmed mode, initially `all`. Fixture tests cover partial publication; live partial-generation acceptance is still pending.

Generated subtitles show the saved generation instruction, resolved by exact capture ID, scene and image URL. Missing instructions are explicitly unknown; image inspection descriptions do not replace instructions. NOW retains the original observation. Input preview polls the current input independently of the last captured NOW; replay preview does not advance the frame. A pending input selection survives state polling until the operator submits it and TD confirms the selected or queued set.

Settings poll every 2 seconds, image metadata every 3 seconds, outputs every 1.5 seconds with a shared cache. Editing fields are retained during polling. Scenario playback uses the existing TD timeline; the browser never runs its own cue clock or schedules inference. History reads TD's independent replay observation history.

## Error / execution uncertainty contract

400 invalid command/file; 401 bridge bearer absent; 403 non-tailnet/Host/Origin/header rejection; 409 stale settings, hold, busy, scenario ownership; 413 body too large; 415 non-JSON; 502 TD RPC rejected; 503 TD/read-only bridge unavailable. A mutating transport timeout returns **504 + indeterminate:true**: a command may already have executed.

TD RPC timeout 20s < Node proxy timeout 25s < browser timeout 30s. No automatic mutation retry. Request IDs deduplicate in TD and the bridge's private on-disk journal. A pending/unknown journal entry is not reissued after timeout or bridge restart. Browser blocks further mutations until explicit Refresh state; that reads the authoritative TD state again. Read-only reconnection does not automatically restart generation or scenarios. Outputs keep the last confirmed image on disconnection and show the connection status.

## Independent browser output mapping

`/control/mapping/` assigns saved camera frames, generated images and imported PNG/JPEG/WebP files to browser screens. `/control/screen/screen-N` uses the existing player. These screens do not change generation imageCount or the four TD output assignments. Configuration supports up to 64 screens; the UI has a ten-screen setup action.

`GET /api/browser-outputs` reads configuration; same-origin JSON `POST` with `X-Control-Request: 1`, `baseRevision`, `requestId` and the full `outputs` array saves it atomically. `GET /api/browser-outputs/screen-N` returns a schema-1 snapshot with `view` flags. `GET /api/browser-outputs/catalog?kind=all&limit=20` pages the image pool. `POST /api/browser-outputs/assets` imports `{filename,imageDataUrl}` into a private directory outside the repository. Arbitrary URLs and filesystem paths are not accepted. All routes require an allowed Host and a loopback or Tailscale peer.

Each output selects NOW/A/B/C, an actual recorded offset, generated history, or a fixed catalog contentId. Automatic history stays in the active source scope; fixed selections can use older scopes. Unknown clocks have `clock.known=false`, and uploaded images have no fabricated recording or generation timestamps. Historical generated subtitles resolve the exact saved instruction after selection. A missing instruction is explicitly unknown.

Catalog loading and concurrent requests share a short cache; timeline selection uses a shared index. Pool thumbnails are on-demand JPEGs up to 320×180 with disk/inflight caching and at most two CPU conversions at once. Metadata reads do not run inference. Current past recordings are saved still-frame sequences; this feature does not create or claim a recorded video stream.

Live recording metadata uses acquisition time with an explicit timezone and `sourceScope: camera:<stable-id>`. Generation requests bind that camera scope only for confirmed non-test live inputs. Legacy record-only frames with unknown input/time remain available for fixed mapping and do not silently enter automatic camera history.

## Verification

`python tools/browser-control/test_control.py`: 14 protocol/import/idempotency tests.
`node --test tools/browser-control/node-proxy.test.mjs`: 7 proxy/origin/address/uncertainty tests.
Actual browser and TD checks are recorded separately; unit tests do not prove inference occurred.
### Main server operator runtime

`OPERATOR_RUNTIME=native` keeps the existing browser API and runs settings,
scenario playback, generation acceptance and display routing on the main server.
`OPERATOR_CONTROL_DIRECTORY` points to a private directory outside the repository.
It contains `bootstrap-state.json`, persistent `state.json`, the `scenarios` library,
and `scenario-events.jsonl`. Initial migration starts in Manual with submission
hold enabled and Preview disabled. It preserves scene instructions and distances.

In native mode the configured laptop bridge supplies only `/api/input/state`,
`preview`, `frame` and `select`. Control API requests never fall back to TD.
Input selection starts a camera only when the user explicitly selects it.
Manual Generate is a single request under hold; live scenario Play authorizes
only its own cues. Timer and chain still require Resume. Stop restores the
previous layout. A command ACK confirms capture acceptance, while completion
and failures remain visible through the capture lifecycle.

Scenario CSV parsing reuses the established grammar in
`scripts/operator-scenario`. The Node clock applies only the latest layout on
catch-up and skips old generation cues instead of generating a backlog.
One-shot instructions are consumed only at actual capture acceptance, with
tokens protecting later edits. Instructions exceeding the existing generation
parser budget are rejected rather than silently truncated.

Live recording uses a one-second clock with one request in flight and no queue.
Test replay and stopped input do not trigger live recording. Live scenario
authorization permits recording while the global automatic-generation hold is
kept on. Recorded bytes retain their acquisition time and camera scope.

