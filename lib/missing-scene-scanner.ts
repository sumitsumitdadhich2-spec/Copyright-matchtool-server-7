import 'server-only'

import fs from 'node:fs'
import path from 'node:path'
import {
  getClient,
  uploadVideo,
  deleteFileQuiet,
  verifyRequest,
  parseVerdict,
} from './gemini'
import { CHUNK_MODEL_POOL, VERIFY_MODEL_POOL } from './models'
import { buildBackupClip, chunkPath, extractClipPrecise } from './ffmpeg'
import { localMediaPath, findAndReusePrescanMovie, findReusableGeminiMovieUpload, findAndReuseMovieChunks } from './media'
import { addLog, getScan, saveScan, scanMediaDir } from './store'
import { gapsOf, mergeRanges } from './short-coverage'
import { globalGeminiCoordinator } from './global-gemini-coordinator'
import type { ChunkMatch, MissingSceneCandidate, MissingSceneScanState, MissingSceneTarget, MissingSceneWindowHit, Scan } from './types'

const MINUTE_FINDER_WINDOW_SEC = 20 * 60 // 20 minutes

interface ScannerCtrl {
  scanId: string
  stopping: boolean
}

const activeControllers = new Map<string, ScannerCtrl>()

export function isMissingSceneScannerRunning(scanId: string): boolean {
  return activeControllers.has(scanId)
}

export function stopMissingSceneScanner(scanId: string): { ok: boolean; error?: string } {
  const ctrl = activeControllers.get(scanId)
  if (!ctrl) return { ok: false, error: 'Missing scene scan is not running' }
  ctrl.stopping = true
  const scan = getScan(scanId)
  if (scan?.missingSceneScan) {
    scan.missingSceneScan.status = 'stopped'
    scan.missingSceneScan.progress = 'Stopped by user'
    scan.missingSceneScan.finishedAt = Date.now()
    saveScan(scan)
    addLog(scan, 'warn', '[Missing Scene Finder] Search stopped by user')
  }
  return { ok: true }
}

