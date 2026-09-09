import type { Scan } from './types'

export interface ErrorCountDetails {
  highDemandOrRateLimit: number // 503 / 429 / Empty Response / Server Busy (No tokens billed)
  notFound404: number // 404 model / clip not found (No tokens billed)
  invalidKey: number // Invalid / expired key (No tokens billed)
  dailyExhausted: number // Daily 25M token or 20 RPD cap reached
  other: number
}

export interface ModelUsageCategory {
  chunkScan: number
  rescan: number
  verifier: number
  minuteFinder: number
  missingScene: number
  total: number // Total attempts made
  effective: number // Completed successful requests (Actual tokens/quota consumed)
  errors: ErrorCountDetails
}

export interface ScanUsageSummary {
  totalRequests: number // Total attempts made across all models
  effectiveRequests: number // Vastav me safal requests (Token quota deduct hua)
  totalErrors: number // Total failed/retried attempts (No token quota charged)
  errorBreakdown: ErrorCountDetails
  byModel: Record<string, ModelUsageCategory>
  byStage: {
    chunkScan: number
    rescan: number
    verifier: number
    minuteFinder: number
    missingScene: number
  }
  mainModels: {
    gemini37: number
    gemini38: number
    gemini36: number
    others: number
  }
}

/**
 * Computes exact AI request counts, distinguishing between effective (successful)
 * requests that consumed quota vs failed/high-demand/rate-limited/empty attempts.
 */
