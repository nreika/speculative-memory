
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Download, WandSparkles } from 'lucide-react';
import CameraPreview from './components/CameraPreview';
import { AppState, PredictionData, Target, PredictionItem, TouchDesignerBridgeStatus } from './types';
import { predictFutureScenarios, generateFutureImage } from './services/geminiService';
import { normalizeTouchDesignerSessionId, useTouchDesignerBridge } from './hooks/useTouchDesignerBridge';

const getSceneKey = (index: number) => `scene${String.fromCharCode(65 + index)}`;
const TOUCHDESIGNER_SESSION_STORAGE_KEY = 'timewarp.touchdesigner.sessionId';
const DEFAULT_GENERATION_COUNT = 3;
const MIN_GENERATION_COUNT = 1;
const MAX_GENERATION_COUNT = 10;

interface RemoteCaptureCommand {
  id: number;
  imageCount: number;
}

const clampGenerationCount = (value: number) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_GENERATION_COUNT;
  }

  return Math.min(MAX_GENERATION_COUNT, Math.max(MIN_GENERATION_COUNT, Math.round(value)));
};

const getInitialTouchDesignerSessionId = () => {
  if (typeof window === 'undefined') {
    return 'timewarp-local';
  }

  return window.localStorage.getItem(TOUCHDESIGNER_SESSION_STORAGE_KEY) || 'timewarp-local';
};

const getBridgeStatusLabel = (status: TouchDesignerBridgeStatus) => {
  switch (status) {
    case 'idle':
      return 'IDLE';
    case 'starting':
      return 'STARTING';
    case 'waiting-answer':
      return 'WAITING_FOR_TD';
    case 'streaming':
      return 'STREAMING';
    case 'stopped':
      return 'STOPPED';
    case 'error':
      return 'ERROR';
    default:
      return 'UNKNOWN';
  }
};

