
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Target, PredictionData } from '../types';

interface CameraPreviewProps {
  onCapture: (base64: string, requestedImageCount?: number, promptOptions?: { variant?: string | null; params?: Record<string, number | string> }) => void;
  isProcessing: boolean;
  target: Target | null;
  onSetTarget: (target: Target | null) => void;
  onStreamReady?: (stream: MediaStream | null) => void;
  onCameraError?: (message: string | null) => void;
  prediction: PredictionData | null;
  selectedTimelineIndex: number;
  showFuture: boolean;
  setShowFuture: (show: boolean) => void;
  captureRequest?: { id: number; imageCount: number; promptVariant?: string | null; promptParams?: Record<string, number | string> } | null;
  onCaptureRequestHandled?: (requestId: number) => void;
}

const CameraPreview: React.FC<CameraPreviewProps> = ({ 
  onCapture, 
  isProcessing, 
  target, 
  onSetTarget, 
  onStreamReady,
  onCameraError,
  prediction,
  selectedTimelineIndex,
  showFuture,
  setShowFuture,
  captureRequest = null,
  onCaptureRequestHandled
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastHandledCaptureRequestIdRef = useRef(0);
  const [isVideoReady, setIsVideoReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    let activeStream: MediaStream | null = null;
    setIsVideoReady(false);

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } } 
        });
        if (!mounted) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        activeStream = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        onStreamReady?.(stream);
        onCameraError?.(null);
      } catch (err) {
        console.error("Error accessing camera:", err);
        onStreamReady?.(null);
        onCameraError?.(err instanceof Error ? err.message : 'Unable to access the browser camera.');
      }
    };

    startCamera();

    return () => {
      mounted = false;
      setIsVideoReady(false);
      onStreamReady?.(null);

      const stream = activeStream || (videoRef.current?.srcObject as MediaStream | null);
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }

      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject = null;
      }
    };
  }, [onCameraError, onStreamReady]);

  const handleVideoClick = (e: React.MouseEvent | React.TouchEvent) => {
    if (isProcessing) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = (e as React.MouseEvent).clientX;
      clientY = (e as React.MouseEvent).clientY;
    }
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    onSetTarget({ x, y });
  };

  const captureFrame = useCallback((requestedImageCount?: number, promptOptions?: { variant?: string | null; params?: Record<string, number | string> }) => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
        return false;
      }

      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        onCapture(canvas.toDataURL('image/jpeg', 0.8), requestedImageCount, promptOptions);
        return true;
      }
    }
    return false;
  }, [onCapture]);

  useEffect(() => {
    const captureRequestId = captureRequest?.id || 0;
    if (!captureRequestId) {
      return;
    }

    if (captureRequestId === lastHandledCaptureRequestIdRef.current || isProcessing || !isVideoReady) {
      return;
    }

    if (captureFrame(captureRequest?.imageCount, {
      variant: captureRequest?.promptVariant ?? null,
      params: captureRequest?.promptParams
    })) {
      lastHandledCaptureRequestIdRef.current = captureRequestId;
      onCaptureRequestHandled?.(captureRequestId);
    }
  }, [captureFrame, captureRequest, isProcessing, isVideoReady, onCaptureRequestHandled]);

  const currentTimeline = prediction?.items[selectedTimelineIndex];

  return (
    <div 
      ref={containerRef}
      onClick={handleVideoClick}
      className={`relative w-full h-full max-h-[85vh] overflow-hidden rounded-xl md:rounded-2xl border-2 transition-all duration-700 ${
        target ? 'border-cyan-500/50 shadow-[0_0_50px_rgba(6,182,212,0.15)]' : 'border-white/10'
      } bg-black aspect-video cursor-crosshair group`}
    >
      {/* 1. Base Real-time Video */}
      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        muted 
        onLoadedData={() => setIsVideoReady(true)}
        onEmptied={() => setIsVideoReady(false)}
        className={`w-full h-full object-cover transition-all duration-1000 ease-in-out ${
          showFuture ? 'opacity-20 scale-105 blur-2xl grayscale brightness-150' : 'opacity-100 scale-100'
        }`}
      />

      {/* 2. Future Projection (The Flash) */}
      {prediction && currentTimeline && (
        <div className={`absolute inset-0 transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] ${
          showFuture ? 'opacity-100 scale-100 z-10' : 'opacity-0 scale-95 -z-10 pointer-events-none'
        }`}>
          <img 
            src={currentTimeline.predictedImage} 
            className="w-full h-full object-cover mix-blend-screen brightness-125"
            alt="Future Path"
          />
          {/* Glitch Overlay */}
          <div className="absolute inset-0 bg-fuchsia-500/10 mix-blend-color-dodge animate-pulse" />
          <div className="absolute inset-0 bg-gradient-to-tr from-fuchsia-900/20 to-transparent pointer-events-none" />
          
          <div className="absolute top-1/2 left-0 w-full h-[1px] bg-white/20 animate-bounce opacity-40" />
        </div>
      )}

      {/* 3. Clean Internal HUD */}
      <div className="absolute inset-0 pointer-events-none p-4 md:p-8 flex flex-col justify-between z-20">
        
        {/* Top Indicators */}
        <div className="flex justify-between items-start">
          <div className="space-y-1">
            <div className="flex items-center space-x-2 bg-black/40 px-3 py-1 rounded-sm border border-white/5 backdrop-blur-md">
              <div className="w-1.5 h-1.5 bg-red-600 rounded-full animate-pulse shadow-[0_0_5px_red]" />
              <span className="text-[9px] font-orbitron text-white tracking-[0.2em] uppercase">REC</span>
            </div>
          </div>
          
          <div className="text-right">
            <div className="inline-block bg-black/40 px-3 py-1 rounded-sm border border-white/5 backdrop-blur-md font-orbitron text-[9px] text-slate-300 tracking-[0.1em]">
              {showFuture ? 'MODE: FUTURE_PROJECTION' : 'MODE: REAL_TIME_SCAN'}
            </div>
          </div>
        </div>

        {/* Dynamic Markers (Targets) */}
        {target && (
          <div 
            className="absolute transition-all duration-700 ease-out" 
            style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%`, transform: 'translate(-50%, -50%)' }}
          >
            <div className="relative flex items-center justify-center">
              {/* Animated Rings */}
              <div className="w-24 h-24 border border-cyan-500/20 rounded-full animate-[ping_4s_infinite]" />
              <div className="absolute w-16 h-16 border-2 border-cyan-400/50 rounded-lg animate-[spin_12s_linear_infinite]" />
              <div className="absolute w-2 h-2 bg-cyan-400 rounded-full shadow-[0_0_15px_#22d3ee]" />
              
              {/* Aim Lines */}
              <div className="absolute h-[1px] w-40 bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />
              <div className="absolute w-[1px] h-40 bg-gradient-to-b from-transparent via-cyan-500/40 to-transparent" />
              
              {isProcessing && (
                <div className="absolute -bottom-12 w-48 text-center bg-cyan-500/10 backdrop-blur-md border border-cyan-500/20 py-1 rounded-sm">
                  <span className="text-[9px] font-orbitron text-cyan-400 animate-pulse tracking-widest">CALCULATING_VECTORS</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Bottom Corner Metrics */}
        <div className="flex justify-between items-end opacity-60">
           <div className="font-orbitron text-[8px] text-slate-500 tracking-[0.2em] space-y-1">
             <p>X_AXIS: {target ? (target.x * 100).toFixed(1) : '0.0'}</p>
             <p>Y_AXIS: {target ? (target.y * 100).toFixed(1) : '0.0'}</p>
           </div>
           <div className="font-orbitron text-[8px] text-slate-500 tracking-[0.2em]">
             BUFFER_SIZE: 1.4GB // {isProcessing ? 'PROCESSING' : 'READY'}
           </div>
        </div>
      </div>

      {/* 4. Functional Controls (Initiate Button) */}
      {!isProcessing && (
        <div className="absolute inset-x-0 bottom-10 flex justify-center pointer-events-none z-30">
          <button
            onClick={(e) => { e.stopPropagation(); captureFrame(); }}
            className="pointer-events-auto px-12 py-4 bg-white hover:bg-cyan-50 text-slate-950 font-orbitron font-bold rounded-sm transition-all transform hover:scale-105 active:scale-95 shadow-[0_15px_40px_rgba(0,0,0,0.5)] flex items-center space-x-3 group/btn"
          >
            <div className="w-2 h-2 bg-red-600 rounded-full animate-pulse group-hover/btn:scale-125 transition-transform" />
            <span className="tracking-[0.1em] text-sm uppercase">Initiate_Scan</span>
          </button>
        </div>
      )}

      {/* Loading Progress Bar */}
      {isProcessing && (
        <div className="absolute top-0 left-0 w-full h-1 bg-white/5 z-50 overflow-hidden">
          <div className="h-full bg-cyan-400 animate-[loading_1.5s_infinite]" style={{ width: '30%' }} />
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />
      <style>{`
        @keyframes loading { 
          0% { transform: translateX(-100%); } 
          100% { transform: translateX(333%); } 
        }
      `}</style>
    </div>
  );
};

export default CameraPreview;
