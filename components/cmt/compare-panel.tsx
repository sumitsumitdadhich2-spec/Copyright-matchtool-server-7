'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  SplitSquareHorizontal,
  Terminal,
  X,
} from 'lucide-react'
import type { Scan, ChunkMatch } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { candidateOptionsFor, hasAlternatives, sameShortSegment } from '@/lib/candidate-pick'
import { CandidateChooser } from './candidate-chooser'

interface RescanLogEntry {
  time: string
  msg: string
  type: 'info' | 'warn' | 'success' | 'error'
}

interface RescanTaskState {
  taskKey: string
  pairIndex: number
  shortStart: number
  shortEnd: number
  chunkIndex: number
  status: 'preparing' | 'uploading' | 'scanning' | 'retrying' | 'done' | 'error'
  progressMsg: string
  attempt: number
  maxAttempts: number
  model?: string
  logs: RescanLogEntry[]
  result?: { movieStart: number; movieEnd: number; model: string }
  errorMsg?: string
}

interface ToastNotification {
  id: string
  title: string
  msg: string
  pairIndex: number
  taskKey: string
}

function playRescanChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const now = ctx.currentTime

    // Note 1 (C5 - 523.25Hz)
    const osc1 = ctx.createOscillator()
    const gain1 = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(523.25, now)
    gain1.gain.setValueAtTime(0.12, now)
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc1.connect(gain1)
    gain1.connect(ctx.destination)
    osc1.start(now)
    osc1.stop(now + 0.3)

    // Note 2 (G5 - 783.99Hz)
    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(783.99, now + 0.12)
    gain2.gain.setValueAtTime(0.18, now + 0.12)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
    osc2.connect(gain2)
    gain2.connect(ctx.destination)
    osc2.start(now + 0.12)
    osc2.stop(now + 0.5)
  } catch {}
}

/** Side-by-side preview of matched windows: each parsed "Short X --> Movie Y" line
 *  is one pair with (near-)equal durations on both sides.
 *
 *  CANDIDATES: when the short window of a pair has alternative movie windows
 *  (other candidates of its group — confirmed, unverified, rejected or not yet
 *  checked), extra Prev/Next-candidate buttons appear. Browsing swaps ONLY the
 *  movie side so the user compares each candidate against the same short clip,
 *  and "Make this the main clip" turns that candidate into the pair used by the
 *  stitched preview and the export.
 *
 *  RESCAN / RETRY: Users can click the Retry / Rescan button to hunt for this exact
 *  short segment in the full chunk. The newly found rescan match immediately becomes
 *  the MAIN clip (with the previous match stored in candidates), marked with Rescan
 *  branding for user review. */
