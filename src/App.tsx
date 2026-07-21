import React, { useState, useRef } from 'react';
import { CloudUpload, Video, Server, Monitor, Play, Download, Search, FileJson, Film, CircleCheck, ScanLine, Activity } from 'lucide-react';
import { processVideoFile, processVideoOnServer } from './VideoProcessor';
import { loadAllReferenceFingerprints, findBestMatch, MatchResult, compareFingerprints } from './Matcher';
import { clearVideoFingerprints } from './utils/db';
import { FrameFingerprint } from './shared/fingerprint';

const DEFAULT_CUT_LIST = `[
  { "startTimeSeconds": 10, "frames": 50 },
  { "startTimeSeconds": 60, "frames": 100 }
]`;

export default function App() {
  const [processMode, setProcessMode] = useState<'browser' | 'server'>('server');
  const [refFile, setRefFile] = useState<File | null>(null);
  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [refFileUrl, setRefFileUrl] = useState<string>('');
  
  const [refProgress, setRefProgress] = useState({ processed: 0, total: 0, inflight: 0, startTime: 0 });
  const [targetProgress, setTargetProgress] = useState({ processed: 0, total: 0, inflight: 0, startTime: 0 });
  
  const [refBatches, setRefBatches] = useState(0);
  
  const [cutListJson, setCutListJson] = useState(DEFAULT_CUT_LIST);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [status, setStatus] = useState<string>('');
  
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleRefFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setRefFile(file);
    if (file) {
      setRefFileUrl(URL.createObjectURL(file));
    }
  };

  const handleProcessReference = async () => {
    if (!refFile) return;
    console.log("[DEBUG] handleProcessReference: starting for file:", refFile.name, "size:", refFile.size, "mode:", processMode);
    setStatus(`Processing reference video (${processMode === 'server' ? 'on Server' : 'in Browser'})...`);
    try {
      console.log("[DEBUG] handleProcessReference: clearing db");
      await clearVideoFingerprints('reference');
      console.log("[DEBUG] handleProcessReference: db cleared, calling extraction pipeline");
      
      const startTime = performance.now();
      const runProcessor = processMode === 'server' ? processVideoOnServer : processVideoFile;
      
      const { totalFrames, batches } = await runProcessor(refFile, 'reference', (p, t, i) => {
        setRefProgress({ processed: p, total: t, inflight: i, startTime });
      });
      console.log("[DEBUG] Loading reference fingerprints to set window.allFingerprints");
      const refFps = await loadAllReferenceFingerprints('reference', batches);
      (window as any).allFingerprints = refFps;
      console.log(`[DEBUG] Set window.allFingerprints with ${refFps.length} items`);

      setRefBatches(batches);
      setStatus(`Reference video processed: ${totalFrames} frames in ${batches} batches.`);
      console.log("[DEBUG] handleProcessReference: processing finished successfully!");
    } catch (e: any) {
      console.error("[DEBUG] handleProcessReference error:", e);
      setStatus(`Error: ${e.message}`);
    }
  };

  const handleRunMatching = async () => {
    if (!targetFile) return;
    try {
      setStatus('Loading reference fingerprints from DB...');
      const refFps = await loadAllReferenceFingerprints('reference', refBatches);
      
      setStatus(`Extracting target fingerprints (${processMode === 'server' ? 'on Server' : 'in Browser'})...`);
      await clearVideoFingerprints('target');
      
      const startTime = performance.now();
      const runProcessor = processMode === 'server' ? processVideoOnServer : processVideoFile;
      
      const { batches: targetBatches } = await runProcessor(targetFile, 'target', (p, t, i) => {
        setTargetProgress({ processed: p, total: t, inflight: i, startTime });
      });
      
      setStatus('Target fingerprints extracted. Matching...');
      const targetFps = await loadAllReferenceFingerprints('target', targetBatches);
      
      let cuts: { startTimeSeconds: number; frames: number }[] = [];
      try {
        cuts = JSON.parse(cutListJson);
      } catch (e) {
        // ignore parse error if empty
      }
      if (!cuts || cuts.length === 0) {
        // default to matching the whole target clip as one cut
        cuts = [{ startTimeSeconds: 0, frames: targetFps.length }];
      }

      const results: MatchResult[] = [];
      
      for (let i = 0; i < cuts.length; i++) {
        const cut = cuts[i];
        // Find start frame
        const startFrameIndex = targetFps.findIndex(f => f.timestamp >= cut.startTimeSeconds);
        if (startFrameIndex === -1) continue;
        
        const startFp = targetFps[startFrameIndex];
        const verifyFp = targetFps[Math.min(targetFps.length - 1, startFrameIndex + 5)]; // secondary verify frame
        const endFp = targetFps[Math.min(targetFps.length - 1, startFrameIndex + cut.frames - 1)]; // last frame
        
        const { bestIndex, bestSim: startSim } = findBestMatch(startFp, refFps, 10, 30);
        
        if (bestIndex !== -1) {
           let finalConfidence = startSim;
           let verifiedEndFrameIndex = refFps[Math.min(refFps.length - 1, bestIndex + cut.frames)]?.frameIndex;
           
           // Verify secondary frame
           const refVerifyIndex = Math.min(refFps.length - 1, bestIndex + 5);
           const verifySim = compareFingerprints(verifyFp, refFps[refVerifyIndex]);
           
           let initialConfidence = (startSim + verifySim) / 2;
           
           // Verify end frame (search around expected end)
           const expectedEndIndex = Math.min(refFps.length - 1, bestIndex + cut.frames - 1);
           const endSearchWindow = 10;
           let bestEndSim = 0;
           let bestActualEndIndex = expectedEndIndex;
           for (let j = Math.max(0, expectedEndIndex - endSearchWindow); j <= Math.min(refFps.length - 1, expectedEndIndex + endSearchWindow); j++) {
             const sim = compareFingerprints(endFp, refFps[j]);
             if (sim > bestEndSim) {
               bestEndSim = sim;
               bestActualEndIndex = j;
             }
           }
           verifiedEndFrameIndex = refFps[bestActualEndIndex]?.frameIndex;
           
           if (initialConfidence >= 90) {
             // Sample 2-3 additional middle frames
             const mid1Fp = targetFps[Math.min(targetFps.length - 1, startFrameIndex + Math.floor(cut.frames * 0.33))];
             const mid2Fp = targetFps[Math.min(targetFps.length - 1, startFrameIndex + Math.floor(cut.frames * 0.66))];
             
             const refMid1Index = Math.min(refFps.length - 1, bestIndex + Math.floor(cut.frames * 0.33));
             const refMid2Index = Math.min(refFps.length - 1, bestIndex + Math.floor(cut.frames * 0.66));
             
             const mid1Sim = compareFingerprints(mid1Fp, refFps[refMid1Index]);
             const mid2Sim = compareFingerprints(mid2Fp, refFps[refMid2Index]);
             
             finalConfidence = (startSim + verifySim + bestEndSim + mid1Sim + mid2Sim) / 5;
           } else {
             finalConfidence = (startSim + verifySim + bestEndSim) / 3;
           }

           results.push({
             cutIndex: i,
             cutStartTime: cut.startTimeSeconds,
             cutFrames: cut.frames,
             refMatchFrameIndex: refFps[bestIndex].frameIndex,
             refMatchTime: refFps[bestIndex].timestamp,
             confidence: finalConfidence,
             verifiedEndFrameIndex: verifiedEndFrameIndex
           });
        }
      }
      
      setMatches(results);
      setStatus('Matching complete.');
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
  };

  const handlePreviewMatch = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play();
    }
  };

  const handleDownloadJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(matches, null, 2));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = "match_results.json";
    a.click();
  };

  const renderProgress = (progress: typeof refProgress, isTarget: boolean = false) => {
    if (progress.total === 0 && progress.processed === 0) return null;
    const elapsedSecs = (performance.now() - progress.startTime) / 1000;
    const fps = progress.processed / (elapsedSecs || 1);
    const remainingFrames = progress.total - progress.processed;
    const etaSecs = fps > 0 ? remainingFrames / fps : 0;
    const etaString = isFinite(etaSecs) ? `${Math.round(etaSecs / 60)}m ${Math.round(etaSecs % 60)}s` : '...';
    const percent = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
    
    return (
      <div className="mt-6 space-y-3">
        <div className="flex justify-between items-end text-sm">
          <div className="flex flex-col">
            <span className="text-slate-500 font-medium text-xs uppercase tracking-wider mb-1">Progress</span>
            <span className="font-mono text-slate-300 font-semibold">{progress.processed} <span className="text-slate-500 font-normal">/ {progress.total || '?'} frames</span></span>
          </div>
          <div className="flex flex-col text-right">
            <span className="text-slate-500 font-medium text-xs uppercase tracking-wider mb-1">Speed & ETA</span>
            <span className="font-mono text-slate-300 font-semibold">{fps.toFixed(1)} fps <span className="text-slate-500 font-normal mx-1">&middot;</span> {etaString}</span>
          </div>
        </div>
        <div className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden border border-slate-700/50">
          <div 
            className={`h-full transition-all duration-300 ease-out ${isTarget ? 'bg-indigo-500' : 'bg-blue-500'}`} 
            style={{ width: `${percent}%` }} 
          />
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0f1115] text-slate-300 font-sans selection:bg-blue-500/30">
      <div className="max-w-5xl mx-auto p-6 md:p-10 space-y-8">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 border-b border-slate-800 pb-8">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
              <ScanLine className="w-8 h-8 text-blue-500" />
              Nexus Video Match
            </h1>
            <p className="text-slate-400 mt-2 text-sm">High-performance video fingerprinting & timeline matching</p>
          </div>
          
          <div className="flex items-center bg-slate-900 p-1.5 rounded-lg border border-slate-800 shadow-inner">
            <button
              onClick={() => setProcessMode('browser')}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-all duration-200 cursor-pointer ${processMode === 'browser' ? 'bg-slate-700 text-white shadow-sm ring-1 ring-slate-600' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
            >
              <Monitor className="w-4 h-4" />
              Browser
            </button>
            <button
              onClick={() => setProcessMode('server')}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-all duration-200 cursor-pointer ${processMode === 'server' ? 'bg-blue-600 text-white shadow-sm ring-1 ring-blue-500 shadow-blue-900/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
            >
              <Server className="w-4 h-4" />
              Server (64-Core)
            </button>
          </div>
        </div>
        
        {/* 1. Reference Movie */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-blue-500/10 p-2 rounded-lg border border-blue-500/20">
              <Film className="w-5 h-5 text-blue-400" />
            </div>
            <h2 className="text-xl font-semibold text-white">Reference Movie</h2>
          </div>
          
          <div className="relative group">
            <input 
              type="file" 
              accept="video/mp4" 
              onChange={handleRefFileChange} 
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" 
            />
            <div className={`flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl transition-colors duration-200 ${refFile ? 'border-blue-500/50 bg-blue-500/5' : 'border-slate-700 bg-slate-800/50 group-hover:border-slate-600 group-hover:bg-slate-800'}`}>
              <CloudUpload className={`w-8 h-8 mb-3 ${refFile ? 'text-blue-400' : 'text-slate-500'}`} />
              <span className="text-sm font-medium text-slate-300">
                {refFile ? refFile.name : 'Drop reference video here or click to browse'}
              </span>
              <span className="text-xs text-slate-500 mt-1">MP4 format supported</span>
            </div>
          </div>

          <button 
            onClick={handleProcessReference} 
            disabled={!refFile}
            className="mt-6 w-full flex justify-center items-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-500 transition-colors shadow-lg shadow-blue-900/20 cursor-pointer"
          >
            <Activity className="w-4 h-4" />
            Extract Fingerprints
          </button>
          
          {renderProgress(refProgress, false)}
        </div>
        
        {/* 2. Target Clip & Match */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-indigo-500/10 p-2 rounded-lg border border-indigo-500/20">
              <Search className="w-5 h-5 text-indigo-400" />
            </div>
            <h2 className="text-xl font-semibold text-white">Target Clip Search</h2>
          </div>

          <div className="space-y-6">
            <div className="relative group">
              <input 
                type="file" 
                accept="video/mp4" 
                onChange={e => setTargetFile(e.target.files?.[0] || null)} 
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" 
              />
              <div className={`flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-xl transition-colors duration-200 ${targetFile ? 'border-indigo-500/50 bg-indigo-500/5' : 'border-slate-700 bg-slate-800/50 group-hover:border-slate-600 group-hover:bg-slate-800'}`}>
                <CloudUpload className={`w-8 h-8 mb-3 ${targetFile ? 'text-indigo-400' : 'text-slate-500'}`} />
                <span className="text-sm font-medium text-slate-300">
                  {targetFile ? targetFile.name : 'Drop target clip to match'}
                </span>
              </div>
            </div>
            
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-300 mb-2">
                <FileJson className="w-4 h-4 text-slate-400" />
                Cut List Definition <span className="text-slate-500 font-normal">(Optional)</span>
              </label>
              <textarea 
                value={cutListJson} 
                onChange={e => setCutListJson(e.target.value)}
                placeholder="Leave empty to process whole file as one cut"
                className="w-full h-24 p-3 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-slate-300 focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 outline-none transition-all resize-none placeholder-slate-700"
              />
            </div>

            <button 
              onClick={handleRunMatching} 
              disabled={!targetFile || !refBatches}
              className="w-full flex justify-center items-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-900/20 cursor-pointer"
            >
              <ScanLine className="w-4 h-4" />
              Run Match Analysis
            </button>

            {renderProgress(targetProgress, true)}
          </div>
        </div>
        
        {/* Status */}
        {status && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex items-center gap-3 font-mono text-sm text-slate-300 shadow-sm">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
            {status}
          </div>
        )}
        
        {/* Results */}
        {matches.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl overflow-hidden">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="bg-green-500/10 p-2 rounded-lg border border-green-500/20">
                  <CircleCheck className="w-5 h-5 text-green-400" />
                </div>
                <h2 className="text-xl font-semibold text-white">Analysis Results</h2>
              </div>
              <button 
                onClick={handleDownloadJson}
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-slate-200 rounded-lg font-medium hover:bg-slate-700 transition border border-slate-700 text-sm cursor-pointer shadow-sm"
              >
                <Download className="w-4 h-4" />
                Export JSON
              </button>
            </div>

            {refFileUrl && (
              <div className="mb-8 rounded-xl overflow-hidden border border-slate-800 bg-black shadow-inner">
                <video ref={videoRef} src={refFileUrl} controls className="w-full max-h-[400px] object-contain" />
              </div>
            )}

            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="min-w-full text-sm text-left whitespace-nowrap">
                <thead className="bg-slate-950 text-slate-400 font-medium border-b border-slate-800">
                  <tr>
                    <th className="px-6 py-4">Cut Index</th>
                    <th className="px-6 py-4">Target Start</th>
                    <th className="px-6 py-4">Frames</th>
                    <th className="px-6 py-4">Match Start</th>
                    <th className="px-6 py-4">Match End</th>
                    <th className="px-6 py-4">Confidence</th>
                    <th className="px-6 py-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 bg-slate-900/30">
                  {matches.map((m, i) => (
                    <tr key={i} className="hover:bg-slate-800/50 transition-colors">
                      <td className="px-6 py-4 font-mono text-slate-300">{m.cutIndex}</td>
                      <td className="px-6 py-4 font-mono text-slate-400">{m.cutStartTime.toFixed(2)}s</td>
                      <td className="px-6 py-4 font-mono text-slate-400">{m.cutFrames}</td>
                      <td className="px-6 py-4 font-mono text-white font-medium">{m.refMatchTime.toFixed(2)}s</td>
                      <td className="px-6 py-4 font-mono text-slate-400">{m.verifiedEndFrameIndex !== undefined ? (m.verifiedEndFrameIndex / 25).toFixed(2) : ((m.refMatchFrameIndex + m.cutFrames) / 25).toFixed(2)}s</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-md font-mono text-xs font-medium border ${m.confidence >= 90 ? 'bg-green-500/10 text-green-400 border-green-500/20' : m.confidence >= 80 ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                          {m.confidence.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => handlePreviewMatch(m.refMatchTime)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 rounded-lg font-medium text-xs transition cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5" />
                          Preview
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
