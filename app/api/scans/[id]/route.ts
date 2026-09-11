import path from 'node:path'
import { NextResponse } from 'next/server'
import { getScan, saveScan, addLog, getApiKey, getAllUsage, deleteScan, SCANS_DIR, scanMediaDir } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { invalidateUsageCache, findAndReuseMovieChunks, localMediaPath } from '@/lib/media'
import { chunkMovie } from '@/lib/ffmpeg'
import { scheduler } from '@/lib/scheduler'
import { ensureBackgroundWorkers, stopBackgroundScan } from '@/lib/background-queue'
import { getSession } from '@/lib/users'
import { isMinuteFinderRunning, stopGeminiMinuteFinder } from '@/lib/gemini-minute-finder'
import { cancelRender } from '@/lib/render'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'
import { pipelineReady } from '@/lib/merge-pipeline'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ensureBackgroundWorkers()
  const { id } = await ctx.params
  // Single long-lived server: the local JSON is always the freshest copy.
  let scan = getScan(id)
  if (!scan) {
    // Fresh instance: the record may only exist in S3.
    await restoreScans(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const key = getApiKey()
  return NextResponse.json({
    scan,
    running: scheduler.isRunning(id),
    usage: key ? getAllUsage(key) : null,
  })
}

/** Delete a scan completely: record + local files + work dirs + ALL S3 objects. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  await restoreScans(SCANS_DIR)
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Stop queued/running scan work, minute finder, and renders before removing files.
  await stopBackgroundScan(id)
  if (scheduler.isRunning(id)) scheduler.stop(id)
  if (isMinuteFinderRunning(id)) stopGeminiMinuteFinder(id)
  cancelRender(id)

  deleteScan(id)
  invalidateUsageCache()
  return NextResponse.json({ ok: true, deleted: id })
}

/** Update scan properties (e.g. verifierEnabled toggle). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = (await req.json().catch(() => ({}))) as { verifierEnabled?: boolean; autoMode?: boolean; customName?: string }
  let updated = false

  if (body.customName !== undefined) {
    scan.customName = typeof body.customName === 'string' ? body.customName.trim() || null : null
    updated = true
  }

  if (body.verifierEnabled !== undefined) {
    const enabled = Boolean(body.verifierEnabled)
    scan.verifierEnabled = enabled
    scheduler.setVerifierEnabled(id, enabled)
    updated = true
  }

  if (body.autoMode !== undefined) {
    const enabled = Boolean(body.autoMode)
    scan.autoMode = enabled
    updated = true

    if (enabled && scan.awaitingTrim && scan.movieDuration && scan.status !== 'chunking' && scan.status !== 'scanning') {
      scan.awaitingTrim = false
      scan.movieTrimStart = undefined
      scan.movieTrimEnd = undefined
      const dur = scan.movieDuration
      const count = Math.max(1, Math.ceil(dur / 60))
      scan.chunkCount = count
      scan.chunks = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
      if (scan.shortSegments) {
        for (const seg of scan.shortSegments) {
          seg.chunks = []
          if (seg.status !== 'pending') seg.status = 'pending'
        }
      }
      scan.status = 'chunking'
      scan.chunkingProgress = 0
      addLog(scan, 'info', `Auto mode ON: full movie auto-selected (${count} chunks), cutting in background`)
      saveScan(scan, { immediate: true })

      if (pipelineReady(scan)) {
        void dispatchMinuteFinder(id, { username: sessionUser.username, role: sessionUser.role })
      }

      const mediaDir = scanMediaDir(id)
      const dest = localMediaPath(id, 'movie')
      void (async () => {
        try {
          const reused = await findAndReuseMovieChunks(id, scan.movieName || '', scan.movieSize || 0, 0, dur, count)
          if (reused.ok) {
            const s = getScan(id)
            if (s) {
              s.chunkCount = reused.count
              s.chunks = Array.from({ length: reused.count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
              s.status = 'ready'
              s.chunkingProgress = 100
              addLog(s, 'success', `Reused ${reused.count} 1-min movie chunks from previous scan (no re-cutting needed)`)
              saveScan(s)
            }
            return
          }
          const actual = await chunkMovie(dest, path.join(mediaDir, 'chunks'), dur, (pct) => {
            const s = getScan(id)
            if (s) {
              s.chunkingProgress = pct
              saveScan(s)
            }
          })
          const s = getScan(id)
          if (s) {
            s.chunkCount = actual
            s.chunks = Array.from({ length: actual }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
            s.status = 'ready'
            s.chunkingProgress = 100
            addLog(s, 'success', `Movie chunking complete: ${actual} × 1-minute file(s)`)
            saveScan(s)
          }
        } catch (err) {
          const s = getScan(id)
          if (s) {
            s.status = 'error'
            addLog(s, 'error', `Movie chunking failed: ${err instanceof Error ? err.message : String(err)}`)
            saveScan(s)
          }
        }
      })()
    }
  }

  if (updated) {
    saveScan(scan, { immediate: true })
  }

  return NextResponse.json({ ok: true, customName: scan.customName, verifierEnabled: scan.verifierEnabled, autoMode: scan.autoMode })
}

