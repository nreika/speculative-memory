
import './server/loadEnv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dgram from 'dgram';
import {
  BACKEND as GENERATION_BACKEND,
  backendStatus,
  clockForSignedDistance,
  generateImage,
  predictScenarios,
  readSceneParams,
} from './server/generation/orchestrator';
import type { PlanTrace } from './server/generation/vlmClient';
import { describePeople } from './server/generation/peopleDescribe';
import { cropRectFor, imageSize, type CropRect } from './server/generation/referenceCrop';
import { behindViewSentence } from './server/generation/orchestrator';
import { mentionsPerson } from './server/generation/scenarioGuard';
import {
  buildSceneExtrasNote,
  parseSceneExtras,
  personExtrasInEmptyRoom,
} from './server/generation/sceneExtras';
import { buildHistoryContextNote } from './services/promptBuilder';
import {
  appendHistory,
  historyEnabled,
  historyFilePath,
  historyLimit,
  historyWindowMin,
  latestPerson,
  readHistory,
  formatHistory,
  recentEntries,
  recentPersonWindowMin,
  resetHistory,
  type LatestPrediction,
} from './server/history/sceneHistory';
import {
  refFramesEnabled,
  refFramesMax,
  refFramesWindowMin,
  classifyOrientation,
  selectRefFrames,
  saveRefFrame,
  loadRefFrameDataUrls,
  resetRefFrames,
  type RefFrameChoice,
} from './server/history/refFrames';
import {
  EMPTY_SUMMARY,
  clearSummary,
  composeSummary,
  loadSummary,
  saveSummary,
  summarizeHistory,
  type HistorySummary,
} from './server/history/historySummary';
import {
  describeSceneParams,
  formatSignedDistanceShort,
  resolveSceneDistances,
  sceneDistanceAt,
} from './services/sceneParams';
import { nowContentText, scenarioContentText } from './services/promptBuilder';
import {
  CaptureLifecycleMessage,
  CaptureManager,
  CaptureSource,
  isAbortError,
} from './server/captureManager';
import { createCaptureQa } from './server/qa/imageJudge';
import { GenerationArchive, generationIdFromFilename, archiveRootDir } from './server/archive/generationArchive';
import { comfyConfig } from './server/generation/comfyClient';
import { vlmConfig } from './server/generation/vlmClient';
import { getCostTracker } from './server/usage/costTracker';
import { buildPublicUrl, resolveNotifyHost, resolvePublicBaseUrl } from './server/network/notifyTarget';
import { registerPresenceRoutes } from './server/presence/routes';
import { registerHealthRoutes } from './server/health/routes';
import { getComfyWatchdog } from './server/generation/comfyWatchdog';
import { obstructedSince, withObstructionNote } from './server/events/obstruction';
import { CaptureEventStore, type CaptureEvent as CaptureEventRow } from './server/events/captureEvents';
import { registerEventRoutes } from './server/events/routes';
import { QaService } from './server/qa/qaService';
import { ensureRulebookFiles, rulebookVersion } from './server/generation/rulebook';
import { mobileAccessGuard } from './server/mobile/access';
import { MobileQueue } from './server/mobile/queue';
import { registerMobileRoutes, type MobilePayload } from './server/mobile/routes';
import { purgeExpiredMobile } from './server/mobile/archiveList';
import { GEMINI_IMAGE_MODEL, GEMINI_VLM_MODEL, backendLabel, resolveBackends } from './server/generation/backends';

interface CaptureEvent {
  type: 'capture.saved';
  /** ComfyUI hang alert (comfyWatchdog): set while consecutive timeouts are being handled, else absent. */
  alert?: { level: string; message: string; since: string } | null;
  /** ~200-char Japanese summary of the room so far (same text on all three images). */
  historySummary?: string;
  /** Operator extras that were not applied: { gen_b: 'ignored: frame empty' } (shown by TD). */
  extrasStatus?: Record<string, string>;
  /** The describe call judged the camera view blocked by a close object (TD display comes later). */
  obstructed?: boolean | null;
  obstructedBy?: string | null;
  /** Rulebook version (rulebook/active.json) the prompts of this capture were built with. */
  rulebookVersion?: number | null;
  test?: boolean;
  captureId: string;
  sceneKey: string;
  sceneIndex: number | null;
  expectedImageCount: number;
  label: string;
  filename: string;
  absolutePath: string;
  normalizedPath: string;
  relativePath: string;
  url: string;
  latestImagePath: string;
  latestImageNormalizedPath: string;
  latestImageUrl: string;
  sourceImageFilename: string | null;
  sourceImageAbsolutePath: string | null;
  sourceImageNormalizedPath: string | null;
  sourceImageRelativePath: string | null;
  sourceImageUrl: string | null;
  /** Absolute URL of the saved source photo (same file as sourceImageUrl); null if none was saved. */
  nowUrl: string | null;
  savedAt: string;
  size: number;
  /** Situation text of this image (the model's scenario_description; no prompt boilerplate). Shown in TD. */
  sceneText?: string;
  /** Scene-recognition text of the source frame (NOW), same on every image of a capture. Shown in TD. */
  nowText?: string;
  /**
   * Distance (seconds) of THIS image from the source frame. With `distanceSigned: true`
   * it is signed (negative = past, positive = future, -600..+600), per scene.
   */
  distanceSec?: number;
  /** True when `distanceSec` is signed. TD uses the sign instead of guessing the direction from the scene index. */
  distanceSigned?: boolean;
  /** Backends/models actually used for this capture ('local' | 'gemini'; a fallback shows the real value). */
  vlmBackend?: string;
  vlmModel?: string;
  imageBackend?: string;
  imageModel?: string;
}

interface SavedImageAsset {
  filename: string;
  absolutePath: string;
  normalizedPath: string;
  relativePath: string;
  url: string;
  size: number;
}

interface PredictionDataLogItem {
  sceneIndex?: number | null;
  label?: string;
  predictionText: string;
  /** Signed distance (seconds) of this scenario from the frame. */
  distanceSec?: number;
}

interface LatestScenesManifest {
  updatedAt: string;
  scenes: Record<string, CaptureEvent>;
}

interface SessionDescriptionPayload {
  type: 'offer' | 'answer';
  sdp: string;
  updatedAt: string;
}

interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface TouchDesignerIceCandidateMessage {
  id: number;
  from: 'browser' | 'touchdesigner';
  candidate: IceCandidatePayload;
  createdAt: string;
}

interface TouchDesignerStreamSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  offer: SessionDescriptionPayload | null;
  answer: SessionDescriptionPayload | null;
  candidates: TouchDesignerIceCandidateMessage[];
  nextCandidateId: number;
}

type TouchDesignerControlCommandType = 'capture';

interface TouchDesignerControlCommand {
  id: number;
  type: TouchDesignerControlCommandType;
  /** The capture this command starts; the browser sends it back on every request. */
  captureId: string;
  imageCount: number;
  promptVariant?: string | null;
  promptParams?: Record<string, number | string>;
  createdAt: string;
}

type ParsedTouchDesignerControlMessage =
  | {
      sessionId: string;
      type: 'capture';
      captureId?: string;
      imageCount: number;
      promptVariant?: string | null;
      promptParams?: Record<string, number | string>;
    }
  | {
      type: 'cancel';
      captureId?: string;
    };

