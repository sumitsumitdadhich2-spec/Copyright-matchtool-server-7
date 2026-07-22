import React, { useState, useRef, useEffect } from 'react';
import {
  CloudUpload, Video, Server, Monitor, Play, Pause, Download, Search,
  Film, CircleCheck, ScanLine, Activity, ChevronRight, X, AlertCircle,
  CheckCircle2, Clock, Layers
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
  matchSequence: Array<{ shortTime: number; movieTime: number; similarity: number }>;
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function ConfidenceBadge({ confidence, isApproximate }: { confidence: number; isApproximate: boolean }) {
  const isHigh = !isApproximate && confidence >= 80;
  const isMed  = !isApproximate && confidence >= 60 && confidence < 80;

  if (isHigh) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-mono text-xs font-semibold bg-green-500/10 text-green-400 border border-green-500/25">
        <CheckCircle2 className="w-3 h-3" />
        {confidence.toFixed(1)}%
      </span>
    );
  }
  if (isMed) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-mono text-xs font-semibold bg-yellow-500/10 text-yellow-400 border border-yellow-500/25">
        <AlertCircle className="w-3 h-3" />
        {confidence.toFixed(1)}%
      </span>
    );
  }
  // Approximate or low confidence
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-mono text-xs font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/25">
      <AlertCircle className="w-3 h-3" />
      {confidence.toFixed(1)}% {isApproximate ? '~' : ''}
    </span>
  );
}

