import { NextResponse } from 'next/server'
import { getAllUsage, MAX_API_KEYS } from '@/lib/store'
import {
  getUserKeyN,
  setUserKeyN,
  clearUserKeyN,
  getAllUserApiKeys,
  getUserTwelveLabsKey,
  setUserTwelveLabsKey,
  clearUserTwelveLabsKey,
  getUserMinuteFinderMode,
  setUserMinuteFinderMode,
  isMinuteFinderMode,
  getUserVerifierEnabled,
  setUserVerifierEnabled,
} from '@/lib/user-keys'
import { getSession } from '@/lib/users'
import { MODEL_POOL } from '@/lib/models'
import { poolSnapshot } from '@/lib/ffmpeg-pool'
import { cleanupOrphanedGeminiFiles } from '@/lib/gemini'

export const runtime = 'nodejs'

function mask(key: string) {
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const keys: {
    index: number
    hasKey: boolean
    maskedKey: string | null
    usage: Record<string, number> | null
    totalRequests: number
  }[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const k = await getUserKeyN(session.username, n)
    const usage = k ? getAllUsage(k) : null
    let totalRequests = 0
    if (usage) {
      for (const val of Object.values(usage)) {
        if (typeof val === 'number') totalRequests += val
      }
    }
    keys.push({
      index: n,
      hasKey: Boolean(k),
      maskedKey: k ? mask(k) : null,
      usage,
      totalRequests,
    })
  }
  const key1 = await getUserKeyN(session.username, 1)
  const tlKey = await getUserTwelveLabsKey(session.username)
  const minuteFinder = await getUserMinuteFinderMode(session.username)
  const verifierEnabled = await getUserVerifierEnabled(session.username)
  return NextResponse.json({
    keys,
    maxKeys: MAX_API_KEYS,
    // Verifier toggle: true (default) | false
    verifierEnabled,
    // Minute finder toggle: 'gemini' (default) | 'twelvelabs' | 'off'
    minuteFinder,
    // OPTIONAL Twelve Labs pre-filter key (missing = feature off, app unchanged)
    twelveLabs: { hasKey: Boolean(tlKey), maskedKey: tlKey ? mask(tlKey) : null },
    // legacy fields kept for older clients
    hasKey: keys[0].hasKey,
    maskedKey: keys[0].maskedKey,
    hasKey2: keys[1].hasKey,
    maskedKey2: keys[1].maskedKey,
    usage: key1 ? getAllUsage(key1) : null,
    models: MODEL_POOL,
    // ffmpeg engine pool: one single-threaded ffmpeg per core.
    engine: (() => {
      const p = poolSnapshot()
      return { cores: p.cores, engines: p.engines, active: p.active, queued: p.queued }
    })(),
  })
}

/** PUT { minuteFinder?: 'gemini' | 'twelvelabs' | 'off', verifierEnabled?: boolean } — persist settings. */
export async function PUT(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  if (body.verifierEnabled !== undefined) {
    const enabled = Boolean(body.verifierEnabled)
    await setUserVerifierEnabled(session.username, enabled)
    return NextResponse.json({ ok: true, verifierEnabled: enabled })
  }
  if (!isMinuteFinderMode(body.minuteFinder)) {
    return NextResponse.json({ error: 'minuteFinder must be gemini | twelvelabs | off' }, { status: 400 })
  }
  await setUserMinuteFinderMode(session.username, body.minuteFinder)
  return NextResponse.json({ ok: true, minuteFinder: body.minuteFinder })
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const username = session.username

  const body = (await req.json()) as Record<string, unknown>

  // ----- Verifier toggle -----
  if (body.verifierEnabled !== undefined) {
    const enabled = Boolean(body.verifierEnabled)
    await setUserVerifierEnabled(username, enabled)
    return NextResponse.json({ ok: true, verifierEnabled: enabled })
  }

  // ----- Minute finder toggle (also accepted via POST for older clients) -----
  if (body.minuteFinder !== undefined) {
    if (!isMinuteFinderMode(body.minuteFinder)) {
      return NextResponse.json({ error: 'minuteFinder must be gemini | twelvelabs | off' }, { status: 400 })
    }
    await setUserMinuteFinderMode(username, body.minuteFinder)
    return NextResponse.json({ ok: true })
  }

  // ----- Twelve Labs key (optional pre-filter): { twelveLabsKey } / { clearTwelveLabs: true } -----
  if (body.clearTwelveLabs === true) {
    await clearUserTwelveLabsKey(username)
    return NextResponse.json({ ok: true })
  }
  if (typeof body.twelveLabsKey === 'string') {
    const key = body.twelveLabsKey.trim()
    if (key.length < 10) {
      return NextResponse.json({ error: 'Invalid Twelve Labs API key' }, { status: 400 })
    }
    await setUserTwelveLabsKey(username, key)
    return NextResponse.json({ ok: true })
  }

  // ----- On-demand Gemini storage sweep: { cleanupStorage: true } -----
  if (body.cleanupStorage === true) {
    const keys = await getAllUserApiKeys(username)
    let totalDeleted = 0
    let totalChecked = 0
    for (const k of keys) {
      const res = await cleanupOrphanedGeminiFiles(k, 0) // delete all temporary files
      totalDeleted += res.deleted
      totalChecked += res.total
    }
    return NextResponse.json({ ok: true, deleted: totalDeleted, total: totalChecked })
  }

  // ----- Reset daily quota counters: { resetCounters: true } -----
  if (body.resetCounters === true) {
    const { resetAllDailyCounters } = await import('@/lib/store')
    resetAllDailyCounters()
    return NextResponse.json({ ok: true, message: 'All daily quota counters have been reset to 0' })
  }

  // ----- Clear a key slot: { clear: n } -----
  if (typeof body.clear === 'number') {
    const n = body.clear
    if (!Number.isInteger(n) || n < 1 || n > MAX_API_KEYS) {
      return NextResponse.json({ error: 'Invalid key slot' }, { status: 400 })
    }
    await clearUserKeyN(username, n)
    return NextResponse.json({ ok: true })
  }

  // ----- Save keys: accepts apiKey/apiKey1 ... apiKey20, any combination -----
  const updates: { n: number; key: string }[] = []
  for (let n = 1; n <= MAX_API_KEYS; n++) {
    const raw = n === 1 ? (body.apiKey1 ?? body.apiKey) : body[`apiKey${n}`]
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (key) updates.push({ n, key })
  }
  if (updates.length === 0) {
    return NextResponse.json({ error: 'No API key provided' }, { status: 400 })
  }

  // Validate each key: length + must be DIFFERENT from every other slot (same key = no extra quota).
  for (const u of updates) {
    if (u.key.length < 10) {
      return NextResponse.json({ error: `Invalid API key ${u.n}` }, { status: 400 })
    }
    for (let other = 1; other <= MAX_API_KEYS; other++) {
      if (other === u.n) continue
      const otherKey = updates.find((x) => x.n === other)?.key ?? (await getUserKeyN(username, other))
      if (otherKey && otherKey === u.key) {
        return NextResponse.json(
          { error: `Key ${u.n} must be DIFFERENT from Key ${other} — the same key gives no extra quota` },
          { status: 400 },
        )
      }
    }
  }

  for (const u of updates) await setUserKeyN(username, u.n, u.key)
  return NextResponse.json({ ok: true })
}
