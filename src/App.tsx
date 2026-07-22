import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  CloudUpload, Video, Server, Monitor, Play, Pause, Download, Search,
  Film, ScanLine, Activity, X, AlertCircle, CheckCircle2, Layers,
  Sliders, RotateCcw, RefreshCw, ChevronDown, ChevronUp, Repeat
} from 'lucide-react';
import { processVideoFile, processVideoOnServer } from './VideoProcessor';
import { clearVideoFingerprints } from './utils/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MatchedSegment {
  shortStart: number;
  shortEnd: number;
  movieStart: number;
  movieEnd: number;
  confidence: number;
  frameCount: number;
  isApproximate: boolean;
  gapCount?: number;
  matchSequence: Array<{ shortTime: number; movieTime: number; similarity: number }>;
}

interface UnmatchedRange {
  shortStart: number;
  shortEnd: number;
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function fmt(secs: number) {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

function fmtDur(secs: number) {
  if (secs < 60) return `${secs.toFixed(2)}s`;
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1);
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfidenceBadge({ confidence, isApproximate }: { confidence: number; isApproximate: boolean }) {
  if (!isApproximate && confidence >= 80) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-xs font-semibold bg-green-500/10 text-green-400 border border-green-500/25">
        <CheckCircle2 className="w-3 h-3" /> {confidence.toFixed(1)}%
      </span>
    );
  }
  if (!isApproximate && confidence >= 60) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-xs font-semibold bg-yellow-500/10 text-yellow-400 border border-yellow-500/25">
        <AlertCircle className="w-3 h-3" /> {confidence.toFixed(1)}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-xs font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/25">
      <AlertCircle className="w-3 h-3" /> {confidence.toFixed(1)}%{isApproximate ? ' ~' : ''}
    </span>
  );
}