export function ComparePanel({ scan }: { scan: Scan }) {
  const { mutate } = useSWRConfig()
  const pairs = useMemo(() => {
    const raw = scan.matches || []
    if (raw.length === 0) return []

    // 1. Sort raw by shortStart, with deterministic priority for conflicts:
    // User pick > Confirmed / Verified > Longer duration > Higher confidence
    const sorted = [...raw].sort((a, b) => {
      if (Math.abs(a.shortStart - b.shortStart) > 0.2) {
        return a.shortStart - b.shortStart
      }
      const aPick = a.userPick ? 1 : 0
      const bPick = b.userPick ? 1 : 0
      if (aPick !== bPick) return bPick - aPick

      const aConf = (a.verified || a.batchVerified === 'confirmed') ? 1 : 0
      const bConf = (b.verified || b.batchVerified === 'confirmed') ? 1 : 0
      if (aConf !== bConf) return bConf - aConf

      const aDur = a.shortEnd - a.shortStart
      const bDur = b.shortEnd - b.shortStart
      if (Math.abs(aDur - bDur) > 0.1) return bDur - aDur

      return (b.confidence || 0) - (a.confidence || 0)
    })

    // 2. Build non-overlapping pairs list. If two matches represent the same short segment
    // or overlap significantly, KEEP ONLY THE BEST ONE as the main match entry!
    // The alternative candidate remains accessible in the Candidate Chooser below.
    const out: ChunkMatch[] = []
    for (const m of sorted) {
      const conflictIndex = out.findIndex((existing) =>
        sameShortSegment(existing.shortStart, existing.shortEnd, m.shortStart, m.shortEnd),
      )

      if (conflictIndex === -1) {
        out.push(m)
      } else {
        const existing = out[conflictIndex]
        const existingPriority =
          (existing.userPick ? 10000 : 0) +
          ((existing.verified || existing.batchVerified === 'confirmed') ? 1000 : 0) +
          (existing.rejected || existing.batchVerified === 'rejected' ? -500 : 0) +
          (existing.shortEnd - existing.shortStart) * 10 +
          (existing.confidence || 0)

        const mPriority =
          (m.userPick ? 10000 : 0) +
          ((m.verified || m.batchVerified === 'confirmed') ? 1000 : 0) +
          (m.rejected || m.batchVerified === 'rejected' ? -500 : 0) +
          (m.shortEnd - m.shortStart) * 10 +
          (m.confidence || 0)

        if (mPriority > existingPriority) {
          out[conflictIndex] = m
        }
      }
    }

    out.sort((a, b) => a.shortStart - b.shortStart)
    return out
  }, [scan.matches])
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  // null = the pair's own movie window; a number = options[candIdx] on the movie side
  const [candIdx, setCandIdx] = useState<number | null>(null)
  const [shortProgress, setShortProgress] = useState(0)
  const [movieProgress, setMovieProgress] = useState(0)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showConsole, setShowConsole] = useState(true)

  // Persistent rescan task tracking keyed by `${shortStart.toFixed(1)}-${shortEnd.toFixed(1)}`
  const [rescanTasks, setRescanTasks] = useState<Record<string, RescanTaskState>>({})
  const [toastNotification, setToastNotification] = useState<ToastNotification | null>(null)

  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)
  const animFrameRef = useRef<number | null>(null)
  const isSeekingRef = useRef(false)

  const pair = pairs[Math.min(idx, Math.max(0, pairs.length - 1))]
  const pairShortStart = pair?.shortStart ?? 0
  const pairShortEnd = pair?.shortEnd ?? 0

  const options = useMemo(
    () => (pair ? candidateOptionsFor(scan, pairShortStart, pairShortEnd) : []),
    [scan, pair, pairShortStart, pairShortEnd],
  )
  const showChooser = hasAlternatives(options)
  const viewing = candIdx === null ? null : options[Math.min(candIdx, options.length - 1)]

  // Movie-side and short-side windows actually shown (candidate or the pair's own window).
  const movieStart = viewing ? viewing.movieStart : pair?.movieStart ?? 0
  const movieEnd = viewing ? viewing.movieEnd : pair?.movieEnd ?? 0
  const shortStart = viewing?.shortStart ?? pair?.shortStart ?? 0
  const shortEnd = viewing?.shortEnd ?? pair?.shortEnd ?? 0
  const shortDur = Math.max(0.1, shortEnd - shortStart)
  const movieDur = Math.max(0.1, movieEnd - movieStart)

  const isCurrentRescanned = !!(
    pair?.viaRescan ||
    pair?.origin === 'rescan' ||
    viewing?.viaRescan ||
    viewing?.origin === 'rescan'
  )

  // Keep index in range when pairs change between refreshes.
  useEffect(() => {
    if (idx > 0 && idx >= pairs.length) {
      setIdx(Math.max(0, pairs.length - 1))
    }
  }, [idx, pairs.length])

  // Leaving a pair always returns to its main window.
  useEffect(() => {
    setCandIdx(null)
  }, [idx, pairShortStart])

  // Safe seek helper to prevent video decode lockup during rapid switching
  const safeSeek = useCallback((video: HTMLVideoElement | null, targetTime: number) => {
    if (!video) return
    try {
      video.pause()
      if (Number.isFinite(targetTime) && targetTime >= 0) {
        if ('fastSeek' in video && typeof (video as unknown as { fastSeek: (t: number) => void }).fastSeek === 'function') {
          (video as unknown as { fastSeek: (t: number) => void }).fastSeek(targetTime)
        } else {
          video.currentTime = targetTime
        }
      }
    } catch {}
  }, [])

  // Seek both players to window start whenever shown windows change
  useEffect(() => {
    if (!pair) return
    isSeekingRef.current = true
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }

    const sv = shortRef.current
    const mv = movieRef.current
    safeSeek(sv, shortStart)
    safeSeek(mv, movieStart)
    setShortProgress(0)
    setMovieProgress(0)
    setPlaying(false)
    isSeekingRef.current = false
  }, [pair, pairShortStart, movieStart, candIdx, safeSeek, shortStart])

  // High-frequency synchronized frame loop during playback
  useEffect(() => {
    if (!playing || !pair) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      return
    }

    let isRunning = true
    const checkFrames = () => {
      if (!isRunning) return

      const sv = shortRef.current
      const mv = movieRef.current

      let shortEnded = false
      let movieEnded = false

      if (sv) {
        const cur = sv.currentTime
        const rel = Math.max(0, cur - shortStart)
        setShortProgress(Math.min(100, (rel / shortDur) * 100))

        if (cur >= shortEnd - 0.03 || cur < shortStart - 0.2) {
          sv.pause()
          sv.currentTime = shortEnd
          shortEnded = true
        }
      } else {
        shortEnded = true
      }

      if (mv) {
        const cur = mv.currentTime
        const rel = Math.max(0, cur - movieStart)
        setMovieProgress(Math.min(100, (rel / movieDur) * 100))

        if (cur >= movieEnd - 0.03 || cur < movieStart - 0.2) {
          mv.pause()
          mv.currentTime = movieEnd
          movieEnded = true
        }
      } else {
        movieEnded = true
      }

      // When BOTH videos have reached their respective cuts, stop playback cleanly!
      if (shortEnded && movieEnded) {
        setPlaying(false)
        return
      }

      animFrameRef.current = requestAnimationFrame(checkFrames)
    }

    animFrameRef.current = requestAnimationFrame(checkFrames)

    return () => {
      isRunning = false
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
    }
  }, [playing, pair, shortStart, shortEnd, movieStart, movieEnd, shortDur, movieDur])

  const togglePlay = useCallback(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (!sv || !mv || !pair) return

    if (playing) {
      sv.pause()
      mv.pause()
      setPlaying(false)
    } else {
      // Re-align to start if either has reached the end
      if (sv.currentTime >= shortEnd - 0.05 || sv.currentTime < shortStart) {
        sv.currentTime = shortStart
      }
      if (mv.currentTime >= movieEnd - 0.05 || mv.currentTime < movieStart) {
        mv.currentTime = movieStart
      }

      const p1 = sv.play().catch(() => {})
      const p2 = mv.play().catch(() => {})
      void Promise.all([p1, p2]).then(() => {
        setPlaying(true)
      })
    }
  }, [playing, pair, shortStart, shortEnd, movieStart, movieEnd])

  const restart = useCallback(() => {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) {
      sv.pause()
      sv.currentTime = shortStart
    }
    if (mv) {
      mv.pause()
      mv.currentTime = movieStart
    }
    setShortProgress(0)
    setMovieProgress(0)
    setPlaying(false)
  }, [shortStart, movieStart])

  // Fast match cycling helper (instant and responsive)
  const handleCycleMatch = useCallback((delta: number) => {
    if (pairs.length <= 1) return
    setIdx((cur) => (cur + delta + pairs.length) % pairs.length)
  }, [pairs.length])

  // Current scene task key
  const currentTaskKey = pair ? `${pair.shortStart.toFixed(1)}-${pair.shortEnd.toFixed(1)}` : ''
  const currentTask = currentTaskKey ? rescanTasks[currentTaskKey] : undefined
  const isCurrentRescanning =
    currentTask?.status === 'preparing' ||
    currentTask?.status === 'uploading' ||
    currentTask?.status === 'scanning' ||
    currentTask?.status === 'retrying'

  // Targeted Rescan / Retry handler with Gemini Model choice (3.6, 3.7, 3.8) & 4x Auto Retry
  async function handleRescanScene(chosenModel?: string) {
    if (!pair) return
    setShowModelPicker(false)

    const taskKey = `${pair.shortStart.toFixed(1)}-${pair.shortEnd.toFixed(1)}`
    const existing = rescanTasks[taskKey]
    if (
      existing?.status === 'preparing' ||
      existing?.status === 'uploading' ||
      existing?.status === 'scanning' ||
      existing?.status === 'retrying'
    ) {
      return // Already in flight for this scene
    }

    const pairIndex = idx
    const activeChunk = viewing ? viewing.chunkIndex : (pair.chunkIndex ?? Math.max(0, Math.floor((movieStart || 0) / 60)))
    const targetShortStart = pair.shortStart
    const targetShortEnd = pair.shortEnd
    const targetMovieStart = movieStart
    const targetMovieEnd = movieEnd

    const appendLog = (msg: string, type: RescanLogEntry['type'] = 'info') => {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false })
      setRescanTasks((prev) => {
        const cur = prev[taskKey] || {
          taskKey,
          pairIndex,
          shortStart: targetShortStart,
          shortEnd: targetShortEnd,
          chunkIndex: activeChunk,
          status: 'preparing',
          progressMsg: 'Starting rescan...',
          attempt: 1,
          maxAttempts: 4,
          model: chosenModel,
          logs: [],
        }
        return {
          ...prev,
          [taskKey]: {
            ...cur,
            logs: [...cur.logs, { time, msg, type }],
          },
        }
      })
    }

    appendLog(`[Rescan Init] Short ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)} | Movie chunk ${activeChunk + 1} | Model: ${chosenModel ? displayModelName(chosenModel) : 'Auto (First Available)'}`)

    for (let attempt = 1; attempt <= 4; attempt++) {
      setRescanTasks((prev) => {
        const cur = prev[taskKey] || {
          taskKey,
          pairIndex,
          shortStart: targetShortStart,
          shortEnd: targetShortEnd,
          chunkIndex: activeChunk,
          status: 'preparing',
          progressMsg: '',
          attempt,
          maxAttempts: 4,
          model: chosenModel,
          logs: [],
        }
        return {
          ...prev,
          [taskKey]: {
            ...cur,
            status: attempt === 1 ? 'preparing' : 'retrying',
            attempt,
            maxAttempts: 4,
            progressMsg:
              attempt === 1
                ? 'Preparing short & movie chunk clips...'
                : `High demand / API error — Auto-retrying attempt ${attempt}/4...`,
          },
        }
      })

      if (attempt > 1) {
        appendLog(`[Attempt ${attempt}/4] High demand / rate limit backoff — waiting 3s before auto-retry...`, 'warn')
        await new Promise((r) => setTimeout(r, 3000))
      }

      appendLog(`[Attempt ${attempt}/4] Cutting Short clip ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)} & Movie chunk ${activeChunk + 1}...`, 'info')

      setRescanTasks((prev) => ({
        ...prev,
        [taskKey]: {
          ...prev[taskKey]!,
          status: 'uploading',
          progressMsg: `Attempt ${attempt}/4: Uploading video clips to Gemini Files API...`,
        },
      }))
      appendLog(`[Attempt ${attempt}/4] Uploading video clips to Gemini Files API...`, 'info')

      setRescanTasks((prev) => ({
        ...prev,
        [taskKey]: {
          ...prev[taskKey]!,
          status: 'scanning',
          progressMsg: `Attempt ${attempt}/4: Requesting frame-precise scan on ${chosenModel ? displayModelName(chosenModel) : 'Gemini'}...`,
        },
      }))
      appendLog(`[Attempt ${attempt}/4] Calling Gemini AI for frame-precise rescan...`, 'info')

      try {
        const res = await fetch(`/api/scans/${scan.id}/rescan-scene`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shortStart: targetShortStart,
            shortEnd: targetShortEnd,
            chunkIndex: activeChunk,
            movieStart: targetMovieStart,
            movieEnd: targetMovieEnd,
            model: chosenModel || undefined,
          }),
        })

        const data = await res.json().catch(() => ({}))

        if (res.ok && data.ok) {
          appendLog(`✅ Rescan Successful! Found Movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)} on ${displayModelName(data.model)}. Set as MAIN clip.`, 'success')

          setRescanTasks((prev) => ({
            ...prev,
            [taskKey]: {
              ...prev[taskKey]!,
              status: 'done',
              progressMsg: `Rescan Successful! Found Movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)}`,
              result: { movieStart: data.movieStart, movieEnd: data.movieEnd, model: data.model },
            },
          }))

          playRescanChime()

          setToastNotification({
            id: `toast-${Date.now()}`,
            title: '✨ Rescan Successful!',
            msg: `Short ${fmtTime(targetShortStart)}–${fmtTime(targetShortEnd)} → Movie ${fmtTime(data.movieStart)}–${fmtTime(data.movieEnd)} (${displayModelName(data.model)})`,
            pairIndex,
            taskKey,
          })

          setCandIdx(null)
          await mutate(`/api/scans/${scan.id}`)
          return
        }

        const errStr = String(data.error || '').toLowerCase()
        const isRetryable =
          errStr.includes('high demand') ||
          errStr.includes('quota') ||
          errStr.includes('rate') ||
          errStr.includes('429') ||
          errStr.includes('503') ||
          errStr.includes('busy') ||
          res.status === 429 ||
          res.status === 503

        if (isRetryable && attempt < 4) {
          appendLog(`⚠️ Attempt ${attempt}/4 encountered high demand / rate limit: "${data.error || 'Server busy'}". Automatic retry ${attempt + 1}/4 scheduled.`, 'warn')
          continue
        } else {
          appendLog(`❌ Rescan failed (Attempt ${attempt}/4): ${data.error || 'No match found in chunk'}`, 'error')
          setRescanTasks((prev) => ({
            ...prev,
            [taskKey]: {
              ...prev[taskKey]!,
              status: 'error',
              progressMsg: `Rescan Failed: ${data.error || 'No match found'}`,
              errorMsg: data.error || 'No match found in chunk',
            },
          }))
          return
        }
      } catch (err) {
        if (attempt < 4) {
          appendLog(`⚠️ Attempt ${attempt}/4 network error. Scheduling automatic retry ${attempt + 1}/4...`, 'warn')
          continue
        } else {
          appendLog(`❌ Network error after 4 attempts.`, 'error')
          setRescanTasks((prev) => ({
            ...prev,
            [taskKey]: {
              ...prev[taskKey]!,
              status: 'error',
              progressMsg: 'Network error after 4 attempts',
              errorMsg: 'Network error after 4 attempts',
            },
          }))
          return
        }
      }
    }
  }

  // Keyboard navigation for smooth review
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handleCycleMatch(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleCycleMatch(1)
      } else if (e.key === ' ' && !e.repeat) {
        e.preventDefault()
        togglePlay()
      } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        restart()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleCycleMatch, togglePlay, restart])

  if (!pair) return null

  const src = (kind: 'short' | 'movie') => `/api/scans/${scan.id}/media?kind=${kind}`

  return (
    <section aria-label="Side-by-side comparison" className="panel relative">
      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <SplitSquareHorizontal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Side-by-Side Match Comparison</h2>

        <span className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs font-medium">
          match {idx + 1} / {pairs.length}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          {shortDur.toFixed(3)}s
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          chunk {viewing ? viewing.chunkIndex : pair.chunkIndex}
        </span>

        {/* Rescan Branding Badge */}
        {isCurrentRescanned && (
          <span className="flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-indigo-400">
            <RotateCcw className="size-3 animate-spin-slow" aria-hidden />
            🔄 Rescanned (User Review)
          </span>
        )}

        {/* Batch Verifier Verdict Badge */}
        {pair.batchVerified === 'confirmed' && (
          <span className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-emerald-400">
            <CheckCircle2 className="size-3" aria-hidden />
            Batch Verified: CONFIRMED
          </span>
        )}
        {pair.batchVerified === 'rejected' && (
          <span className="flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-0.5 font-mono text-xs font-semibold text-rose-400" title={pair.batchReason}>
            <AlertCircle className="size-3" aria-hidden />
            Batch Verifier: REJECTED (Rescan Required)
          </span>
        )}
        {!pair.verified && !pair.batchVerified && !pair.userPick && (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-0.5 font-mono text-xs font-medium text-amber-400">
            Unconfirmed (Pending 24fps)
          </span>
        )}

        {showChooser && (
          <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-mono text-xs text-primary font-medium">
            {options.length} candidates
          </span>
        )}

        {pair.userPick && !viewing && !isCurrentRescanned && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
            your choice
          </span>
        )}

        {/* Fast Navigation Buttons */}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => handleCycleMatch(-1)}
            disabled={pairs.length <= 1 || rescanning}
            className="flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary active:scale-95 disabled:opacity-40"
            title="Previous match (← Left Arrow)"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Prev
          </button>
          <span className="font-mono text-[11px] text-muted-foreground select-none">
            {idx + 1}/{pairs.length}
          </span>
          <button
            type="button"
            onClick={() => handleCycleMatch(1)}
            disabled={pairs.length <= 1 || rescanning}
            className="flex items-center gap-1 rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary active:scale-95 disabled:opacity-40"
            title="Next match (→ Right Arrow)"
          >
            Next <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {/* Video Preview Grid */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
        {/* Short Video View */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">Short video</span>
              {viewing && (Math.abs(viewing.shortStart - (pair?.shortStart ?? 0)) > 0.1 || Math.abs(viewing.shortEnd - (pair?.shortEnd ?? 0)) > 0.1) && (
                <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[9px] font-mono font-medium text-amber-300">
                  CANDIDATE DURATION ({(shortEnd - shortStart).toFixed(1)}s)
                </span>
              )}
            </div>
            <span className="font-mono text-muted-foreground text-[11px]">
              {fmtTime(shortStart)} – {fmtTime(shortEnd)}
            </span>
          </figcaption>
          <div className="relative overflow-hidden rounded-md border border-border bg-black">
            <video
              ref={shortRef}
              src={src('short')}
              preload="auto"
              muted
              playsInline
              className="aspect-video w-full object-contain"
            />
            {/* Progress line for short video */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
              <div
                className="h-full bg-primary transition-all duration-75"
                style={{ width: `${shortProgress}%` }}
              />
            </div>
          </div>
        </figure>

        {/* Movie Video View */}
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">
                {viewing ? 'Movie — candidate' : isCurrentRescanned ? 'Movie — Rescanned' : 'Movie'}
              </span>
              {isCurrentRescanned && (
                <span className="rounded bg-indigo-500/20 px-1 py-0.2 text-[9px] font-mono font-medium text-indigo-300">
                  RESCAN
                </span>
              )}
            </div>
            <span className="font-mono text-muted-foreground text-[11px]">
              {fmtTime(movieStart)} – {fmtTime(movieEnd)}
            </span>
          </figcaption>
          <div className={`relative overflow-hidden rounded-md border bg-black ${viewing ? 'border-primary' : isCurrentRescanned ? 'border-indigo-500/60' : 'border-border'}`}>
            <video
              ref={movieRef}
              src={src('movie')}
              preload="auto"
              muted
              playsInline
              className="aspect-video w-full object-contain"
            />
            {/* Progress line for movie video */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
              <div
                className={`h-full transition-all duration-75 ${isCurrentRescanned ? 'bg-indigo-400' : 'bg-primary'}`}
                style={{ width: `${movieProgress}%` }}
              />
            </div>
          </div>
        </figure>
      </div>

      {/* Batch Verifier Forensic Note */}
      {pair.batchReason && (
        <div className={`mt-2.5 rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${
          pair.batchVerified === 'confirmed'
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
            : 'border-rose-500/30 bg-rose-500/5 text-rose-300'
        }`}>
          <span className="font-semibold text-foreground shrink-0">Batch Verifier:</span>
          <span>{pair.batchReason}</span>
        </div>
      )}

      {/* Candidate Chooser with full alternative list */}
      {showChooser && (
        <div className="mt-3">
          <CandidateChooser scan={scan} options={options} viewIdx={candIdx} onView={setCandIdx} />
        </div>
      )}

      {/* Live Rescan Terminal Log Console */}
      {currentTask && (
        <div className="mt-3 overflow-hidden rounded-lg border border-indigo-500/30 bg-black/90 p-3 shadow-lg font-mono text-xs text-foreground">
          <div className="flex items-center justify-between border-b border-border/40 pb-2 mb-2">
            <div className="flex flex-wrap items-center gap-2">
              <Terminal className="size-4 text-indigo-400" />
              <span className="font-semibold text-indigo-300">Rescan Live Console</span>
              <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-[10px] text-indigo-300 border border-indigo-500/30">
                Attempt {currentTask.attempt}/{currentTask.maxAttempts}
              </span>
              {isCurrentRescanning ? (
                <span className="flex items-center gap-1.5 rounded-full bg-amber-500/20 text-amber-300 px-2.5 py-0.5 text-[10px] border border-amber-500/30 animate-pulse">
                  <RefreshCw className="size-3 animate-spin" />
                  {currentTask.status === 'retrying' ? 'High Demand Auto-Retry...' : 'Scanning Chunk...'}
                </span>
              ) : currentTask.status === 'done' ? (
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-300 px-2.5 py-0.5 text-[10px] border border-emerald-500/30">
                  <CheckCircle2 className="size-3" /> Rescan Complete
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded-full bg-rose-500/20 text-rose-300 px-2.5 py-0.5 text-[10px] border border-rose-500/30">
                  <AlertCircle className="size-3" /> Error Encountered
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowConsole((prev) => !prev)}
              className="text-[11px] font-sans text-muted-foreground hover:text-foreground transition-colors"
            >
              {showConsole ? 'Minimize Console ▲' : 'Expand Logs ▼'}
            </button>
          </div>

          <div className="text-[11px] text-indigo-200/90 mb-2 font-sans font-medium flex items-center justify-between">
            <span>{currentTask.progressMsg}</span>
            <span className="text-[10px] text-muted-foreground font-mono">
              Short {fmtTime(currentTask.shortStart)}–{fmtTime(currentTask.shortEnd)}
            </span>
          </div>

          {showConsole && (
            <div className="max-h-36 overflow-y-auto space-y-1 rounded bg-black/80 p-2 border border-white/5 font-mono text-[11px]">
              {currentTask.logs.map((l, i) => (
                <div key={i} className="flex items-start gap-2 leading-snug">
                  <span className="text-muted-foreground shrink-0 select-none">[{l.time}]</span>
                  <span
                    className={
                      l.type === 'success'
                        ? 'text-emerald-400 font-semibold'
                        : l.type === 'warn'
                        ? 'text-amber-300 font-medium'
                        : l.type === 'error'
                        ? 'text-rose-400 font-semibold'
                        : 'text-zinc-300'
                    }
                  >
                    {l.msg}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bottom Action Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-transform active:scale-95 cursor-pointer"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause both' : 'Play both'}
        </button>

        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 rounded-md border border-input bg-card px-3 py-2 text-xs font-medium hover:bg-secondary transition-colors cursor-pointer"
          title="Restart playback from match start (R)"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Restart match
        </button>

        {/* Retry / Rescan Button with Model Selection (3.6, 3.7, 3.8) */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (isCurrentRescanning) return
              setShowModelPicker((prev) => !prev)
            }}
            disabled={isCurrentRescanning}
            className="flex items-center gap-1.5 rounded-md border border-indigo-500/50 bg-indigo-500/10 px-3.5 py-2 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/20 active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
            title="Choose Gemini Model (3.6, 3.7, 3.8) to rescan this scene with 4x auto-retry"
          >
            {isCurrentRescanning ? (
              <Loader2 className="size-3.5 animate-spin text-indigo-400" aria-hidden />
            ) : (
              <Sparkles className="size-3.5 text-indigo-400" aria-hidden />
            )}
            {isCurrentRescanning ? (
              <span>Rescanning (Attempt {currentTask?.attempt || 1}/4)...</span>
            ) : (
              <>
                <span>Rescan Scene (Retry)</span>
                <ChevronDown className="size-3 opacity-70" />
              </>
            )}
          </button>

          {/* Model Selection Menu */}
          {showModelPicker && !rescanning && (
            <div className="absolute bottom-full left-0 mb-2 w-60 rounded-lg border border-indigo-500/30 bg-card/95 p-1.5 shadow-xl backdrop-blur-md z-50 animate-in fade-in zoom-in-95">
              <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground border-b border-border/50 mb-1 flex items-center justify-between">
                <span>Choose Rescan Model:</span>
                <button
                  type="button"
                  onClick={() => setShowModelPicker(false)}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.7-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                  <span className="font-medium">Gemini 3.7 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">High Precision</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.8-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                  <span className="font-medium">Gemini 3.8 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Latest Gen</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRescanScene('gemini-3.6-flash')}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                  <span className="font-medium">Gemini 3.6 Flash</span>
                </div>
                <span className="text-[10px] text-muted-foreground">Fast Pool</span>
              </button>
              <div className="border-t border-border/40 my-1"></div>
              <button
                type="button"
                onClick={() => void handleRescanScene(undefined)}
                className="w-full flex items-center justify-between rounded px-2 py-1.5 text-xs text-foreground hover:bg-indigo-500/20 hover:text-indigo-300 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
                  <span className="font-medium">Auto (First Free)</span>
                </div>
                <span className="text-[10px] text-muted-foreground">3.6 / 3.7 / 3.8</span>
              </button>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isCurrentRescanned && (
            <span className="rounded-full bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-mono text-indigo-300">
              User Verified
            </span>
          )}
          <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {displayModelName(viewing ? viewing.model : pair.model)}
          </span>
        </div>
      </div>

      {/* Floating Bottom Toast Notification Banner with Sound & Jump Link */}
      {toastNotification && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="flex items-start gap-3 rounded-xl border border-indigo-500/50 bg-zinc-950/95 p-3.5 shadow-2xl backdrop-blur-md ring-1 ring-indigo-500/20">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              <Bell className="size-5 animate-bounce" />
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-foreground">{toastNotification.title}</p>
                <button
                  type="button"
                  onClick={() => setToastNotification(null)}
                  className="text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">{toastNotification.msg}</p>
              <button
                type="button"
                onClick={() => {
                  setIdx(toastNotification.pairIndex)
                  setToastNotification(null)
                }}
                className="mt-1 flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 active:scale-95 transition-all cursor-pointer"
              >
                Jump to Rescanned Scene →
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
