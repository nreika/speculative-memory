<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/e8858f2a-09bc-4544-bc5e-8fb79710a497

## Run Locally

**Prerequisites:**  Node.js

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## GitHub Integration

This project is now set up to work cleanly with GitHub:

- Runtime output in `captures/` is ignored, so generated prediction images do not pollute commits
- A GitHub Actions workflow at `.github/workflows/ci.yml` runs `npm run lint`, `npm run build`, and a Python syntax check for the TouchDesigner listener
- `.env.local` stays local and is not committed

Recommended first-time commands:

1. Initialize Git locally if needed:
   `git init --initial-branch=main`
2. Stage the project:
   `git add .`
3. Create the first commit:
   `git commit -m "Initial commit"`
4. Connect your GitHub repository:
   `git remote add origin <YOUR_GITHUB_REPO_URL>`
5. Push to GitHub:
   `git push -u origin main`

If you later add TouchDesigner project files such as `.toe` or `.tox`, keep them under `touchdesigner/` and commit them intentionally because they are binary project assets.

## TouchDesigner Real-Time Bridge

### Browser Camera to TouchDesigner (WebRTC)

The browser can keep exclusive access to the camera and stream that live feed to TouchDesigner over WebRTC. This avoids the unstable "two apps try to open the same webcam" setup.

What changed in the app:

- The React app now exposes a `TouchDesigner_Bridge` panel
- `START_WEBRTC_STREAM` creates a local signaling session at `/api/touchdesigner-stream`
- The browser camera stream is published from the existing `getUserMedia()` feed, so prediction capture still works as before

Default session ID:

- `timewarp-local`

Recommended flow:

1. Start the app with `npm run dev`
2. Allow camera access in the browser as usual
3. In the sidebar, keep `Session_ID` as `timewarp-local` or set your own value
4. Press `START_WEBRTC_STREAM`
5. In TouchDesigner, use the sample receiver in [touchdesigner/td_webrtc_receiver.py](./touchdesigner/td_webrtc_receiver.py)
6. Receive the remote video track through `WebRTC DAT` and `Video Stream In TOP`

Notes:

- This WebRTC bridge is designed for local machine / local network use first
- If you move TouchDesigner onto another machine, you may need to add STUN/TURN settings on the TouchDesigner side
- The signaling session is kept in memory and expires automatically
- The existing UDP image-save bridge still works independently
### Prediction Image Notifications (UDP)

When a capture is saved, the local server now does three extra things:

1. Saves each generated image with its own timestamped filename
2. Writes the newest event to `captures/latest.json` and the per-scene state to `captures/latest_scenes.json`
3. Sends the same metadata as a UDP JSON message to TouchDesigner

Optional environment variables:

- `PORT=3000`
- `HMR_PORT=24679`
- `TOUCHDESIGNER_BRIDGE_ENABLED=true`
- `TOUCHDESIGNER_UDP_HOST=127.0.0.1`
- `TOUCHDESIGNER_UDP_PORT=9989`

The payload looks like this:

```json
{
  "type": "capture.saved",
  "captureId": "1776156364832",
  "sceneKey": "gen_a",
  "sceneIndex": 0,
  "expectedImageCount": 3,
  "label": "Gen_a",
  "filename": "Gen_a_1776156364832.png",
  "absolutePath": "C:/.../captures/Gen_a_1776156364832.png",
  "normalizedPath": "C:/.../captures/Gen_a_1776156364832.png",
  "relativePath": "captures/Gen_a_1776156364832.png",
  "url": "/captures/Gen_a_1776156364832.png",
  "latestImagePath": "C:/.../captures/Gen_a_1776156364832.png",
  "latestImageNormalizedPath": "C:/.../captures/Gen_a_1776156364832.png",
  "latestImageUrl": "/captures/Gen_a_1776156364832.png",
  "sourceImageFilename": "record_1776156364832.jpg",
  "sourceImageAbsolutePath": "C:/.../captures/record_1776156364832.jpg",
  "sourceImageNormalizedPath": "C:/.../captures/record_1776156364832.jpg",
  "sourceImageRelativePath": "captures/record_1776156364832.jpg",
  "sourceImageUrl": "/captures/record_1776156364832.jpg",
  "savedAt": "2026-04-14T08:42:31.000Z",
  "size": 123456
}
```

TouchDesigner sample files are in [touchdesigner/README.md](./touchdesigner/README.md).

TouchDesigner-triggered captures can now set `imageCount` from `1` to `10`. The browser app uses that value to decide how many future images to generate for the current capture batch.

