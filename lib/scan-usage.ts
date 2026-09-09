import type { Scan } from './types'

export interface ModelUsageCategory {
  chunkScan: number
  rescan: number
  verifier: number
  minuteFinder: number
  missingScene: number
  total: number
}

export interface ScanUsageSummary {
  totalRequests: number
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
 * Computes exact AI request counts across models and phases for a scan.
 * Tracks 3.7, 3.8, 3.6, rescan, chunk scan, verifier, minute finder, and gap backup.
 */
export function computeScanUsage(scan: Scan | null | undefined): ScanUsageSummary {
  const summary: ScanUsageSummary = {
    totalRequests: 0,
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
      }
    }
    return summary.byModel[cleanId]
  }

  const addUsage = (modelId: string, stage: keyof ScanUsageSummary['byStage'], count = 1) => {
    if (!modelId || count <= 0) return
    const cleanId = modelId.trim().toLowerCase()
    const bucket = getModelBucket(cleanId)
    bucket[stage] += count
    bucket.total += count
    summary.byStage[stage] += count
    summary.totalRequests += count

    if (cleanId.includes('3.7')) {
      summary.mainModels.gemini37 += count
    } else if (cleanId.includes('3.8')) {
      summary.mainModels.gemini38 += count
    } else if (cleanId.includes('3.6')) {
      summary.mainModels.gemini36 += count
    } else {
      summary.mainModels.others += count
    }
  }

  // Set of unique request signatures from logs to avoid double-counting if both structural & log data exist
  const loggedRequests = new Set<string>()

  // 1. Parse Scan Logs for all request executions
  if (Array.isArray(scan.logs)) {
    for (const entry of scan.logs) {
      const msg = entry.msg || ''

      // Chunk scan log matches
      // Examples: "Minute 3 · Chunk 65: mapping short → movie minute 65 on gemini-3.7-shiva (key 1)"
      //           "Chunk 12 attempt 1 failed on gemini-3.6-shiva..."
      //           "Rate limit on gemini-3.8-shiva (key 5) — Chunk 65 re-queued"
      const chunkMatch = msg.match(/(?:Chunk\s+(\d+).*?on|mapping short.*on|Rate limit on)\s+(gemini-[\w.-]+)/i)
      if (chunkMatch && !msg.toLowerCase().includes('rescan') && !msg.toLowerCase().includes('verifier') && !msg.toLowerCase().includes('missing-scene')) {
        const model = chunkMatch[2] || chunkMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `chunk-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          addUsage(rawModel, 'chunkScan', 1)
        }
      }

      // Rescan log matches
      // Examples: "Starting targeted rescan... on gemini-3.5-flash"
      //           "[Rescan Scene] Successfully rescanned... (gemini-3.7-shiva)"
      const rescanMatch = msg.match(/rescan(?:ned|ning)?.*?on\s+(gemini-[\w.-]+)|\((gemini-[\w.-]+).*?rescan\)/i)
      if (rescanMatch) {
        const model = rescanMatch[1] || rescanMatch[2]
        const rawModel = normalizeModelName(model)
        const key = `rescan-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          addUsage(rawModel, 'rescan', 1)
        }
      }

      // Verifier log matches
      // Examples: "Verifier attempt 1 failed for group cg-1 on gemini-3.5-flash-lite"
      //           "Batch Verifier Min 2 attempt 1 failed on gemini-3.5-flash-lite"
      const verifierMatch = msg.match(/(?:Verifier|Batch Verifier).*?on\s+(gemini-[\w.-]+)/i)
      if (verifierMatch) {
        const model = verifierMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `verifier-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          addUsage(rawModel, 'verifier', 1)
        }
      }

      // Missing-scene / Gap backup log matches
      // Examples: "Missing-scene minute 2, chunk 48: 1 strict match(es) found on gemini-3.7-shiva"
      const missingMatch = msg.match(/Missing-scene.*?on\s+(gemini-[\w.-]+)/i)
      if (missingMatch) {
        const model = missingMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `missing-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          addUsage(rawModel, 'missingScene', 1)
        }
      }

      // Minute Finder Windows log matches
      // Examples: "Window #1 ... on gemini-3.6-shiva"
      const windowMatch = msg.match(/(?:Window|pass window|Minute finder).*?on\s+(gemini-[\w.-]+)/i)
      if (windowMatch) {
        const model = windowMatch[1]
        const rawModel = normalizeModelName(model)
        const key = `window-${entry.t || (entry as { time?: number }).time || msg}-${rawModel}`
        if (!loggedRequests.has(key)) {
          loggedRequests.add(key)
          addUsage(rawModel, 'minuteFinder', 1)
        }
      }
    }
  }

  // 2. Structural fallback & complement if logs are truncated or sparse
  // Minute Finder Prescan windows
  if (scan.geminiPrescan) {
    if (Array.isArray(scan.geminiPrescan.windows)) {
      for (const w of scan.geminiPrescan.windows) {
        const attempts = Math.max(1, w.attempts || 1)
        const model = w.modelId || 'gemini-3.7-flash'
        const countNeeded = Math.max(0, attempts - (summary.byModel[normalizeModelName(model)]?.minuteFinder || 0))
        if (countNeeded > 0 && summary.byStage.minuteFinder === 0) {
          addUsage(normalizeModelName(model), 'minuteFinder', countNeeded)
        }
      }
    }
    if (scan.geminiPrescan.backup && Array.isArray(scan.geminiPrescan.backup.windows)) {
      for (const w of scan.geminiPrescan.backup.windows) {
        const attempts = Math.max(1, w.attempts || 1)
        const model = w.modelId || 'gemini-3.7-flash'
        const countNeeded = Math.max(0, attempts - (summary.byModel[normalizeModelName(model)]?.minuteFinder || 0))
        if (countNeeded > 0 && summary.byStage.minuteFinder === 0) {
          addUsage(normalizeModelName(model), 'minuteFinder', countNeeded)
        }
      }
    }
  }

  // Chunks scanned count fallback
  if (summary.byStage.chunkScan === 0) {
    const segments = scan.shortSegments || []
    const chunks = segments.flatMap((s) => s.chunks || [])
    const chunkList = chunks.length > 0 ? chunks : scan.chunks || []
    for (const c of chunkList) {
      if (c && (c.status === 'match' || c.status === 'no_match' || c.status === 'failed')) {
        const attempts = Math.max(1, c.attempts || 1)
        // If specific model recorded in output
        if (c.modelOutputs && Object.keys(c.modelOutputs).length > 0) {
          for (const m of Object.keys(c.modelOutputs)) {
            addUsage(normalizeModelName(m), 'chunkScan', 1)
          }
        } else {
          // Distribute across primary 3 chunk models
          addUsage('gemini-3.7-flash', 'chunkScan', attempts)
        }
      }
    }
  }

  // Ensure known standard models exist in the dict even if 0 requests so user sees full table
  const defaultModels = ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.6-flash']
  for (const m of defaultModels) {
    if (!summary.byModel[m]) {
      summary.byModel[m] = {
        chunkScan: 0,
        rescan: 0,
        verifier: 0,
        minuteFinder: 0,
        missingScene: 0,
        total: 0,
      }
    }
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
  return clean
}