const getBridgeStatusClassName = (status: TouchDesignerBridgeStatus) => {
  switch (status) {
    case 'streaming':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    case 'starting':
    case 'waiting-answer':
      return 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300';
    case 'error':
      return 'border-red-500/40 bg-red-500/10 text-red-300';
    case 'stopped':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    default:
      return 'border-white/10 bg-white/5 text-slate-400';
  }
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [lastPrediction, setLastPrediction] = useState<PredictionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [touchDesignerBridgeEnabled, setTouchDesignerBridgeEnabled] = useState(false);
  const [touchDesignerSessionId, setTouchDesignerSessionId] = useState<string>(() => getInitialTouchDesignerSessionId());
  const [remoteCaptureQueue, setRemoteCaptureQueue] = useState<RemoteCaptureCommand[]>([]);
  const [remoteControlError, setRemoteControlError] = useState<string | null>(null);
  const remoteControlAfterRef = useRef(0);
  
  // Immersive states moved up to App to drive the separate Data Terminal
  const [showFuture, setShowFuture] = useState(false);
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState(0);

  const normalizedTouchDesignerSessionId = normalizeTouchDesignerSessionId(touchDesignerSessionId);
  const { bridgeState } = useTouchDesignerBridge(
    cameraStream,
    touchDesignerBridgeEnabled,
    normalizedTouchDesignerSessionId
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(
      TOUCHDESIGNER_SESSION_STORAGE_KEY,
      normalizedTouchDesignerSessionId
    );
  }, [normalizedTouchDesignerSessionId]);

  useEffect(() => {
    if (!cameraStream && touchDesignerBridgeEnabled) {
      setTouchDesignerBridgeEnabled(false);
    }
  }, [cameraStream, touchDesignerBridgeEnabled]);

  useEffect(() => {
    if (!cameraStream) {
      remoteControlAfterRef.current = 0;
      setRemoteCaptureQueue([]);
      setRemoteControlError(null);
      return;
    }

    remoteControlAfterRef.current = 0;
    setRemoteCaptureQueue([]);
    setRemoteControlError(null);

    let cancelled = false;
    let timeoutId: number | null = null;

    const pollRemoteCommands = async () => {
      try {
        const response = await fetch(
          `/api/touchdesigner-control/session/${normalizedTouchDesignerSessionId}/commands?after=${remoteControlAfterRef.current}`
        );
        if (!response.ok) {
          throw new Error(`Remote control polling failed (${response.status})`);
        }

        const data = await response.json();
        if (cancelled) {
          return;
        }

        const items = Array.isArray(data.items) ? data.items : [];
        const captureCommands = items
          .filter((item): item is { id: number; type: string; imageCount?: number } => typeof item?.id === 'number' && typeof item?.type === 'string')
          .filter((item) => item.type === 'capture')
          .map((item) => ({
            id: item.id,
            imageCount: clampGenerationCount(
              typeof item.imageCount === 'number' ? item.imageCount : DEFAULT_GENERATION_COUNT
            )
          }));

        if (captureCommands.length > 0) {
          setRemoteCaptureQueue((current) => {
            const next = [...current];
            captureCommands.forEach((command) => {
              if (!next.some((item) => item.id === command.id)) {
                next.push(command);
              }
            });
            return next;
          });
        }

        if (typeof data.lastId === 'number') {
          remoteControlAfterRef.current = Math.max(remoteControlAfterRef.current, data.lastId);
        }
        setRemoteControlError(null);
      } catch (err: any) {
        if (!cancelled) {
          setRemoteControlError(err?.message || 'Failed to poll TouchDesigner remote controls.');
        }
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(pollRemoteCommands, 1000);
      }
    };

    pollRemoteCommands();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [cameraStream, normalizedTouchDesignerSessionId]);

  const handleCapture = useCallback(async (base64: string, requestedImageCount = DEFAULT_GENERATION_COUNT) => {
    setAppState(AppState.ANALYZING);
    setError(null);
    setSelectedTimelineIndex(0);

    try {
      const imageCount = clampGenerationCount(requestedImageCount);
      const scenarios = await predictFutureScenarios(base64, target, imageCount);
      setAppState(AppState.GENERATING);

      const items: PredictionItem[] = await Promise.all(
        scenarios.map(async (s) => ({
          predictedImage: await generateFutureImage(base64, s.prediction_prompt),
          predictionText: s.scenario_description,
          label: s.label
        }))
      );

      const captureTimestamp = Date.now();
      const prediction: PredictionData = {
        originalImage: base64,
        items,
        timestamp: captureTimestamp,
        requestedImageCount: imageCount
      };

      setLastPrediction(prediction);

      // Automatically save to local folder via server API
      try {
        await Promise.all(prediction.items.map((item, index) =>
          fetch('/api/save-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image: item.predictedImage,
              originalImage: prediction.originalImage,
              captureId: String(prediction.timestamp),
              label: item.label,
              sceneKey: getSceneKey(index),
              sceneIndex: index,
              expectedImageCount: prediction.items.length
            })
          })
        ));
        console.log("All images auto-saved to server.");
      } catch (saveErr) {
        console.error("Auto-save failed:", saveErr);
      }

      setAppState(AppState.IDLE);
      // Auto-flash the first result
      setShowFuture(true);
      setTimeout(() => setShowFuture(false), 2500);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "予期せぬエラーが発生しました。");
      setAppState(AppState.ERROR);
    }
  }, [target]);

  const currentTimeline = lastPrediction?.items[selectedTimelineIndex];

  const handleSaveImage = useCallback(() => {
    if (!currentTimeline) return;
    const link = document.createElement('a');
    link.href = currentTimeline.predictedImage;
    link.download = `timewarp_${currentTimeline.label.replace(/\s+/g, '_')}_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [currentTimeline]);

  const handleRegenerateFromCurrentImage = useCallback(() => {
    if (!currentTimeline || appState === AppState.ANALYZING || appState === AppState.GENERATING) {
      return;
    }

    void handleCapture(
      currentTimeline.predictedImage,
      lastPrediction?.requestedImageCount ?? DEFAULT_GENERATION_COUNT
    );
  }, [appState, currentTimeline, handleCapture, lastPrediction?.requestedImageCount]);

  const handleTouchDesignerBridgeToggle = useCallback(() => {
    if (!cameraStream) {
      setError('ブラウザカメラの準備が完了してから TouchDesigner ストリームを開始してください。');
      return;
    }

    setTouchDesignerBridgeEnabled((current) => !current);
  }, [cameraStream]);

  const handleRemoteCaptureRequestHandled = useCallback((requestId: number) => {
    setRemoteCaptureQueue((current) => current.filter((item) => item.id !== requestId));
  }, []);

  return (
    <div className="min-h-screen bg-[#020202] text-slate-100 flex flex-col font-inter">
      {/* 1. Immersive Header */}
      <header className="p-4 md:p-6 z-50 flex justify-between items-center border-b border-white/5 bg-black/40 backdrop-blur-xl">
        <div className="flex items-center space-x-4">
          <div className="relative">
             <h1 className="text-xl md:text-2xl font-orbitron font-bold tracking-[0.3em] text-white">
              TIMEWARP<span className="text-cyan-500">.V</span>
            </h1>
            <div className="absolute -bottom-1 left-0 w-full h-[1px] bg-gradient-to-r from-cyan-500 to-transparent" />
          </div>
          <span className="hidden md:inline-block text-[10px] font-orbitron text-slate-500 uppercase tracking-widest border-l border-slate-800 pl-4">
            Parallel Chronos Interface v1.4
          </span>
        </div>
        
        <div className="flex items-center space-x-3">
          <div className={`px-3 py-1 rounded-sm border text-[9px] font-orbitron tracking-[0.2em] uppercase transition-all duration-500 ${
            appState === AppState.IDLE ? 'border-slate-800 text-slate-600' :
            'border-cyan-500 text-cyan-400 bg-cyan-500/10 shadow-[0_0_10px_rgba(6,182,212,0.2)]'
          }`}>
            {appState === AppState.IDLE ? 'STATUS: STANDBY' : `STATUS: ${appState}`}
          </div>
        </div>
      </header>

      {/* 2. Main Layout Split */}
      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        
        {/* Left/Top: Immersive Video Zone */}
        <section className="flex-[3] relative bg-black flex items-center justify-center p-2 md:p-6 border-r border-white/5">
           {/* Scanline effect */}
           <div className="absolute inset-0 pointer-events-none opacity-5 z-10 overflow-hidden">
              <div className="w-full h-full bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%]" />
           </div>

           <CameraPreview 
            onCapture={handleCapture} 
            isProcessing={appState === AppState.ANALYZING || appState === AppState.GENERATING} 
            target={target}
            onSetTarget={setTarget}
            onStreamReady={setCameraStream}
            onCameraError={setCameraError}
            prediction={lastPrediction}
            selectedTimelineIndex={selectedTimelineIndex}
            showFuture={showFuture}
            setShowFuture={setShowFuture}
            captureRequest={remoteCaptureQueue[0] || null}
            onCaptureRequestHandled={handleRemoteCaptureRequestHandled}
          />
        </section>

        {/* Right/Bottom: Data & Control Terminal */}
        <aside className="flex-[1] lg:w-96 bg-slate-950/50 border-t lg:border-t-0 border-white/5 backdrop-blur-sm flex flex-col">
          <div className="p-6 flex-1 flex flex-col space-y-6 overflow-y-auto">
            
            {/* Intel Panel */}
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <h2 className="text-[11px] font-orbitron text-cyan-400 tracking-widest uppercase">Chronos_Intel</h2>
                <span className="text-[9px] font-orbitron text-slate-600">ID: {target ? 'LOCKED' : 'SCANNING'}</span>
              </div>

              <div className="bg-white/5 border border-white/10 rounded-lg p-4 min-h-[120px] transition-all duration-500 hover:bg-white/[0.07]">
                {lastPrediction ? (
                  <div className="space-y-3 animate-in fade-in slide-in-from-right-2">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[10px] font-orbitron text-fuchsia-400 tracking-tighter uppercase">Prediction_Data (T+{selectedTimelineIndex + 1})</p>
                      <div className="flex items-center gap-2">
                        <motion.button
                          whileHover={{ scale: 1.03 }}
                          whileTap={{ scale: 0.97 }}
                          onClick={handleRegenerateFromCurrentImage}
                          disabled={appState === AppState.ANALYZING || appState === AppState.GENERATING}
                          className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[9px] font-orbitron tracking-[0.15em] text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                          title="Generate again from this image"
                        >
                          <WandSparkles size={12} />
                          <span>FROM_THIS</span>
                        </motion.button>
                        <motion.button
                          whileHover={{ scale: 1.1 }}
                          whileTap={{ scale: 0.9 }}
                          onClick={handleSaveImage}
                          className="p-1.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-400 hover:bg-fuchsia-500/20 transition-colors"
                          title="Save Prediction Image"
                        >
                          <Download size={12} />
                        </motion.button>
                      </div>
                    </div>
                    <p className="text-sm text-slate-200 leading-relaxed font-medium">
                      {currentTimeline?.predictionText}
                    </p>
                    <p className="text-[10px] leading-relaxed text-slate-500">
                      FROM_THIS で、選択中の生成画像を次の入力としてそのまま再生成できます。
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full opacity-40 text-center py-4">
                    <div className="w-8 h-8 border border-dashed border-slate-600 rounded-full mb-3 flex items-center justify-center">
                      <div className="w-1 h-1 bg-slate-600 rounded-full animate-pulse" />
                    </div>
                    <p className="text-[10px] font-orbitron text-slate-500 uppercase tracking-widest">
                      Waiting for input...<br/>
                      <span className="text-[8px] opacity-60 mt-1 block">Tap an object to predict its fate</span>
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Timeline Selection */}
            {lastPrediction && (
              <div className="space-y-4 animate-in fade-in zoom-in-95 duration-500">
                <h2 className="text-[11px] font-orbitron text-fuchsia-400 tracking-widest uppercase border-b border-white/10 pb-2">Timeline_Branches</h2>
                <div className="grid grid-cols-1 gap-2">
                  {lastPrediction.items.map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => { setSelectedTimelineIndex(idx); setShowFuture(true); }}
                      className={`group relative flex flex-col p-3 rounded border transition-all duration-300 ${
                        selectedTimelineIndex === idx 
                        ? 'bg-fuchsia-500/20 border-fuchsia-500 ring-1 ring-fuchsia-500/50' 
                        : 'bg-white/5 border-white/10 hover:border-white/30 hover:bg-white/10'
                      }`}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className={`text-[9px] font-orbitron ${selectedTimelineIndex === idx ? 'text-fuchsia-400' : 'text-slate-500'}`}>
                          PATH_0{idx + 1}
                        </span>
                        {selectedTimelineIndex === idx && <div className="w-1.5 h-1.5 bg-fuchsia-500 rounded-full animate-pulse" />}
                      </div>
                      <span className="text-[11px] font-bold text-slate-100 group-hover:text-white transition-colors">
                        {item.label || `Timeline Branch ${idx + 1}`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <h2 className="text-[11px] font-orbitron text-cyan-400 tracking-widest uppercase">TouchDesigner_Bridge</h2>
                <span className={`rounded-full border px-2 py-1 text-[9px] font-orbitron tracking-[0.15em] ${getBridgeStatusClassName(bridgeState.status)}`}>
                  {getBridgeStatusLabel(bridgeState.status)}
                </span>
              </div>

              <div className="space-y-4 rounded-lg border border-white/10 bg-white/5 p-4 transition-all duration-300 hover:bg-white/[0.07]">
                <div className="space-y-2">
                  <label htmlFor="touchdesigner-session-id" className="block text-[9px] font-orbitron uppercase tracking-[0.25em] text-slate-500">
                    Session_ID
                  </label>
                  <input
                    id="touchdesigner-session-id"
                    value={touchDesignerSessionId}
                    onChange={(event) => setTouchDesignerSessionId(event.target.value)}
                    disabled={touchDesignerBridgeEnabled}
                    className="w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-500"
                    placeholder="timewarp-local"
                  />
                  <p className="text-[10px] leading-relaxed text-slate-400">
                    TouchDesigner 側の受信設定でもこの Session ID を使います。
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] font-orbitron tracking-[0.15em] text-slate-500">
                  <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
                    INPUT: {cameraStream ? 'BROWSER_CAM' : 'WAITING'}
                  </div>
                  <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
                    OUTPUT: WEBRTC
                  </div>
                </div>

                <button
                  onClick={handleTouchDesignerBridgeToggle}
                  disabled={!cameraStream}
                  className={`w-full rounded-xl border-2 px-4 py-3 font-orbitron text-[11px] tracking-[0.2em] transition-all duration-300 ${
                    touchDesignerBridgeEnabled
                      ? 'border-red-500/60 bg-red-500/10 text-red-200 hover:bg-red-500/20'
                      : 'border-cyan-500/60 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600'
                  }`}
                >
                  {touchDesignerBridgeEnabled ? 'STOP_WEBRTC_STREAM' : 'START_WEBRTC_STREAM'}
                </button>

                <div className="rounded border border-white/10 bg-black/20 px-3 py-3 text-[10px] leading-relaxed text-slate-400">
                  <p>1. ブラウザがカメラを保持したまま映像を送ります。</p>
                  <p>2. TouchDesigner は `WebRTC DAT` で受信します。</p>
                  <p>3. シグナリング API は `/api/touchdesigner-stream` です。</p>
                </div>

                {(cameraError || bridgeState.error || remoteControlError) && (
                  <div className="rounded border border-red-500/40 bg-red-950/30 px-3 py-3 text-[10px] leading-relaxed text-red-300">
                    {cameraError || bridgeState.error || remoteControlError}
                  </div>
                )}
              </div>
            </div>

            {/* System Status / Error */}
            {error && (
              <div className="p-3 bg-red-950/30 border border-red-500/50 rounded flex items-start space-x-3 text-red-400">
                <svg className="h-4 w-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="text-[10px] font-orbitron leading-relaxed">
                  <span className="font-bold">SYSTEM_ERROR</span><br/>
                  {error}
                </div>
              </div>
            )}
          </div>

          {/* Flash Toggle Control */}
          {lastPrediction && (
            <div className="p-6 border-t border-white/5 bg-black/20">
               <button
                  onMouseDown={() => setShowFuture(true)}
                  onMouseUp={() => setShowFuture(false)}
                  onTouchStart={() => setShowFuture(true)}
                  onTouchEnd={() => setShowFuture(false)}
                  className={`w-full py-4 rounded-xl border-2 transition-all duration-300 flex flex-col items-center justify-center space-y-1 ${
                    showFuture 
                    ? 'bg-fuchsia-600 border-fuchsia-400 shadow-[0_0_40px_rgba(192,38,211,0.4)]' 
                    : 'bg-slate-900 border-fuchsia-900/50 hover:border-fuchsia-500'
                  }`}
                >
                  <span className="text-[12px] font-orbitron font-bold tracking-widest text-white">CHRONO_FLASH</span>
                  <span className="text-[8px] font-orbitron text-white/50">{showFuture ? 'STABILIZING...' : 'HOLD TO VISUALIZE'}</span>
               </button>
            </div>
          )}
        </aside>
      </main>

      {/* 3. Immersive Footer Bar */}
      <footer className="px-6 py-2 border-t border-white/5 bg-black flex justify-between items-center">
        <div className="text-[8px] font-orbitron text-slate-600 tracking-[0.4em] uppercase">
          Neural_Grid_Active // Parallel_Compute_V1.4
        </div>
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full shadow-[0_0_5px_green]" />
            <span className="text-[8px] font-orbitron text-slate-500 uppercase tracking-widest">Core_Sync</span>
          </div>
          {target && (
            <button 
              onClick={() => setTarget(null)}
              className="text-[8px] font-orbitron text-slate-400 hover:text-red-400 transition-colors tracking-[0.2em] uppercase"
            >
              Reset_Vector
            </button>
          )}
        </div>
      </footer>
    </div>
  );
};

export default App;

