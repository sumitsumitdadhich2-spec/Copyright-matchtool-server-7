import 'server-only'

import { apiKeyHash, getModelUsage } from './store'
import { pacingIntervalMs, RATE_COOLDOWN_MS } from './models'

export interface CandidateLane {
  apiKey: string
  keyIdx: number
  modelId: string
  slot?: number
  rpd?: number
}

interface LaneWaiter {
  scanId: string
  scanTitle: string
  operation: string
  resolve: (releaseFn: (actualVideoSec?: number) => void) => void
  reject: (err: Error) => void
  isStopping?: () => boolean
}

interface GlobalLaneState {
  laneKey: string
  keyHash: string
  keyIdx: number
  modelId: string
  slot: number
  activeScanId: string | null
  activeScanTitle: string | null
  activeOperation: string | null
  activeSince: number | null
  nextFreeAt: number
  cooldownUntil: number
  isExhausted: boolean
  waiters: LaneWaiter[]
}

class GlobalGeminiCoordinator {
  private lanes = new Map<string, GlobalLaneState>()

  private getLaneKey(apiKey: string, modelId: string, slot: number = 0): string {
    return `${apiKeyHash(apiKey)}:${modelId}:${slot}`
  }

  private getOrCreateLane(apiKey: string, modelId: string, slot: number = 0, keyIdx: number = 1): GlobalLaneState {
    const key = this.getLaneKey(apiKey, modelId, slot)
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = {
        laneKey: key,
        keyHash: apiKeyHash(apiKey),
        keyIdx,
        modelId,
        slot,
        activeScanId: null,
        activeScanTitle: null,
        activeOperation: null,
        activeSince: null,
        nextFreeAt: 0,
        cooldownUntil: 0,
        isExhausted: false,
        waiters: [],
      }
      this.lanes.set(key, lane)
    }
    if (keyIdx > 0) lane.keyIdx = keyIdx
    return lane
  }

  /** Check if a lane is currently in use by ANY scan or in cooldown/pacing */
  public isLaneBusy(apiKey: string, modelId: string, slot: number = 0): {
    busy: boolean
    activeScanId?: string
    activeScanTitle?: string
    activeOperation?: string
    waitSec?: number
    cooling?: boolean
  } {
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    const now = Date.now()

    if (lane.activeScanId) {
      return {
        busy: true,
        activeScanId: lane.activeScanId,
        activeScanTitle: lane.activeScanTitle || undefined,
        activeOperation: lane.activeOperation || undefined,
      }
    }

    if (lane.cooldownUntil > now) {
      return {
        busy: true,
        cooling: true,
        waitSec: Math.ceil((lane.cooldownUntil - now) / 1000),
      }
    }

    if (lane.nextFreeAt > now) {
      return {
        busy: true,
        waitSec: Math.ceil((lane.nextFreeAt - now) / 1000),
      }
    }

    return { busy: false }
  }

  /**
   * Acquire an exclusive lock on a (Key × Model × Slot) lane across ALL scans in the entire application.
   * If another scan is using the lane or if the lane is in TPM pacing / 429 cooldown,
   * this will wait and yield gracefully without triggering duplicate requests or 429 collisions.
   */
  public async acquireLane(opts: {
    scanId: string
    scanTitle?: string
    apiKey: string
    keyIdx?: number
    modelId: string
    slot?: number
    operation: string
    videoSeconds?: number
    onWait?: (msg: string, waitSec: number) => void
    isStopping?: () => boolean
  }): Promise<(actualVideoSec?: number) => void> {
    const {
      scanId,
      scanTitle = scanId,
      apiKey,
      keyIdx = 1,
      modelId,
      slot = 0,
      operation,
      videoSeconds = 60,
      onWait,
      isStopping,
    } = opts

    const lane = this.getOrCreateLane(apiKey, modelId, slot, keyIdx)

    return new Promise<(actualVideoSec?: number) => void>((resolve, reject) => {
      const tryAcquireOrQueue = async () => {
        if (isStopping && isStopping()) {
          reject(new Error('Stop requested — lane acquisition cancelled'))
          return
        }

        const now = Date.now()

        // If lane is currently active in another scan OR there are earlier waiters queued
        const hasOtherActive = lane.activeScanId !== null
        const isQueuedBehindOthers = lane.waiters.length > 0 && lane.waiters[0]?.scanId !== scanId

        if (hasOtherActive || isQueuedBehindOthers) {
          const waitMsg = hasOtherActive
            ? `[Global Coordinator] Key ${lane.keyIdx} · ${modelId} is busy in Scan "${lane.activeScanTitle || lane.activeScanId}" (${lane.activeOperation || 'working'}). Waiting for lane to become free...`
            : `[Global Coordinator] Key ${lane.keyIdx} · ${modelId} is queued behind other scans. Waiting turn...`

          onWait?.(waitMsg, 5)

          lane.waiters.push({
            scanId,
            scanTitle,
            operation,
            resolve: (releaseFn) => resolve(releaseFn),
            reject,
            isStopping,
          })
          return
        }

        // Check 429 Cooldown
        if (lane.cooldownUntil > now) {
          const waitMs = lane.cooldownUntil - now
          const waitSec = Math.ceil(waitMs / 1000)
          onWait?.(
            `[Global Coordinator] Key ${lane.keyIdx} · ${modelId} is in 429 rate cooldown (${waitSec}s remaining). Waiting for rate limit reset...`,
            waitSec,
          )

          setTimeout(() => {
            if (isStopping && isStopping()) {
              reject(new Error('Stop requested during cooldown'))
              return
            }
            void this.processNext(lane)
          }, waitMs + 50)

          lane.waiters.push({
            scanId,
            scanTitle,
            operation,
            resolve: (releaseFn) => resolve(releaseFn),
            reject,
            isStopping,
          })
          return
        }

        // Check TPM pacing interval
        if (lane.nextFreeAt > now) {
          const waitMs = lane.nextFreeAt - now
          const waitSec = Math.ceil(waitMs / 1000)
          onWait?.(
            `[Global Coordinator] Key ${lane.keyIdx} · ${modelId} pacing wait (${waitSec}s for TPM quota). Pacing request...`,
            waitSec,
          )

          setTimeout(() => {
            if (isStopping && isStopping()) {
              reject(new Error('Stop requested during pacing wait'))
              return
            }
            void this.processNext(lane)
          }, waitMs + 20)

          lane.waiters.push({
            scanId,
            scanTitle,
            operation,
            resolve: (releaseFn) => resolve(releaseFn),
            reject,
            isStopping,
          })
          return
        }

        // Lock is free! Acquire exclusively now.
        lane.activeScanId = scanId
        lane.activeScanTitle = scanTitle
        lane.activeOperation = operation
        lane.activeSince = Date.now()

        const releaseFn = (actualVideoSec?: number) => {
          this.releaseLane(lane, actualVideoSec ?? videoSeconds)
        }

        resolve(releaseFn)
      }

      void tryAcquireOrQueue()
    })
  }

  /**
   * Dynamically search across multiple candidate lanes (different API keys and/or models).
   * 1. If any candidate lane is immediately free (not in use, not cooling, not pacing, not exhausted),
   *    grab that free lane instantly with ZERO wait!
   * 2. If all candidate lanes are busy, poll/re-evaluate EVERY 1 SECOND across ALL candidates.
   *    As soon as ANY lane (e.g. Key 3 · 3.8, or Key 2 · 3.6) frees up first,
   *    immediately shift to that newly freed lane and acquire it!
   */
  public async acquireFirstAvailableLane(opts: {
    scanId: string
    scanTitle?: string
    candidates: CandidateLane[]
    operation: string
    videoSeconds?: number
    onWait?: (msg: string, waitSec: number, candidateSummary: string) => void
    isStopping?: () => boolean
  }): Promise<{
    selected: CandidateLane
    release: (actualVideoSec?: number) => void
  }> {
    const {
      scanId,
      scanTitle = scanId,
      candidates,
      operation,
      videoSeconds = 60,
      onWait,
      isStopping,
    } = opts

    if (!candidates || candidates.length === 0) {
      throw new Error('No candidate lanes provided for execution')
    }

    let lastLoggedWaitMsg = ''

    while (true) {
      if (isStopping && isStopping()) {
        throw new Error('Stop requested — lane acquisition cancelled')
      }

      const now = Date.now()

      // 1. Filter out permanently exhausted / disabled lanes
      const availableCandidates = candidates.filter((c) => {
        const lane = this.getOrCreateLane(c.apiKey, c.modelId, c.slot || 0, c.keyIdx)
        if (lane.isExhausted) return false
        if (c.rpd && getModelUsage(c.modelId, c.apiKey) >= c.rpd) return false
        return true
      })

      if (availableCandidates.length === 0) {
        throw new Error('All candidate keys/models have reached their daily quota or are exhausted')
      }

      // 2. Check for immediately FREE lanes (no active scan, no cooldown, no pacing wait, no waiters)
      for (const cand of availableCandidates) {
        const lane = this.getOrCreateLane(cand.apiKey, cand.modelId, cand.slot || 0, cand.keyIdx)
        const isFree =
          lane.activeScanId === null &&
          lane.cooldownUntil <= now &&
          lane.nextFreeAt <= now &&
          lane.waiters.length === 0

        if (isFree) {
          // Immediately grab this free lane!
          lane.activeScanId = scanId
          lane.activeScanTitle = scanTitle
          lane.activeOperation = operation
          lane.activeSince = Date.now()

          const release = (actualVideoSec?: number) => {
            this.releaseLane(lane, actualVideoSec ?? videoSeconds)
          }

          return { selected: cand, release }
        }
      }

      // 3. None are immediately free. Calculate estimated shortest wait time across all candidate lanes
      const waits = availableCandidates.map((c) => {
        const lane = this.getOrCreateLane(c.apiKey, c.modelId, c.slot || 0, c.keyIdx)
        const cdWait = Math.max(0, lane.cooldownUntil - now)
        const paceWait = Math.max(0, lane.nextFreeAt - now)
        const activeWait = lane.activeScanId ? 4000 : 0
        const totalWait = Math.max(cdWait, paceWait, activeWait)
        return { c, lane, totalWait }
      })

      waits.sort((a, b) => a.totalWait - b.totalWait)
      const shortest = waits[0]
      const waitSec = Math.max(1, Math.ceil(shortest.totalWait / 1000))

      const candidateSummary = availableCandidates
        .map((c) => `Key ${c.keyIdx} (${c.modelId})`)
        .slice(0, 4)
        .join(', ')

      const waitMsg = `[Global Coordinator] All candidate lanes busy (${candidateSummary}${availableCandidates.length > 4 ? '...' : ''}). Re-checking every 1s for the first available lane (next free ~${waitSec}s)...`

      if (waitMsg !== lastLoggedWaitMsg) {
        lastLoggedWaitMsg = waitMsg
        onWait?.(waitMsg, waitSec, candidateSummary)
      }

      // 4. Sleep for 1 second (1000ms), then re-evaluate the whole pool immediately!
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  private releaseLane(lane: GlobalLaneState, videoSeconds: number) {
    const paceMs = pacingIntervalMs(videoSeconds)
    lane.nextFreeAt = Date.now() + paceMs
    lane.activeScanId = null
    lane.activeScanTitle = null
    lane.activeOperation = null
    lane.activeSince = null

    // Process next waiter in queue after pacing expires (or schedule it)
    if (lane.waiters.length > 0) {
      setTimeout(() => {
        void this.processNext(lane)
      }, paceMs + 20)
    }
  }

  private async processNext(lane: GlobalLaneState) {
    if (lane.activeScanId !== null) return // still busy

    while (lane.waiters.length > 0) {
      const next = lane.waiters.shift()
      if (!next) break

      if (next.isStopping && next.isStopping()) {
        next.reject(new Error('Stop requested while queued'))
        continue
      }

      const now = Date.now()
      if (lane.cooldownUntil > now) {
        // Still in cooldown, put back and wait
        lane.waiters.unshift(next)
        const waitMs = lane.cooldownUntil - now
        setTimeout(() => {
          void this.processNext(lane)
        }, waitMs + 50)
        return
      }

      if (lane.nextFreeAt > now) {
        // Still in pacing interval, put back and wait
        lane.waiters.unshift(next)
        const waitMs = lane.nextFreeAt - now
        setTimeout(() => {
          void this.processNext(lane)
        }, waitMs + 20)
        return
      }

      // Lane is free to take
      lane.activeScanId = next.scanId
      lane.activeScanTitle = next.scanTitle
      lane.activeOperation = next.operation
      lane.activeSince = Date.now()

      const releaseFn = (actualVideoSec?: number) => {
        this.releaseLane(lane, actualVideoSec ?? 60)
      }

      next.resolve(releaseFn)
      return
    }
  }

  /** Report a 429 Rate Limit error on a lane across the entire app */
  public reportRateLimit(apiKey: string, modelId: string, cooldownMs: number = RATE_COOLDOWN_MS, slot: number = 0) {
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    lane.cooldownUntil = Math.max(lane.cooldownUntil, Date.now() + cooldownMs)
  }

  /** Report that a model's daily quota has been exhausted across the entire app */
  public reportExhausted(apiKey: string, modelId: string, slot: number = 0) {
    const lane = this.getOrCreateLane(apiKey, modelId, slot)
    lane.isExhausted = true
  }

  /** Get snapshot summary of all active/busy lanes across the application */
  public getSnapshot(): Array<{
    laneKey: string
    keyIdx: number
    modelId: string
    activeScanId: string | null
    activeScanTitle: string | null
    activeOperation: string | null
    waitingCount: number
    cooling: boolean
    pacingWaitSec: number
  }> {
    const now = Date.now()
    return Array.from(this.lanes.values()).map((l) => ({
      laneKey: l.laneKey,
      keyIdx: l.keyIdx,
      modelId: l.modelId,
      activeScanId: l.activeScanId,
      activeScanTitle: l.activeScanTitle,
      activeOperation: l.activeOperation,
      waitingCount: l.waiters.length,
      cooling: l.cooldownUntil > now,
      pacingWaitSec: Math.max(0, Math.ceil((Math.max(l.nextFreeAt, l.cooldownUntil) - now) / 1000)),
    }))
  }
}

// Global Singleton instance shared across the entire Node.js server process
const globalCoordinatorKey = Symbol.for('__global_gemini_coordinator__')
const globalObj = globalThis as unknown as { [globalCoordinatorKey]?: GlobalGeminiCoordinator }

if (!globalObj[globalCoordinatorKey]) {
  globalObj[globalCoordinatorKey] = new GlobalGeminiCoordinator()
}

export const globalGeminiCoordinator = globalObj[globalCoordinatorKey]!