function SliderParam({
  label, hint, value, min, max, step, display, onChange, disabled
}: {
  label: string; hint: string; value: number; min: number; max: number;
  step: number; display: string; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs font-mono">
        <span className="text-slate-400">{label}</span>
        <span className="text-white font-bold">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className="w-full h-1.5 rounded appearance-none cursor-pointer accent-blue-500 bg-slate-700 disabled:opacity-40"
      />
      <p className="text-[10px] text-slate-600 leading-tight">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [processMode, setProcessMode] = useState<'browser' | 'server'>('server');

  // Reference video state
  const [refFile, setRefFile]       = useState<File | null>(null);
  const [refFileUrl, setRefFileUrl] = useState<string>('');
  const [refJobId, setRefJobId]     = useState<string>('');
  const [refProgress, setRefProgress] = useState({ processed: 0, total: 0, startTime: 0 });
  const [refDone, setRefDone]       = useState(false);
  const [refBatches, setRefBatches] = useState(0);

  // Target clip state
  const [targetFile, setTargetFile]       = useState<File | null>(null);
  const [targetFileUrl, setTargetFileUrl] = useState<string>('');
  const [targetJobId, setTargetJobId]     = useState<string>('');
  const [targetProgress, setTargetProgress] = useState({ processed: 0, total: 0, startTime: 0 });
  const [targetDone, setTargetDone]       = useState(false);

  // Match params (sent to server)
  const [similarityThreshold, setSimilarityThreshold] = useState(82);
  const [minSegmentDuration, setMinSegmentDuration]   = useState(0.5);   // seconds → converted to frames
  const [showSettings, setShowSettings]               = useState(false);

  // Match results
  const [segments, setSegments]           = useState<MatchedSegment[]>([]);
  const [unmatchedRanges, setUnmatched]   = useState<UnmatchedRange[]>([]);
  const [isMatching, setIsMatching]       = useState(false);
  const [matchStats, setMatchStats]       = useState<{ movieFrames: number; shortFrames: number } | null>(null);

  // Status / error
  const [status, setStatus]     = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  // Processing in-flight
  const [isProcessingRef, setIsProcessingRef]       = useState(false);
  const [isProcessingTarget, setIsProcessingTarget] = useState(false);

  // Preview panel
  const [previewSegment, setPreviewSegment] = useState<MatchedSegment | null>(null);
  const [isPlaying, setIsPlaying]           = useState(false);
  const [loopSegment, setLoopSegment]       = useState(true);
  const [playbackSpeed, setPlaybackSpeed]   = useState(1.0);

  const refVideoRef  = useRef<HTMLVideoElement>(null);
  const clipVideoRef = useRef<HTMLVideoElement>(null);
  const loopRef      = useRef({ loop: true, seg: null as MatchedSegment | null });

  // Keep loopRef in sync so the timeupdate handler always sees current values
  useEffect(() => {
    loopRef.current = { loop: loopSegment, seg: previewSegment };
  }, [loopSegment, previewSegment]);

  // Apply playback speed whenever it changes
  useEffect(() => {
    if (refVideoRef.current)  refVideoRef.current.playbackRate  = playbackSpeed;
    if (clipVideoRef.current) clipVideoRef.current.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      if (refFileUrl)    URL.revokeObjectURL(refFileUrl);
      if (targetFileUrl) URL.revokeObjectURL(targetFileUrl);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Loop / segment-end detection
  // ---------------------------------------------------------------------------
  const handleRefTimeUpdate = useCallback(() => {
    const { loop, seg } = loopRef.current;
    if (!seg || !refVideoRef.current) return;
    if (refVideoRef.current.currentTime >= seg.movieEnd - 0.08) {
      // Segment ended — loop or pause
      if (loop) {
        refVideoRef.current.currentTime  = seg.movieStart;
        if (clipVideoRef.current) clipVideoRef.current.currentTime = seg.shortStart;
      } else {
        refVideoRef.current.pause();
        clipVideoRef.current?.pause();
        setIsPlaying(false);
      }
    }
  }, []);

  // ---------------------------------------------------------------------------
  // File handlers
  // ---------------------------------------------------------------------------
  const handleRefFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setRefFile(file);
    setRefDone(false);
    setRefJobId('');
    setSegments([]);
    setMatchStats(null);
    setPreviewSegment(null);
    if (refFileUrl) URL.revokeObjectURL(refFileUrl);
    setRefFileUrl(file ? URL.createObjectURL(file) : '');
  };

  const handleTargetFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setTargetFile(file);
    setTargetDone(false);
    setTargetJobId('');
    setSegments([]);
    setMatchStats(null);
    setPreviewSegment(null);
    if (targetFileUrl) URL.revokeObjectURL(targetFileUrl);
    setTargetFileUrl(file ? URL.createObjectURL(file) : '');
  };

  // ---------------------------------------------------------------------------
  // Process reference
  // ---------------------------------------------------------------------------
  const handleProcessReference = async () => {
    if (!refFile) return;
    setIsProcessingRef(true);
    setRefDone(false);
    setRefJobId('');
    setErrorMsg('');
    setStatus(`Processing reference video${processMode === 'server' ? ' on server' : ' in browser'}…`);

    try {
      await clearVideoFingerprints('reference');
      const startTime = performance.now();
      const run = processMode === 'server' ? processVideoOnServer : processVideoFile;

      const { totalFrames, batches, jobId } = await run(refFile, 'reference', (p, t) => {
        setRefProgress({ processed: p, total: t, startTime });
      });

      setRefBatches(batches);
      setRefJobId(jobId || '');
      setRefDone(true);
      setStatus(`Reference processed: ${totalFrames} frames.`);
    } catch (e: any) {
      setErrorMsg(`Reference error: ${e.message}`);
      setStatus('');
    } finally {
      setIsProcessingRef(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Process target + match
  // ---------------------------------------------------------------------------
  const handleRunAnalysis = async () => {
    if (!targetFile) return;
    setIsProcessingTarget(true);
    setIsMatching(false);
    setSegments([]);
    setUnmatched([]);
    setMatchStats(null);
    setPreviewSegment(null);
    setErrorMsg('');
    setStatus(`Processing target clip${processMode === 'server' ? ' on server' : ' in browser'}…`);

    try {
      await clearVideoFingerprints('target');
      const startTime = performance.now();
      const run = processMode === 'server' ? processVideoOnServer : processVideoFile;

      const { totalFrames, batches, jobId } = await run(targetFile, 'target', (p, t) => {
        setTargetProgress({ processed: p, total: t, startTime });
      });

      setTargetJobId(jobId || '');
      setTargetDone(true);
      setIsProcessingTarget(false);

      if (processMode === 'server') {
        if (!refJobId) {
          setErrorMsg('Reference job ID not found — please re-process the reference video first.');
          return;
        }
        if (!jobId) {
          setErrorMsg('Target job ID missing — re-process the target clip.');
          return;
        }
        setIsMatching(true);
        setStatus(`Fingerprints extracted (${totalFrames} frames). Running segment matching…`);

        // Convert minSegmentDuration (seconds) to min consecutive frames @ 25fps
        const minConsecutiveFrames = Math.max(5, Math.round(minSegmentDuration * 25));

        const matchRes = await fetch('/api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            movieJobId: refJobId,
            shortJobId: jobId,
            minSimilarity: similarityThreshold,
            minConsecutiveFrames
          })
        });

        if (!matchRes.ok) {
          const errData = await matchRes.json().catch(() => ({}));
          throw new Error(errData.error || `Match API returned ${matchRes.status}`);
        }

        const data = await matchRes.json();
        setSegments(data.segments || []);
        setUnmatched(data.unmatchedRanges || []);
        setMatchStats({ movieFrames: data.movieFrames, shortFrames: data.shortFrames });
        setIsMatching(false);
        const segs = data.segments || [];
        const unmatched = data.unmatchedRanges || [];
        setStatus(`Matching complete. ${segs.length} segment(s) found${unmatched.length > 0 ? `, ${unmatched.length} unmatched range(s)` : ' — full clip covered'}.`);
      } else {
        setIsMatching(true);
        setStatus('Running browser-side matching…');

        const { loadAllReferenceFingerprints, compareFingerprints } = await import('./Matcher');
        const refFps    = await loadAllReferenceFingerprints('reference', refBatches);
        const targetFps = await loadAllReferenceFingerprints('target', batches);

        let bestSim = 0, bestMi = 0;
        for (let mi = 0; mi < refFps.length; mi += 5) {
          const sim = compareFingerprints(targetFps[0], refFps[mi]);
          if (sim > bestSim) { bestSim = sim; bestMi = mi; }
        }

        setSegments([{
          shortStart: targetFps[0]?.timestamp ?? 0,
          shortEnd:   targetFps[targetFps.length - 1]?.timestamp ?? 0,
          movieStart: refFps[bestMi]?.timestamp ?? 0,
          movieEnd:   refFps[Math.min(refFps.length - 1, bestMi + targetFps.length)]?.timestamp ?? 0,
          confidence: bestSim, frameCount: targetFps.length,
          isApproximate: true, matchSequence: []
        }]);
        setIsMatching(false);
        setStatus('Browser matching complete.');
      }
    } catch (e: any) {
      setErrorMsg(`Error: ${e.message}`);
      setStatus('');
      setIsProcessingTarget(false);
      setIsMatching(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Preview: seek + auto-play
  // ---------------------------------------------------------------------------
  const handlePreviewSegment = (seg: MatchedSegment) => {
    setPreviewSegment(seg);
    setIsPlaying(false);
    setTimeout(() => {
      if (refVideoRef.current) {
        refVideoRef.current.currentTime  = seg.movieStart;
        refVideoRef.current.playbackRate = playbackSpeed;
      }
      if (clipVideoRef.current) {
        clipVideoRef.current.currentTime  = seg.shortStart;
        clipVideoRef.current.playbackRate = playbackSpeed;
      }
      // Auto-play after seeking
      setTimeout(() => {
        refVideoRef.current?.play();
        clipVideoRef.current?.play();
        setIsPlaying(true);
      }, 200);
    }, 100);
  };

  const handleSyncPlay = () => {
    if (!refVideoRef.current || !clipVideoRef.current) return;
    if (isPlaying) {
      refVideoRef.current.pause();
      clipVideoRef.current.pause();
      setIsPlaying(false);
    } else {
      refVideoRef.current.playbackRate  = playbackSpeed;
      clipVideoRef.current.playbackRate = playbackSpeed;
      refVideoRef.current.play();
      clipVideoRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleRestartPreview = () => {
    if (!previewSegment) return;
    if (refVideoRef.current)  refVideoRef.current.currentTime  = previewSegment.movieStart;
    if (clipVideoRef.current) clipVideoRef.current.currentTime = previewSegment.shortStart;
    refVideoRef.current?.play();
    clipVideoRef.current?.play();
    setIsPlaying(true);
  };

  // ---------------------------------------------------------------------------
  // Download JSON
  // ---------------------------------------------------------------------------
  const handleDownloadJson = () => {
    const payload = { segments, matchStats, params: { similarityThreshold, minSegmentDuration } };
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = 'match_results.json';
    a.click();
  };

  // ---------------------------------------------------------------------------
  // Progress renderer
  // ---------------------------------------------------------------------------
  const renderProgress = (prog: typeof refProgress, accent: string) => {
    if (prog.total === 0 && prog.processed === 0) return null;
    const elapsed   = (performance.now() - prog.startTime) / 1000;
    const fps       = prog.processed / (elapsed || 1);
    const remaining = prog.total - prog.processed;
    const eta       = fps > 0 ? remaining / fps : 0;
    const etaStr    = isFinite(eta) ? `${Math.floor(eta / 60)}m ${Math.round(eta % 60)}s` : '…';
    const pct       = prog.total > 0 ? Math.min(100, Math.round((prog.processed / prog.total) * 100)) : 0;
    return (
      <div className="mt-3 space-y-1.5">
        <div className="flex justify-between text-xs font-mono text-slate-400">
          <span>{prog.processed.toLocaleString()} / {prog.total ? prog.total.toLocaleString() : '?'} frames</span>
          <span>{fps.toFixed(1)} fps · ETA {etaStr}</span>
        </div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div className={`h-full transition-all duration-300 ${accent}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const canRunAnalysis = !!targetFile && refDone && !isProcessingRef && !isProcessingTarget && !isMatching;
  const busy = isProcessingRef || isProcessingTarget || isMatching;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#0d1117] text-slate-300 font-sans">
      <div className="max-w-5xl mx-auto p-6 md:p-10 space-y-5">

        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-6">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
              <ScanLine className="w-7 h-7 text-blue-500" />
              Nexus Video Match
            </h1>
            <p className="text-slate-500 text-sm mt-1">Sequence-alignment video fingerprint matching</p>
          </div>
          <div className="flex items-center bg-slate-900 p-1 rounded-lg border border-slate-800">
            <button onClick={() => setProcessMode('browser')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${processMode === 'browser' ? 'bg-slate-700 text-white shadow ring-1 ring-slate-600' : 'text-slate-400 hover:text-white'}`}>
              <Monitor className="w-3.5 h-3.5" /> Browser
            </button>
            <button onClick={() => setProcessMode('server')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${processMode === 'server' ? 'bg-blue-600 text-white shadow ring-1 ring-blue-500' : 'text-slate-400 hover:text-white'}`}>
              <Server className="w-3.5 h-3.5" /> Server
            </button>
          </div>
        </div>

        {/* ── Error banner ── */}
        {errorMsg && (
          <div className="flex items-start gap-3 bg-red-950/40 border border-red-800/50 rounded-xl p-4 text-red-300 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg('')} className="ml-auto shrink-0 text-red-500 hover:text-red-300 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* ── Step 1: Reference ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="bg-blue-500/10 p-2 rounded-lg border border-blue-500/20">
              <Film className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Step 1 — Reference Movie</h2>
              <p className="text-xs text-slate-500">The full-length video to search within</p>
            </div>
            {refDone && (
              <span className="ml-auto flex items-center gap-1 text-xs text-green-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Ready
              </span>
            )}
          </div>

          <div className="relative group">
            <input type="file" accept="video/mp4" onChange={handleRefFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
            <div className={`flex items-center gap-3 p-4 border-2 border-dashed rounded-xl transition-colors ${refFile ? 'border-blue-500/40 bg-blue-500/5' : 'border-slate-700 bg-slate-800/40 group-hover:border-slate-600'}`}>
              <CloudUpload className={`w-5 h-5 shrink-0 ${refFile ? 'text-blue-400' : 'text-slate-500'}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-300 truncate">{refFile ? refFile.name : 'Drop reference video here or click to browse'}</p>
                {refFile && <p className="text-xs text-slate-500">{(refFile.size / 1024 / 1024).toFixed(1)} MB</p>}
              </div>
            </div>
          </div>

          <button onClick={handleProcessReference} disabled={!refFile || isProcessingRef}
            className="w-full flex justify-center items-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors cursor-pointer">
            {isProcessingRef ? <><RefreshCw className="w-4 h-4 animate-spin" /> Processing…</> : <><Activity className="w-4 h-4" /> Extract Fingerprints</>}
          </button>
          {renderProgress(refProgress, 'bg-blue-500')}
        </section>

        {/* ── Settings Panel ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowSettings(s => !s)}
            className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <div className="bg-purple-500/10 p-2 rounded-lg border border-purple-500/20">
                <Sliders className="w-4 h-4 text-purple-400" />
              </div>
              <div className="text-left">
                <h2 className="text-base font-semibold text-white">Match Parameters</h2>
                <p className="text-xs text-slate-500">
                  Confidence ≥{similarityThreshold}% · Min duration {minSegmentDuration.toFixed(1)}s
                </p>
              </div>
            </div>
            {showSettings ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </button>

          {showSettings && (
            <div className="px-6 pb-6 pt-2 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-6">
              <SliderParam
                label="Confidence Threshold"
                hint="Minimum similarity % for a frame to count as a match. Lower = catch more (but more false positives). Default: 82%."
                value={similarityThreshold}
                min={60} max={95} step={1}
                display={`≥ ${similarityThreshold}%`}
                onChange={setSimilarityThreshold}
                disabled={busy}
              />
              <SliderParam
                label="Min Segment Duration"
                hint="Shortest accepted match sequence. Raises this to filter out brief single-scene blips. Default: 0.5s."
                value={minSegmentDuration}
                min={0.2} max={5.0} step={0.1}
                display={`${minSegmentDuration.toFixed(1)}s`}
                onChange={setMinSegmentDuration}
                disabled={busy}
              />
            </div>
          )}
        </section>

        {/* ── Step 2: Target + Match ── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/10 p-2 rounded-lg border border-indigo-500/20">
              <Search className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Step 2 — Target Clip &amp; Find Matches</h2>
              <p className="text-xs text-slate-500">Upload the clip to locate inside the reference</p>
            </div>
            {targetDone && (
              <span className="ml-auto flex items-center gap-1 text-xs text-green-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Processed
              </span>
            )}
          </div>

          <div className="relative group">
            <input type="file" accept="video/mp4" onChange={handleTargetFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
            <div className={`flex items-center gap-3 p-4 border-2 border-dashed rounded-xl transition-colors ${targetFile ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-slate-700 bg-slate-800/40 group-hover:border-slate-600'}`}>
              <CloudUpload className={`w-5 h-5 shrink-0 ${targetFile ? 'text-indigo-400' : 'text-slate-500'}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-300 truncate">{targetFile ? targetFile.name : 'Drop target clip here or click to browse'}</p>
                {targetFile && <p className="text-xs text-slate-500">{(targetFile.size / 1024 / 1024).toFixed(1)} MB</p>}
              </div>
            </div>
          </div>

          {!refDone && targetFile && (
            <p className="text-xs text-amber-400/80 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> Process the reference video first (Step 1).
            </p>
          )}

          <button onClick={handleRunAnalysis} disabled={!canRunAnalysis}
            className="w-full flex justify-center items-center gap-2 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors cursor-pointer">
            <ScanLine className="w-4 h-4" />
            {isProcessingTarget ? 'Extracting fingerprints…' : isMatching ? 'Running matching algorithm…' : 'Process & Find Matches'}
          </button>
          {renderProgress(targetProgress, 'bg-indigo-500')}
        </section>

        {/* ── Status bar ── */}
        {(status || isMatching) && (
          <div className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 text-sm text-slate-300">
            <div className={`w-2 h-2 rounded-full shrink-0 ${busy ? 'bg-blue-500 animate-pulse' : 'bg-green-500'}`} />
            {status}
          </div>
        )}

        {/* ── Results table ── */}
        {segments.length > 0 && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div className="flex items-center gap-3">
                <div className="bg-green-500/10 p-2 rounded-lg border border-green-500/20">
                  <Layers className="w-4 h-4 text-green-400" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">
                    {segments.length} Matched Segment{segments.length !== 1 ? 's' : ''}
                  </h2>
                  {matchStats && (
                    <p className="text-xs text-slate-500">
                      {matchStats.shortFrames} clip frames · {matchStats.movieFrames} reference frames ·
                      threshold {similarityThreshold}% · min {minSegmentDuration.toFixed(1)}s
                    </p>
                  )}
                </div>
              </div>
              <button onClick={handleDownloadJson}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer">
                <Download className="w-3.5 h-3.5" /> Export JSON
              </button>
            </div>

            {/* ── Clip coverage timeline ── */}
            {matchStats && matchStats.shortFrames > 0 && (() => {
              const clipDur = segments.length > 0
                ? Math.max(...segments.map(s => s.shortEnd), ...unmatchedRanges.map(u => u.shortEnd))
                : 0;
              if (clipDur <= 0) return null;
              return (
                <div className="px-5 py-4 border-b border-slate-800 space-y-2">
                  <div className="flex justify-between text-xs text-slate-500 font-mono">
                    <span>Clip coverage</span>
                    <span>
                      {unmatchedRanges.length === 0
                        ? '✓ Full clip matched'
                        : `${unmatchedRanges.length} unmatched range${unmatchedRanges.length !== 1 ? 's' : ''}`}
                    </span>
                  </div>
                  {/* Stacked bar: green=matched, orange=unmatched */}
                  <div className="relative h-6 rounded overflow-hidden bg-slate-800 flex">
                    {(() => {
                      // Build a sorted list of intervals with type
                      type Bar = { start: number; end: number; kind: 'match' | 'gap'; conf: number; idx: number };
                      const bars: Bar[] = [];
                      segments.forEach((s, i) => bars.push({ start: s.shortStart, end: s.shortEnd, kind: 'match', conf: s.confidence, idx: i }));
                      unmatchedRanges.forEach((u, i) => bars.push({ start: u.shortStart, end: u.shortEnd, kind: 'gap', conf: 0, idx: i }));
                      bars.sort((a, b) => a.start - b.start);
                      return bars.map((bar, i) => {
                        const left  = (bar.start / clipDur) * 100;
                        const width = Math.max(0.3, ((bar.end - bar.start) / clipDur) * 100);
                        const conf  = bar.conf;
                        const bg    = bar.kind === 'gap'
                          ? 'bg-orange-700/60'
                          : conf >= 80 ? 'bg-green-500' : conf >= 60 ? 'bg-yellow-500' : 'bg-blue-400';
                        const label = bar.kind === 'match'
                          ? `Seg ${bar.idx + 1}: ${fmt(bar.start)}–${fmt(bar.end)} (${conf.toFixed(0)}%)`
                          : `Unmatched: ${fmt(bar.start)}–${fmt(bar.end)}`;
                        return (
                          <div key={i} title={label}
                            className={`absolute top-0 h-full ${bg} transition-all`}
                            style={{ left: `${left}%`, width: `${width}%` }} />
                        );
                      });
                    })()}
                  </div>
                  <div className="flex items-center gap-4 text-[10px] text-slate-600">
                    <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-500" /> High confidence match</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-500" /> Medium confidence</span>
                    <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-700/60" /> No match found</span>
                  </div>
                </div>
              );
            })()}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-950 text-slate-500 text-xs font-medium uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3 text-left">#</th>
                    <th className="px-4 py-3 text-left">Clip Time</th>
                    <th className="px-4 py-3 text-left">Movie Time</th>
                    <th className="px-4 py-3 text-left">Duration</th>
                    <th className="px-4 py-3 text-left">Frames</th>
                    <th className="px-4 py-3 text-left">Confidence</th>
                    <th className="px-4 py-3 text-right">Compare</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {segments.map((seg, i) => {
                    const clipDur  = seg.shortEnd - seg.shortStart;
                    const movieDur = seg.movieEnd - seg.movieStart;
                    const isActive = previewSegment === seg;
                    return (
                      <tr key={i}
                        className={`transition-colors hover:bg-slate-800/40 ${isActive ? 'bg-indigo-900/20 ring-1 ring-inset ring-indigo-500/30' : ''}`}>
                        <td className="px-4 py-3 font-mono text-slate-500 text-xs">{i + 1}</td>

                        {/* Clip time */}
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs">
                            <span className="text-white">{fmt(seg.shortStart)}</span>
                            <span className="text-slate-600 mx-1">→</span>
                            <span className="text-slate-400">{fmt(seg.shortEnd)}</span>
                          </div>
                        </td>

                        {/* Movie time */}
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs">
                            <span className="text-white">{fmt(seg.movieStart)}</span>
                            <span className="text-slate-600 mx-1">→</span>
                            <span className="text-slate-400">{fmt(seg.movieEnd)}</span>
                          </div>
                        </td>

                        {/* Duration */}
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs text-slate-400">
                            <div>{fmtDur(clipDur)} clip</div>
                            <div className="text-slate-600">{fmtDur(movieDur)} movie</div>
                          </div>
                        </td>

                        {/* Frame count */}
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">
                          {seg.frameCount}
                          {seg.gapCount != null && seg.gapCount > 0 && (
                            <span className="ml-1 text-amber-500/70" title={`${seg.gapCount} low-confidence frame(s) skipped within segment`}>
                              +{seg.gapCount}↗
                            </span>
                          )}
                        </td>

                        {/* Confidence */}
                        <td className="px-4 py-3">
                          <ConfidenceBadge confidence={seg.confidence} isApproximate={seg.isApproximate} />
                        </td>

                        {/* Compare button */}
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => handlePreviewSegment(seg)}
                            className={`inline-flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs font-medium transition cursor-pointer ${isActive ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300' : 'bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/20 text-blue-400'}`}>
                            <Play className="w-3 h-3" /> Compare
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* No results message */}
        {segments.length === 0 && !isMatching && matchStats && (
          <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-5 text-slate-400 text-sm">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            No matching segments found. Try lowering the confidence threshold or min duration in Match Parameters, or ensure the clip actually appears in the reference.
          </div>
        )}

        {/* ── Side-by-side Preview Panel ── */}
        {previewSegment && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">

            {/* Panel header */}
            <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="bg-blue-500/10 p-1.5 rounded-lg border border-blue-500/20">
                  <Video className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    Side-by-Side Comparison
                    <ConfidenceBadge confidence={previewSegment.confidence} isApproximate={previewSegment.isApproximate} />
                  </h3>
                  <p className="text-xs text-slate-500 font-mono">
                    Clip {fmt(previewSegment.shortStart)}–{fmt(previewSegment.shortEnd)} ({fmtDur(previewSegment.shortEnd - previewSegment.shortStart)}) ·
                    Movie {fmt(previewSegment.movieStart)}–{fmt(previewSegment.movieEnd)} ·
                    {previewSegment.frameCount} frames
                  </p>
                </div>
              </div>
              <button onClick={() => { setPreviewSegment(null); setIsPlaying(false); refVideoRef.current?.pause(); clipVideoRef.current?.pause(); }}
                className="p-1.5 text-slate-500 hover:text-slate-300 rounded-lg hover:bg-slate-800 transition cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Playback controls bar */}
            <div className="px-4 py-3 border-b border-slate-800 bg-slate-950/50 flex flex-wrap items-center gap-3">

              {/* Play / Pause */}
              <button onClick={handleSyncPlay}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${isPlaying ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30' : 'bg-green-600 border border-green-500 text-white hover:bg-green-500'}`}>
                {isPlaying ? <><Pause className="w-3.5 h-3.5" /> Pause Both</> : <><Play className="w-3.5 h-3.5" /> Play Both</>}
              </button>

              {/* Restart */}
              <button onClick={handleRestartPreview}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition cursor-pointer">
                <RotateCcw className="w-3.5 h-3.5" /> Restart
              </button>

              {/* Separator */}
              <div className="w-px h-6 bg-slate-700" />

              {/* Loop toggle */}
              <button onClick={() => setLoopSegment(l => !l)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition cursor-pointer ${loopSegment ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-300'}`}>
                <Repeat className="w-3.5 h-3.5" />
                {loopSegment ? 'Loop: ON' : 'Loop: OFF'}
              </button>

              {/* Separator */}
              <div className="w-px h-6 bg-slate-700" />

              {/* Speed controls */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 font-mono">Speed:</span>
                {[0.25, 0.5, 1.0].map(sp => (
                  <button key={sp} onClick={() => setPlaybackSpeed(sp)}
                    className={`px-2.5 py-1.5 rounded-md text-xs font-mono font-semibold border transition cursor-pointer ${playbackSpeed === sp ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700'}`}>
                    {sp === 1 ? '1×' : `${sp}×`}
                  </button>
                ))}
              </div>
            </div>

            {/* Segment info row */}
            <div className="px-4 py-2.5 bg-slate-950/30 border-b border-slate-800 grid grid-cols-3 gap-4 text-xs font-mono">
              <div>
                <span className="text-slate-600 block">Clip duration</span>
                <span className="text-slate-300">{fmtDur(previewSegment.shortEnd - previewSegment.shortStart)}</span>
              </div>
              <div>
                <span className="text-slate-600 block">Movie duration</span>
                <span className="text-slate-300">{fmtDur(previewSegment.movieEnd - previewSegment.movieStart)}</span>
              </div>
              <div>
                <span className="text-slate-600 block">Speed ratio</span>
                <span className="text-slate-300">
                  {((previewSegment.movieEnd - previewSegment.movieStart) /
                    Math.max(0.001, previewSegment.shortEnd - previewSegment.shortStart)).toFixed(3)}×
                </span>
              </div>
            </div>

            {/* Dual video panes */}
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-800">

              {/* Reference movie */}
              <div className="p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5 text-blue-400" /> Reference Movie
                  <span className="font-normal font-mono text-slate-600 normal-case ml-1">@ {fmt(previewSegment.movieStart)}</span>
                </p>
                <div className="bg-black rounded-xl overflow-hidden border border-slate-800 relative">
                  {refFileUrl ? (
                    <video ref={refVideoRef} src={refFileUrl} controls
                      className="w-full max-h-72 object-contain"
                      onTimeUpdate={handleRefTimeUpdate}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-40 text-slate-600 text-sm">
                      Reference video not available for preview
                    </div>
                  )}
                </div>
              </div>

              {/* Target clip */}
              <div className="p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Search className="w-3.5 h-3.5 text-indigo-400" /> Target Clip
                  <span className="font-normal font-mono text-slate-600 normal-case ml-1">@ {fmt(previewSegment.shortStart)}</span>
                </p>
                <div className="bg-black rounded-xl overflow-hidden border border-slate-800">
                  {targetFileUrl ? (
                    <video ref={clipVideoRef} src={targetFileUrl} controls
                      className="w-full max-h-72 object-contain"
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-40 text-slate-600 text-sm">
                      Target clip not available for preview
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Match quality timeline */}
            {previewSegment.matchSequence.length > 0 && (
              <div className="p-4 border-t border-slate-800">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-slate-500">Match quality timeline — {previewSegment.matchSequence.length} frames</p>
                  <p className="text-xs font-mono text-slate-500">
                    avg {(previewSegment.matchSequence.reduce((a, f) => a + f.similarity, 0) / previewSegment.matchSequence.length).toFixed(1)}%
                  </p>
                </div>
                <div className="flex gap-px h-8 rounded overflow-hidden">
                  {previewSegment.matchSequence.map((item, i) => {
                    const pct = item.similarity;
                    const bg  = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500';
                    return (
                      <div key={i} className={`flex-1 ${bg}`} style={{ opacity: 0.4 + (pct / 100) * 0.6 }}
                        title={`Frame ${i + 1}: ${item.similarity.toFixed(1)}% @ clip ${fmt(item.shortTime)} → movie ${fmt(item.movieTime)}`} />
                    );
                  })}
                </div>
                <div className="flex justify-between text-xs text-slate-700 mt-1 font-mono">
                  <span>{fmt(previewSegment.shortStart)}</span>
                  <span className="text-slate-600">clip timeline</span>
                  <span>{fmt(previewSegment.shortEnd)}</span>
                </div>
              </div>
            )}
          </section>
        )}

      </div>
    </div>
  );
}
