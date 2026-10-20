import {createScenePersonReferenceAssets,registerScenePersonReferenceRoutes,type ResolvedPersonReferences} from './server/scenePersonReferenceAssets';
import {buildSceneReferenceInputs,validateSceneReferenceRequest,sourceCastIdentityImages,type SourceCastIdentityImage} from './server/generation/sceneReferenceIntegration';
import type {QaReferenceCastJob} from './server/qa/qaService';
import {tdBrowserSnapshot} from './server/tdBrowserFollow';
import {currentBrowserSnapshot} from './server/currentBrowserDisplay';
import {createInstructionCaptionLookup} from './server/instructionCaptions';
import {createTdDisplayTimingReader} from './server/tdDisplayTiming';
import {registerBrowserDisplayRoutes,isBrowserDisplayImageUrl} from './server/browserDisplay';
import {registerBrowserOutputsRoutes,browserOutputsAccess,type BrowserOutputsStore} from './server/browserOutputs';
import {createBrowserOutputSources} from './server/browserOutputSources';
import {createBrowserOutputAssets} from './server/browserOutputAssets';
import {createBrowserOutputRecordings} from './server/browserOutputRecordings';
import {createBrowserOutputThumbnails} from './server/browserOutputThumbnails';
import {createCaptureThumbs} from './server/captureThumbs';
import {createBrowserFaceBoxes} from './server/browserFaceBoxes';
import {createBrowserFacePresentation} from './server/browserFacePresentation';
import {browserOutputCurrent} from './server/browserOutputCurrent';
import {installTdBrowserControl} from './server/tdControl/node-proxy.mjs';
import {createNativeOperator} from './server/nativeOperator';
import {createScenarioRunArchive,registerScenarioRunRoutes} from './server/scenarioRunArchive';
import {createOperatorScenarioOutputs} from './server/operatorScenarioOutputs';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {SourceObservationIndex} from './server/history/sourceObservationIndex';
import {updateTestHistory} from './server/history/testHistoryApi';
import {latestTestPerson} from './server/history/testRecentPerson';
import {TestRecentPersonStore,DEFAULT_TEST_RECENT_PERSON_DIR,mergeReplayed,recoverTestPersonFromArchive} from './server/history/testRecentPersonStore';
import {captureHistoryContext,ScopedTestHistory,type CaptureHistoryEcho} from './server/history/historyDisplay';
import { peopleEditRegion } from './server/generation/peopleEditRegion';
import {parseScenarioControl,ScenarioControlValidationError,scenarioControlArchiveMetadata,type ValidatedScenarioControl,type ScenarioSceneKey} from './server/scenarioControl';
import {prepareScenarioInputs,mergeScenarioEditRegion,scenarioElementInstruction,scenarioControlEcho,validateScenarioSceneCount,validateScenarioModes,assetOnlyEditInstruction,scenarioPeoplePolicy,scenarioNeedsFullFrame} from './server/scenarioGeneration';
﻿
import './server/loadEnv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dgram from 'dgram';
import { recordingFilename,recordingMetadata } from './server/recordingFiles';
import {
  BACKEND as GENERATION_BACKEND,
  backendStatus,
  clockForSignedDistance,
  generateImage,
  predictScenarios,
  readSceneParams,
  type ImageTrace,
} from './server/generation/orchestrator';
import type { PlanTrace } from './server/generation/vlmClient';
import { describePeople, DESCRIBE_PROMPT, DESCRIBE_SCHEMA } from './server/generation/peopleDescribe';
import { cropRectFor, figureCropFor, headCropFor, imageSize, type CropRect } from './server/generation/referenceCrop';
import { behindViewSentence } from './server/generation/orchestrator';
import { sceneBelongings, inspectionBelongings } from './server/generation/behindViewPlacement';
import { mentionsPerson } from './server/generation/scenarioGuard';
import {
  buildSceneExtrasNote,
  parseSceneExtras,
  personExtrasInEmptyRoom,
} from './server/generation/sceneExtras';
import { DEFAULT_EMPTY_ROOM_PERSON_CHANCE, activityMinutesFromRecent, decideEmptyRoomScenes, emptyRoomActivityMin, sceneSkipPlan } from './server/generation/emptyRoomDecision';
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
  resizeToMaxPx,
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
  presenceAt,
  toneAt,
  resolveScenePresence,
  resolveSceneTone,
  sceneRecord,
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
import { describeGeneratedImage } from './server/generation/fidelity';
import { generateUniquePeople } from './server/generation/peopleIntegrity';
import { inspectAndCaption, inspectAndCaptionWithReferences, inspectionDefectType } from './server/generation/combinedInspection';
import {inspectCountedImage} from './server/generation/countInspection';
import { detectPeople, extraPeopleVerdict } from './server/generation/lightPeopleDetector';
import { appendQaRow } from './server/qa/localJudge';
import { withJapaneseSpan } from './server/generation/spanFix';
import { buildStateLedger, judgePastContinuity, stateLedgerNote, type PastHistoryRow } from './server/generation/pastScene';
import { getCostTracker } from './server/usage/costTracker';
import { buildPublicUrl, resolveNotifyHost, resolvePublicBaseUrl } from './server/network/notifyTarget';
import { registerPresenceRoutes } from './server/presence/routes';
import { registerHealthRoutes } from './server/health/routes';
import { getComfyWatchdog } from './server/generation/comfyWatchdog';
import { obstructedSince, withObstructionNote } from './server/events/obstruction';
import { operatorWarnings } from './server/operatorWarnings';
import { sceneNotes } from './server/sceneNotes';
import { toneMismatch, rewriteForTone, forceToneWording } from './server/generation/toneEnforce';
import { CaptureEventStore, captureBatchCounts, captureExecutionSource, captureInputIdentity, type CaptureEvent as CaptureEventRow } from './server/events/captureEvents';
import { registerEventRoutes } from './server/events/routes';
import { QaService } from './server/qa/qaService';
import { ensureRulebookFiles, rulebookVersion } from './server/generation/rulebook';
import { mobileAccessGuard } from './server/mobile/access';
import { MobileQueue } from './server/mobile/queue';
import { registerMobileRoutes, type MobilePayload } from './server/mobile/routes';
import { purgeExpiredMobile } from './server/mobile/archiveList';
import { GEMINI_IMAGE_MODEL, GEMINI_VLM_MODEL, backendLabel, resolveBackends } from './server/generation/backends';
import {resolveLocalImageEngine,selectSceneImageEngine,isTurboEngine,productionTurboSourceContext} from './server/generation/imageEngine';
import {TurboCandidateGeometryError} from './server/generation/turboCandidate';

interface CaptureEvent extends Partial<CaptureHistoryEcho> {
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
  scenarioControl?: ReturnType<typeof scenarioControlEcho>;
  captureId: string;
  sceneKey: string;
  sceneIndex: number | null;
  expectedImageCount: number;
  /** G-24: scene keys of this capture that were skipped (no datagram is sent for them; their panels keep the previous image/text). */
  skippedScenes?: string[];
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
  const testHistory=new ScopedTestHistory();
  // Test-scope recent person survives restarts (data/state/test-recent-person; never the venue scene-history.jsonl).
  const testPersonStore=new TestRecentPersonStore({dir:process.env.TEST_RECENT_PERSON_DIR||DEFAULT_TEST_RECENT_PERSON_DIR,windowMin:()=>recentPersonWindowMin()});
  let testSourceIndex:SourceObservationIndex|null=null;
  try {testSourceIndex=new SourceObservationIndex(JSON.parse(fs.readFileSync(process.env.TEST_SOURCE_OBSERVATION_INDEX||'C:/Users/nmrei/claude-code/tsc001-fix/original-source-observations.v1.json','utf8')));}
  catch(error){console.error('[test-history] source cache unavailable; no observation is inferred:',String(error));}
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
  // History thumbnails (captures/thumbs/<name>.jpg): written in the background after each capture image.
  // On-miss jobs for old history rows wait while a capture is active (captureManager is declared below; read lazily).
  const captureThumbs = createCaptureThumbs({ capturesDir, busy: () => !!captureManager.snapshot().active });

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
    captureThumbs.enqueue(asset.absolutePath);
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
    captureThumbs.enqueue(asset.absolutePath);
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