function fmt(secs: number) {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [processMode, setProcessMode] = useState<'browser' | 'server'>('server');

  // Reference video state
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refFileUrl, setRefFileUrl] = useState<string>('');
  const [refJobId, setRefJobId] = useState<string>('');
  const [refProgress, setRefProgress] = useState({ processed: 0, total: 0, startTime: 0 });
  const [refDone, setRefDone] = useState(false);
  const [refBatches, setRefBatches] = useState(0);

  // Target clip state
  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [targetFileUrl, setTargetFileUrl] = useState<string>('');
  const [targetJobId, setTargetJobId] = useState<string>('');
  const [targetProgress, setTargetProgress] = useState({ processed: 0, total: 0, startTime: 0 });
  const [targetDone, setTargetDone] = useState(false);

  // Match state
  const [segments, setSegments] = useState<MatchedSegment[]>([]);
  const [isMatching, setIsMatching] = useState(false);
  const [matchStats, setMatchStats] = useState<{ movieFrames: number; shortFrames: number } | null>(null);

  // Status / error
  const [status, setStatus] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  // Processing in-flight
  const [isProcessingRef, setIsProcessingRef] = useState(false);
  const [isProcessingTarget, setIsProcessingTarget] = useState(false);

  // Preview panel
  const [previewSegment, setPreviewSegment] = useState<MatchedSegment | null>(null);
  const refVideoRef   = useRef<HTMLVideoElement>(null);
  const clipVideoRef  = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      if (refFileUrl) URL.revokeObjectURL(refFileUrl);
      if (targetFileUrl) URL.revokeObjectURL(targetFileUrl);
    };
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
    if (refFileUrl) URL.revokeObjectURL(refFileUrl);
    if (file) setRefFileUrl(URL.createObjectURL(file));
    else setRefFileUrl('');
  };

  const handleTargetFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setTargetFile(file);
    setTargetDone(false);
    setTargetJobId('');
    setSegments([]);
    setMatchStats(null);
    if (targetFileUrl) URL.revokeObjectURL(targetFileUrl);
    if (file) setTargetFileUrl(URL.createObjectURL(file));
    else setTargetFileUrl('');
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
  // Process target + match (server mode) or just match (browser mode)
  // ---------------------------------------------------------------------------

  const handleRunAnalysis = async () => {
    if (!targetFile) return;
    setIsProcessingTarget(true);
    setIsMatching(false);
    setSegments([]);
    setMatchStats(null);
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

      // ---- Server mode: use /api/match ----
      if (processMode === 'server') {
        if (!refJobId) {
          setErrorMsg('Reference job ID not found — please re-process the reference video in server mode.');
          return;
        }
        if (!jobId) {
          setErrorMsg('Target job ID missing — re-process the target clip.');
          return;
        }
        setIsMatching(true);
        setStatus(`Fingerprints extracted (${totalFrames} frames). Running segment matching…`);

        const matchRes = await fetch('/api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ movieJobId: refJobId, shortJobId: jobId })
        });

        if (!matchRes.ok) {
          const errData = await matchRes.json().catch(() => ({}));
          throw new Error(errData.error || `Match API returned ${matchRes.status}`);
        }

        const data = await matchRes.json();
        setSegments(data.segments || []);
        setMatchStats({ movieFrames: data.movieFrames, shortFrames: data.shortFrames });
        setIsMatching(false);
        setStatus(`Matching complete. ${(data.segments || []).length} segment(s) found.`);
      } else {
        // ---- Browser mode: simple sequential scan ----
        setIsMatching(true);
        setStatus('Running browser-side matching…');

        const { loadAllReferenceFingerprints, compareFingerprints } = await import('./Matcher');
        const refFps = await loadAllReferenceFingerprints('reference', refBatches);
        const targetFps = await loadAllReferenceFingerprints('target', batches);

        // Naive scan: find the best movie start for the whole clip
        let bestSim = 0;
        let bestMi = 0;
        for (let mi = 0; mi < refFps.length; mi += 5) {
          const sim = compareFingerprints(targetFps[0], refFps[mi]);
          if (sim > bestSim) { bestSim = sim; bestMi = mi; }
        }

        const approxSegment: MatchedSegment = {
          shortStart: targetFps[0]?.timestamp ?? 0,
          shortEnd:   targetFps[targetFps.length - 1]?.timestamp ?? 0,
          movieStart: refFps[bestMi]?.timestamp ?? 0,
          movieEnd:   refFps[Math.min(refFps.length - 1, bestMi + targetFps.length)]?.timestamp ?? 0,
          confidence: bestSim,
          frameCount: targetFps.length,
          isApproximate: true,
          matchSequence: []
        };
        setSegments([approxSegment]);
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
  // Preview
  // ---------------------------------------------------------------------------

  const handlePreviewSegment = (seg: MatchedSegment) => {
    setPreviewSegment(seg);
    setIsPlaying(false);
    // Seek both videos after a short delay to let the panel render
    setTimeout(() => {
      if (refVideoRef.current) {
        refVideoRef.current.currentTime = seg.movieStart;
      }
      if (clipVideoRef.current) {
        clipVideoRef.current.currentTime = seg.shortStart;
      }
    }, 100);
  };

  const handleSyncPlay = () => {
    if (!refVideoRef.current || !clipVideoRef.current) return;
    if (isPlaying) {
      refVideoRef.current.pause();
      clipVideoRef.current.pause();
      setIsPlaying(false);
    } else {
      refVideoRef.current.play();
      clipVideoRef.current.play();
      setIsPlaying(true);
    }
  };

  // ---------------------------------------------------------------------------
  // Download JSON
  // ---------------------------------------------------------------------------

  const handleDownloadJson = () => {
    const payload = { segments, matchStats };
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
    const elapsed = (performance.now() - prog.startTime) / 1000;
    const fps = prog.processed / (elapsed || 1);
    const remaining = prog.total - prog.processed;
    const eta = fps > 0 ? remaining / fps : 0;
    const etaStr = isFinite(eta) ? `${Math.floor(eta / 60)}m ${Math.round(eta % 60)}s` : '…';
    const pct = prog.total > 0 ? Math.min(100, Math.round((prog.processed / prog.total) * 100)) : 0;
    return (
      <div className="mt-4 space-y-2">
        <div className="flex justify-between text-xs font-mono text-slate-400">
          <span>{prog.processed.toLocaleString()} / {prog.total ? prog.total.toLocaleString() : '?'} frames</span>
          <span>{fps.toFixed(1)} fps · ETA {etaStr}</span>
        </div>
        <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${accent}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canRunAnalysis = !!targetFile && refDone && !isProcessingRef && !isProcessingTarget && !isMatching;

  return (
    <div className="min-h-screen bg-[#0d1117] text-slate-300 font-sans">
      <div className="max-w-5xl mx-auto p-6 md:p-10 space-y-6">

        {/* ---- Header ---- */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-6">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
              <ScanLine className="w-7 h-7 text-blue-500" />
              Nexus Video Match
            </h1>
            <p className="text-slate-500 text-sm mt-1">Sequence-alignment video fingerprint matching</p>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center bg-slate-900 p-1 rounded-lg border border-slate-800">
            <button
              onClick={() => setProcessMode('browser')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${processMode === 'browser' ? 'bg-slate-700 text-white shadow ring-1 ring-slate-600' : 'text-slate-400 hover:text-white'}`}
            >
              <Monitor className="w-3.5 h-3.5" /> Browser
            </button>
            <button
              onClick={() => setProcessMode('server')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${processMode === 'server' ? 'bg-blue-600 text-white shadow ring-1 ring-blue-500' : 'text-slate-400 hover:text-white'}`}
            >
              <Server className="w-3.5 h-3.5" /> Server
            </button>
          </div>
        </div>

        {/* ---- Error banner ---- */}
        {errorMsg && (
          <div className="flex items-start gap-3 bg-red-950/40 border border-red-800/50 rounded-xl p-4 text-red-300 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg('')} className="ml-auto shrink-0 text-red-500 hover:text-red-300 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* ---- Step 1: Reference Movie ---- */}
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
            <input
              type="file"
              accept="video/mp4"
              onChange={handleRefFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
            />
            <div className={`flex items-center gap-3 p-4 border-2 border-dashed rounded-xl transition-colors ${refFile ? 'border-blue-500/40 bg-blue-500/5' : 'border-slate-700 bg-slate-800/40 group-hover:border-slate-600'}`}>
              <CloudUpload className={`w-5 h-5 shrink-0 ${refFile ? 'text-blue-400' : 'text-slate-500'}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-300 truncate">{refFile ? refFile.name : 'Drop reference video here or click to browse'}</p>
                {refFile && <p className="text-xs text-slate-500">{(refFile.size / 1024 / 1024).toFixed(1)} MB</p>}
              </div>
            </div>
          </div>

          <button
            onClick={handleProcessReference}
            disabled={!refFile || isProcessingRef}
            className="w-full flex justify-center items-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors cursor-pointer"
          >
            <Activity className="w-4 h-4" />
            {isProcessingRef ? 'Processing…' : 'Extract Fingerprints'}
          </button>

          {renderProgress(refProgress, 'bg-blue-500')}
        </section>

        {/* ---- Step 2: Target Clip ---- */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/10 p-2 rounded-lg border border-indigo-500/20">
              <Search className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Step 2 — Target Clip & Find Matches</h2>
              <p className="text-xs text-slate-500">Upload the clip to locate inside the reference</p>
            </div>
            {targetDone && (
              <span className="ml-auto flex items-center gap-1 text-xs text-green-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Processed
              </span>
            )}
          </div>

          <div className="relative group">
            <input
              type="file"
              accept="video/mp4"
              onChange={handleTargetFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
            />
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
              <AlertCircle className="w-3.5 h-3.5" />
              Process the reference video first (Step 1).
            </p>
          )}

          <button
            onClick={handleRunAnalysis}
            disabled={!canRunAnalysis}
            className="w-full flex justify-center items-center gap-2 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors cursor-pointer"
          >
            <ScanLine className="w-4 h-4" />
            {isProcessingTarget ? 'Extracting fingerprints…' : isMatching ? 'Running matching algorithm…' : 'Process & Find Matches'}
          </button>

          {renderProgress(targetProgress, 'bg-indigo-500')}
        </section>

        {/* ---- Status bar ---- */}
        {(status || isMatching) && (
          <div className="flex items-center gap-3 bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 text-sm text-slate-300">
            <div className={`w-2 h-2 rounded-full shrink-0 ${isMatching || isProcessingRef || isProcessingTarget ? 'bg-blue-500 animate-pulse' : 'bg-green-500'}`} />
            {status}
          </div>
        )}

        {/* ---- Results ---- */}
        {segments.length > 0 && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-6 border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
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
                      {matchStats.shortFrames} clip frames scanned against {matchStats.movieFrames} movie frames
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={handleDownloadJson}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" /> Export JSON
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-950 text-slate-500 text-xs font-medium uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="px-5 py-3 text-left">#</th>
                    <th className="px-5 py-3 text-left">Clip Time</th>
                    <th className="px-5 py-3 text-left">Movie Time</th>
                    <th className="px-5 py-3 text-left">Duration</th>
                    <th className="px-5 py-3 text-left">Confidence</th>
                    <th className="px-5 py-3 text-right">Preview</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {segments.map((seg, i) => (
                    <tr
                      key={i}
                      className={`transition-colors hover:bg-slate-800/40 ${previewSegment === seg ? 'bg-slate-800/60' : ''}`}
                    >
                      <td className="px-5 py-3.5 font-mono text-slate-500 text-xs">{i + 1}</td>
                      <td className="px-5 py-3.5">
                        <span className="font-mono text-white text-xs">{fmt(seg.shortStart)}</span>
                        <span className="text-slate-600 mx-1">→</span>
                        <span className="font-mono text-slate-400 text-xs">{fmt(seg.shortEnd)}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-mono text-white text-xs">{fmt(seg.movieStart)}</span>
                        <span className="text-slate-600 mx-1">→</span>
                        <span className="font-mono text-slate-400 text-xs">{fmt(seg.movieEnd)}</span>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-slate-400 text-xs">
                        {(seg.movieEnd - seg.movieStart).toFixed(1)}s · {seg.frameCount}f
                      </td>
                      <td className="px-5 py-3.5">
                        <ConfidenceBadge confidence={seg.confidence} isApproximate={seg.isApproximate} />
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <button
                          onClick={() => handlePreviewSegment(seg)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 rounded-lg text-xs font-medium transition cursor-pointer"
                        >
                          <Play className="w-3 h-3" /> Preview
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {segments.length === 0 && !isMatching && matchStats && (
          <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-5 text-slate-400 text-sm">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            No matching segments found. Try re-processing with better-quality source videos, or ensure the clip actually appears in the reference.
          </div>
        )}

        {/* ---- Preview Panel ---- */}
        {previewSegment && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="bg-blue-500/10 p-1.5 rounded-lg border border-blue-500/20">
                  <Video className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Side-by-Side Preview</h3>
                  <p className="text-xs text-slate-500">
                    Movie @ {fmt(previewSegment.movieStart)} · Clip @ {fmt(previewSegment.shortStart)} · Confidence {previewSegment.confidence.toFixed(1)}%
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSyncPlay}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium transition cursor-pointer"
                >
                  {isPlaying ? <><Pause className="w-3.5 h-3.5" /> Pause Both</> : <><Play className="w-3.5 h-3.5" /> Play Both</>}
                </button>
                <button
                  onClick={() => setPreviewSegment(null)}
                  className="p-1.5 text-slate-500 hover:text-slate-300 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-800">
              {/* Reference movie */}
              <div className="p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5 text-blue-400" /> Reference Movie
                  <span className="font-normal font-mono text-slate-500 normal-case">@ {fmt(previewSegment.movieStart)}</span>
                </p>
                <div className="bg-black rounded-xl overflow-hidden border border-slate-800">
                  {refFileUrl ? (
                    <video
                      ref={refVideoRef}
                      src={refFileUrl}
                      controls
                      className="w-full max-h-64 object-contain"
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-40 text-slate-600 text-sm">
                      Reference video file not available for preview
                    </div>
                  )}
                </div>
              </div>

              {/* Target clip */}
              <div className="p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Search className="w-3.5 h-3.5 text-indigo-400" /> Target Clip
                  <span className="font-normal font-mono text-slate-500 normal-case">@ {fmt(previewSegment.shortStart)}</span>
                </p>
                <div className="bg-black rounded-xl overflow-hidden border border-slate-800">
                  {targetFileUrl ? (
                    <video
                      ref={clipVideoRef}
                      src={targetFileUrl}
                      controls
                      className="w-full max-h-64 object-contain"
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-40 text-slate-600 text-sm">
                      Target clip file not available for preview
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Match sequence mini-timeline */}
            {previewSegment.matchSequence.length > 0 && (
              <div className="p-4 border-t border-slate-800">
                <p className="text-xs text-slate-500 mb-2">Match quality timeline ({previewSegment.matchSequence.length} frames)</p>
                <div className="flex gap-px h-6 rounded overflow-hidden">
                  {previewSegment.matchSequence.map((item, i) => {
                    const pct = item.similarity;
                    const bg = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500';
                    return <div key={i} className={`flex-1 ${bg} opacity-80`} style={{ opacity: pct / 100 }} title={`${item.similarity.toFixed(0)}%`} />;
                  })}
                </div>
                <div className="flex justify-between text-xs text-slate-600 mt-1 font-mono">
                  <span>{fmt(previewSegment.shortStart)}</span>
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