interface TouchDesignerControlSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  commands: TouchDesignerControlCommand[];
  nextCommandId: number;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || '3000');
  const HMR_PORT = Number(process.env.HMR_PORT || '24679');
  const defaultImageCount = 3;
  const minImageCount = 1;
  const maxImageCount = 10;

  // Ensure captures directory exists
  const capturesDir = path.resolve(process.cwd(), process.env.CAPTURES_DIR || 'captures'); // CAPTURES_DIR is for test instances
  if (!fs.existsSync(capturesDir)) {
    fs.mkdirSync(capturesDir);
  }

  const latestMetaPath = path.join(capturesDir, 'latest.json');
  const latestScenesMetaPath = path.join(capturesDir, 'latest_scenes.json');
  const predictionDataLogPath = path.join(capturesDir, 'prediction_data.md');
  const touchDesignerBridgeEnabled = (process.env.TOUCHDESIGNER_BRIDGE_ENABLED ?? 'true').toLowerCase() !== 'false';
  const touchDesignerHost = process.env.TOUCHDESIGNER_UDP_HOST || '127.0.0.1';
  const touchDesignerPort = Number(process.env.TOUCHDESIGNER_UDP_PORT || '9989');
  const tokyoTimestampFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const touchDesignerControlUdpEnabled = (process.env.TOUCHDESIGNER_CONTROL_UDP_ENABLED ?? 'true').toLowerCase() !== 'false';
  const touchDesignerControlUdpHost = process.env.TOUCHDESIGNER_CONTROL_UDP_HOST || '127.0.0.1';
  const touchDesignerControlUdpPort = Number(process.env.TOUCHDESIGNER_CONTROL_UDP_PORT || '9990');
  const touchDesignerStreamSessionTtlMs = Number(process.env.TOUCHDESIGNER_STREAM_SESSION_TTL_MS || '1800000');
  const touchDesignerControlSessionTtlMs = Number(process.env.TOUCHDESIGNER_CONTROL_SESSION_TTL_MS || '1800000');
  const udpClient = dgram.createSocket('udp4');
  const touchDesignerControlUdpServer = dgram.createSocket('udp4');
  const touchDesignerStreamSessions = new Map<string, TouchDesignerStreamSession>();
  const touchDesignerControlSessions = new Map<string, TouchDesignerControlSession>();
  const sourceImageAssetsByCaptureId = new Map<string, SavedImageAsset>();
  // Two-machine setup: image URLs in UDP messages are absolute, built from PUBLIC_BASE_URL
  // (default http://127.0.0.1:<PORT>). Set it to http://<this PC's LAN/Tailscale IP>:3000 for a remote TD.
  const publicBaseUrl = resolvePublicBaseUrl(process.env.PUBLIC_BASE_URL, PORT);
  // Per-capture UDP target (body.notifyHost / body.notifyToSender on /api/generate). Messages that carry a
  // captureId found here go only to that host; everything else (usage.updated, server.ready, ...) goes to the
  // default host and to every host a capture was recently routed to.
  const captureNotifyHosts = new Map<string, string>();
  const recentNotifyHosts = new Set<string>();
  const targetsFor = (payload: unknown): string[] => {
    const captureId = (payload as { captureId?: unknown } | null)?.captureId;
    if (typeof captureId === 'string') {
      const routed = captureNotifyHosts.get(captureId);
      if (routed) return [routed];
    }
    return [touchDesignerHost, ...recentNotifyHosts].filter((host, i, all) => all.indexOf(host) === i);
  };
  const routeCaptureNotifications = (captureId: string, host: string) => {
    if (host === touchDesignerHost) return;
    captureNotifyHosts.set(captureId, host);
    recentNotifyHosts.add(host);
    while (captureNotifyHosts.size > 50) {
      captureNotifyHosts.delete(captureNotifyHosts.keys().next().value as string);
    }
    console.log(`TouchDesigner notify target for capture ${captureId}: udp://${host}:${touchDesignerPort} (default ${touchDesignerHost})`);
  };
  // Test captures (body.test:true / captureId containing "test") are sent with test:true + source:'test' so the venue
  // display can show a banner; body.notify:false sends nothing at all. Neither updates latest.json.
  const testCaptureIds = new Set<string>();
  const silentCaptureIds = new Set<string>();
  const sendToTouchDesigner = (payload: unknown, what: string) => {
    if (!touchDesignerBridgeEnabled) {
      return;
    }
    const cid = (payload as { captureId?: unknown } | null)?.captureId;
    if (typeof cid === 'string' && silentCaptureIds.has(cid)) {
      return;
    }
    const outgoing =
      typeof cid === 'string' && testCaptureIds.has(cid)
        ? { ...(payload as object), test: true, source: 'test' }
        : payload;

    const body = Buffer.from(JSON.stringify(outgoing));
    for (const host of targetsFor(payload)) {
      udpClient.send(body, touchDesignerPort, host, (error) => {
        if (error) {
          console.error(`Failed to notify TouchDesigner at ${host} (${what}):`, error);
        }
      });
    }
  };
  // Gemini cost accounting (server/usage/costTracker.ts): every call lands in
  // logs/usage.jsonl and a usage.updated datagram goes to TD after each one.
  const costTracker = getCostTracker();
  costTracker.setNotifier((update) => sendToTouchDesigner(update, 'usage.updated'));
  app.get('/api/usage', (_req, res) => {
    res.json(costTracker.snapshot());
  });
  // Scene history (server/history): observations of past captures, oldest first.
  let latestPredictionStore: LatestPrediction | null = null;
  // Venue history summary (~200 chars, Japanese): last value is reused until a new one is ready; test captures never change it.
  let venueSummary: HistorySummary = loadSummary();
  // Closing note "(カメラが遮られている可能性)" while the latest captures are judged obstructed (decided: generation continues).
  const summaryWithObstruction = () => withObstructionNote(composeSummary(venueSummary), obstructedSince(captureEvents.readAll()));
  app.get('/api/history-summary', (_req, res) => {
    res.json({ ...venueSummary, summary: summaryWithObstruction(), obstructedSince: obstructedSince(captureEvents.readAll()) });
  });
  app.get('/api/action-history', (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(50, Math.floor(raw)) : 8;
    const items = readHistory().slice(-limit).map((e) => ({
      captureId: e.captureId,
      at: e.time,
      observation: e.observation,
      hasPerson: e.hasPerson,
    }));
    res.json({ count: items.length, items, text: items.map((e, i) => `${i + 1}. ${e.observation}`).join('\n') });
  });
  app.post('/api/reset-history', (_req, res) => {
    try {
      const archived = resetHistory();
      const refArchived = resetRefFrames();
      clearSummary();
      venueSummary = { ...EMPTY_SUMMARY };
      res.json({ ok: true, archivedTo: archived ? path.relative(process.cwd(), archived) : null, refFramesArchivedTo: refArchived });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'reset failed' });
    }
  });
  app.get('/api/latest-prediction', (_req, res) => {
    let latest = latestPredictionStore;
    if (!latest) {
      try {
        latest = JSON.parse(fs.readFileSync(path.join(path.dirname(historyFilePath()), 'latest-prediction.json'), 'utf8'));
      } catch {
        latest = null;
      }
    }
    if (!latest) return res.status(404).json({ error: 'no prediction yet' });
    res.json(latest);
  });
  // Single active capture; lifecycle messages go to TD next to capture.saved.
  // Advisory image QA (server/qa/imageJudge.ts): runs after generation.completed,
  // never blocks the pipeline. QA_ENABLED / QA_MODEL, see that file.
  const captureQa = createCaptureQa({ rootDir: process.cwd(), capturesDir });
  const captureManager = new CaptureManager({
    notify: (message: CaptureLifecycleMessage) => {
      sendToTouchDesigner(message, message.type);
      try {
        if (message.type === 'generation.completed') captureQa.onCompleted(message.captureId);
        else if (message.type === 'generation.cancelled' || message.type === 'generation.failed') {
          captureQa.discard(message.captureId);
        }
      } catch (error) {
        console.error('[qa] hook failed:', error);
      }
    },
    pickupTimeoutMs: Number(process.env.CAPTURE_PICKUP_TIMEOUT_MS || '30000'),
    idleTimeoutMs: Number(process.env.CAPTURE_IDLE_TIMEOUT_MS || '360000'),
  });
  // Phone lane: its own manager, so a venue capture never cancels it and it never talks to TD (notify is a no-op).
  const mobileCaptureManager = new CaptureManager({
    notify: () => undefined,
    pickupTimeoutMs: 30000,
    idleTimeoutMs: Number(process.env.CAPTURE_IDLE_TIMEOUT_MS || '360000'),
  });
  /**
   * Signal for one HTTP request's share of a capture: aborts when the capture
   * is cancelled, or when the client goes away mid-request (the browser
   * aborted its fetch / the tab closed / TD dropped the connection). A client
   * vanishing while its capture is still active cancels the capture.
   */
  const requestSignal = (res: express.Response, captureId: string | null, captureSignal?: AbortSignal, manager: CaptureManager = captureManager) => {
    const closed = new AbortController();
    res.on('close', () => {
      if (res.writableEnded) {
        return;
      }
      closed.abort(new DOMException('client closed the request', 'AbortError'));
      if (captureId && manager.isActive(captureId)) {
        manager.cancel(captureId, 'client-gone');
      }
    });
    return captureSignal ? AbortSignal.any([captureSignal, closed.signal]) : closed.signal;
  };
  const readCaptureId = (value: unknown): string | null => {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) {
      return null;
    }
    return rawValue.replace(/[^a-zA-Z0-9_-]/g, '') || null;
  };
  const sendCancelled = (res: express.Response, captureId: string, manager: CaptureManager = captureManager) => {
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.status(409).json({ cancelled: true, captureId, state: manager.stateOf(captureId) });
    }
  };
  const imageDataUrlPattern = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;
  const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
  const normalizeSceneKey = (value: unknown, fallbackLabel: unknown) => {
    const rawValue = String(value || '').trim();
    if (rawValue) {
      return rawValue.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'gen';
    }

    const rawLabel = String(fallbackLabel || 'gen').replace(/\s+/g, '');
    return rawLabel.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'gen';
  };
  const normalizeSessionId = (value: unknown) => {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
      return 'timewarp-local';
    }

    return rawValue.replace(/[^a-zA-Z0-9_-]/g, '') || 'timewarp-local';
  };
  const normalizeCaptureId = (value: unknown) => {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
      return String(Date.now());
    }

    return rawValue.replace(/[^a-zA-Z0-9_-]/g, '') || String(Date.now());
  };
  const normalizeImageCount = (value: unknown) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return defaultImageCount;
    }

    return Math.min(maxImageCount, Math.max(minImageCount, Math.round(numericValue)));
  };
  const getImageExtension = (mimeType: string) => {
    switch (mimeType.toLowerCase()) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      default:
        return mimeType.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png';
    }
  };
  const decodeImageDataUrl = (imageDataUrl: string) => {
    const match = imageDataUrl.match(imageDataUrlPattern);
    if (!match) {
      throw new Error('Invalid image data URL');
    }

    return {
      buffer: Buffer.from(match[2], 'base64'),
      extension: getImageExtension(match[1])
    };
  };
  const formatTokyoTimestampForFilename = (date = new Date()) => {
    const parts = tokyoTimestampFormatter.formatToParts(date);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    ) as Record<string, string>;

    return `${values.year}-${values.month}-${values.day}_${values.hour}-${values.minute}-${values.second}`;
  };
  const formatTokyoTimestampForDocument = (date = new Date()) =>
    formatTokyoTimestampForFilename(date).replace('_', ' ');
  const normalizePredictionLogText = (value: unknown) =>
    String(value || '').replace(/\r\n/g, '\n').trim();
  const buildPredictionDataLogEntry = (
    captureId: string,
    items: PredictionDataLogItem[],
    date = new Date(),
    sceneControls?: string,
    nowText?: string
  ) => {
    const lines = [
      '',
      `## Capture ${formatTokyoTimestampForDocument(date)}`,
      `- captureId: ${captureId}`,
      ...(sceneControls ? [`- controls: ${sceneControls}`] : []),
      ...(nowText ? [`- now: ${normalizePredictionLogText(nowText)}`] : []),
      ''
    ];

    items.forEach((item, fallbackIndex) => {
      const sceneIndex = Number.isInteger(item.sceneIndex) ? Number(item.sceneIndex) : fallbackIndex;
      const displayIndex = sceneIndex + 1;
      const label = String(item.label || '').trim();
      const labelSuffix = label ? ` - ${label}` : '';

      lines.push(
        `### Prediction_Data (T+${displayIndex})${labelSuffix}`,
        ...(item.distanceSec !== undefined ? [`- distance: ${formatSignedDistanceShort(item.distanceSec)}`] : []),
        normalizePredictionLogText(item.predictionText),
        ''
      );
    });

    return `${lines.join('\n')}\n`;
  };
  const buildSavedFilename = (prefix: string, extension: string, date = new Date()) => {
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_') || 'capture';
    const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png';
    const timestamp = formatTokyoTimestampForFilename(date);

    return `${safePrefix}_${timestamp}.${safeExtension}`;
  };
  const buildSavedImageAsset = (filename: string, buffer: Buffer): SavedImageAsset => {
    const absolutePath = path.join(capturesDir, filename);
    return {
      filename,
      absolutePath,
      normalizedPath: normalizePath(absolutePath),
      relativePath: normalizePath(path.relative(process.cwd(), absolutePath)),
      url: buildPublicUrl(publicBaseUrl, `/captures/${filename}`),
      size: buffer.length
    };
  };
  const saveImageAsset = (filename: string, buffer: Buffer): SavedImageAsset => {
    const asset = buildSavedImageAsset(filename, buffer);
    fs.writeFileSync(asset.absolutePath, buffer);
    return asset;
  };
  const ensureSourceImageSaved = (sourceImage: unknown, captureId: string): SavedImageAsset | null => {
    if (typeof sourceImage !== 'string' || !sourceImage.trim()) {
      return null;
    }

    const { buffer, extension } = decodeImageDataUrl(sourceImage);
    const cachedAsset = sourceImageAssetsByCaptureId.get(captureId);
    if (cachedAsset && fs.existsSync(cachedAsset.absolutePath)) {
      return cachedAsset;
    }

    const asset = buildSavedImageAsset(buildSavedFilename('record', extension), buffer);
    fs.writeFileSync(asset.absolutePath, buffer);
    console.log(`Saved source image to: ${asset.absolutePath}`);
    sourceImageAssetsByCaptureId.set(captureId, asset);

    return asset;
  };
  const readLatestScenesManifest = (): LatestScenesManifest => {
    if (!fs.existsSync(latestScenesMetaPath)) {
      return { updatedAt: '', scenes: {} };
    }

    try {
      return JSON.parse(fs.readFileSync(latestScenesMetaPath, 'utf8')) as LatestScenesManifest;
    } catch (error) {
      console.error('Failed to parse latest scenes metadata:', error);
      return { updatedAt: '', scenes: {} };
    }
  };
  const summarizeTouchDesignerStreamSession = (session: TouchDesignerStreamSession) => ({
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    hasOffer: Boolean(session.offer),
    hasAnswer: Boolean(session.answer),
    candidateCounts: {
      browser: session.candidates.filter((item) => item.from === 'browser').length,
      touchdesigner: session.candidates.filter((item) => item.from === 'touchdesigner').length
    }
  });
  const createTouchDesignerStreamSession = (sessionId: string) => {
    const now = new Date().toISOString();
    const session: TouchDesignerStreamSession = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      offer: null,
      answer: null,
      candidates: [],
      nextCandidateId: 1
    };

    touchDesignerStreamSessions.set(sessionId, session);
    return session;
  };
  const getTouchDesignerStreamSession = (sessionId: string) =>
    touchDesignerStreamSessions.get(sessionId) || null;
  const cleanupExpiredTouchDesignerStreamSessions = () => {
    const expirationThreshold = Date.now() - touchDesignerStreamSessionTtlMs;

    for (const [sessionId, session] of touchDesignerStreamSessions.entries()) {
      if (new Date(session.updatedAt).getTime() < expirationThreshold) {
        touchDesignerStreamSessions.delete(sessionId);
      }
    }
  };
  const summarizeTouchDesignerControlSession = (session: TouchDesignerControlSession) => ({
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    commandCount: session.commands.length
  });
  const createTouchDesignerControlSession = (sessionId: string) => {
    const now = new Date().toISOString();
    const session: TouchDesignerControlSession = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      commands: [],
      nextCommandId: 1
    };

    touchDesignerControlSessions.set(sessionId, session);
    return session;
  };
  const getTouchDesignerControlSession = (sessionId: string) =>
    touchDesignerControlSessions.get(sessionId) || null;
  const cleanupExpiredTouchDesignerControlSessions = () => {
    const expirationThreshold = Date.now() - touchDesignerControlSessionTtlMs;

    for (const [sessionId, session] of touchDesignerControlSessions.entries()) {
      if (new Date(session.updatedAt).getTime() < expirationThreshold) {
        touchDesignerControlSessions.delete(sessionId);
      }
    }
  };
  const enqueueTouchDesignerControlCommand = (
    sessionId: string,
    type: TouchDesignerControlCommandType,
    captureId: string,
    imageCount: number,
    promptVariant?: string | null,
    promptParams?: Record<string, number | string>
  ) => {
    const session = getTouchDesignerControlSession(sessionId) || createTouchDesignerControlSession(sessionId);
    const command: TouchDesignerControlCommand = {
      id: session.nextCommandId++,
      type,
      captureId,
      imageCount: normalizeImageCount(imageCount),
      promptVariant: typeof promptVariant === 'string' ? promptVariant.trim() || null : null,
      promptParams: promptParams && typeof promptParams === 'object' ? promptParams : undefined,
      createdAt: new Date().toISOString()
    };

    session.commands.push(command);
    if (session.commands.length > 100) {
      session.commands = session.commands.slice(-100);
    }
    session.updatedAt = command.createdAt;
    return { session, command };
  };
  const queueTouchDesignerCapture = (
    sessionId: string,
    source: string,
    imageCount = defaultImageCount,
    promptVariant?: string | null,
    promptParams?: Record<string, number | string>,
    requestedCaptureId?: string | null
  ) => {
    cleanupExpiredTouchDesignerControlSessions();

    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedImageCount = normalizeImageCount(imageCount);
    const captureId = readCaptureId(requestedCaptureId) || `ctl-${Date.now()}`;
    // The capture starts now (cancelling any capture still in flight), so TD
    // sees generation.started right away; the browser attaches to it when it
    // picks the command up, or the pickup watchdog fails it.
    captureManager.begin(captureId, {
      source: 'control',
      imageCount: normalizedImageCount,
      awaitingClient: true,
    });
    const { session, command } = enqueueTouchDesignerControlCommand(
      normalizedSessionId,
      'capture',
      captureId,
      normalizedImageCount,
      promptVariant,
      promptParams
    );
    console.log(
      `TouchDesigner remote capture queued via ${source} for session "${normalizedSessionId}" (#${command.id}, captureId=${captureId}, imageCount=${normalizedImageCount}).`
    );
    return { session, command };
  };
  const parseTouchDesignerControlMessage = (messageText: string): ParsedTouchDesignerControlMessage | null => {
    const trimmed = messageText.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const type = parsed.type ?? parsed.action;
        if (type === 'cancel') {
          return { type: 'cancel', captureId: readCaptureId(parsed.captureId) ?? undefined };
        }
        if (type === 'capture') {
          return {
            type: 'capture',
            sessionId: normalizeSessionId(parsed.sessionId),
            captureId: readCaptureId(parsed.captureId) ?? undefined,
            imageCount: normalizeImageCount(parsed.imageCount ?? parsed.count),
            promptVariant: typeof parsed.promptVariant === 'string' ? parsed.promptVariant : null,
            promptParams: parsed.promptParams && typeof parsed.promptParams === 'object' ? parsed.promptParams : undefined
          };
        }
      }
    } catch (_error) {
      // Fallback to a compact plain-text protocol below.
    }

    const [rawType, rawSessionId, rawImageCount] = trimmed.split(':', 3);
    if (rawType === 'cancel') {
      return { type: 'cancel', captureId: readCaptureId(rawSessionId) ?? undefined };
    }
    if (rawType === 'capture') {
      return {
        type: 'capture',
        sessionId: normalizeSessionId(rawSessionId),
        imageCount: normalizeImageCount(rawImageCount)
      };
    }

    return null;
  };

  const publishCapture = (payload: CaptureEvent) => {
    const latestScenesManifest = readLatestScenesManifest();
    latestScenesManifest.updatedAt = payload.savedAt;
    latestScenesManifest.scenes[payload.sceneKey] = payload;

    if (!testCaptureIds.has(payload.captureId)) {
      fs.writeFileSync(latestMetaPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.writeFileSync(latestScenesMetaPath, JSON.stringify(latestScenesManifest, null, 2), 'utf8');
    }

    sendToTouchDesigner(payload, 'capture.saved');
    try {
      captureQa.noteSaved(payload);
    } catch (error) {
      console.error('[qa] noteSaved failed:', error);
    }
  };

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  registerPresenceRoutes(app);
  // ComfyUI hang recovery (comfyWatchdog.ts): alert state -> /api/health, /logs banner, comfy.alert UDP, capture.saved.alert.
  const comfyWatchdog = getComfyWatchdog();
  comfyWatchdog.onChange = (st) => sendToTouchDesigner({ type: 'comfy.alert', alert: st.alert, autoRestarts: st.autoRestarts, lastTimeoutAt: st.lastTimeoutAt }, 'comfy.alert');
  registerHealthRoutes(app, { watchdogStatus: () => comfyWatchdog.status() });
  // Per-capture structured log + display-log + /logs viewer (server/events).
  const captureEvents = new CaptureEventStore(
    path.join(process.cwd(), 'logs', 'capture-events.jsonl'),
    path.join(process.cwd(), 'logs', 'display-log.jsonl'),
    costTracker.logPath,
    () => new Date(),
    () => comfyWatchdog.status().alert
  );
  registerEventRoutes(app, captureEvents, { archiveRoot: archiveRootDir() });
  // Continuous local QA (Qwen, free) between captures + the versioned rulebook with its automatic improvement.
  ensureRulebookFiles();
  // QA_DURING_IMAGE_STAGE=true (default false): also judge while ComfyUI renders the images (stage sceneA/B/C), when the
  // laptop's Ollama is idle. Off by default: the user's rule is "never during a capture".
  const qaDuringImages = (process.env.QA_DURING_IMAGE_STAGE ?? 'false').toLowerCase() === 'true';
  const qaService = new QaService({
    isBusy: () => {
      const c = captureManager.current;
      if (c && !(qaDuringImages && /^scene/.test(c.stage ?? ''))) return true;
      return mobileCaptureManager.current !== null;
    },
    events: captureEvents,
  });
  qaService.registerRoutes(app);
  // Served to the TD machine over HTTP. Image filenames are unique (timestamped); the JSON/markdown
  // "latest" files change in place, so they must never be cached.
  app.use(
    '/captures',
    express.static(capturesDir, {
      setHeaders: (res, filePath) => {
        if (/(^|[\\/])(latest[^\\/]*\.json|prediction_data\.md)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'no-store');
        }
      },
    })
  );

  app.post('/api/touchdesigner-stream/session', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.body?.sessionId);
    const session = createTouchDesignerStreamSession(sessionId);
    res.json(summarizeTouchDesignerStreamSession(session));
  });

  app.get('/api/touchdesigner-stream/session/:sessionId', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const session = getTouchDesignerStreamSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(summarizeTouchDesignerStreamSession(session));
  });

  app.delete('/api/touchdesigner-stream/session/:sessionId', (req, res) => {
    const sessionId = normalizeSessionId(req.params.sessionId);
    touchDesignerStreamSessions.delete(sessionId);
    res.json({ success: true, sessionId });
  });

  app.post('/api/touchdesigner-stream/session/:sessionId/offer', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const { type, sdp } = req.body || {};
    if (type !== 'offer' || typeof sdp !== 'string' || !sdp.trim()) {
      return res.status(400).json({ error: 'A valid WebRTC offer is required' });
    }

    const session = getTouchDesignerStreamSession(sessionId) || createTouchDesignerStreamSession(sessionId);
    session.offer = {
      type,
      sdp,
      updatedAt: new Date().toISOString()
    };
    session.updatedAt = session.offer.updatedAt;
    res.json({ success: true, session: summarizeTouchDesignerStreamSession(session) });
  });

  app.get('/api/touchdesigner-stream/session/:sessionId/offer', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const session = getTouchDesignerStreamSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ offer: session.offer });
  });

  app.post('/api/touchdesigner-stream/session/:sessionId/answer', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const session = getTouchDesignerStreamSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { type, sdp } = req.body || {};
    if (type !== 'answer' || typeof sdp !== 'string' || !sdp.trim()) {
      return res.status(400).json({ error: 'A valid WebRTC answer is required' });
    }

    session.answer = {
      type,
      sdp,
      updatedAt: new Date().toISOString()
    };
    session.updatedAt = session.answer.updatedAt;
    res.json({ success: true, session: summarizeTouchDesignerStreamSession(session) });
  });

  app.get('/api/touchdesigner-stream/session/:sessionId/answer', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const session = getTouchDesignerStreamSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ answer: session.answer });
  });

  app.post('/api/touchdesigner-stream/session/:sessionId/candidates', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const session = getTouchDesignerStreamSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { from, candidate } = req.body || {};
    if ((from !== 'browser' && from !== 'touchdesigner') || !candidate || typeof candidate.candidate !== 'string') {
      return res.status(400).json({ error: 'A valid ICE candidate is required' });
    }

    const message: TouchDesignerIceCandidateMessage = {
      id: session.nextCandidateId++,
      from,
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : null,
        usernameFragment: candidate.usernameFragment ?? null
      },
      createdAt: new Date().toISOString()
    };

    session.candidates.push(message);
    session.updatedAt = message.createdAt;
    res.json({ success: true, candidateId: message.id });
  });

  app.get('/api/touchdesigner-stream/session/:sessionId/candidates', (req, res) => {
    cleanupExpiredTouchDesignerStreamSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const session = getTouchDesignerStreamSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const target = String(req.query.target || 'browser');
    const after = Number(req.query.after || '0');
    const expectedSender = target === 'touchdesigner' ? 'browser' : 'touchdesigner';
    const items = session.candidates.filter((item) => item.from === expectedSender && item.id > after);
    const lastId = items.length > 0 ? items[items.length - 1].id : after;

    res.json({ items, lastId });
  });

  app.post('/api/touchdesigner-control/session/:sessionId/capture', (req, res) => {
    const sessionId = normalizeSessionId(req.params.sessionId);
    const imageCount = normalizeImageCount(req.body?.imageCount);
    const promptVariant = typeof req.body?.promptVariant === 'string' ? req.body.promptVariant : null;
    const promptParams = req.body?.promptParams && typeof req.body.promptParams === 'object'
      ? req.body.promptParams as Record<string, number | string>
      : undefined;
    const { session, command } = queueTouchDesignerCapture(
      sessionId,
      'http',
      imageCount,
      promptVariant,
      promptParams,
      req.body?.captureId
    );
    res.json({
      success: true,
      command,
      session: summarizeTouchDesignerControlSession(session)
    });
  });

  app.get('/api/touchdesigner-control/session/:sessionId/commands', (req, res) => {
    cleanupExpiredTouchDesignerControlSessions();

    const sessionId = normalizeSessionId(req.params.sessionId);
    const session = getTouchDesignerControlSession(sessionId) || createTouchDesignerControlSession(sessionId);
    const after = Number(req.query.after || '0');
    const newer = session.commands.filter((item) => item.id > after);
    const lastId = newer.length > 0 ? newer[newer.length - 1].id : after;
    // Only commands whose capture is still live: a browser that (re)connects
    // must not replay a backlog of old/cancelled captures.
    const items = newer.filter((item) => captureManager.isActive(item.captureId));

    res.json({
      items,
      lastId,
      session: summarizeTouchDesignerControlSession(session)
    });
  });

  app.get('/api/latest-capture', (_req, res) => {
    if (!fs.existsSync(latestMetaPath)) {
      return res.status(404).json({ error: 'No captures have been saved yet' });
    }

    try {
      const payload = JSON.parse(fs.readFileSync(latestMetaPath, 'utf8'));
      res.json(payload);
    } catch (error) {
      console.error('Failed to read latest capture metadata:', error);
      res.status(500).json({ error: 'Failed to read latest capture metadata' });
    }
  });

  app.get('/api/latest-captures', (_req, res) => {
    try {
      res.json(readLatestScenesManifest());
    } catch (error) {
      console.error('Failed to read latest scenes metadata:', error);
      res.status(500).json({ error: 'Failed to read latest scenes metadata' });
    }
  });

  app.post('/api/save-prediction-data', (req, res) => {
    const normalizedCaptureId = normalizeCaptureId(req.body?.captureId);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items: PredictionDataLogItem[] = rawItems
      .map((item, fallbackIndex) => ({
        sceneIndex: Number.isInteger(item?.sceneIndex) ? Number(item.sceneIndex) : fallbackIndex,
        label: typeof item?.label === 'string' ? item.label : '',
        predictionText: normalizePredictionLogText(item?.predictionText)
      }))
      .filter((item) => item.predictionText.length > 0);

    if (items.length === 0) {
      return res.status(400).json({ error: 'No prediction text provided' });
    }

    try {
      fs.appendFileSync(
        predictionDataLogPath,
        buildPredictionDataLogEntry(normalizedCaptureId, items),
        'utf8'
      );

      res.json({
        success: true,
        filename: path.basename(predictionDataLogPath),
        absolutePath: predictionDataLogPath,
        normalizedPath: normalizePath(predictionDataLogPath),
        relativePath: normalizePath(path.relative(process.cwd(), predictionDataLogPath)),
        url: buildPublicUrl(publicBaseUrl, '/captures/prediction_data.md')
      });
    } catch (error) {
      console.error('Failed to save prediction data:', error);
      res.status(500).json({ error: 'Failed to save prediction data' });
    }
  });
  // API to save images
  app.post('/api/save-image', (req, res) => {
    const { image, originalImage, captureId, label, sceneKey, sceneIndex, expectedImageCount } = req.body;
    if (typeof image !== 'string' || !image.trim()) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Lifecycle-tracked captures (the browser sends the captureId it was given)
    // are published only while still active. Unknown ids keep the old,
    // untracked behaviour.
    const trackedCaptureId = readCaptureId(captureId);
    if (trackedCaptureId) {
      const state = captureManager.stateOf(trackedCaptureId);
      if (state !== 'active' && state !== 'unknown') {
        return sendCancelled(res, trackedCaptureId);
      }
    }

    try {
      const normalizedCaptureId = normalizeCaptureId(captureId);
      const sourceImageAsset = ensureSourceImageSaved(originalImage, normalizedCaptureId);
      const { buffer, extension } = decodeImageDataUrl(image);
      const safeSceneKey = normalizeSceneKey(sceneKey, label);
      const safeLabel = String(label || safeSceneKey).replace(/\s+/g, '_');
      const filenamePrefix = safeSceneKey.charAt(0).toUpperCase() + safeSceneKey.slice(1);
      const savedImageAsset = saveImageAsset(buildSavedFilename(filenamePrefix, extension), buffer);
      const payload: CaptureEvent = {
        type: 'capture.saved',
        captureId: normalizedCaptureId,
        sceneKey: safeSceneKey,
        sceneIndex: Number.isInteger(sceneIndex) ? Number(sceneIndex) : null,
        expectedImageCount: normalizeImageCount(expectedImageCount),
        label: safeLabel,
        filename: savedImageAsset.filename,
        absolutePath: savedImageAsset.absolutePath,
        normalizedPath: savedImageAsset.normalizedPath,
        relativePath: savedImageAsset.relativePath,
        url: savedImageAsset.url,
        latestImagePath: savedImageAsset.absolutePath,
        latestImageNormalizedPath: savedImageAsset.normalizedPath,
        latestImageUrl: savedImageAsset.url,
        sourceImageFilename: sourceImageAsset?.filename || null,
        sourceImageAbsolutePath: sourceImageAsset?.absolutePath || null,
        sourceImageNormalizedPath: sourceImageAsset?.normalizedPath || null,
        sourceImageRelativePath: sourceImageAsset?.relativePath || null,
        sourceImageUrl: sourceImageAsset?.url || null,
        nowUrl: sourceImageAsset?.url || null,
        savedAt: new Date().toISOString(),
        size: savedImageAsset.size
      };

      if (trackedCaptureId && captureManager.stateOf(trackedCaptureId) !== 'unknown') {
        if (!captureManager.isActive(trackedCaptureId)) {
          return sendCancelled(res, trackedCaptureId);
        }
        captureManager.noteDelivered(trackedCaptureId);
      }
      publishCapture(payload);

      console.log(`Saved image to: ${savedImageAsset.absolutePath}`);
      res.json({ success: true, capture: payload });
    } catch (error) {
      console.error('Failed to save image:', error);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });

  // --- Local generation backend (ComfyUI/Qwen + Ollama VLM) ---
  const imageDataUrlRe = /^data:image\/[a-zA-Z0-9.+-]+;base64,.+$/;

  app.get('/api/generation-status', async (_req, res) => {
    try {
      res.json(await backendStatus());
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'status check failed' });
    }
  });

  // --- Capture lifecycle API ---
  app.get('/api/capture/status', (_req, res) => {
    res.json(captureManager.snapshot());
  });

  // Record-only frame (Timer mode tick while a generation is running): saved
  // as captures/record_<timestamp>.<ext>, the same series as the source
  // frames of generated captures. Deliberately inert: it does not touch the
  // active capture, sends no generation.* message and nothing to TD's display.
  app.post('/api/capture/record', (req, res) => {
    const { image } = req.body || {};
    if (typeof image !== 'string' || !imageDataUrlRe.test(image)) {
      return res.status(400).json({ error: 'A base64 image data URL is required' });
    }
    try {
      const { buffer, extension } = decodeImageDataUrl(image);
      const asset = saveImageAsset(buildSavedFilename('record', extension), buffer);
      console.log(`Saved record-only frame to: ${asset.absolutePath}`);
      res.json({ success: true, record: asset, savedAt: new Date().toISOString() });
    } catch (error: any) {
      console.error('capture/record failed:', error);
      res.status(500).json({ error: error?.message || 'record save failed' });
    }
  });

  // Cancel the given capture (or whatever is active). Body: { captureId? }
  app.post('/api/capture/cancel', (req, res) => {
    const captureId = readCaptureId(req.body?.captureId);
    const cancelled = captureManager.cancel(captureId, 'requested');
    res.json({ cancelled, ...captureManager.snapshot() });
  });

  // The browser path reports the end of its capture explicitly.
  app.post('/api/capture/:captureId/complete', (req, res) => {
    const captureId = readCaptureId(req.params.captureId) || '';
    const completed = captureManager.complete(captureId);
    res.status(completed ? 200 : 409).json({ completed, state: captureManager.stateOf(captureId) });
  });

  app.post('/api/capture/:captureId/fail', (req, res) => {
    const captureId = readCaptureId(req.params.captureId) || '';
    const failed = captureManager.fail(captureId, new Error(String(req.body?.error || 'client reported failure')));
    res.status(failed ? 200 : 409).json({ failed, state: captureManager.stateOf(captureId) });
  });

  app.post('/api/predict-scenarios', async (req, res) => {
    const { image, target, scenarioCount, promptOptions, sceneTime } = req.body || {};
    const sceneParams = readSceneParams(req.body);
    if (typeof image !== 'string' || !imageDataUrlRe.test(image)) {
      return res.status(400).json({ error: 'A base64 image data URL is required' });
    }
    const normalizedTarget =
      target && typeof target.x === 'number' && typeof target.y === 'number'
        ? { x: target.x, y: target.y }
        : null;

    // With a captureId this request is the first step of a tracked capture:
    // attach to it if TD already started it (control command), start it if it
    // is new (browser-initiated capture; cancels the one in flight), refuse it
    // if it has already ended.
    const captureId = readCaptureId(req.body?.captureId);
    let signal: AbortSignal | undefined;
    if (captureId) {
      const state = captureManager.stateOf(captureId);
      if (state !== 'active' && state !== 'unknown') {
        return sendCancelled(res, captureId);
      }
      const capture =
        state === 'active'
          ? captureManager.get(captureId)!
          : captureManager.begin(captureId, {
              source: 'browser',
              imageCount: normalizeImageCount(scenarioCount),
            });
      captureManager.touch(captureId);
      signal = requestSignal(res, captureId, capture.signal);
    }

    try {
      const scenarios = await predictScenarios({
        imageDataUrl: image,
        target: normalizedTarget,
        scenarioCount: normalizeImageCount(scenarioCount),
        options: promptOptions && typeof promptOptions === 'object' ? promptOptions : undefined,
        sceneTime: typeof sceneTime === 'string' ? sceneTime : undefined,
        sceneParams,
        captureId,
        signal,
      });
      if (captureId) {
        if (!captureManager.isActive(captureId)) {
          return sendCancelled(res, captureId);
        }
        captureManager.touch(captureId);
      }
      res.json({ scenarios, backend: GENERATION_BACKEND, captureId, sceneParams });
    } catch (error: any) {
      if (captureId && (isAbortError(error) || !captureManager.isActive(captureId))) {
        console.log(`predict-scenarios: capture ${captureId} cancelled during planning`);
        return sendCancelled(res, captureId);
      }
      console.error('predict-scenarios failed:', error);
      if (captureId) {
        captureManager.fail(captureId, error);
      }
      res.status(502).json({ error: error?.message || 'scenario prediction failed' });
    }
  });

  app.post('/api/generate-image', async (req, res) => {
    const { originalImage, predictionPrompt, promptOptions, faceImage, seed, timeDirection, sceneTime, clockVisible } =
      req.body || {};
    const sceneParams = readSceneParams(req.body);
    // Optional sceneIndex (0..2) picks that scene's own signed distance; without it the legacy single distance applies.
    const bodySceneIndex = Number.isInteger(req.body?.sceneIndex) ? Number(req.body.sceneIndex) : null;
    const sceneDistance =
      bodySceneIndex !== null && bodySceneIndex >= 0
        ? sceneDistanceAt(sceneParams, bodySceneIndex)
        : timeDirection === 'past'
          ? -sceneParams.futureDistanceSec
          : sceneParams.futureDistanceSec;
    if (typeof originalImage !== 'string' || !imageDataUrlRe.test(originalImage)) {
      return res.status(400).json({ error: 'originalImage (base64 data URL) is required' });
    }
    if (typeof predictionPrompt !== 'string' || !predictionPrompt.trim()) {
      return res.status(400).json({ error: 'predictionPrompt is required' });
    }

    const captureId = readCaptureId(req.body?.captureId);
    let signal: AbortSignal | undefined;
    if (captureId) {
      const capture = captureManager.get(captureId);
      if (!capture || capture.signal.aborted) {
        return sendCancelled(res, captureId);
      }
      captureManager.touch(captureId);
      signal = requestSignal(res, captureId, capture.signal);
    }

    try {
      const image = await generateImage({
        originalImageDataUrl: originalImage,
        predictionPrompt,
        options: promptOptions && typeof promptOptions === 'object' ? promptOptions : undefined,
        faceImageDataUrl:
          typeof faceImage === 'string' && imageDataUrlRe.test(faceImage) ? faceImage : undefined,
        seed: Number.isFinite(seed) ? Number(seed) : undefined,
        filenamePrefix: 'SpecMem/gen',
        captureId,
        presence: sceneParams.presence,
        tone: sceneParams.tone,
        distanceSec: sceneDistance,
        clock:
          timeDirection === 'future' || timeDirection === 'past' || bodySceneIndex !== null
            ? // Detection round-tripped from /api/predict-scenarios (scenario.clock_visible).
              clockForSignedDistance(
                sceneDistance,
                typeof sceneTime === 'string' ? sceneTime : undefined,
                clockVisible === true
              )
            : undefined,
        signal,
      });
      if (captureId) {
        if (!captureManager.isActive(captureId)) {
          return sendCancelled(res, captureId);
        }
        captureManager.touch(captureId);
      }
      res.json({ image, backend: GENERATION_BACKEND, captureId });
    } catch (error: any) {
      if (captureId && (isAbortError(error) || !captureManager.isActive(captureId))) {
        console.log(`generate-image: capture ${captureId} cancelled`);
        return sendCancelled(res, captureId);
      }
      console.error('generate-image failed:', error);
      if (captureId) {
        captureManager.fail(captureId, error);
      }
      res.status(502).json({ error: error?.message || 'image generation failed' });
    }
  });

  // Full server-side capture->generate->save pipeline.
  // Lets TouchDesigner (or anything) hand over one camera frame and get the
  // whole set of speculative-memory images back, saved + broadcast exactly
  // like the browser flow. No browser needed.
  const handleGenerate = async (req: any, res: any, lane: "venue" | "mobile" = "venue") => {
    const mobileLane = lane === "mobile";
    const cm = mobileLane ? mobileCaptureManager : captureManager;
    const { image, imageCount, target, sceneTime } = req.body || {};
    if (typeof image !== 'string' || !imageDataUrlRe.test(image)) {
      return res.status(400).json({ error: 'A base64 image data URL is required' });
    }

    const count = normalizeImageCount(imageCount);
    const captureId = normalizeCaptureId(req.body?.captureId);
    // Per-capture backends (TD Vlmbackend / Imagebackend); missing/invalid -> GENERATION_BACKEND default.
    const backends = resolveBackends(req.body);
    const vlmModelUsed = backends.vlm === 'gemini' ? GEMINI_VLM_MODEL : vlmConfig.model;
    const imageModelUsed =
      backends.image === 'gemini'
        ? GEMINI_IMAGE_MODEL
        : `qwen-image-edit (${process.env.COMFYUI_GGUF === 'true' ? comfyConfig.models.ggufUnet : comfyConfig.models.unet})`;
    console.log(
      `generate: backends: vlm=${backends.vlm} image=${backends.image}` +
        (backends.fellBack.length ? ` (no Gemini API key: ${backends.fellBack.join(',')} fell back to local)` : '')
    );
    // sceneDistancesSec [a,b,c] (signed s; fallback futureDistanceSec N -> [+N,+N,-N]) / presence / tone
    // (TD Perform panel); clamped, defaults if missing.
    const sceneParams = readSceneParams(req.body);
    const sceneDistances = resolveSceneDistances(sceneParams, count);
    // TD sceneExtras { gen_a, gen_b, gen_c }: per-scene "must include" elements (<=200 chars each).
    const sceneExtras = parseSceneExtras(req.body?.sceneExtras);
    const normalizedTarget =
      target && typeof target.x === 'number' && typeof target.y === 'number'
        ? { x: target.x, y: target.y }
        : null;
    const source: CaptureSource = mobileLane ? 'mobile' : req.body?.source === 'browser' ? 'browser' : 'td-native';
    // Phone lane (server/mobile): own CaptureManager, never UDP to TD, no latest.json / venue history / venue summary.
    const isTest = !mobileLane && (req.body?.test === true || /test/i.test(captureId));
    const silent = mobileLane || req.body?.notify === false;
    if (isTest) testCaptureIds.add(captureId);
    if (silent) silentCaptureIds.add(captureId);
    if (mobileLane) console.log(`[mobile] capture ${captureId}: phone lane (no UDP, no latest.json, no venue history)`);
    else if (silent) console.log(`[test] capture ${captureId} no notify`);
    else if (isTest) console.log(`[test] capture ${captureId} (notify with test flag)`);
    // Send this capture's UDP messages to the requester (laptop TD) when asked: body.notifyHost wins,
    // else body.notifyToSender:true uses this request's remote address.
    if (!mobileLane) {
      routeCaptureNotifications(
        captureId,
        resolveNotifyHost({ body: req.body, remoteAddress: req.socket.remoteAddress, defaultHost: touchDesignerHost })
      );
    }

    // A new capture always wins: anything still in flight (TD pressed the
    // manual capture during a generation) is cancelled here, and its own
    // /api/generate request answers 409 { cancelled: true }.
    // ComfyUI being restarted after a hang (comfyWatchdog): do not start a capture until it answers again.
    await comfyWatchdog.whenReady();
    const stateBefore = cm.stateOf(captureId);
    if (stateBefore !== 'unknown' && stateBefore !== 'active') {
      return sendCancelled(res, captureId, cm);
    }
    const capture = cm.begin(captureId, { source, imageCount: count });
    // QA never competes with a capture: the running QA call is aborted, the rest waits until nothing generates.
    qaService.interruptForCapture(!mobileLane);
    const rbVersion = rulebookVersion();
    // Structured log row (logs/capture-events.jsonl): started now, final row at completed/failed/cancelled.
    const evt: CaptureEventRow = {
      captureId,
      source: isTest ? 'test' : source,
      test: isTest || undefined,
      startedAt: new Date().toISOString(),
      result: 'running',
      vlmBackend: backends.vlm,
      vlmModel: vlmModelUsed,
      imageBackend: backends.image,
      imageModel: imageModelUsed,
    };
    evt.rulebookVersion = rbVersion;
    evt.presence = sceneParams.presence;
    evt.tone = sceneParams.tone;
    let evtStage = 'setup';
    const mobileCaptureFiles: string[] = [];
    const setStage = (stage: string) => {
      evtStage = stage;
      cm.setStage(captureId, stage);
    };
    const evtImageUrl = (u: string | null | undefined) => {
      if (!u) return null;
      const i = u.indexOf('/captures/');
      return i >= 0 ? u.slice(i) : null;
    };
    captureEvents.write(evt);
    console.log(`generate: capture ${captureId} controls ${describeSceneParams(sceneParams)}`);
    const signal = requestSignal(res, captureId, capture.signal, cm);
    const ensureActive = () => {
      if (!cm.isActive(captureId)) {
        throw new DOMException(`capture ${captureId} cancelled`, 'AbortError');
      }
      cm.touch(captureId);
    };

    // Additive archive (GENERATION_ARCHIVE_DIR): never affects the generation, see server/archive.
    let archive: GenerationArchive | null = null;
    try {
      const sourceImageAsset = ensureSourceImageSaved(image, captureId);
      if (mobileLane && sourceImageAsset) mobileCaptureFiles.push(sourceImageAsset.filename);
      evt.images = { now: evtImageUrl(sourceImageAsset?.url) };

      try {
        const generationId = generationIdFromFilename(sourceImageAsset?.filename);
        if (generationId) {
          archive = new GenerationArchive({
            generationId,
            captureId,
            source: isTest ? ('test' as CaptureSource) : source,
            capturedAt: typeof sceneTime === 'string' ? sceneTime : new Date().toISOString(),
            backend: backendLabel(backends),
            vlmBackend: backends.vlm,
            vlmModel: vlmModelUsed,
            imageBackend: backends.image,
            imageModel: imageModelUsed,
            rulebookVersion: rbVersion,
            params: {
              sceneDistancesSec: sceneDistances,
              presence: sceneParams.presence,
              tone: sceneParams.tone,
              imageCount: count,
            },
          });
          const src = decodeImageDataUrl(image);
          archive.saveSource(src.buffer, src.extension);
          evt.archiveDir = archive.dir;
        }
      } catch (archiveErr) {
        console.error('generate: archive setup failed (continuing):', archiveErr);
        archive = null;
      }

      // Scene history: recent observations (prompt context) and the "was anyone here lately" rule of the guard.
      // Test captures (body.recordHistory:false / body.test:true / captureId containing "test") neither read nor write the history.
      const useHistory =
        req.body?.recordHistory !== false && !isTest && !mobileLane;
      if (!useHistory && !mobileLane) console.log(`[history] capture ${captureId} is a test capture: history is not read or written`);
      const historyAll = useHistory ? readHistory() : [];
      const historyItems = historyEnabled()
        ? recentEntries(historyAll, { limit: historyLimit(), windowMin: historyWindowMin() })
        : [];
      const recentPerson = latestPerson(historyAll, recentPersonWindowMin());
      const formattedHistory = formatHistory(historyItems);
      const historyNote = buildHistoryContextNote({
        observations: formattedHistory.lines,
        footer: formattedHistory.people,
        recentPerson: recentPerson
          ? { description: recentPerson.entry.sceneDescription, minutesAgo: recentPerson.minutesAgo }
          : null,
      });
      const extrasNote = buildSceneExtrasNote(sceneExtras);
      const contextNote = [historyNote, extrasNote].filter(Boolean).join('\n');
      if (extrasNote) console.log(`[extras] ${JSON.stringify(sceneExtras)}`);
      console.log(
        `[history] ${historyItems.length} obs -> ${formattedHistory.lines.length} lines (limit ${historyLimit()}, window ${historyWindowMin()} min); ` +
          `recent person: ${recentPerson ? `${recentPerson.minutesAgo} min ago` : 'none'}`
      );

      // One short image call both detects and describes (people empty = nobody): occupied = people OR text.
      setStage('detect');
      const described = await describePeople(image, { signal });
      evt.detectDescribeMs = described.elapsedMs;
      const people = described.people;
      if (typeof described.obstructed === 'boolean') {
        evt.obstructed = described.obstructed;
        evt.obstructedBy = described.obstructedBy || undefined;
        if (described.obstructed) console.log(`[guard] camera possibly obstructed by "${described.obstructedBy ?? ''}"`);
      }
      const detect = {
        person: described.ok ? people.length > 0 : (null as boolean | null),
        count: described.ok ? people.length : undefined,
        elapsedMs: described.elapsedMs,
        error: described.ok ? undefined : 'describe failed',
      };
      const detector = {
        person: detect.person,
        count: detect.count,
        elapsedMs: detect.elapsedMs,
        doneReason: described.doneReason,
        raw: described.rawHead,
      };
      console.log(`[guard] detector+describe person=${detect.person} people=${people.length} ${detect.elapsedMs}ms done_reason=${described.doneReason ?? '-'}${detect.error ? ' error=' + detect.error + ' raw=' + (described.rawHead ?? '').slice(0, 120) : ''}`);
      ensureActive();

      const vlmTrace: PlanTrace = {};
      const vlmStartedAt = Date.now();
      setStage('plan');
      const scenarios = await predictScenarios({
        imageDataUrl: image,
        target: normalizedTarget,
        scenarioCount: count,
        sceneTime: typeof sceneTime === 'string' ? sceneTime : new Date().toISOString(),
        sceneParams: contextNote ? { ...sceneParams, contextNote } : sceneParams,
        captureId,
        trace: vlmTrace,
        signal,
        allowPerson: !!recentPerson,
        sceneExtras,
        detector,
        people,
        sceneDistances,
        vlmBackend: backends.vlm,
      });
      {
        const g = vlmTrace.guard;
        evt.planMs = g?.planMs ?? Date.now() - vlmStartedAt;
        evt.planCalls = g?.planCalls ?? null;
        evt.occupied = g ? g.unoccupied === false : null;
        evt.occupancySource = g?.occupancySource ?? null;
        evt.people = people.length;
        if (g && typeof described.obstructed === 'boolean') {
          g.obstructed = described.obstructed;
          g.obstructedBy = described.obstructedBy || undefined;
        }
        evt.guard = { synthesized: !!g?.synthesized, replaced: g?.replaced?.length ?? 0, duplicateRetried: !!g?.duplicateRetried };
        const ex: NonNullable<CaptureEventRow['extras']> = {};
        for (const [key, text] of Object.entries(sceneExtras as Record<string, string | undefined>)) {
          if (!text) continue;
          const c = g?.extras?.[key];
          ex[key] = { text, reflected: c ? c.reflected : null, synthesized: !!c?.synthesized };
        }
        if (Object.keys(ex).length) evt.extras = ex;
      }
      archive?.setVlm({
        promptFull: vlmTrace.promptFull ?? null,
        rawResponse: vlmTrace.rawResponse ?? null,
        parsedScenarios: scenarios,
        elapsedMs: Date.now() - vlmStartedAt,
        guard: vlmTrace.guard ?? null,
        history: {
          used: historyItems.length,
          observations: historyItems.map((e) => e.observation),
          historyText: formattedHistory.text,
          recentPerson: recentPerson
            ? { minutesAgo: recentPerson.minutesAgo, description: recentPerson.entry.sceneDescription, captureId: recentPerson.entry.captureId }
            : null,
        },
      });
      // Record this frame's observation (English scene_description) for later captures.
      const observation = (vlmTrace.guard?.scene ?? scenarios[0]?.scene_now ?? '').trim();
      if (observation && useHistory) {
        try {
          // Only frames where the detector/describe call really saw someone: the scene text alone can claim people that are not in the picture (empty-room frames would be useless references).
          const hasPersonNow = detect.person === true;
          // Keep a downscaled copy of every such frame (outside the public repo) as a future reference image.
          const refFrameFile =
            refFramesEnabled() && hasPersonNow
              ? await saveRefFrame(
                  decodeImageDataUrl(image).buffer,
                  captureId,
                  typeof sceneTime === 'string' && !Number.isNaN(Date.parse(sceneTime)) ? sceneTime : new Date().toISOString()
                )
              : null;
          appendHistory({
            time: typeof sceneTime === 'string' && !Number.isNaN(Date.parse(sceneTime)) ? sceneTime : new Date().toISOString(),
            captureId,
            sceneDescription: observation,
            // the detector/describe verdict wins; the planner's text decides only when there is none
            hasPerson: typeof detect.person === 'boolean' ? detect.person : mentionsPerson(observation),
            detectorPerson: detect.person,
            observation,
            imageFile: sourceImageAsset?.filename,
            people: people.length > 0 ? people : undefined,
            refFrameFile: refFrameFile ?? undefined,
          });
        } catch (histErr) {
          console.error('generate: scene history append failed (continuing):', histErr);
        }
      }
      // Venue summary (~200 chars): runs in parallel with the image generation; test captures leave it alone.
      let summaryPromise: Promise<void> = Promise.resolve();
      if (useHistory) {
        const summaryEntries = recentEntries(readHistory(), {
          limit: 50,
          windowMin: Number(process.env.SUMMARY_WINDOW_MIN || '120'),
        });
        summaryPromise = summarizeHistory(summaryEntries, Date.now(), { signal, prior: venueSummary, older: readHistory() })
          .then((r) => {
            if (r.summary || r.state) {
              venueSummary = {
                summary: '',
                body: r.summary,
                since: r.state?.since ?? null,
                hasPerson: (r.state?.count ?? 0) > 0,
                state: r.state ?? undefined,
                changePoints: r.changePoints,
                lastOccupied: r.lastOccupied,
                updatedAt: new Date().toISOString(),
                captureId,
              };
              venueSummary.summary = composeSummary(venueSummary);
              try {
                saveSummary(venueSummary);
              } catch (saveErr) {
                console.error('[summary] save failed:', saveErr);
              }
            }
            console.log(`[summary] ${r.source} ${r.elapsedMs}ms: ${r.summary.slice(0, 80)}`);
          })
          .catch((err) => console.error('[summary] failed:', err));
      }
      // Empty room: never let the image edit add a person (presence treated as 0).
      // ...unless a person was seen lately: then that person may be present, drawn from their recent frame.
      const unoccupied = vlmTrace.guard?.unoccupied === true && !recentPerson;
      evt.effectivePresence = unoccupied ? 0 : sceneParams.presence;
      const blockedExtras = new Set(personExtrasInEmptyRoom(sceneExtras, unoccupied));
      for (const key of blockedExtras) {
        console.log(`[extras] ${key}: the extra names a person but the room is empty; the extra is ignored (the scenario stays person-free)`);
      }
      let referencePersonImage: string | undefined;
      let referenceCrop: CropRect | null = null;
      // Empty frame + a person seen lately: draw them from behind, same clothes/hair, from a cropped reference.
      const drawFromBehind = vlmTrace.guard?.unoccupied === true && !!recentPerson;
      const recentLook = recentPerson?.entry.people?.[0];
      if (drawFromBehind) console.log(`[guard] recent person drawn from behind (${recentPerson!.minutesAgo} min ago)`);
      if (vlmTrace.guard?.unoccupied === true && recentPerson?.entry.imageFile) {
        try {
          const buf = fs.readFileSync(path.join(capturesDir, path.basename(recentPerson.entry.imageFile)));
          referencePersonImage = `data:image/jpeg;base64,${buf.toString('base64')}`;
          const size = imageSize(buf);
          if (size && recentLook?.position) referenceCrop = cropRectFor(recentLook.position, size.width, size.height);
        } catch {
          referencePersonImage = undefined;
        }
      }
      // Frame with a person (not the recent-person-from-behind case): attach up to REF_FRAMES_MAX recent frames of other orientations.
      let refChoices: RefFrameChoice[] = [];
      let refImages: string[] = [];
      if (refFramesEnabled() && useHistory && backends.image !== 'gemini' && vlmTrace.guard?.unoccupied !== true && !unoccupied && sceneParams.presence > 0) {
        try {
          const cur = classifyOrientation({ people, sceneDescription: observation, observation });
          const picked = selectRefFrames(historyAll, { captureId, orientation: cur }, { max: refFramesMax(), windowMin: refFramesWindowMin() });
          const loaded = await loadRefFrameDataUrls(picked);
          refChoices = loaded.map((l) => l.choice);
          refImages = loaded.map((l) => l.dataUrl);
          console.log(
            `[ref] ${refImages.length} frames: now=${cur.label}` +
              (refChoices.length ? ' | ' + refChoices.map((c) => `${c.captureId} ${c.orientation} (${c.reason})`).join(' | ') : '')
          );
        } catch (refErr) {
          console.error('[ref] selection failed (continuing without):', refErr);
          refChoices = [];
          refImages = [];
        }
      }
      if (vlmTrace.guard) {
        console.log(`[guard] unoccupied=${unoccupied} occupancySource=${vlmTrace.guard.occupancySource} attempts=${vlmTrace.guard.attempts} replaced=[${vlmTrace.guard.replaced.join(',')}]`);
      }
      ensureActive();
      // NOW text (scene recognition of this frame); "" from an old/failed model answer.
      const nowText = nowContentText(scenarios);
      archive?.setNowText(nowText);

      try {
        fs.appendFileSync(
          predictionDataLogPath,
          buildPredictionDataLogEntry(
            captureId,
            scenarios.map((s, index) => ({
              sceneIndex: index,
              label: s.label,
              predictionText: s.scenario_description,
              distanceSec: sceneDistances[index],
            })),
            new Date(),
            describeSceneParams(sceneParams),
            nowText
          ),
          'utf8'
        );
      } catch (logErr) {
        console.error('generate: prediction log append failed', logErr);
      }

      const results: Array<{ sceneKey: string; label: string; url: string; predictionText: string }> = [];
      const qaJobs: Array<{ sceneKey: string; imagePath: string; predictionPrompt: string }> = [];

      const resolvedSceneTime =
        typeof sceneTime === 'string' ? sceneTime : new Date().toISOString();

      for (let index = 0; index < scenarios.length; index += 1) {
        const scenario = scenarios[index];
        const sceneKey = `gen_${String.fromCharCode(97 + index)}`;
        const label = `Gen_${String.fromCharCode(97 + index)}`;

        const imageTrace: { editInstruction?: string | null; negativePrompt?: string | null; seed?: number | null; denoise?: number | null; referenceImage?: string } = {};
        const imageStartedAt = Date.now();
        setStage(`scene${String.fromCharCode(65 + index)}`);
        const dataUrl = await generateImage({
          originalImageDataUrl: image,
          predictionPrompt: scenario.prediction_prompt,
          seed: undefined,
          filenamePrefix: `SpecMem/${sceneKey}`,
          captureId,
          trace: imageTrace,
          faceImageDataUrl: referencePersonImage,
          faceCrop: referenceCrop ?? undefined,
          behindView: drawFromBehind ? { clothes: recentLook?.clothes, hair: recentLook?.hair, position: recentLook?.position } : undefined,
          obstructed: described.obstructed === true,
          obstructedBy: described.obstructedBy || undefined,
          referencePerson: !!referencePersonImage,
          referenceImages: referencePersonImage ? undefined : refImages,
          foregroundObject: scenario.foreground_object,
          presence: unoccupied ? 0 : sceneParams.presence,
          tone: sceneParams.tone,
          distanceSec: sceneDistances[index],
          // Each scene's own signed offset decides the direction and the clock digits.
          clock: clockForSignedDistance(sceneDistances[index], resolvedSceneTime, scenario.clock_visible === true),
          signal,
          imageBackend: backends.image,
        });
        ensureActive();

        const { buffer, extension } = decodeImageDataUrl(dataUrl);
        const savedImageAsset = saveImageAsset(
          buildSavedFilename(sceneKey.charAt(0).toUpperCase() + sceneKey.slice(1), extension),
          buffer
        );
        if (mobileLane) {
          mobileCaptureFiles.push(savedImageAsset.filename);
          archive?.noteCaptureFiles(mobileCaptureFiles);
        }
        (evt as any)[`scene${String.fromCharCode(65 + index)}Ms`] = Date.now() - imageStartedAt;
        (evt.images ??= {})[String.fromCharCode(97 + index) as 'a' | 'b' | 'c'] = evtImageUrl(savedImageAsset.url);
        archive?.addScene(
          index,
          {
            sceneKey,
            distanceSec: sceneDistances[index],
            label: scenario.label,
            predictionPrompt: scenario.prediction_prompt,
            scenarioDescription: scenario.scenario_description,
            imagePromptFull: imageTrace.editInstruction ?? null,
            sceneExtra: (sceneExtras as Record<string, string | undefined>)[sceneKey] ?? null,
            sceneExtraReflected: vlmTrace.guard?.extras?.[sceneKey]?.reflected ?? null,
            behindView: drawFromBehind,
            scaleRule: drawFromBehind,
            referenceCrop: drawFromBehind ? referenceCrop : null,
            negativePrompt: imageTrace.negativePrompt ?? null,
            seed: imageTrace.seed ?? null,
            denoise: imageTrace.denoise ?? null,
            elapsedMs: Date.now() - imageStartedAt,
            imageBackend: backends.image,
            imageModel: imageModelUsed,
            referenceImage:
              backends.image === 'gemini'
                ? imageTrace.referenceImage ?? 'none'
                : referencePersonImage
                  ? 'attached'
                  : 'none',
            refFrames: refChoices.length > 0 && !referencePersonImage ? refChoices : undefined,
          },
          buffer,
          extension
        );

        const payload: CaptureEvent = {
          type: 'capture.saved',
          ...(comfyWatchdog.status().alert ? { alert: comfyWatchdog.status().alert } : {}),
          captureId,
          sceneKey,
          sceneIndex: index,
          expectedImageCount: count,
          label,
          filename: savedImageAsset.filename,
          absolutePath: savedImageAsset.absolutePath,
          normalizedPath: savedImageAsset.normalizedPath,
          relativePath: savedImageAsset.relativePath,
          url: savedImageAsset.url,
          latestImagePath: savedImageAsset.absolutePath,
          latestImageNormalizedPath: savedImageAsset.normalizedPath,
          latestImageUrl: savedImageAsset.url,
          sourceImageFilename: sourceImageAsset?.filename || null,
          sourceImageAbsolutePath: sourceImageAsset?.absolutePath || null,
          sourceImageNormalizedPath: sourceImageAsset?.normalizedPath || null,
          sourceImageRelativePath: sourceImageAsset?.relativePath || null,
          sourceImageUrl: sourceImageAsset?.url || null,
        nowUrl: sourceImageAsset?.url || null,
          savedAt: new Date().toISOString(),
          size: savedImageAsset.size,
          sceneText: scenarioContentText(scenario),
          nowText,
          historySummary: summaryWithObstruction(),
          obstructed: typeof evt.obstructed === 'boolean' ? evt.obstructed : null,
          obstructedBy: evt.obstructedBy ?? null,
          extrasStatus: vlmTrace.guard?.extrasStatus && Object.keys(vlmTrace.guard.extrasStatus).length > 0 ? vlmTrace.guard.extrasStatus : undefined,
          distanceSec: sceneDistances[index],
          distanceSigned: true,
          vlmBackend: backends.vlm,
          vlmModel: vlmModelUsed,
          imageBackend: backends.image,
          imageModel: imageModelUsed,
          rulebookVersion: rbVersion,
        };

        // Synchronous from the isActive check above to the UDP send, so a
        // cancel cannot slip in between: cancelled captures never publish.
        ensureActive();
        cm.noteDelivered(captureId);
        if (!mobileLane) {
          publishCapture(payload);
          captureQa.notePrompt(captureId, sceneKey, scenario.prediction_prompt);
        }
        console.log(`generate: saved ${sceneKey} -> ${savedImageAsset.absolutePath}`);
        results.push({ sceneKey, label, url: savedImageAsset.url, predictionText: scenario.scenario_description });
        qaJobs.push({ sceneKey, imagePath: savedImageAsset.absolutePath, predictionPrompt: scenario.prediction_prompt });
      }

      ensureActive();
      cm.complete(captureId);
      await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 500))]);
      if (!mobileLane) archive?.setHistorySummary(composeSummary(venueSummary));
      archive?.finish('completed');
      captureEvents.finish({ ...evt, result: 'completed', errorStage: null, errorMessage: null });
      // QA of the three images runs later, between captures (never while something generates).
      if (!mobileLane && sourceImageAsset?.absolutePath) {
        for (const job of qaJobs) {
          qaService.enqueueScene({
            captureId,
            sceneKey: job.sceneKey,
            nowPath: sourceImageAsset.absolutePath,
            imagePath: job.imagePath,
            predictionPrompt: job.predictionPrompt,
            archiveDir: archive?.dir ?? null,
            rulebookVersion: rbVersion,
            sceneCount: qaJobs.length,
            test: isTest,
          });
        }
      }
      try {
        const latest: LatestPrediction = {
          captureId,
          observation: observation || nowText,
          savedAt: new Date().toISOString(),
          scenarios: results.map((r) => ({ sceneKey: r.sceneKey, label: r.label, text: r.predictionText })),
        };
        if (!isTest && !mobileLane) {
          latestPredictionStore = latest;
          fs.writeFileSync(path.join(path.dirname(historyFilePath()), 'latest-prediction.json'), JSON.stringify(latest), 'utf8');
        }
      } catch (lpErr) {
        console.error('generate: latest-prediction write failed (continuing):', lpErr);
      }
      res.json({
        captureId,
        backend: backendLabel(backends),
        vlmBackend: backends.vlm,
        vlmModel: vlmModelUsed,
        imageBackend: backends.image,
        imageModel: imageModelUsed,
        count: results.length,
        scenarios,
        images: results,
        sceneParams,
      });
    } catch (error: any) {
      if (isAbortError(error) || !cm.isActive(captureId)) {
        archive?.fail(error, 'cancelled');
        captureEvents.finish({ ...evt, result: 'cancelled', errorStage: evtStage, errorMessage: String(error?.message ?? error) });
        console.log(`generate: capture ${captureId} cancelled (${cm.stateOf(captureId)})`);
        return sendCancelled(res, captureId, cm);
      }
      console.error('generate pipeline failed:', error);
      archive?.fail(error, 'failed');
      captureEvents.finish({ ...evt, result: 'failed', errorStage: evtStage, errorMessage: String(error?.message ?? error) });
      cm.fail(captureId, error);
      res.status(502).json({ error: error?.message || 'generation pipeline failed' });
    }
  };
  app.post("/api/generate", (req, res) => handleGenerate(req, res, "venue"));

  // ---- Phone page (/m): see venue results, shoot with the phone; phone jobs run one at a time, only while the venue lane is idle.
  const mobileQueue = new MobileQueue<MobilePayload>({
    isVenueBusy: () => captureManager.current !== null,
    jobEstimateSec: 110,
    run: async (job) => {
      const body = {
        ...job.payload.body,
        captureId: job.id,
        source: 'mobile',
        imageCount: 3,
        notify: false,
        recordHistory: false,
        test: false,
        notifyHost: undefined,
        notifyToSender: false,
        vlmBackend: job.payload.body.vlmBackend === 'gemini' ? 'gemini' : 'local',
        imageBackend: job.payload.body.imageBackend === 'gemini' ? 'gemini' : 'local',
      };
      const stageTimer = setInterval(() => {
        job.stage = mobileCaptureManager.current?.stage ?? job.stage;
      }, 1000);
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const fakeRes: any = {
            headersSent: false,
            writableEnded: false,
            destroyed: false,
            statusCode: 200,
            on: () => fakeRes,
            status(code: number) {
              fakeRes.statusCode = code;
              return fakeRes;
            },
            json(payload: any) {
              fakeRes.headersSent = true;
              fakeRes.writableEnded = true;
              if (fakeRes.statusCode >= 400) reject(new Error(payload?.error || `generation ${payload?.state ?? 'failed'}`));
              else resolve({ captureId: payload.captureId, images: payload.images, vlmBackend: payload.vlmBackend, imageBackend: payload.imageBackend });
              return fakeRes;
            },
          };
          void handleGenerate({ body, socket: { remoteAddress: job.payload.remoteAddress } }, fakeRes, 'mobile').catch(reject);
        });
      } finally {
        clearInterval(stageTimer);
      }
    },
  });
  registerMobileRoutes(app, {
    guard: mobileAccessGuard(),
    archiveRoot: archiveRootDir(),
    queue: mobileQueue,
    venueSnapshot: () => captureManager.snapshot(),
  });
  // Phone captures are deleted by themselves: MOBILE_RETENTION_HOURS (default 24, 0 = keep) at start-up and hourly.
  const mobileRetentionHours = (() => {
    const v = Number(process.env.MOBILE_RETENTION_HOURS ?? '24');
    return Number.isFinite(v) ? v : 24;
  })();
  const purgeMobile = () => {
    try {
      const n = purgeExpiredMobile(archiveRootDir(), capturesDir, mobileRetentionHours);
      if (n) console.log(`[mobile] retention: removed ${n} phone capture(s) older than ${mobileRetentionHours} h`);
    } catch (error) {
      console.error('[mobile] retention failed:', error);
    }
  };
  purgeMobile();
  setInterval(purgeMobile, 3600_000).unref?.();

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          port: HMR_PORT
        }
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  touchDesignerControlUdpServer.on('message', (message, peer) => {
    const parsed = parseTouchDesignerControlMessage(message.toString('utf8'));
    if (!parsed) {
      console.warn(`Ignoring unsupported TouchDesigner UDP control message from ${peer.address}:${peer.port}`);
      return;
    }

    if (parsed.type === 'cancel') {
      const cancelled = captureManager.cancel(parsed.captureId ?? null, 'requested');
      console.log(
        `TouchDesigner UDP cancel from ${peer.address}:${peer.port}: ${cancelled ? `cancelled ${cancelled}` : 'nothing to cancel'}`
      );
      return;
    }

    if (parsed.type === 'capture') {
      queueTouchDesignerCapture(
        parsed.sessionId,
        `udp://${peer.address}:${peer.port}`,
        parsed.imageCount,
        parsed.promptVariant,
        parsed.promptParams,
        parsed.captureId
      );
    }
  });

  touchDesignerControlUdpServer.on('error', (error) => {
    console.error('TouchDesigner UDP control listener error:', error);
  });

  if (touchDesignerControlUdpEnabled) {
    touchDesignerControlUdpServer.bind(touchDesignerControlUdpPort, touchDesignerControlUdpHost);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Images will be saved to: ${capturesDir}`);
    console.log('TouchDesigner will receive the newest timestamped file path for each scene.');
    console.log(`Public base URL for image links: ${publicBaseUrl} (PUBLIC_BASE_URL)`);
    console.log(`Vite HMR port: ${HMR_PORT}`);
    console.log(
      `TouchDesigner bridge: ${touchDesignerBridgeEnabled ? `udp://${touchDesignerHost}:${touchDesignerPort}` : 'disabled'}`
    );
    console.log(
      `TouchDesigner control listener: ${touchDesignerControlUdpEnabled ? `udp://${touchDesignerControlUdpHost}:${touchDesignerControlUdpPort}` : 'disabled'}`
    );
    console.log(`Generation backend: ${GENERATION_BACKEND}`);
    // Lets TD's capture controller (re)start its heartbeat when the server comes up.
    sendToTouchDesigner({ type: 'server.ready', startedAt: new Date().toISOString() }, 'server.ready');
    // Show the running cost right away (TD's display is empty after a TD restart).
    sendToTouchDesigner(costTracker.update(), 'usage.updated');
    void backendStatus()
      .then((status) => console.log('Generation status:', JSON.stringify(status)))
      .catch(() => undefined);
  });
}

startServer();