/** Compute gaps in short video based on existing confirmed/verified matches */
export function getDetectedMissingScenes(scan: Scan): MissingSceneTarget[] {
  const shortDur = scan.shortDuration || 0
  if (shortDur <= 0) return []
  // Matches that genuinely cover the short video (excluding rejected ones)
  const matches = (scan.matches || [])
    .filter((m) => !m.rejected && m.batchVerified !== 'rejected')
    .map((m) => ({ start: m.shortStart, end: m.shortEnd }))
  const covered = mergeRanges(matches)
  const gaps = gapsOf(covered, shortDur).filter((g) => g.end - g.start >= 0.4)
  return gaps.map((g, idx) => ({
    id: `gap-${idx + 1}-${Math.round(g.start)}-${Math.round(g.end)}`,
    shortStart: Number(g.start.toFixed(3)),
    shortEnd: Number(g.end.toFixed(3)),
    duration: Number((g.end - g.start).toFixed(3)),
  }))
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function fmtMinSec(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseTs(ts: string): number | null {
  const m = ts.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const sec = Number(m[1]) * 60 + Number(m[2])
  return Number.isFinite(sec) ? sec : null
}

export async function startMissingSceneScanner(
  scanId: string,
  apiKeys: string[],
  user: { username: string; role: string },
  selectedScenes: Array<{ start: number; end: number; id?: string }>,
  windowIndices?: number[],
): Promise<{ ok: boolean; error?: string }> {
  const scan = getScan(scanId)
  if (!scan) return { ok: false, error: 'Scan not found' }
  if (activeControllers.has(scanId)) return { ok: false, error: 'Missing scene scan is already running' }
  if (apiKeys.length === 0) return { ok: false, error: 'Gemini API key is required' }
  if (!selectedScenes || selectedScenes.length === 0) {
    return { ok: false, error: 'Kripya kam se kam 1 missing scene select karein' }
  }

  const shortFile = localMediaPath(scanId, 'short')
  const movieFile = localMediaPath(scanId, 'movie')
  if (!fs.existsSync(/*turbopackIgnore: true*/ shortFile) || !fs.existsSync(/*turbopackIgnore: true*/ movieFile)) {
    return { ok: false, error: 'Short ya movie video file missing hai' }
  }

  const ctrl: ScannerCtrl = { scanId, stopping: false }
  activeControllers.set(scanId, ctrl)

  // Asynchronous background execution
  void runMissingSceneScanner(ctrl, scanId, apiKeys, selectedScenes, windowIndices).finally(() => {
    activeControllers.delete(scanId)
  })

  return { ok: true }
}

async function runMissingSceneScanner(
  ctrl: ScannerCtrl,
  scanId: string,
  apiKeys: string[],
  selectedScenes: Array<{ start: number; end: number; id?: string }>,
  windowIndices?: number[],
) {
  const scan = getScan(scanId)
  if (!scan) return

  const mediaDir = scanMediaDir(scanId)
  const chunksDir = path.join(mediaDir, 'chunks')
  fs.mkdirSync(chunksDir, { recursive: true })

  const shortFile = localMediaPath(scanId, 'short')
  const movieFile = localMediaPath(scanId, 'movie')

  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0
  const copyDuration = Math.max(1, trimEnd - trimStart)

  const targets: MissingSceneTarget[] = selectedScenes.map((s, idx) => ({
    id: s.id || `scene-${idx + 1}-${Math.round(s.start)}-${Math.round(s.end)}`,
    shortStart: Number(s.start.toFixed(3)),
    shortEnd: Number(s.end.toFixed(3)),
    duration: Number((s.end - s.start).toFixed(3)),
  }))

  const state: MissingSceneScanState = {
    status: 'preparing',
    progress: `Preparing clip(s) for ${targets.length} missing scene(s)...`,
    selectedScenes: targets,
    windowHits: [],
    candidates: [],
    addedMatches: [],
    startedAt: Date.now(),
  }
  scan.missingSceneScan = state
  saveScan(scan)
  addLog(scan, 'info', `[Missing Scene Finder] Initialized for ${targets.length} scene(s): ${targets.map((t) => `${fmtTime(t.shortStart)}–${fmtTime(t.shortEnd)}`).join(', ')}`)

  const primaryApiKey = apiKeys[0]
  const ai = getClient(primaryApiKey)
  const uploadedFilesToClean: string[] = []

  try {
    // 1. Cut the target short clip (single scene or merged multi-scene)
    const clipOutFile = path.join(mediaDir, `missing-scene-clip-${Date.now()}.mp4`)
    let partMapText = ''
    let sceneParts: Array<{ partNum: number; clipStart: number; clipEnd: number; target: MissingSceneTarget }> = []

    if (targets.length === 1) {
      const t = targets[0]
      state.progress = `Cutting clip for scene ${fmtTime(t.shortStart)}–${fmtTime(t.shortEnd)}...`
      saveScan(scan)
      await extractClipPrecise(shortFile, t.shortStart, t.shortEnd, clipOutFile)
      t.clipStart = 0
      t.clipEnd = t.duration
      sceneParts = [{ partNum: 1, clipStart: 0, clipEnd: t.duration, target: t }]
      partMapText = `Part 1: Clip time 00:00 - ${fmtMinSec(t.duration)} (Original Short Video timestamp: ${fmtTime(t.shortStart)} - ${fmtTime(t.shortEnd)})`
    } else {
      state.progress = `Merging ${targets.length} missing scenes into single clip with 1s gap...`
      saveScan(scan)
      const res = await buildBackupClip(
        shortFile,
        targets.map((t) => ({ start: t.shortStart, end: t.shortEnd })),
        clipOutFile,
      )
      sceneParts = res.parts.map((p, idx) => {
        const t = targets[idx]
        t.clipStart = p.clipStart
        t.clipEnd = p.clipEnd
        return { partNum: idx + 1, clipStart: p.clipStart, clipEnd: p.clipEnd, target: t }
      })
      partMapText = sceneParts
        .map(
          (p) =>
            `Part ${p.partNum}: Clip time ${fmtMinSec(p.clipStart)} - ${fmtMinSec(p.clipEnd)} (Original Short Video timestamp: ${fmtTime(p.target.shortStart)} - ${fmtTime(p.target.shortEnd)})`,
        )
        .join('\n')
    }

    if (ctrl.stopping) return

    // 2. Upload missing scene clip to Gemini Files API
    state.progress = 'Uploading missing scene clip to Gemini...'
    saveScan(scan)
    const clipUpload = await uploadVideo(ai, clipOutFile, 'Missing Scene Short Clip')
    uploadedFilesToClean.push(clipUpload.name)

    // 3. Ensure movie copy is available
    let movieCopyPath = path.join(mediaDir, 'prescan-movie.mp4')
    if (!fs.existsSync(/*turbopackIgnore: true*/ movieCopyPath)) {
      const reused = await findAndReusePrescanMovie(scanId, trimStart, trimEnd, mediaDir)
      if (reused) {
        movieCopyPath = reused.path
      } else {
        // Fallback: use movieFile if no copy
        movieCopyPath = movieFile
      }
    }

    // Check if movie copy is already on Gemini Files API
    const primaryKeyId = apiKeyHash(primaryApiKey)
    let movieUploadUri = scan.geminiPrescan?.uploads?.[primaryKeyId]?.movieUri

    if (!movieUploadUri) {
      const reusableUpload = findReusableGeminiMovieUpload(
        scan.movieName || '',
        scan.movieSize || 0,
        primaryKeyId,
        trimStart,
        trimEnd,
        scanId,
      )
      if (reusableUpload) {
        movieUploadUri = reusableUpload.uri
      } else {
        state.progress = 'Uploading movie copy to Gemini Files API...'
        saveScan(scan)
        const up = await uploadVideo(ai, movieCopyPath, 'Prescan Movie Copy')
        movieUploadUri = up.uri
        uploadedFilesToClean.push(up.name)
      }
    }

    if (ctrl.stopping) return

    // 4. Windows generation (20-min chunks)
    const allWindows: Array<{ index: number; start: number; end: number }> = []
    for (let t = 0, i = 0; t < copyDuration - 0.5; t += MINUTE_FINDER_WINDOW_SEC, i++) {
      allWindows.push({ index: i, start: t, end: Math.min(t + MINUTE_FINDER_WINDOW_SEC, copyDuration) })
    }

    const selectedIndices = windowIndices && windowIndices.length > 0 ? new Set(windowIndices) : null
    const windowsToScan = allWindows.filter((w) => (selectedIndices ? selectedIndices.has(w.index) : true))

    state.status = 'scanning_windows'
    state.progress = `Scanning ${windowsToScan.length} movie window(s) (20-min each) for missing scene(s)...`
    saveScan(scan)
    addLog(scan, 'info', `[Missing Scene Finder] Starting 20-min window scan across ${windowsToScan.length} window(s)...`)

    // Build the window prompt
    const windowPrompt = `You are a forensic video analyst searching for SPECIFIC MISSING SCENE(S) from an edited short video in a movie window.

Video 1: A clip containing ${targets.length} missing scene(s) from the short video:
${partMapText}

Video 2: A 20-MINUTE WINDOW of the original movie.
Your mission:
Check if ANY of the missing scene(s) in Video 1 appear in Video 2 (this 20-minute window).
Identify the EXACT MOVIE MINUTE (e.g. Minute 42 = 42:00 to 43:00) where the scene appears so we can scan and verify the chunk at 24 fps.

Respond in Hinglish:
=====================
HISSA 1 — SCENE SUMMARY & DIALOGUE
=====================
For each Part in Video 1, note actors, actions, and verbatim quoted dialogue.

=====================
HISSA 2 — WINDOW SEARCH RESULTS
=====================
For each Part:
If MATCH:
PART <n>: MATCH | Movie time mm:ss - mm:ss | Movie Minute: <number> | Confidence: HIGH/MEDIUM | Evidence: "<dialogue quote or exact visual action>"

If NOT FOUND:
PART <n>: NOT FOUND — not in this 20-minute window`

    const windowHits: MissingSceneWindowHit[] = []
    const candidateMinutes = new Set<number>()

    // Run window scan
    let completedWindows = 0
    for (const win of windowsToScan) {
      if (ctrl.stopping) break

      const winStartAbs = trimStart + win.start
      const winEndAbs = trimStart + win.end
      const winLabel = `Window ${win.index + 1} (${fmtMinSec(winStartAbs)}–${fmtMinSec(winEndAbs)})`

      state.progress = `Scanning ${winLabel} (${completedWindows + 1}/${windowsToScan.length})...`
      saveScan(scan)

      let releaseGlobalLock: ((sec?: number) => void) | null = null
      try {
        const candLanes = CHUNK_MODEL_POOL.map((m) => ({
          apiKey: primaryApiKey,
          keyIdx: 1,
          modelId: m.id,
          rpd: m.rpd,
        }))

        const { selected, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
          scanId,
          scanTitle: scan.shortName || scanId,
          candidates: candLanes,
          operation: `Missing Scene ${winLabel}`,
          videoSeconds: 60,
          onWait: (msg) => addLog(scan, 'info', msg),
          isStopping: () => ctrl.stopping,
        })
        releaseGlobalLock = release

        const runnerAi = selected.apiKey === primaryApiKey ? ai : new GoogleGenAI({ apiKey: selected.apiKey })
        const resp = await runnerAi.models.generateContent({
          model: selected.modelId,
          contents: [
            {
              role: 'user',
              parts: [
                { fileData: { fileUri: clipUpload.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 10 } },
                {
                  fileData: { fileUri: movieUploadUri, mimeType: 'video/mp4' },
                  videoMetadata: { fps: 1, startOffset: `${Math.round(win.start)}s`, endOffset: `${Math.round(win.end)}s` },
                },
                { text: windowPrompt },
              ],
            },
          ],
        })

        const text = resp.text || ''
        completedWindows++

        // Parse matches
        const lines = text.split('\n')
        for (const line of lines) {
          const matchRegex = /PART\s*(\d+).*?(?:MATCH|FOUND)/i
          const partMatch = line.match(matchRegex)
          if (partMatch) {
            const partNum = parseInt(partMatch[1], 10)
            const scenePart = sceneParts.find((p) => p.partNum === partNum) || sceneParts[0]

            let foundMinute: number | null = null
            const minRegex = /Movie Minute\s*:\s*(\d+)/i
            const minM = line.match(minRegex)
            if (minM) {
              foundMinute = parseInt(minM[1], 10)
            } else {
              const timeRegex = /(\d{1,2}:\d{2}(?:\.\d+)?)\s*-\s*(\d{1,2}:\d{2}(?:\.\d+)?)/
              const timeM = line.match(timeRegex)
              if (timeM) {
                const parsedT = parseTs(timeM[1])
                if (parsedT !== null) {
                  const absSec = parsedT < win.end ? winStartAbs + parsedT : parsedT
                  foundMinute = Math.floor(absSec / 60)
                }
              }
            }

            if (foundMinute !== null && foundMinute >= 0) {
              candidateMinutes.add(foundMinute)
              const hit: MissingSceneWindowHit = {
                windowIndex: win.index,
                windowStart: winStartAbs,
                windowEnd: winEndAbs,
                movieMinute: foundMinute,
                sceneId: scenePart.target.id,
                shortStart: scenePart.target.shortStart,
                shortEnd: scenePart.target.shortEnd,
                evidence: line.slice(0, 150),
                confidence: line.includes('HIGH') ? 'HIGH' : 'MEDIUM',
              }
              windowHits.push(hit)
              state.windowHits = [...windowHits]
              saveScan(scan)
              addLog(
                scan,
                'success',
                `[Missing Scene Finder] ${winLabel}: Found scene ${fmtTime(scenePart.target.shortStart)}–${fmtTime(scenePart.target.shortEnd)} in Movie Minute ${foundMinute}!`,
              )
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        addLog(scan, 'warn', `[Missing Scene Finder] ${winLabel} failed: ${msg.slice(0, 120)}`)
      } finally {
        if (releaseGlobalLock) releaseGlobalLock(60)
      }
    }

    if (ctrl.stopping) return

    if (candidateMinutes.size === 0) {
      state.status = 'done'
      state.progress = 'Window scan complete — selected missing scene(s) were not found in movie windows.'
      state.finishedAt = Date.now()
      saveScan(scan)
      addLog(scan, 'warn', '[Missing Scene Finder] None of the selected missing scenes were detected in the scanned windows.')
      return
    }

    // 5. Chunk Scan for detected minutes
    state.status = 'scanning_chunks'
    state.progress = `Scanning 1-minute chunks for ${candidateMinutes.size} candidate minute(s)...`
    saveScan(scan)
    addLog(scan, 'info', `[Missing Scene Finder] Found ${candidateMinutes.size} candidate minute(s): [${Array.from(candidateMinutes).join(', ')}]. Slicing chunks and searching...`)

    // Reuse existing chunks from this scan or other scans
    await findAndReuseMovieChunks(scanId, trimStart, trimEnd)

    const candidates: MissingSceneCandidate[] = []

    for (const minute of Array.from(candidateMinutes)) {
      if (ctrl.stopping) break

      const chunkIdx = minute
      const chunkStart = chunkIdx * 60
      const chunkEnd = chunkStart + 60
      const chunkFile = chunkPath(chunksDir, chunkIdx)

      state.progress = `Processing Chunk ${chunkIdx + 1} (${fmtMinSec(chunkStart)}–${fmtMinSec(chunkEnd)})...`
      saveScan(scan)

      if (!fs.existsSync(/*turbopackIgnore: true*/ chunkFile)) {
        await extractClipPrecise(movieFile, chunkStart, chunkEnd, chunkFile)
      }

      // Upload chunk to Gemini
      try {
        const up = await uploadVideo(ai, chunkFile, `Movie Chunk ${chunkIdx + 1}`)
        uploadedFilesToClean.push(up.name)

        const chunkPrompt = `You are a forensic video analyst.
- Video 1: Missing scene clip from the short video:
${partMapText}

- Video 2: 1-minute chunk cut from the movie (Minute ${minute} = ${fmtMinSec(chunkStart)} to ${fmtMinSec(chunkEnd)}).

Find if any part of Video 1 appears in Video 2.
Respond in Hinglish:
HISSA 1 — SHORT SCENE TIME MAP
mm:ss - mm:ss: <short description + exact quoted dialogue>

HISSA 2 — MOVIE MAP TIME
Map the scene to Video 2:
Short mm:ss.mmm - mm:ss.mmm --> Movie mm:ss.mmm - mm:ss.mmm
or:
Short mm:ss.mmm - mm:ss.mmm --> NOT FOUND`

        let releaseChunkLock: ((sec?: number) => void) | null = null
        try {
          const apiKeys = scan.apiKeys && scan.apiKeys.length > 0 ? scan.apiKeys : [primaryApiKey]
          const candLanes = apiKeys.flatMap((k, ki) =>
            CHUNK_MODEL_POOL.map((m) => ({
              apiKey: k,
              keyIdx: ki + 1,
              modelId: m.id,
              rpd: m.rpd,
            })),
          )

          const { selected, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
            scanId,
            scanTitle: scan.shortName || scanId,
            candidates: candLanes,
            operation: `Missing Scene Chunk ${chunkIdx + 1} Map`,
            videoSeconds: 60,
            onWait: (msg) => addLog(scan, 'info', msg),
            isStopping: () => ctrl.stopping,
          })
          releaseChunkLock = release

          const runnerAi = selected.apiKey === primaryApiKey ? ai : new GoogleGenAI({ apiKey: selected.apiKey })
          const resp = await runnerAi.models.generateContent({
            model: selected.modelId,
            contents: [
              {
                role: 'user',
                parts: [
                  { fileData: { fileUri: clipUpload.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 10 } },
                  { fileData: { fileUri: up.uri, mimeType: 'video/mp4' }, videoMetadata: { fps: 10 } },
                  { text: chunkPrompt },
                ],
              },
            ],
          })

          const cText = resp.text || ''
          const mapRegex = /(\d{1,2}:\d{2}(?:\.\d+)?)\s*-\s*(\d{1,2}:\d{2}(?:\.\d+)?)\s*-->\s*(?:Movie\s*)?(\d{1,2}:\d{2}(?:\.\d+)?)\s*-\s*(\d{1,2}:\d{2}(?:\.\d+)?)/gi
          let match: RegExpExecArray | null

          while ((match = mapRegex.exec(cText)) !== null) {
            const s1 = parseTs(match[1])
            const s2 = parseTs(match[2])
            const m1 = parseTs(match[3])
            const m2 = parseTs(match[4])

            if (s1 !== null && s2 !== null && m1 !== null && m2 !== null) {
              // Find which target scene this corresponds to
              let matchedTarget = targets[0]
              for (const sp of sceneParts) {
                if (s1 >= sp.clipStart - 1 && s1 <= sp.clipEnd + 1) {
                  matchedTarget = sp.target
                  break
                }
              }

              const absShortStart = matchedTarget.shortStart + (s1 - (matchedTarget.clipStart || 0))
              const absShortEnd = matchedTarget.shortStart + (s2 - (matchedTarget.clipStart || 0))
              const absMovieStart = chunkStart + m1
              const absMovieEnd = chunkStart + m2

              const cand: MissingSceneCandidate = {
                id: `missing-cand-${chunkIdx}-${Date.now()}-${candidates.length}`,
                sceneId: matchedTarget.id,
                shortStart: Math.max(0, Number(absShortStart.toFixed(3))),
                shortEnd: Number(absShortEnd.toFixed(3)),
                movieMinute: minute,
                chunkIndex: chunkIdx,
                movieStart: Math.max(0, Number(absMovieStart.toFixed(3))),
                movieEnd: Number(absMovieEnd.toFixed(3)),
                model,
                status: 'pending',
              }
              candidates.push(cand)
              state.candidates = [...candidates]
              saveScan(scan)
              addLog(
                scan,
                'info',
                `[Missing Scene Finder] Chunk ${chunkIdx + 1} match candidate: Short ${fmtTime(cand.shortStart)}–${fmtTime(cand.shortEnd)} --> Movie ${fmtTime(cand.movieStart)}–${fmtTime(cand.movieEnd)}`,
              )
            }
          }
        } finally {
          if (releaseChunkLock) releaseChunkLock(60)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        addLog(scan, 'warn', `[Missing Scene Finder] Chunk ${chunkIdx + 1} mapping error: ${msg.slice(0, 120)}`)
      }
    }

    if (ctrl.stopping) return

    // 6. 24 FPS Verification for all candidates
    if (candidates.length > 0) {
      state.status = 'verifying'
      state.progress = `Verifying ${candidates.length} candidate match(es) at 24 fps...`
      saveScan(scan)
      addLog(scan, 'info', `[Missing Scene Finder] Starting 24 fps frame-by-frame verification for ${candidates.length} candidate(s)...`)

      for (const cand of candidates) {
        if (ctrl.stopping) break

        cand.status = 'verifying'
        saveScan(scan)

        const vShortClip = path.join(mediaDir, `verify-short-${cand.id}.mp4`)
        const vMovieClip = path.join(mediaDir, `verify-movie-${cand.id}.mp4`)

        try {
          // Cut short and movie clips precisely at 24 fps
          await extractClipPrecise(shortFile, cand.shortStart, cand.shortEnd, vShortClip)
          await extractClipPrecise(movieFile, cand.movieStart, cand.movieEnd, vMovieClip)

          const upShort = await uploadVideo(ai, vShortClip, `Verify Short ${cand.id}`)
          const upMovie = await uploadVideo(ai, vMovieClip, `Verify Movie ${cand.id}`)
          uploadedFilesToClean.push(upShort.name, upMovie.name)

          const clipSec = Math.max(cand.shortEnd - cand.shortStart, cand.movieEnd - cand.movieStart, 5)
          let releaseVLock: ((sec?: number) => void) | null = null
          try {
            const apiKeys = scan.apiKeys && scan.apiKeys.length > 0 ? scan.apiKeys : [primaryApiKey]
            const candLanes = apiKeys.flatMap((k, ki) =>
              VERIFY_MODEL_POOL.map((m) => ({
                apiKey: k,
                keyIdx: ki + 1,
                modelId: m.id,
                rpd: m.rpd,
              })),
            )

            const { selected, release } = await globalGeminiCoordinator.acquireFirstAvailableLane({
              scanId,
              scanTitle: scan.shortName || scanId,
              candidates: candLanes,
              operation: `Missing Scene Verify Short ${fmtTime(cand.shortStart)}`,
              videoSeconds: clipSec,
              onWait: (msg) => addLog(scan, 'info', msg),
              isStopping: () => ctrl.stopping,
            })
            releaseVLock = release

            const runnerAi = selected.apiKey === primaryApiKey ? ai : new GoogleGenAI({ apiKey: selected.apiKey })
            const vResp = await verifyRequest(runnerAi, selected.modelId, upShort.uri, upMovie.uri)
            const verdict = parseVerdict(vResp)

            cand.verifierModel = selected.modelId
            cand.verifierReason = verdict?.reason || ''
            cand.verified = verdict?.same === true

            if (verdict?.same) {
              cand.status = 'confirmed'
              const confirmedMatch: ChunkMatch = {
                chunkIndex: cand.chunkIndex,
                shortStart: cand.shortStart,
                shortEnd: cand.shortEnd,
                movieStart: cand.movieStart,
                movieEnd: cand.movieEnd,
                confidence: 0.98,
                reason: `Targeted missing scene verified at 24 fps (${cand.verifierReason})`,
                model: cand.model,
                verified: true,
                verifierModel: selected.modelId,
                verifierReason: cand.verifierReason,
                origin: 'gap-backup',
              }

              // Merge into scan.matches
              if (!Array.isArray(scan.matches)) scan.matches = []
              scan.matches = [...scan.matches.filter((m) => !(m.shortStart >= cand.shortStart && m.shortEnd <= cand.shortEnd)), confirmedMatch]
              scan.matches.sort((a, b) => a.shortStart - b.shortStart)

              state.addedMatches = state.addedMatches || []
              state.addedMatches.push(confirmedMatch)

              saveScan(scan)
              addLog(
                scan,
                'success',
                `[Missing Scene Finder] 24 FPS VERIFIED SAME! Short ${fmtTime(cand.shortStart)}–${fmtTime(cand.shortEnd)} matches Movie ${fmtTime(cand.movieStart)}–${fmtTime(cand.movieEnd)}!`,
              )
            } else {
              cand.status = 'rejected'
              saveScan(scan)
              addLog(
                scan,
                'info',
                `[Missing Scene Finder] 24 FPS Verifier: DIFFERENT for candidate ${fmtTime(cand.shortStart)}–${fmtTime(cand.shortEnd)} (${cand.verifierReason})`,
              )
            }
          } finally {
            if (releaseVLock) releaseVLock(clipSec)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          cand.status = 'rejected'
          cand.verifierReason = msg.slice(0, 100)
          saveScan(scan)
          addLog(scan, 'warn', `[Missing Scene Finder] Verification failed for candidate: ${msg.slice(0, 100)}`)
        } finally {
          try {
            if (fs.existsSync(/*turbopackIgnore: true*/ vShortClip)) fs.unlinkSync(vShortClip)
            if (fs.existsSync(/*turbopackIgnore: true*/ vMovieClip)) fs.unlinkSync(vMovieClip)
          } catch {}
        }
      }
    }

    state.status = 'done'
    state.progress = `Missing scene scan completed! ${state.addedMatches?.length || 0} match(es) verified & added to results.`
    state.finishedAt = Date.now()
    saveScan(scan)
    addLog(
      scan,
      'success',
      `[Missing Scene Finder] Scan finished! Added ${state.addedMatches?.length || 0} confirmed 24 fps match(es).`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.status = 'error'
    state.error = msg
    state.progress = `Error: ${msg.slice(0, 150)}`
    saveScan(scan)
    addLog(scan, 'error', `[Missing Scene Finder] Error: ${msg}`)
  } finally {
    // Clean up uploaded Gemini files
    for (const name of uploadedFilesToClean) {
      void deleteFileQuiet(ai, name).catch(() => {})
    }
  }
}
