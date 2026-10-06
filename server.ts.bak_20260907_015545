
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dgram from 'dgram';

interface CaptureEvent {
  type: 'capture.saved';
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
  savedAt: string;
  size: number;
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
  imageCount: number;
  promptVariant?: string | null;
  promptParams?: Record<string, number | string>;
  createdAt: string;
}

interface ParsedTouchDesignerControlMessage {
  sessionId: string;
  type: TouchDesignerControlCommandType;
  imageCount: number;
  promptVariant?: string | null;
  promptParams?: Record<string, number | string>;
}

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
  const capturesDir = path.join(process.cwd(), 'captures');
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
    date = new Date()
  ) => {
    const lines = [
      '',
      `## Capture ${formatTokyoTimestampForDocument(date)}`,
      `- captureId: ${captureId}`,
      ''
    ];

    items.forEach((item, fallbackIndex) => {
      const sceneIndex = Number.isInteger(item.sceneIndex) ? Number(item.sceneIndex) : fallbackIndex;
      const displayIndex = sceneIndex + 1;
      const label = String(item.label || '').trim();
      const labelSuffix = label ? ` - ${label}` : '';

      lines.push(
        `### Prediction_Data (T+${displayIndex})${labelSuffix}`,
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
      url: `/captures/${filename}`,
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
    imageCount: number,
    promptVariant?: string | null,
    promptParams?: Record<string, number | string>
  ) => {
    const session = getTouchDesignerControlSession(sessionId) || createTouchDesignerControlSession(sessionId);
    const command: TouchDesignerControlCommand = {
      id: session.nextCommandId++,
      type,
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
    promptParams?: Record<string, number | string>
  ) => {
    cleanupExpiredTouchDesignerControlSessions();

    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedImageCount = normalizeImageCount(imageCount);
    const { session, command } = enqueueTouchDesignerControlCommand(
      normalizedSessionId,
      'capture',
      normalizedImageCount,
      promptVariant,
      promptParams
    );
    console.log(
      `TouchDesigner remote capture queued via ${source} for session "${normalizedSessionId}" (#${command.id}, imageCount=${normalizedImageCount}).`
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
        if (type === 'capture') {
          return {
            type: 'capture',
            sessionId: normalizeSessionId(parsed.sessionId),
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

    fs.writeFileSync(latestMetaPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(latestScenesMetaPath, JSON.stringify(latestScenesManifest, null, 2), 'utf8');

    if (!touchDesignerBridgeEnabled) {
      return;
    }

    udpClient.send(Buffer.from(JSON.stringify(payload)), touchDesignerPort, touchDesignerHost, (error) => {
      if (error) {
        console.error('Failed to notify TouchDesigner:', error);
      }
    });
  };

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use('/captures', express.static(capturesDir));

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
    const { session, command } = queueTouchDesignerCapture(sessionId, 'http', imageCount, promptVariant, promptParams);
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
    const items = session.commands.filter((item) => item.id > after);
    const lastId = items.length > 0 ? items[items.length - 1].id : after;

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
        url: '/captures/prediction_data.md'
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
        savedAt: new Date().toISOString(),
        size: savedImageAsset.size
      };

      publishCapture(payload);

      console.log(`Saved image to: ${savedImageAsset.absolutePath}`);
      res.json({ success: true, capture: payload });
    } catch (error) {
      console.error('Failed to save image:', error);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });

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

    if (parsed.type === 'capture') {
      queueTouchDesignerCapture(
        parsed.sessionId,
        `udp://${peer.address}:${peer.port}`,
        parsed.imageCount,
        parsed.promptVariant,
        parsed.promptParams
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
    console.log(`Vite HMR port: ${HMR_PORT}`);
    console.log(
      `TouchDesigner bridge: ${touchDesignerBridgeEnabled ? `udp://${touchDesignerHost}:${touchDesignerPort}` : 'disabled'}`
    );
    console.log(
      `TouchDesigner control listener: ${touchDesignerControlUdpEnabled ? `udp://${touchDesignerControlUdpHost}:${touchDesignerControlUdpPort}` : 'disabled'}`
    );
  });
}

startServer();