export function computeScanUsage(scan: Scan | null | undefined): ScanUsageSummary {
  const summary: ScanUsageSummary = {
    totalRequests: 0,
    effectiveRequests: 0,
    totalErrors: 0,
    errorBreakdown: {
      highDemandOrRateLimit: 0,
      notFound404: 0,
      invalidKey: 0,
      dailyExhausted: 0,
      other: 0,
    },
    byModel: {},
    byStage: {
      chunkScan: 0,
      rescan: 0,
      verifier: 0,
      minuteFinder: 0,
      missingScene: 0,
    },
    mainModels: {
      gemini37: 0,
      gemini38: 0,
      gemini36: 0,
      others: 0,
    },
  }

  if (!scan) return summary

  const getModelBucket = (modelId: string): ModelUsageCategory => {
    const cleanId = modelId.trim().toLowerCase()
    if (!summary.byModel[cleanId]) {
      summary.byModel[cleanId] = {
        chunkScan: 0,
        rescan: 0,
        verifier: 0,
        minuteFinder: 0,
        missingScene: 0,
        total: 0,
        effective: 0,
        errors: {
          highDemandOrRateLimit: 0,
          notFound404: 0,
          invalidKey: 0,
          dailyExhausted: 0,
          other: 0,
        },
      }
    }
    return summary.byModel[cleanId]
  }

  const recordRequest = (
    modelId: string,
    stage: keyof ScanUsageSummary['byStage'],
    isEffective: boolean,
    errorType?: keyof ErrorCountDetails,
  ) => {
    if (!modelId) return
    const cleanId = modelId.trim().toLowerCase()
    const bucket = getModelBucket(cleanId)

    bucket[stage] += 1
    bucket.total += 1
    summary.totalRequests += 1

    if (isEffective) {
      bucket.effective += 1
      summary.effectiveRequests += 1
      summary.byStage[stage] += 1

      if (cleanId.includes('3.7')) {
        summary.mainModels.gemini37 += 1
      } else if (cleanId.includes('3.8')) {
        summary.mainModels.gemini38 += 1
      } else if (cleanId.includes('3.6')) {
        summary.mainModels.gemini36 += 1
      } else {
        summary.mainModels.others += 1
      }
    } else {
      summary.totalErrors += 1
      const errKey = errorType || 'highDemandOrRateLimit'
      bucket.errors[errKey] += 1
      summary.errorBreakdown[errKey] += 1
    }
  }

  const loggedRequests = new Set<string>()

  // 1. Parse Scan Logs with precise error vs effective request differentiation
  if (Array.isArray(scan.logs)) {
    for (const entry of scan.logs) {
      const msg = entry.msg || ''
      const lower = msg.toLowerCase()

      // Determine Error Type if this log represents a failure/retry
      let isError = false
      let errorCategory: keyof ErrorCountDetails = 'highDemandOrRateLimit'

      if (
        lower.includes('rate limit') ||
        lower.includes('empty response') ||
        lower.includes('high demand') ||
        lower.includes('503') ||
        lower.includes('429') ||
        lower.includes('re-queued') ||
        lower.includes('overloaded') ||
        lower.includes('cooldown') ||
        lower.includes('failed on') ||
        (lower.includes('attempt') && lower.includes('failed'))
      ) {
        isError = true
        errorCategory = 'highDemandOrRateLimit'
      } else if (lower.includes('404') || lower.includes('not found') || lower.includes('unavailable')) {
        isError = true
        errorCategory = 'notFound404'
      } else if (lower.includes('invalid/expired') || lower.includes('invalid api key')) {
        isError = true
        errorCategory = 'invalidKey'
      } else if (lower.includes('daily quota') || lower.includes('quota exhausted') || lower.includes('tokens_per_model_per_user')) {
        isError = true
        errorCategory = 'dailyExhausted'
      }

      // Chunk mapping logs
      const chunkMatch = msg.match(/(?:Chunk\s+(\d+).*?on|mapping short.*on|Rate limit on)\s+(gemini-[\w.-]+)/i)
      if (
        chunkMatch &&
        !lower.includes('rescan') &&
        !lower.includes('verifier') &&
        !lower.includes('missing-scene')
      ) {
        const model = chunkMatch[2] || chunkMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `chunk-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}-${isError ? 'err' : 'ok'}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          recordRequest(rawModel, 'chunkScan', !isError, isError ? errorCategory : undefined)
        }
      }

      // Rescan logs
      const rescanMatch = msg.match(/rescan(?:ned|ning)?.*?on\s+(gemini-[\w.-]+)|\((gemini-[\w.-]+).*?rescan\)/i)
      if (rescanMatch) {
        const model = rescanMatch[1] || rescanMatch[2]
        const rawModel = normalizeModelName(model)
        const key = `rescan-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}-${isError ? 'err' : 'ok'}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          recordRequest(rawModel, 'rescan', !isError, isError ? errorCategory : undefined)
        }
      }

      // Verifier logs
      const verifierMatch = msg.match(/(?:Verifier|Batch Verifier).*?on\s+(gemini-[\w.-]+)/i)
      if (verifierMatch) {
        const model = verifierMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `verifier-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}-${isError ? 'err' : 'ok'}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          recordRequest(rawModel, 'verifier', !isError, isError ? errorCategory : undefined)
        }
      }

      // Missing-scene logs
      const missingMatch = msg.match(/Missing-scene.*?on\s+(gemini-[\w.-]+)/i)
      if (missingMatch) {
        const model = missingMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `missing-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}-${isError ? 'err' : 'ok'}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          recordRequest(rawModel, 'missingScene', !isError, isError ? errorCategory : undefined)
        }
      }

      // Minute Finder Window logs
      const windowMatch = msg.match(/(?:Window|pass window|Minute finder).*?on\s+(gemini-[\w.-]+)/i)
      if (windowMatch) {
        const model = windowMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `window-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}-${isError ? 'err' : 'ok'}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          recordRequest(rawModel, 'minuteFinder', !isError, isError ? errorCategory : undefined)
        }
      }
    }
  }

  // 2. Structural fallback if logs are empty/truncated
  if (scan.geminiPrescan) {
    if (Array.isArray(scan.geminiPrescan.windows)) {
      for (const w of scan.geminiPrescan.windows) {
        const laneModel = w.lane?.split('·')[1]?.trim()
        const model = normalizeModelName(laneModel || 'gemini-3.7-flash')
        if (summary.byStage.minuteFinder === 0) {
          recordRequest(model, 'minuteFinder', true)
        }
      }
    }
  }

  if (summary.byStage.chunkScan === 0) {
    const segments = scan.shortSegments || []
    const chunks = segments.flatMap((s) => s.chunks || [])
    const chunkList = chunks.length > 0 ? chunks : scan.chunks || []
    for (const c of chunkList) {
      if (c && (c.status === 'match' || c.status === 'no_match')) {
        const model = normalizeModelName(c.model || 'gemini-3.7-flash')
        recordRequest(model, 'chunkScan', true)
      }
    }
  }

  // Ensure default models exist in summary
  const defaultModels = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash']
  for (const m of defaultModels) {
    getModelBucket(m)
  }

  return summary
}

function normalizeModelName(name: string): string {
  if (!name) return 'gemini-3.7-flash'
  let clean = name.toLowerCase().trim()
  if (clean.includes('shiva')) {
    clean = clean.replace('shiva', 'flash')
  }
  if (!clean.startsWith('gemini-')) {
    clean = `gemini-${clean}`
  }
  if (clean.includes('3.7')) return 'gemini-3.7-flash'
  if (clean.includes('3.8')) return 'gemini-3.8-flash'
  if (clean.includes('3.6')) return 'gemini-3.6-flash'
  if (clean.includes('3.5-flash-lite') || clean.includes('3.5-lite')) return 'gemini-3.5-flash-lite'
  if (clean.includes('3.1-flash-lite') || clean.includes('3.1-lite')) return 'gemini-3.1-flash-lite'
  if (clean.includes('3.5-flash') || clean.includes('3.5')) return 'gemini-3.5-flash'
  if (clean.includes('3-flash-preview')) return 'gemini-3-flash-preview'
  return clean
}