  // Control routes keep their own peer/Host/Origin checks and bounded body reader.
  // Mount before global CORS/JSON parsing; an unavailable control bridge must not stop generation.
  const nativeOperatorMode=process.env.OPERATOR_RUNTIME==='native';
  let nativeOperator:Awaited<ReturnType<typeof createNativeOperator>>|undefined;
  let browserOutputs:BrowserOutputsStore|undefined;
  let personReferenceAssets:ReturnType<typeof createScenePersonReferenceAssets>|undefined;
  const pinnedPersonReferences=new WeakMap<object,ResolvedPersonReferences>();
  const preflightScenePersonReferences=async(body:Readonly<Record<string,any>>,mobile=false)=>{
    const control=parseScenarioControl(body.scenarioControl);
    const parsed=validateSceneReferenceRequest(body.scenePersonReferences,{count:normalizeImageCount(body.imageCount),imageBackend:resolveBackends(body).image,engine:resolveLocalImageEngine(body),mobile,sceneModes:control?.sceneModes});
    if(!Object.values(parsed).some(refs=>refs?.length))return undefined;
    const existing=pinnedPersonReferences.get(body);if(existing)return existing;
    if(!personReferenceAssets)throw Error('Private person reference service is unavailable');
    const resolved=await personReferenceAssets.resolve(parsed);
    const sourceSha=createHash('sha256').update(decodeImageDataUrl(body.image).buffer).digest('hex');
    if(Object.values(resolved).some(refs=>refs?.some(ref=>ref.sha256===sourceSha)))throw Error('Additional reference duplicates the original source');
    pinnedPersonReferences.set(body,resolved);return resolved;
  };
  let browserFaces:ReturnType<typeof createBrowserFaceBoxes>|undefined;
  const presentBrowserFaces=createBrowserFacePresentation(url=>browserFaces?.inspect(url)??Promise.resolve({status:'unavailable',boxes:[]}));
  if (process.env.TD_CONTROL_BRIDGE_URL && process.env.TD_CONTROL_BRIDGE_TOKEN_FILE) {
    try { installTdBrowserControl(app,{...(nativeOperatorMode?{controlHandler:async request=>nativeOperator?nativeOperator.handle(request):{status:503,body:{ok:false,error:'Native operator is initializing'}}}:{})}); }
    catch {
      console.error('[td-control] Control initialization failed; generation remains available.');
      app.use(['/control', '/api/td-control'], (_req, res) => res.status(503).json({ok:false,error:'TD browser control is unavailable'}));
    }
  }
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/test/history',(req,res)=>{
    try {const result=updateTestHistory(testSourceIndex,testHistory,req.body);res.status(result.sourceStatus==='unavailable'?503:200).json(result);}
    catch(error){res.status(400).json({error:String((error as Error).message),historySummary:'',nowText:''});}
  });
  registerPresenceRoutes(app);
  // ComfyUI hang recovery (comfyWatchdog.ts): alert state -> /api/health, /logs banner, comfy.alert UDP, capture.saved.alert.
  const comfyWatchdog = getComfyWatchdog();
  comfyWatchdog.onChange = (st) => sendToTouchDesigner({ type: 'comfy.alert', alert: st.alert, autoRestarts: st.autoRestarts, lastTimeoutAt: st.lastTimeoutAt }, 'comfy.alert');
  registerHealthRoutes(app, { scenarioControlVersion:1, scenarioControlCapabilities:{sceneModes:['asset_only','people_and_assets'],defaultSceneMode:'legacy',assetOnlyRequiresAssets:true,assetOnlyRejectsSceneExtras:true,assetOnlySourceAlpha:'opaque_crop_only',assetOnlyOverlapsDetectedPeople:'reject',assetOnlyContentProtection:'composed_pixels_where_effective_alpha_positive',assetOnlyOutputFrame:'original_now',assetOnlyTargetsInsideModelCrop:true}, watchdogStatus: () => comfyWatchdog.status() });
  // Per-capture structured log + display-log + /logs viewer (server/events).
  const captureEvents = new CaptureEventStore(
    path.join(process.cwd(), 'logs', 'capture-events.jsonl'),
    path.join(process.cwd(), 'logs', 'display-log.jsonl'),
    costTracker.logPath,
    () => new Date(),
    () => comfyWatchdog.status().alert
  );
  // G-27: exact CSV copy of every live scenario run (logs/scenario-runs/ + logs/scenario-runs.jsonl); History draws the run ranges.
  const scenarioRuns = createScenarioRunArchive({ logsDirectory: path.join(process.cwd(), 'logs') });
  registerScenarioRunRoutes(app, scenarioRuns);
  registerEventRoutes(app, captureEvents, { archiveRoot: archiveRootDir(), thumbs: captureThumbs, scenarioRuns });
  // Read-only screen output. Content comes from an explicit complete archive registry, never latest.json.
  const browserSettings=process.env.BROWSER_DISPLAY_SETTINGS_FILE;
  const browserContents=process.env.BROWSER_DISPLAY_CONTENTS_FILE;
  const instructionLookup=createInstructionCaptionLookup(archiveRootDir(),()=>captureEvents.readAll());
  const legacyDisplayTiming=createTdDisplayTimingReader();
  const readDisplayTiming=Object.assign(async()=>nativeOperatorMode?(await nativeOperator?.state.readSettings())?.displayTiming??'all':legacyDisplayTiming(),{readRouting:async()=>{
    if(!nativeOperatorMode)return legacyDisplayTiming.readRouting();
    if(!nativeOperator)return undefined;
    const [display,settings]=await Promise.all([nativeOperator.state.readDisplay(),nativeOperator.state.readSettings()]);
    const sources={A:'a',B:'b',C:'c',NOW:'now'}as const;
    return {slots:Object.fromEntries(display.layout.map((label,index)=>['td-'+(index+1),sources[label]])),view:{visible:display.visible,labels:settings.labels,subtitles:settings.subtitles,fade:settings.fade}};
  }});
  if(browserSettings && browserContents){
    const viewer=path.resolve(process.cwd(),'tools/browser-display');
    app.use('/display-assets',express.static(viewer,{index:false,dotfiles:'deny'}));
    app.get('/display/face-blur.mjs',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.sendFile(path.join(viewer,'face-blur.mjs'));});
    app.get('/display/:screenId',(req,res)=>{
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(req.params.screenId))return void res.sendStatus(400);
      res.setHeader('Cache-Control','no-store');res.sendFile(path.join(viewer,'index.html'));
    });
    registerBrowserDisplayRoutes(app,{settingsFile:browserSettings,contentsFile:browserContents,snapshotProvider:async(id,now)=>{
      const rows=captureEvents.readAll(),options={instructionLookup,updateMode:await readDisplayTiming()};
      if(/^current-(now|a|b|c)$/.test(id)){
        const routing=await readDisplayTiming.readRouting();
        const fadeMode=await browserOutputs?.channelFadeMode(id)??'original';
        const fadeTiming=await browserOutputs?.channelFadeTiming(id)??{fadeDurationMs:800,blackHoldMs:120};
        const faceBlur=await browserOutputs?.channelFaceBlur(id)??{enabled:false,strengthPx:12};
        const captions=await browserOutputs?.channelCaptions(id)??{labels:true,subtitles:true};
        const routed={visible:true,labels:true,subtitles:true,fade:true,...routing?.view};
        const view={...routed,labels:routed.labels&&captions.labels,subtitles:routed.subtitles&&captions.subtitles};
        const snapshot=currentBrowserSnapshot(id,rows,now,{...options,view:{...view,...fadeTiming,faceBlur,fadeOnImageChange:false,fadeMode:view.fade?fadeMode:'none',fade:view.fade&&fadeMode!=='none'}});
        return snapshot?presentBrowserFaces(snapshot):snapshot;
      }
      return tdBrowserSnapshot(id,rows,now,options);
    },statusProvider:(_screen,snapshot)=>{
      const rows=captureEvents.readAll().filter(e=>e.test && e.captureId.startsWith('test-turbo-app-e2e-'));
      const relevant=rows.filter(e=>{
        if(!/^[A-Za-z0-9_-]+$/.test(e.captureId))return false;
        try{const request=JSON.parse(fs.readFileSync(path.join(path.dirname(browserSettings),e.captureId,'request-without-image.json'),'utf8'));return snapshot.clock.scope==='test:turbo-app-e2e:'+request.testFrameId;}catch{return false;}
      }).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt));
      const latest=relevant[0];
      const selected=rows.find(e=>e.captureId===snapshot.content?.captureId);
      const failed=latest?.result==='failed'||latest?.result==='cancelled';
      return {requestedCaptureId:latest?.captureId??null,
        // Actual decoded/displayed identity is tracked by each browser, not inferred from server selection.
        displayedCaptureId:null,state:failed?'failed':latest?.result==='running'?'generating':latest?.result==='completed'?'completed':'idle',
        error:failed?(latest?.errorMessage||'capture failed').slice(0,512):null,
        userMessage:failed?'今回の画像は表示できません。前回の画像を表示中。':null,
        lastSuccessAtMs:selected?.result==='completed'&&selected.endedAt?Date.parse(selected.endedAt):null};
    }});
  }

  // Additional browser screens share metadata and private presentation assets; they never request generation.
  try {
    const privateOutputRoot=path.dirname(path.resolve(archiveRootDir()));
    const outputAssets=createBrowserOutputAssets({directory:path.join(privateOutputRoot,'browser-output-assets'),repositoryRoot:process.cwd()});
    personReferenceAssets=createScenePersonReferenceAssets({assets:outputAssets,directory:path.join(privateOutputRoot,'scene-person-reference-observations'),modelKey:vlmConfig.model+':'+createHash('sha256').update(JSON.stringify([DESCRIBE_PROMPT,DESCRIBE_SCHEMA])).digest('hex'),describe:async(imageDataUrl,signal)=>{// Phone photos (e.g. 4000x3000) are rejected by Ollama; describe a 1280px copy instead.
const m=/^data:image\/[a-z]+;base64,(.+)$/i.exec(imageDataUrl);const small=m?'data:image/jpeg;base64,'+(await resizeToMaxPx(Buffer.from(m[1],'base64'),1280)).toString('base64'):imageDataUrl;const result=await describePeople(small,{signal});if(!result.ok)throw Error('Reference person observation unavailable');return {people:result.people};}});
    registerScenePersonReferenceRoutes(app,{service:personReferenceAssets,allowedHosts:new Set(process.env.TD_CONTROL_ALLOWED_HOSTS?.split(',').map(host=>host.trim()).filter(Boolean)??['localhost:3000','127.0.0.1:3000'])});
    const resolvePresentationImage=async(imageUrl:string)=>{
      if(imageUrl.startsWith('/captures/browser-output-assets/'))return (await outputAssets.resolve(imageUrl))?.absolutePath??null;
      if(!isBrowserDisplayImageUrl(imageUrl))return null;
      try {
        const candidate=path.resolve(capturesDir,decodeURIComponent(imageUrl).slice('/captures/'.length));
        const entry=await fs.promises.lstat(candidate);if(!entry.isFile()||entry.isSymbolicLink())return null;
        const [root,actual]=await Promise.all([fs.promises.realpath(capturesDir),fs.promises.realpath(candidate)]);
        const relative=path.relative(root,actual);
        return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)?actual:null;
      } catch {return null;}
    };
    browserFaces=createBrowserFaceBoxes({resolveImage:resolvePresentationImage,allowedRoots:[capturesDir,path.join(privateOutputRoot,'browser-output-assets')],python:process.env.FACE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','claude-code/runtime-face-detector/Scripts/python.exe'),worker:path.resolve('scripts/browser-face-boxes.py')});
    const outputThumbnails=createBrowserOutputThumbnails({cacheDirectory:path.join(privateOutputRoot,'browser-output-thumbnails'),resolveImage:resolvePresentationImage});
    const outputRecordings=createBrowserOutputRecordings({recordingsFile:path.join(process.cwd(),'logs','recordings.jsonl'),publicBaseUrl:process.env.PUBLIC_BASE_URL});
    const outputSources=createBrowserOutputSources({readEvents:()=>captureEvents.readAll(),readCurrent:async()=>{
      const updateMode=await readDisplayTiming();
      return browserOutputCurrent(captureEvents.readAll(),Date.now(),{updateMode,instructionLookup});
    },readUploads:()=>outputAssets.list(),readRecords:()=>outputRecordings.readRecords(),thumbnailUrl:outputThumbnails.thumbnailUrl});
    browserOutputs=registerBrowserOutputsRoutes(app,{configFile:path.join(privateOutputRoot,'browser-output-config.json'),loadCatalog:async()=>{
      const [catalog,tdRouting]=await Promise.all([outputSources.loadCatalog(),readDisplayTiming.readRouting()]);
      return {...catalog,...(tdRouting?{tdRouting}:{})};
    },assets:outputAssets,thumbnails:outputThumbnails,presentSnapshot:presentBrowserFaces,
      allowedHosts:process.env.TD_CONTROL_ALLOWED_HOSTS?.split(',').map(host=>host.trim()).filter(Boolean),resolveContent:async(content)=>{
        const saved=content.captureId&&content.sceneKey?instructionLookup({captureId:content.captureId,sceneKey:content.sceneKey,imageUrl:content.imageUrl}):undefined;
        return {...content,caption:saved?.plannedDescription??'生成指示を確認できません。'};
      }});
  } catch {
    console.warn('[browser-outputs] Initialization unavailable');
    app.use('/api/browser-outputs',(_req,res)=>res.status(503).json({ok:false,error:'Browser-output service unavailable'}));
  }

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
  const handleRecordFrame = (req:any, res:any) => {
    const { image } = req.body || {};
    if (typeof image !== 'string' || !imageDataUrlRe.test(image)) {
      return res.status(400).json({ error: 'A base64 image data URL is required' });
    }
    try {
      const { buffer, extension } = decodeImageDataUrl(image);
      const filename = recordingFilename(formatTokyoTimestampForFilename(), extension);
      const asset = buildSavedImageAsset(filename, buffer);
      fs.writeFileSync(asset.absolutePath, buffer, { flag: 'wx' });
      captureThumbs.enqueue(asset.absolutePath);
      const savedAt = new Date().toISOString();
      fs.appendFileSync(path.join(process.cwd(), 'logs', 'recordings.jsonl'), JSON.stringify({ savedAt, ...recordingMetadata(req.body), filename, url: asset.url, size: asset.size }) + '\n');
      console.log(`Saved record-only frame to: ${asset.absolutePath}`);
      res.json({ success: true, record: asset, savedAt: new Date().toISOString() });
    } catch (error: any) {
      console.error('capture/record failed:', error);
      res.status(500).json({ error: error?.message || 'record save failed' });
    }
  };
  app.post('/api/capture/record',handleRecordFrame);

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
        presence: bodySceneIndex !== null && bodySceneIndex >= 0 ? presenceAt(sceneParams, bodySceneIndex) : sceneParams.presence,
        tone: bodySceneIndex !== null && bodySceneIndex >= 0 ? toneAt(sceneParams, bodySceneIndex) : sceneParams.tone,
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
  const handleGenerate = async (req: any, res: any, lane: "venue" | "mobile" = "venue",onAccepted?:()=>Promise<void>,beforeBegin?:()=>void) => {
    const mobileLane = lane === "mobile";
    const cm = mobileLane ? mobileCaptureManager : captureManager;
    const { image, imageCount, target, sceneTime } = req.body || {};
    if (typeof image !== 'string' || !imageDataUrlRe.test(image)) {
      return res.status(400).json({ error: 'A base64 image data URL is required' });
    }

    const count = normalizeImageCount(imageCount);
    let scenarioControl:ValidatedScenarioControl|undefined;
    try {scenarioControl=parseScenarioControl(req.body?.scenarioControl);validateScenarioSceneCount(scenarioControl,count);}
    catch(error){return res.status(400).json({error:String((error as Error).message),code:'INVALID_SCENARIO_CONTROL'});}
    const captureId = normalizeCaptureId(req.body?.captureId);
    // Per-capture backends (TD Vlmbackend / Imagebackend); missing/invalid -> GENERATION_BACKEND default.
    const backends = resolveBackends(req.body);
    let localImageEngine:ReturnType<typeof resolveLocalImageEngine>;
    try{localImageEngine=resolveLocalImageEngine(req.body||{});}catch(error){return res.status(400).json({error:String((error as Error).message),code:'INVALID_IMAGE_ENGINE'});}
    if(localImageEngine==='qwen21-turbo-candidate'&&(mobileLane||scenarioControl||backends.image!=='local'))return res.status(400).json({error:'Turbo candidate is venue test-only and does not yet support scenarioControl',code:'INVALID_IMAGE_ENGINE'});
    const requestFullFrameReason=localImageEngine==='qwen21-turbo'&&(mobileLane||backends.image!=='local')?'full-frame request mode':undefined;
    if(scenarioControl&&backends.image!=='local')return res.status(400).json({error:'scenarioControl v1 requires the local image backend'});
    // Public HTTP requests may not use private upload IDs outside the existing control security boundary.
    // Native operator calls are in-process and carry the unforgeable beforeBegin ownership callback.
    if(req.body?.scenePersonReferences!==undefined&&!beforeBegin){
      const denied=browserOutputsAccess(req,new Set(process.env.TD_CONTROL_ALLOWED_HOSTS?.split(',').map(host=>host.trim()).filter(Boolean)??['localhost:3000','127.0.0.1:3000']));
      if(denied)return res.status(denied).json({error:'Private person reference access denied',code:'PERSON_REFERENCE_ACCESS_DENIED'});
    }
    let resolvedPersonReferences:ResolvedPersonReferences|undefined;
    try{resolvedPersonReferences=await preflightScenePersonReferences(req.body,mobileLane);}catch(error){return res.status(400).json({error:String((error as Error).message),code:'INVALID_PERSON_REFERENCES'});}
    const vlmModelUsed = backends.vlm === 'gemini' ? GEMINI_VLM_MODEL : vlmConfig.model;
    const imageModelUsed =
      backends.image === 'gemini'
        ? GEMINI_IMAGE_MODEL
        : isTurboEngine(localImageEngine)?`qwen_image_2.1_turbo_int8_convrot.safetensors (8steps/cfg1/${localImageEngine==='qwen21-turbo'?'production':'test-candidate'})`:`qwen-image-edit (${process.env.COMFYUI_GGUF === 'true' ? comfyConfig.models.ggufUnet : comfyConfig.models.unet})`;
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
    try{validateScenarioModes(scenarioControl,sceneExtras);}catch(error){return res.status(400).json({error:String((error as Error).message),code:'INVALID_SCENARIO_CONTROL'});}
    const normalizedTarget =
      target && typeof target.x === 'number' && typeof target.y === 'number'
        ? { x: target.x, y: target.y }
        : null;
    const source: CaptureSource = mobileLane ? 'mobile' : req.body?.source === 'browser' ? 'browser' : 'td-native';
    // Phone lane (server/mobile): own CaptureManager, never UDP to TD, no latest.json / venue history / venue summary.
    const isTest = !mobileLane && (req.body?.test === true || /test/i.test(captureId));
    const useHistory=req.body?.recordHistory !== false && !isTest && !mobileLane;
    const historyContext=captureHistoryContext({captureId,isTest,useLiveHistory:useHistory,request:req.body});
    const captureDisplayTiming=req.body?.displayTiming==='each'||req.body?.displayTiming==='all'?req.body.displayTiming:await readDisplayTiming();
    // A test must never supersede an in-flight exhibition capture or another test.
    if (isTest && cm.snapshot().active && cm.snapshot().active?.captureId !== captureId) {
      return res.status(409).json({ busy: true, error: 'Another capture is active; retry the test when idle.' });
    }
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
    if (isTest && cm.snapshot().active && cm.snapshot().active?.captureId !== captureId) return res.status(409).json({ busy: true });
    if(beforeBegin)beforeBegin();
    const capture = cm.begin(captureId, { source, imageCount: count });
    if(onAccepted)await onAccepted();
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
      batchLogVersion:1,requestedCount:count,savedCount:0,publishedCount:0,
      executionSource:captureExecutionSource(req.body?.executionSource),
      inputIdentity:captureInputIdentity(req.body,isTest),
      // Native operator captures started while a live CSV run owns playback carry that run (G-27 History ranges).
      ...(req.body?.executionSource!==undefined&&nativeOperator?.scenarioRunTag()?{scenarioRun:nativeOperator.scenarioRunTag()}:{}),
      browserFollow:{testSceneId:historyContext.echo.testSceneId,testRunId:historyContext.echo.testRunId,scope:historyContext.scope.key,sourceRecordedAtMs:null,updateMode:captureDisplayTiming,...(!isTest&&source==='td-native'&&recordingMetadata({source:'live-camera',sourceScope:req.body?.sourceScope}).sourceScope?{cameraScope:recordingMetadata({source:'live-camera',sourceScope:req.body?.sourceScope}).sourceScope!}:{})},
      vlmBackend: backends.vlm,
      vlmModel: vlmModelUsed,
      imageBackend: backends.image,
      imageModel: imageModelUsed,
    };
    evt.rulebookVersion = rbVersion;
    evt.presence = sceneParams.presence;
    evt.tone = sceneParams.tone;
    // Per-scene overrides (order gen_a, gen_b, gen_c); recorded only when a scene differs from the global value.
    const scenePresenceList = resolveScenePresence(sceneParams, count);
    const sceneToneList = resolveSceneTone(sceneParams, count);
    if (scenePresenceList.some((v) => v !== sceneParams.presence)) evt.scenePresence = scenePresenceList;
    if (sceneToneList.some((v) => v !== sceneParams.tone)) evt.sceneTone = sceneToneList;
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
    sceneNotes.start(captureId);
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
              scenePresence: sceneRecord(resolveScenePresence(sceneParams)),
              sceneTone: sceneRecord(resolveSceneTone(sceneParams)),
              imageCount: count,
            },
          });
          const src = decodeImageDataUrl(image);
          if(evt.inputIdentity)evt.inputIdentity.sha256=createHash('sha256').update(src.buffer).digest('hex');
          archive.saveSource(src.buffer, src.extension);
          evt.archiveDir = archive.dir;
        }
      } catch (archiveErr) {
        console.error('generate: archive setup failed (continuing):', archiveErr);
        archive = null;
      }

      const scenarioPrepared=scenarioControl?await prepareScenarioInputs(image,scenarioControl,signal):undefined;
      if(scenarioControl&&scenarioPrepared){
        if(!archive)throw new Error('Scenario input archive is required');
        archive.setScenarioControl({...scenarioControlArchiveMetadata(scenarioControl),stage:'composed-generation-input',sourceSha256:scenarioPrepared.composition.sourceSha256,assetChecks:scenarioPrepared.assetChecks});
      }

      // Scene history: recent observations (prompt context) and the "was anyone here lately" rule of the guard.
      // Test captures (body.recordHistory:false / body.test:true / captureId containing "test") neither read nor write the history.
      const cachedSource=isTest?testSourceIndex?.lookupImage(decodeImageDataUrl(image).buffer,{sceneId:historyContext.echo.testSceneId,frameId:historyContext.echo.testFrameId}):undefined;
      if(evt.browserFollow)evt.browserFollow.sourceRecordedAtMs=cachedSource?.status==='hit'&&cachedSource.record.sourceObservedAt?Date.parse(cachedSource.record.sourceObservedAt):isTest?null:Date.parse(evt.startedAt);
      if(evt.browserFollow&&sourceImageAsset?.url){
        const sourceRecordedAtMs=evt.browserFollow.sourceRecordedAtMs;
        evt.browserBatch=[{id:captureId+':now',captureId,sceneKey:'now',scope:evt.browserFollow.scope,provenance:'actual',distanceSecSigned:null,imageUrl:evtImageUrl(sourceImageAsset.url)!,recordedAtMs:sourceRecordedAtMs,sourceRecordedAtMs,generatedAtMs:null,targetAtMs:null,caption:''}];
        captureEvents.patch(captureId,{...captureBatchCounts(evt),inputIdentity:evt.inputIdentity,images:evt.images,browserFollow:evt.browserFollow,browserBatch:evt.browserBatch});
      }
      const replayedAt=new Date().toISOString();
      if(cachedSource?.status==='hit')testHistory.observe(historyContext.scope,cachedSource.record,replayedAt);
      if(cachedSource?.status==='hit'&&cachedSource.record.detectorPerson===true&&historyContext.scope.kind==='test')testPersonStore.remember(historyContext.scope.key,{...cachedSource.record,replayedAt},image);
      archive?.setHistoryContext({...historyContext.echo,cachedObservation:cachedSource?.status==='hit'?{status:'hit',originalCaptureId:cachedSource.record.originalCaptureId,sourceImageSha256:cachedSource.record.sourceImageSha256,sourceObservedAt:cachedSource.record.sourceObservedAt}:{status:cachedSource?.status??'not-used'}});
      if (!useHistory && !mobileLane) console.log(`[history] capture ${captureId} is a test capture: history is not read or written`);
      const historyAll = useHistory ? readHistory() : [];
      const historyItems = historyEnabled()
        ? recentEntries(historyAll, { limit: historyLimit(), windowMin: historyWindowMin() })
        : [];
      // G-01/G-02: test playback reads its own loop's replayed observations (never the exhibition jsonl).
      // Test scope: in-memory loop history + the persisted occupied frames (restart-safe); if none, the archive of this scope.
      const recentPerson = useHistory
        ? latestPerson(historyAll, recentPersonWindowMin())
        : historyContext.scope.kind === 'test'
          ? (() => {
              const scope = historyContext.scope;
              const excludeFrameId = cachedSource?.status === 'hit' ? cachedSource.record.frameId : undefined;
              const found = latestTestPerson(mergeReplayed(testHistory.snapshot(scope).observations, testPersonStore.observations(scope.key)), { windowMin: recentPersonWindowMin(), excludeFrameId });
              if (found) return found;
              const recovered = recoverTestPersonFromArchive({ archiveRoot: archiveRootDir(), historyScope: scope.key, windowMin: recentPersonWindowMin(), excludeDir: archive?.dir ?? null, excludeFrameId });
              if (!recovered) return null;
              testPersonStore.remember(scope.key, recovered.row, recovered.imageDataUrl);
              console.log(`[history] recent person recovered from archive (${recovered.minutesAgo} min ago) ${path.basename(recovered.dir)} ${recovered.row.frameId}`);
              return latestTestPerson([recovered.row], { windowMin: recentPersonWindowMin(), excludeFrameId });
            })()
          : null;
      // G-24/G-25: per-scene empty-room decisions (applied only if the frame turns out unoccupied): person roll vs
      // emptyRoomPersonChance, object change only after activity within EMPTY_ROOM_ACTIVITY_MIN + roll, else skip.
      const activityWindowMin = emptyRoomActivityMin();
      // Activity = the same source as recentPerson (live latestPerson / test latestTestPerson): minutes since that occupied frame.
      const activityMinutesAgo = activityMinutesFromRecent(recentPerson);
      const emptyRoomForceKeep = new Set(['gen_a', 'gen_b', 'gen_c'].filter((key) => {
        const k = key as ScenarioSceneKey;
        return !!scenarioControl?.sceneElements?.[k]?.length || !!scenarioControl?.sceneModes?.[k] || !!resolvedPersonReferences?.[k]?.length;
      }));
      const emptyRoomScenes = decideEmptyRoomScenes({
        captureId, sceneKeys: ['gen_a', 'gen_b', 'gen_c'].slice(0, count),
        emptyRoomPersonChance: sceneParams.emptyRoomPersonChance ?? DEFAULT_EMPTY_ROOM_PERSON_CHANCE,
        recentPerson: !!recentPerson, extras: sceneExtras as Record<string, string | undefined>,
        activityMinutesAgo, activityWindowMin, forceKeep: emptyRoomForceKeep,
      });
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
      // A reference person that cannot be observed must not stop the whole capture: generate without it and say so.
      let observedPersonReferences:Awaited<ReturnType<NonNullable<typeof personReferenceAssets>['observe']>>|undefined;
      if(resolvedPersonReferences&&!described.ok){console.warn('[person-ref] source observation unavailable; generating without reference people');operatorWarnings.push('person-ref','カメラ画像の人物を読み取れなかったため、参照人物なしで生成しました',captureId);sceneNotes.add(captureId,'all','カメラ画像の人物を読み取れず、参照人物なしで生成','warn');}
      else if(resolvedPersonReferences){
        try{observedPersonReferences=await personReferenceAssets!.observe(resolvedPersonReferences,signal);}
        catch(error){if(signal?.aborted)throw error;console.warn('[person-ref] '+String((error as Error).message)+'; generating without reference people');operatorWarnings.push('person-ref','参照画像を読み取れなかったため、参照人物なしで生成しました ('+String((error as Error).message)+')',captureId);sceneNotes.add(captureId,'all','参照画像を読み取れず、参照人物なしで生成 ('+String((error as Error).message)+')','warn');}
      }
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

      // G-26: compact STATE LEDGER from history (live rows, or this test loop's replayed rows) -> planner note; past verdict.
      const ledgerRows: PastHistoryRow[] = useHistory
        ? historyItems
        : historyContext.scope.kind === 'test'
          ? testHistory.snapshot(historyContext.scope).observations.map((r) => ({ time: r.replayedAt, detectorPerson: r.detectorPerson, observation: r.observation, people: r.people as PastHistoryRow['people'] }))
          : [];
      const stateLedger = buildStateLedger({ history: ledgerRows, people });
      const pastSpans = sceneDistances.filter((d) => d < 0);
      const pastSpan = pastSpans.length ? Math.max(...pastSpans) : undefined;
      const pastContinuity = pastSpan !== undefined ? judgePastContinuity({ ledger: stateLedger, people, spanSec: pastSpan }) : undefined;
      const ledgerNote = stateLedgerNote({ ledger: stateLedger, continuity: pastContinuity, pastSpanSec: pastSpan });
      console.log(`[past] ledger ${stateLedger.rows} rows, ${stateLedger.states.length} states; continuity=${pastContinuity ? `${pastContinuity.verdict} (${pastContinuity.reason})` : '-'}`);
      const planContextNote = [contextNote, ledgerNote].filter(Boolean).join('\n');

      const vlmTrace: PlanTrace = {};
      const vlmStartedAt = Date.now();
      setStage('plan');
      const scenarios = await predictScenarios({
        imageDataUrl: image,
        target: normalizedTarget,
        scenarioCount: count,
        sceneTime: typeof sceneTime === 'string' ? sceneTime : new Date().toISOString(),
        sceneParams: planContextNote ? { ...sceneParams, contextNote: planContextNote } : sceneParams,
        captureId,
        trace: vlmTrace,
        signal,
        allowPerson: !!recentPerson,
        emptyRoomScenes,
        sceneExtras,
        detector,
        people,
        sceneDistances,
        vlmBackend: backends.vlm,
      });
      // Tone enforcement (2026-10-20): the planner ignores the Tone sentence, so a scene whose wording contradicts its
      // tone band ("slightly" at TONE 1) is rewritten once; a failed rewrite keeps the original plan.
      if (people.length > 0 && backends.vlm !== 'gemini') {
        await Promise.all(scenarios.map(async (scenario, index) => {
          const tone = toneAt(sceneParams, index);
          const english = String(scenario?.prediction_prompt ?? ''), japanese = String(scenario?.scenario_description ?? '');
          const mismatch = english ? toneMismatch(tone, english, japanese) : null;
          if (!mismatch) return;
          const scene = String.fromCharCode(65 + index);
          let fixed = await rewriteForTone({ tone, english, japanese, seconds: sceneDistances[index] ?? null, signal });
          if (!fixed) fixed = await rewriteForTone({ tone, english, japanese, seconds: sceneDistances[index] ?? null, signal });
          if (!fixed) { fixed = forceToneWording(mismatch, english, japanese); console.warn(`[tone] ${captureId} ${scene}: rewrite failed twice; weak words replaced`); sceneNotes.add(captureId, scene, `Tone ${tone.toFixed(2)} に合わない計画（${mismatch==='too_weak'?'弱すぎ':'強すぎ'}）。書き直しに2回失敗し、言葉を置き換えた`, 'warn'); }
          else sceneNotes.add(captureId, scene, `Tone ${tone.toFixed(2)} に合わない計画（${mismatch==='too_weak'?'弱すぎ':'強すぎ'}）を書き直した。元: ${japanese}`, 'info');
          console.log(`[tone] ${captureId} ${scene}: ${mismatch} at tone ${tone.toFixed(2)} -> rewritten: ${fixed.prediction_prompt}`);
          scenario.prediction_prompt = fixed.prediction_prompt;
          scenario.scenario_description = fixed.scenario_description;
        }));
      }
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
        // Belongings from the same describe call (also for empty rooms): free spot + objectsVisible (missing_belongings).
        if (g) g.belongings = described.belongings ?? [];
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
      // G-25: in an unoccupied frame the recent person appears only in the scenes whose roll chose it (or the operator named a person).
      const emptyRoomDecision = (index: number) => vlmTrace.guard?.unoccupied === true ? vlmTrace.guard.emptyRoom?.[index] : undefined;
      const sceneWithoutPerson = (index: number) => unoccupied || (drawFromBehind && emptyRoomDecision(index)?.personDrawn === false);
      if (drawFromBehind) console.log(`[guard] recent person (${recentPerson!.minutesAgo} min ago) drawn from behind in scenes [${scenarios.map((_, i) => sceneWithoutPerson(i) ? '' : String.fromCharCode(65 + i)).filter(Boolean).join(',')}]`);
      const testRecentFrame = !useHistory && recentPerson && historyContext.scope.kind === 'test' ? testPersonStore.frame(historyContext.scope.key, recentPerson.entry.captureId) : undefined;
      if (vlmTrace.guard?.unoccupied === true && (recentPerson?.entry.imageFile || testRecentFrame)) {
        try {
          const buf = testRecentFrame ? decodeImageDataUrl(testRecentFrame).buffer : fs.readFileSync(path.join(capturesDir, path.basename(recentPerson!.entry.imageFile!)));
          referencePersonImage = testRecentFrame ?? `data:image/jpeg;base64,${buf.toString('base64')}`;
          const size = imageSize(buf);
          // G-13: head + shoulders + torso of that person (full figure), never a tip-dominated head crop.
          if (size && (recentLook?.position || recentLook?.headBox)) referenceCrop = figureCropFor(recentLook.headBox, recentLook.position ?? '', size.width, size.height);
        } catch {
          referencePersonImage = undefined;
        }
      }
      // Identity reference must also be attached for tests (history is deliberately disabled there).
      // The original photo controls composition; its person crop only supplies identity/held-item detail.
      if (!drawFromBehind && !unoccupied && (people.length > 0 || detector.count && detector.count > 0)) {
        referencePersonImage = image;
        const size = imageSize(decodeImageDataUrl(image).buffer);
        if (size && people.length === 1 && people[0]?.position) referenceCrop = { ...cropRectFor(people[0].position, size.width, size.height), y: 0, height: Math.floor(size.height / 8) * 8 };
      }
      // Frame with a person (not the recent-person-from-behind case): attach up to REF_FRAMES_MAX recent frames of other orientations.
      let refChoices: RefFrameChoice[] = [];
      let refImages: string[] = [];
      let referenceCrops: Array<{x:number;y:number;width:number;height:number}> | undefined;
      const explicitRefs = Array.isArray(req.body?.identityReferences) ? req.body.identityReferences.filter((x: unknown): x is string => typeof x === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(x)).slice(0, 2) : [];
      if (!unoccupied && !drawFromBehind && explicitRefs.length) {
        // One portrait per original person: two portraits of one person can be copied as two people.
        referencePersonImage = undefined;
        referenceCrop = null;
        refImages = explicitRefs.slice(0, Math.min(2, people.length || detector.count || 1));
      }
      if (!explicitRefs.length && !drawFromBehind && !unoccupied && people.length) {
        const size=imageSize(decodeImageDataUrl(image).buffer);
        const heads=size ? people.slice(0,2).map(p=>headCropFor(p.headBox,size.width,size.height)) : [];
        const visibleHeads=heads.filter((h): h is NonNullable<typeof h> => !!h);
        referencePersonImage=undefined;referenceCrop=null;
        refImages=visibleHeads.map(()=>image);referenceCrops=visibleHeads;
      }
      if (!referencePersonImage && !refImages.length && refFramesEnabled() && useHistory && backends.image !== 'gemini' && vlmTrace.guard?.unoccupied !== true && !unoccupied && resolveScenePresence(sceneParams, count).some((p) => p > 0)) {
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
      if(evt.browserBatch?.[0]?.sceneKey==='now'){
        evt.browserBatch[0].caption=nowText;
        captureEvents.patch(captureId,{...captureBatchCounts(evt),inputIdentity:evt.inputIdentity,browserBatch:evt.browserBatch,images:evt.images});
      }
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
              skipped: !!s.skipped,
            })).filter((row) => !row.skipped).map(({ skipped: _skipped, ...row }) => row),
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
      const qaJobs: Array<{ sceneKey: string; imagePath: string; predictionPrompt: string; nowPath?:string; expectedPeople:number;referenceCast?:QaReferenceCastJob }> = [];

      const resolvedSceneTime =
        typeof sceneTime === 'string' ? sceneTime : new Date().toISOString();

      let sourcePeopleDetection: Awaited<ReturnType<typeof detectPeople>> | null = scenarioPrepared?.sourceDetection??null;
      const sourceSize = imageSize(decodeImageDataUrl(image).buffer);
      if (!sourcePeopleDetection && !unoccupied && !drawFromBehind && backends.image === 'local') {
        try { sourcePeopleDetection = await detectPeople(image, signal); }
        catch (error) { signal.throwIfAborted(); console.warn('[region] source detection unavailable', String(error)); }
      }
      // Original identity portraits retain their own image roles before added people.
      const castIdentityImages:SourceCastIdentityImage[]=observedPersonReferences&&Object.values(observedPersonReferences).some(refs=>refs?.length)
        ? sourceCastIdentityImages(image,people,explicitRefs,sourceSize):[];
      const sceneCasts=new Map(scenarios.map((scenario,index)=>{const key=('gen_'+String.fromCharCode(97+index)) as ScenarioSceneKey;return [key,buildSceneReferenceInputs({sourceImage:image,sourcePeople:people,sourceOk:described.ok,references:observedPersonReferences?.[key]??[],identityImages:castIdentityImages,predictionPrompt:scenario.prediction_prompt})];}));
      // G-24: skipped scenes (unoccupied, neither the recent person nor an object change) are not generated. TD/browser get
      // no capture.saved for them (their panels keep the previous image and caption); expectedImageCount = scenes generated.
      const skipPlan = sceneSkipPlan(scenarios);
      // A scene rejected twice by the pre-publish inspection is appended here too (reason "rejected:<defect>").
      const skippedScenes: Array<{ sceneKey: 'gen_a' | 'gen_b' | 'gen_c'; reason: string }> = [...skipPlan.skippedScenes];
      let generatedCount = skipPlan.generated.length;
      if (vlmTrace.guard?.unoccupied === true && vlmTrace.guard.emptyRoom) {
        evt.emptyRoom = vlmTrace.guard.emptyRoom.map((d) => ({ sceneKey: d.sceneKey, chance: d.emptyRoomPersonChance, roll: d.roll, personDrawn: d.personDrawn, reason: d.reason, objectAllowed: d.objectAllowed, ...(d.skipped !== undefined ? { skipped: d.skipped } : {}), ...(d.skipReason ? { skipReason: d.skipReason } : {}) }));
        archive?.setEmptyRoom(vlmTrace.guard.emptyRoom);
      }
      if (skippedScenes.length) {
        evt.skippedScenes = skippedScenes;
        console.log(`[empty-room] ${captureId}: skipped ${skippedScenes.map((s) => `${s.sceneKey}(${s.reason})`).join(', ')}; generating ${generatedCount} scene(s)`);
      }
      if (evt.emptyRoom || skippedScenes.length) captureEvents.patch(captureId, { ...(evt.emptyRoom ? { emptyRoom: evt.emptyRoom } : {}), ...(skippedScenes.length ? { skippedScenes } : {}) });
      for (let index = 0; index < scenarios.length; index += 1) {
        const sceneKey = `gen_${String.fromCharCode(97 + index)}`;
        if (scenarios[index].skipped) {
          archive?.addSkippedScene(index, { sceneKey, distanceSec: sceneDistances[index], reason: scenarios[index].skipped!, emptyRoom: emptyRoomDecision(index) });
          continue;
        }
        const sceneMode=scenarioControl?.sceneModes?.[sceneKey as ScenarioSceneKey];
        const assetOnly=sceneMode==='asset_only';
        const scenario=assetOnly?{...scenarios[index],prediction_prompt:'Preserve original people and place the supplied image element only in its configured target area.',scenario_description:'指定位置に画像要素を合成する。'}:scenarios[index];
        if(assetOnly)scenarios[index]=scenario;
        const label = `Gen_${String.fromCharCode(97 + index)}`;

        const imageTrace: ImageTrace = {};
        const imageStartedAt = Date.now();
        setStage(`scene${String.fromCharCode(65 + index)}`);
        const sceneCast=sceneCasts.get(sceneKey as ScenarioSceneKey);
        const sceneUnoccupied=sceneWithoutPerson(index);
        const legacyPeople=scenarioPeoplePolicy(sceneMode,people.length||detector.count||0,sceneUnoccupied,drawFromBehind&&!sceneUnoccupied);
        const sceneDrawFromBehind=sceneCast?false:legacyPeople.drawFromBehind;
        const expectedPeople=sceneCast?sceneCast.cast.expectedSceneTotal:legacyPeople.expectedPeople;
        const sceneReference=sceneCast?undefined:(assetOnly||!unoccupied)&&sceneUnoccupied?undefined:referencePersonImage;
        const sceneRefs=sceneCast?sceneCast.referenceImages:(assetOnly||!unoccupied)&&sceneUnoccupied?[]:refImages;
        const sceneReferenceCrops=sceneCast?sceneCast.referenceCrops:referenceCrops;
        const sceneInput=scenarioPrepared?.composition.scenes[sceneKey as ScenarioSceneKey];
        let sceneInputPath:string|undefined;
        if(sceneInput){
          const decoded=decodeImageDataUrl(sceneInput.imageDataUrl);
          sceneInputPath=archive?.saveScenarioInput(index,decoded.buffer,decoded.extension,{imageSha256:sceneInput.imageSha256,targets:sceneInput.targets,protectedCoreMaskSha256:sceneInput.protectedCoreMaskSha256,protectedCorePixels:sceneInput.protectedCorePixels});
          if(sceneInput.protectedCoreMaskDataUrl)archive?.saveScenarioCoreMask(index,decodeImageDataUrl(sceneInput.protectedCoreMaskDataUrl).buffer);
          if(!sceneInputPath)throw new Error('Scenario input could not be archived');
        }
        const personRegion = peopleEditRegion(sourcePeopleDetection, expectedPeople, sourceSize, scenario.prediction_prompt, people.map(p => p.headBox));
        if(assetOnly&&expectedPeople>0&&!personRegion?.sourceEvidence)throw new ScenarioControlValidationError('image','asset_only cannot safely protect incompletely detected source people');
        const editRegion = scenarioPrepared?mergeScenarioEditRegion(personRegion,sceneInput?.editRectangles??[],scenarioPrepared.composition,expectedPeople,sceneMode):personRegion;
        const selection=selectSceneImageEngine(localImageEngine,[people,peopleEditRegion(sourcePeopleDetection,expectedPeople,sourceSize,'',people.map(p=>p.headBox)),sourceSize,scenario.prediction_prompt],(sceneCast?'explicit reference cast requires full-frame synthesis':requestFullFrameReason)??(scenarioNeedsFullFrame(sceneMode,sceneInput)||sceneDrawFromBehind||expectedPeople!==people.length?'full-frame scene image mode/count':undefined));
        const turboContext=selection.context;
        let countSourceActors=turboContext?.sourceActors;
        if(!countSourceActors&&!sceneCast&&selection.engine==='qwen21-turbo'&&!assetOnly&&!sceneDrawFromBehind&&expectedPeople===1&&people.length===1){
          try{countSourceActors=productionTurboSourceContext(people,personRegion,sourceSize,scenario.prediction_prompt).sourceActors;}catch{}
        }
        const sceneImageModel=backends.image==='gemini'?GEMINI_IMAGE_MODEL:isTurboEngine(selection.engine)?imageModelUsed:`qwen-image-edit (${process.env.COMFYUI_GGUF==='true'?comfyConfig.models.ggufUnet:comfyConfig.models.unet})`;

        const generated = await generateUniquePeople({
          generate: async (attempt, correction) => generateImage({
          originalImageDataUrl: sceneInput?.imageDataUrl??image,
          scenarioElementInstruction:scenarioElementInstruction(scenarioControl,sceneKey as ScenarioSceneKey),
          assetOnlyInstruction:assetOnly?assetOnlyEditInstruction():undefined,
          assetOnlyFrame:assetOnly?{rawImageDataUrl:image,protectedCoreMaskDataUrl:sceneInput?.protectedCoreMaskDataUrl??'',rectangles:sceneInput?.editRectangles??[]}:undefined,
          predictionPrompt: scenario.prediction_prompt + (correction ? " " + correction : ""),
          seed: attempt === 0 && isTest && Number.isSafeInteger(req.body?.seeds?.[index]) && req.body.seeds[index] >= 0 ? req.body.seeds[index] : undefined,
          filenamePrefix: `SpecMem/${sceneKey}`,
          captureId,
          trace: imageTrace,
          faceImageDataUrl: sceneReference,
          faceCrop: referenceCrop ?? undefined,
          behindView: sceneDrawFromBehind ? { clothes: recentLook?.clothes, hair: recentLook?.hair, position: recentLook?.position, headBox: recentLook?.headBox, belongings: vlmTrace.guard?.belongings, scene: vlmTrace.guard?.scene ?? scenarios[0]?.scene_now, objects: sceneBelongings(vlmTrace.guard?.scene ?? scenarios[0]?.scene_now) } : undefined,
          obstructed: described.obstructed === true,
          obstructedBy: described.obstructedBy || undefined,
          referencePerson: sceneDrawFromBehind && !!sceneReference,
          people,
          personCount: expectedPeople,
          compactPeople: true,
          referenceImages: sceneDrawFromBehind ? undefined : sceneRefs,
          referenceCrops:sceneReferenceCrops,
          referenceCast:sceneCast?{sourcePeople:people,references:sceneCast.references,sourceIdentityImages:sceneCast.sourceIdentityImages}:undefined,
          editRegion,
          foregroundObject: scenario.foreground_object,
          presence: sceneUnoccupied ? 0 : presenceAt(sceneParams, index),
          tone: toneAt(sceneParams, index),
          distanceSec: sceneDistances[index],
          pastContinuity: pastContinuity?.verdict,
          // Each scene's own signed offset decides the direction and the clock digits.
          clock: clockForSignedDistance(sceneDistances[index], resolvedSceneTime, scenario.clock_visible === true),
          signal,
          imageBackend: backends.image,
          localImageEngine:selection.engine,turboContext,
          }),
          inspect: async candidate => {
            // missing_belongings: objects the source scene lists on its furniture must stay visible (same inspection call).
            const belongings = inspectionBelongings(vlmTrace.guard?.scene ?? scenarios[0]?.scene_now, { action: scenario.prediction_prompt, people, belongings: vlmTrace.guard?.belongings });
            const detection = await detectPeople(candidate, signal);
            return inspectCountedImage({detection,expectedPeople,sourceActors:countSourceActors,
              allowPartOverlap:!sceneCast&&selection.engine==='qwen21-turbo'&&!assetOnly&&!sceneDrawFromBehind&&expectedPeople===1&&people.length===1,
              inspect:()=>sceneCast?inspectAndCaptionWithReferences(image,candidate,people,sceneCast.references,sceneDistances[index],signal,sceneCast.sourceIdentityImages,belongings):inspectAndCaption(sceneDrawFromBehind && sceneReference ? sceneReference : image, candidate, expectedPeople, sceneDistances[index], people, signal, image, belongings)});
          },
          rejected: (candidate, verdict, attempt) => {
            sceneNotes.add(captureId, sceneKey, `${attempt}回目の画像を検査で不合格: ${verdict.ok===null?'判定不能 ':''}${String(verdict.reason??'').slice(0,240)}`, verdict.ok===null?'warn':'warn');
            const rejectedDir = path.join(archiveRootDir(), 'rejected', captureId.replace(/[^a-zA-Z0-9_-]/g, '_'));
            fs.mkdirSync(rejectedDir, { recursive: true });
            const rejectedFile = `${sceneKey}-attempt${attempt}-${Date.now()}.png`;
            fs.writeFileSync(path.join(rejectedDir, rejectedFile), decodeImageDataUrl(candidate).buffer);
            fs.appendFileSync(path.join(rejectedDir, 'integrity.jsonl'), JSON.stringify({ time: new Date().toISOString(), sceneKey, attempt, verdict, seed: imageTrace.seed, prompt: imageTrace.editInstruction }) + '\n');
            appendQaRow(path.join(process.cwd(), 'logs', 'qa-local.jsonl'), {
              time: new Date().toISOString(), captureId, sceneKey: `${sceneKey}.rejected${attempt}`, file: rejectedFile,
              ok: verdict.ok === null ? null : false, score: verdict.ok === null ? null : 0,
              defects: verdict.ok === false ? [{ type: inspectionDefectType(verdict.defect), where: sceneKey, note: verdict.reason + ': ' + JSON.stringify(verdict.outputToSource) }] : [],
              model: process.env.VLM_MODEL || 'local', elapsedMs: 0, rulebookVersion: rbVersion,
              sceneCount: count,
              ...(isTest ? { test: true } : {}), ...(verdict.ok === null ? { error: verdict.reason } : {}),
            });
            console.warn(`[integrity] rejected ${captureId} ${sceneKey} attempt=${attempt}: ${verdict.reason}`);
          },
          signal,
          // Unoccupied captures / behind-view / person-free scenes get a second attempt with a correction naming the defect
          // (2026-10-19 L003: one missing_belongings rejection used to fail the whole capture). Occupied scenes unchanged.
          maxAttempts:isTest&&req.body?.automaticImageRetries===false?1:(unoccupied||sceneUnoccupied||sceneDrawFromBehind)?2:isTurboEngine(selection.engine)?1:2,
          expectedPeople,
          onExhausted:'skip',
        });
        if ('defect' in generated) {
          // Never publish a rejected image, but do not fail the capture: this scene keeps its previous image on the displays.
          const reason = `rejected:${generated.defect}`;
          console.warn(`[integrity] scene ${sceneKey} skipped after ${generated.attempts} rejection${generated.attempts===1?'':'s'}: ${generated.defect} (${captureId})`);
          skippedScenes.push({ sceneKey: sceneKey as 'gen_a' | 'gen_b' | 'gen_c', reason });
          if(generated.defect==='inspection_unavailable')operatorWarnings.push('inspection',`${sceneKey.slice(-1).toUpperCase()}: 人物チェックが判定できなかったため、この場面は出さず前の画像を残しました${observedPersonReferences?.[sceneKey as ScenarioSceneKey]?.length?'（参照人物あり）':''}`,captureId);
          generatedCount -= 1;
          evt.skippedScenes = skippedScenes;
          captureEvents.patch(captureId, { skippedScenes });
          archive?.addSkippedScene(index, { sceneKey, distanceSec: sceneDistances[index], reason, emptyRoom: emptyRoomDecision(index) });
          continue;
        }
        const dataUrl = generated.image;
        const executedImageModel=imageTrace.assetOnlyExecution?.modelExecuted===false?'cpu asset composition (no image model executed)':sceneImageModel;
        ensureActive();

        const plannedDescription = scenario.scenario_description;
        // User specification: subtitles show the generation instruction, not a post-generation observation.
        scenario.scenario_description = plannedDescription;
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
            plannedDescription,
            displayDescriptionSource: "generation-instruction",
            imagePromptFull: imageTrace.editInstruction ?? null,
            sceneExtra: (sceneExtras as Record<string, string | undefined>)[sceneKey] ?? null,
            sceneExtraReflected: vlmTrace.guard?.extras?.[sceneKey]?.reflected ?? null,
            behindView: sceneDrawFromBehind,
            scaleRule: sceneDrawFromBehind,
            emptyRoom: emptyRoomDecision(index),
            referenceCrop,
            peopleIntegrity: { ...generated.verdict, attempts: generated.attempts },
            sceneReferenceCast:sceneCast?.metadata,
            peopleEditRegion: editRegion ? {width:editRegion.width,height:editRegion.height,rectangles:editRegion.rectangles.map(({x,y,width,height})=>({x,y,width,height})),sourceEvidence:editRegion.sourceEvidence} : null,
            identityReferenceCount: sceneCast?castIdentityImages.length:(sceneReference ? 1 : 0) + sceneRefs.slice(0, sceneReference ? 1 : 2).length,
            identityReferenceCrops: sceneCast?sceneReferenceCrops?.slice(0,castIdentityImages.length)??[]:assetOnly&&unoccupied?[]:sceneReferenceCrops ?? [],
            identityReferenceMissing: sceneCast?Math.max(0,people.length-castIdentityImages.length):Math.max(0, Math.min(2, expectedPeople) - ((sceneReference ? 1 : 0) + sceneRefs.slice(0, sceneReference ? 1 : 2).length)),
            sourcePeopleDetection,
            sourceFrameRestoration:imageTrace.sourceFrameRestoration,
            assetOnlyExecution:imageTrace.assetOnlyExecution,
            turboCandidate:imageTrace.turboCandidate,
            localImageEngine:selection.engine,
            turboFullFrameReason:selection.fullFrameReason,
            scenarioInput:sceneInput?{imageSha256:sceneInput.imageSha256,file:sceneInputPath?path.basename(sceneInputPath):null,mode:sceneMode??'legacy',protectedCoreMaskSha256:sceneInput.protectedCoreMaskSha256,protectedCorePixels:sceneInput.protectedCorePixels,editRectangles:editRegion?.rectangles??null,targets:sceneInput.targets,rawNowSha256:scenarioPrepared?.composition.sourceSha256}:undefined,
            negativePrompt: imageTrace.negativePrompt ?? null,
            seed: imageTrace.seed ?? null,
            denoise: imageTrace.denoise ?? null,
            elapsedMs: Date.now() - imageStartedAt,
            imageBackend: backends.image,
            imageModel: executedImageModel,
            referenceImage:
              backends.image === 'gemini'
                ? imageTrace.referenceImage ?? 'none'
                : imageTrace.referenceImage ?? 'none',
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
          expectedImageCount: generatedCount,
          ...(skippedScenes.length ? { skippedScenes: skippedScenes.map((x) => x.sceneKey) } : {}),
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
          historySummary: useHistory?summaryWithObstruction():testHistory.snapshot(historyContext.scope).summary,
          ...historyContext.echo,
          scenarioControl:scenarioControlEcho(scenarioControl),
          obstructed: typeof evt.obstructed === 'boolean' ? evt.obstructed : null,
          obstructedBy: evt.obstructedBy ?? null,
          extrasStatus: vlmTrace.guard?.extrasStatus && Object.keys(vlmTrace.guard.extrasStatus).length > 0 ? vlmTrace.guard.extrasStatus : undefined,
          distanceSec: sceneDistances[index],
          distanceSigned: true,
          vlmBackend: backends.vlm,
          vlmModel: vlmModelUsed,
          imageBackend: backends.image,
          imageModel: executedImageModel,
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
        sceneNotes.add(captureId, sceneKey, `公開した${generated.attempts>1?'（'+generated.attempts+'回目で合格）':''}`, 'info');
        results.push({ sceneKey, label, url: savedImageAsset.url, predictionText: scenario.scenario_description });
        if(evt.browserFollow){
          evt.browserBatch??=[];
          const scope=evt.browserFollow.scope,sourceRecordedAtMs=evt.browserFollow.sourceRecordedAtMs;
          if(!evt.browserBatch.length&&sourceImageAsset?.url)evt.browserBatch.push({id:captureId+':now',captureId,sceneKey:'now',scope,provenance:'actual',distanceSecSigned:null,imageUrl:evtImageUrl(sourceImageAsset.url)!,recordedAtMs:sourceRecordedAtMs,sourceRecordedAtMs,generatedAtMs:null,targetAtMs:null,caption:nowText});
          const sceneAt=Date.parse(resolvedSceneTime);
          evt.browserBatch.push({id:captureId+':'+sceneKey,captureId,sceneKey,scope,provenance:'generated',distanceSecSigned:Number.isFinite(sceneDistances[index])?sceneDistances[index]:null,imageUrl:evtImageUrl(savedImageAsset.url)!,recordedAtMs:null,sourceRecordedAtMs,generatedAtMs:Date.now(),targetAtMs:Number.isFinite(sceneAt)?sceneAt+sceneDistances[index]*1000:null,caption:scenarioContentText(scenario)});
          captureEvents.patch(captureId,{...captureBatchCounts(evt),inputIdentity:evt.inputIdentity,images:evt.images,browserFollow:evt.browserFollow,browserBatch:evt.browserBatch});
        }
        qaJobs.push({ sceneKey, imagePath: savedImageAsset.absolutePath, predictionPrompt: scenario.prediction_prompt,nowPath:sceneInputPath,expectedPeople:sceneCast?people.length:expectedPeople,referenceCast:sceneCast?{sourcePeople:people,references:sceneCast.references,distanceSec:sceneDistances[index],sourceIdentityImages:sceneCast.sourceIdentityImages}:undefined });
      }

      ensureActive();
      cm.complete(captureId);
      await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 500))]);
      if (!mobileLane) archive?.setHistorySummary(useHistory?composeSummary(venueSummary):testHistory.snapshot(historyContext.scope).summary);
      // MAIN error box: say which scenes were not shown and why, or the display just looks frozen (2026-10-20).
      const skipWhy=(reason:string)=>reason==='no_recent_activity'?'無人で最近の動きもない':reason==='chance'?'無人時の確率ルールで変化なし':reason==='no_movable_object'?'無人で動かせる物がない':reason==='rejected:inspection_unavailable'?'人物チェックが判定できなかった':reason.startsWith('rejected:')?'検査で不合格（'+reason.slice(9)+'）':reason;
      for(const item of skippedScenes)sceneNotes.add(captureId,item.sceneKey,'出さなかった（前の画像のまま）: '+skipWhy(item.reason),'warn');
      sceneNotes.end(captureId,'completed');
      if(skippedScenes.length&&!isTest){
        const why=(reason:string)=>reason==='no_recent_activity'?'無人で最近の動きもないため':reason==='chance'?'無人時の確率ルールで変化なし':reason==='no_movable_object'?'無人で動かせる物がないため':reason==='rejected:inspection_unavailable'?'人物チェックが判定できなかったため':reason.startsWith('rejected:')?'検査で不合格（'+reason.slice(9)+'）':reason;
        operatorWarnings.push('skip',skippedScenes.map(item=>item.sceneKey.slice(-1).toUpperCase()+' '+(sceneDistances[item.sceneKey.charCodeAt(4)-97]>0?'+':'')+(sceneDistances[item.sceneKey.charCodeAt(4)-97]??'?')+'秒: '+why(item.reason)).join(' / ')+' → 前の画像のまま',captureId);
      }
      archive?.finish('completed');
      captureEvents.finish({ ...evt, result: 'completed', errorStage: null, errorMessage: null });
      // QA of the three images runs later, between captures (never while something generates).
      if (!mobileLane && sourceImageAsset?.absolutePath) {
        for (const job of qaJobs) {
          qaService.enqueueScene({
            captureId,
            sceneKey: job.sceneKey,
            nowPath: job.nowPath??sourceImageAsset.absolutePath,
            identityNowPath:sourceImageAsset.absolutePath,
            imagePath: job.imagePath,
            predictionPrompt: job.predictionPrompt,
            archiveDir: archive?.dir ?? null,
            rulebookVersion: rbVersion,
            sceneCount: qaJobs.length,
            test: isTest,
            expectedPeople: job.expectedPeople,
            referenceCast:job.referenceCast,
          });
        }
      }
      try {
        const latest: LatestPrediction = {
          captureId,
          observation: observation || nowText,
          savedAt: new Date().toISOString(),
          // G-24: a skipped scene keeps the previous prediction text (its display keeps the previous image/caption too).
          scenarios: scenarios.flatMap((_, index) => {
            const key = `gen_${String.fromCharCode(97 + index)}`;
            const r = results.find((x) => x.sceneKey === key);
            if (r) return [{ sceneKey: r.sceneKey, label: r.label, text: r.predictionText }];
            const previous = latestPredictionStore?.scenarios.find((x) => x.sceneKey === key);
            return previous ? [previous] : [];
          }),
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
        ...(skippedScenes.length ? { skippedScenes } : {}),
        sceneParams,
        ...historyContext.echo,
        scenarioControl:scenarioControlEcho(scenarioControl),
      });
    } catch (error: any) {
      if (isAbortError(error) || !cm.isActive(captureId)) {
        archive?.fail(error, 'cancelled');
        captureEvents.finish({ ...evt, result: 'cancelled', errorStage: evtStage, errorMessage: String(error?.message ?? error) });
        console.log(`generate: capture ${captureId} cancelled (${cm.stateOf(captureId)})`);
        return sendCancelled(res, captureId, cm);
      }
      if(error instanceof TurboCandidateGeometryError&&!silent)sendToTouchDesigner({type:'comfy.alert',captureId,code:error.code,reason:error.reason,test:isTest,alert:{level:'warning',message:'今回の画像は表示できません（人物保護領域との重なり／対応不明）。前回の画像を表示中。'}},'turbo.geometry.unknown');
      console.error('generate pipeline failed:', error);
      archive?.fail(error, 'failed');
      captureEvents.finish({ ...evt, result: 'failed', errorStage: evtStage, errorMessage: String(error?.message ?? error) });
      cm.fail(captureId, error);
      res.status(error instanceof ScenarioControlValidationError || /ASSET_ONLY_(?:OPAQUE_CROP_REQUIRED|TARGET_OUTSIDE_MODEL_CROP)/.test(String(error?.message))?400:502).json({ error: error?.message || 'generation pipeline failed' });
    }
  };
  app.post("/api/generate", (req, res) => handleGenerate(req, res, "venue"));
  if(nativeOperatorMode){
    nativeOperator=await createNativeOperator({
      scenarioRuns,
      directory:process.env.OPERATOR_CONTROL_DIRECTORY||path.join(path.dirname(path.resolve(archiveRootDir())),'operator-control'),
      python:process.env.PEOPLE_DETECTOR_PYTHON||path.join(process.env.USERPROFILE||'','Documents/ComfyUI/.venv/Scripts/python.exe'),
      preflightPersonReferences:async body=>{await preflightScenePersonReferences(body);},
      isBusy:()=>captureManager.current!==null,capture:()=>captureManager.snapshot(),cancel:()=>captureManager.cancel(null,'requested'),
      readScenes:mode=>browserOutputCurrent(captureEvents.readAll(),Date.now(),{instructionLookup,updateMode:mode}),
      readFadeMode:id=>browserOutputs?.channelFadeMode(id)??Promise.resolve('original'),
      readFadeTiming:id=>browserOutputs?.channelFadeTiming(id)??Promise.resolve(undefined),
      readFaceBlur:id=>browserOutputs?.channelFaceBlur(id)??Promise.resolve(undefined),
      readCaptions:id=>browserOutputs?.channelCaptions(id)??Promise.resolve(undefined),
      presentOutput:presentBrowserFaces,
      outputMapping:browserOutputs?createOperatorScenarioOutputs(browserOutputs):undefined,
      readOutputIds:browserOutputs?async()=>(await browserOutputs.configuration()).outputs.map((o:any)=>o.id):undefined,
      checkPersonReferences:async ids=>{if(!personReferenceAssets)throw Error('Private person reference service is unavailable');return (await personReferenceAssets.metadata(ids)).missingIds;},
      readCost:()=>costTracker.update(),
      latestOutcome:()=>captureEvents.readAll().filter(row=>row.browserFollow&&['completed','failed','cancelled'].includes(row.result)).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0],
      recordFrame:body=>new Promise((resolve,reject)=>{let status=200;const response:any={status:(value:number)=>{status=value;return response;},json:(value:any)=>{if(status>=400)reject(Error(value.error??'record failed'));else resolve(value);return response;}};handleRecordFrame({body},response);}),
      invokeGenerate:(body,onAccepted)=>new Promise((resolve,reject)=>{
        let status=200;const response:any=new EventEmitter();
        response.writableEnded=false;response.headersSent=false;response.destroyed=false;
        response.status=(value:number)=>{status=value;return response;};
        response.json=(value:unknown)=>{response.writableEnded=true;response.headersSent=true;resolve({status,body:value});return response;};
        void handleGenerate({body,socket:{remoteAddress:'127.0.0.1'}},response,'venue',onAccepted,()=>nativeOperator?.assertCaptureAllowed(String(body.captureId))).catch(reject);
      })
    });
  }

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
        },
        // 2026-10-20: Vite's chokidar watcher crawled captures/ (24k files, 21 GB) and logs/ on every new file,
        // blocking the event loop for seconds (static images took 4-12 s; history thumbnails stayed black).
        watch: { ignored: ['**/captures/**', '**/logs/**', '**/.local/**', '**/rulebook/**', '**/scripts/**', '**/docs/**', '**/touchdesigner/**', '**/tools/**'] }
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

  // Public output gate (127.0.0.1:3443, for Tailscale Funnel). Inert without PUBLIC_OUTPUT_PASSWORD/PUBLIC_COOKIE_SECRET.
  void import('./server/publicGate/index').then(m => m.startPublicGate()).catch(() => console.log('public gate disabled (load failed)'));
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Load the CPU-only detector before the first generated image needs it.
    void detectPeople('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC')
      .then(() => console.log('[integrity] CPU detector warm'))
      .catch(error => console.error('[integrity] CPU detector warmup failed', String(error)));

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
