'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { KeyRound, Check, ShieldCheck, X, Sparkles, HardDrive } from 'lucide-react'
import { fetcher } from '@/lib/format'

interface ModelSpecInfo {
  id: string
  name: string
  rpd: number
  purpose?: string
}

interface KeySlot {
  index: number
  hasKey: boolean
  maskedKey: string | null
  usage?: Record<string, number> | null
  totalRequests?: number
}

interface SettingsResponse {
  keys: KeySlot[]
  maxKeys: number
  models?: ModelSpecInfo[]
  twelveLabs?: { hasKey: boolean; maskedKey: string | null }
}

const MAX_SLOTS = 20

function slotLabel(n: number): string {
  return n === 1 ? 'API Key 1 — Main Scanner' : `API Key ${n} — Worker (optional)`
}

export function ApiKeyPanel() {
  const { data, mutate } = useSWR<SettingsResponse>('/api/settings', fetcher)
  const [values, setValues] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<number | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tlValue, setTlValue] = useState('')
  const [tlSaving, setTlSaving] = useState(false)
  const [tlSaved, setTlSaved] = useState(false)
  const [cleaningStorage, setCleaningStorage] = useState(false)
  const [cleanMsg, setCleanMsg] = useState<string | null>(null)

  async function cleanGeminiStorage() {
    setCleaningStorage(true)
    setCleanMsg(null)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanupStorage: true }),
    })
    setCleaningStorage(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to sweep Gemini cloud storage')
      return
    }
    const j = (await res.json().catch(() => ({}))) as { deleted?: number; total?: number }
    setCleanMsg(`Storage Cleaned: ${j.deleted ?? 0} temporary file(s) deleted from Gemini Cloud Files API (Checked ${j.total ?? 0}).`)
    setTimeout(() => setCleanMsg(null), 5000)
  }

  async function saveTl() {
    const v = tlValue.trim()
    if (!v) return
    setTlSaving(true)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twelveLabsKey: v }),
    })
    setTlSaving(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save Twelve Labs key')
      return
    }
    setTlValue('')
    setTlSaved(true)
    setTimeout(() => setTlSaved(false), 2500)
    void mutate()
  }

  async function removeTl() {
    setTlSaving(true)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearTwelveLabs: true }),
    })
    setTlSaving(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to remove Twelve Labs key')
      return
    }
    void mutate()
  }

  const slots: KeySlot[] =
    data?.keys ?? Array.from({ length: MAX_SLOTS }, (_, i) => ({ index: i + 1, hasKey: false, maskedKey: null }))

  async function save(n: number) {
    const v = (values[n] || '').trim()
    if (!v) return
    setSaving(n)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [`apiKey${n}`]: v }),
    })
    setSaving(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to save key')
      return
    }
    setValues((p) => ({ ...p, [n]: '' }))
    setSaved(n)
    setTimeout(() => setSaved(null), 2500)
    void mutate()
  }

  async function remove(n: number) {
    setRemoving(n)
    setError(null)
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: n }),
    })
    setRemoving(null)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Failed to remove key')
      return
    }
    void mutate()
  }

  return (
    <section aria-label="API key settings" className="panel">
      {slots.map((slot) => {
        const n = slot.index
        const Icon = n === 1 ? KeyRound : ShieldCheck
        return (
          <div key={n} className={n === 1 ? '' : 'mt-4 border-t border-border pt-4'}>
            <div className="flex items-center gap-2">
              <Icon className="size-4 text-primary" aria-hidden />
              <h2 className="text-sm font-semibold">{slotLabel(n)}</h2>
              {slot.hasKey ? (
                <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
                  <Check className="size-3" aria-hidden />
                  {slot.maskedKey}
                </span>
              ) : n === 1 ? (
                <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">not set</span>
              ) : (
                <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">not set</span>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                type="password"
                value={values[n] || ''}
                onChange={(e) => setValues((p) => ({ ...p, [n]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) save(n)
                }}
                placeholder={
                  slot.hasKey
                    ? 'Paste a new key to replace'
                    : n === 1
                      ? 'Paste your Gemini API key'
                      : `Paste Gemini API key ${n} (different account)`
                }
                aria-label={`Gemini API key ${n}`}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => save(n)}
                disabled={saving !== null || !(values[n] || '').trim()}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                {saving === n ? 'Saving...' : saved === n ? 'Saved' : slot.hasKey ? 'Update' : 'Save'}
              </button>
              {slot.hasKey && (
                <button
                  type="button"
                  onClick={() => remove(n)}
                  disabled={removing !== null}
                  aria-label={`Remove API key ${n}`}
                  title="Remove this key"
                  className="rounded-md border border-border px-2.5 py-2 text-sm text-muted-foreground hover:text-destructive disabled:opacity-40"
                >
                  {removing === n ? '...' : <X className="size-4" aria-hidden />}
                </button>
              )}
            </div>

            {/* ---------- Per-Key Daily Usage Tracking ---------- */}
            {slot.hasKey && (
              <div className="mt-2.5 rounded-md border border-border/70 bg-card/60 p-2.5 text-xs">
                <div className="flex items-center justify-between font-medium mb-2">
                  <div className="flex items-center gap-1.5 text-foreground">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden />
                    <span>Daily Model Usage for this Key</span>
                  </div>
                  <span className="font-mono text-muted-foreground">
                    Total: <strong className="text-foreground font-semibold">{slot.totalRequests ?? 0}</strong> reqs
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 font-mono">
                  {(data?.models ?? [
                    { id: 'gemini-2.5-flash', name: '2.5 Flash', rpd: 20 },
                    { id: 'gemini-2.5-pro', name: '2.5 Pro', rpd: 20 },
                    { id: 'gemini-3-flash', name: '3 Flash', rpd: 20 },
                    { id: 'gemini-3.5-flash', name: '3.5 Flash', rpd: 20 },
                    { id: 'gemini-3.5-flash-lite', name: '3.5 Flash-Lite', rpd: 500 },
                    { id: 'gemini-3.1-flash-lite', name: '3.1 Flash-Lite', rpd: 500 },
                  ]).map((m) => {
                    const used = slot.usage?.[m.id] ?? 0
                    const isExhausted = used >= m.rpd
                    const isNear = used >= m.rpd * 0.8
                    return (
                      <div
                        key={m.id}
                        className={`flex items-center justify-between rounded px-2 py-1 border transition-colors ${
                          isExhausted
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : isNear
                              ? 'border-warning/40 bg-warning/10 text-warning'
                              : 'border-border/60 bg-background/60 text-foreground/90'
                        }`}
                      >
                        <span className="truncate pr-1 text-[11px]" title={m.id}>
                          {m.name || m.id.replace('gemini-', '')}
                        </span>
                        <span className="font-semibold text-[11px] shrink-0">
                          {used}/{m.rpd}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* ---------- Twelve Labs (OPTIONAL pre-filter) ---------- */}
      <div className="mt-4 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">Twelve Labs API Key — Pre-Filter (optional)</h2>
          {data?.twelveLabs?.hasKey ? (
            <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
              <Check className="size-3" aria-hidden />
              {data.twelveLabs.maskedKey}
            </span>
          ) : (
            <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">not set</span>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={tlValue}
            onChange={(e) => setTlValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) saveTl()
            }}
            placeholder={data?.twelveLabs?.hasKey ? 'Paste a new key to replace' : 'Paste your Twelve Labs API key (optional)'}
            aria-label="Twelve Labs API key"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => saveTl()}
            disabled={tlSaving || !tlValue.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            {tlSaving ? 'Saving...' : tlSaved ? 'Saved' : data?.twelveLabs?.hasKey ? 'Update' : 'Save'}
          </button>
          {data?.twelveLabs?.hasKey && (
            <button
              type="button"
              onClick={() => removeTl()}
              disabled={tlSaving}
              aria-label="Remove Twelve Labs API key"
              title="Remove this key"
              className="rounded-md border border-border px-2.5 py-2 text-sm text-muted-foreground hover:text-destructive disabled:opacity-40"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Optional embedding pre-filter — jab set hai to scan se pehle Twelve Labs sirf matching movie chunks select
          karta hai (Gemini quota saver). Khali chhodo to app bilkul normal full-scan mode me chalega, koi asar nahi.
        </p>
      </div>

      {/* ---------- Gemini Cloud Files API Storage Cleaner (20 GB Quota Protector) ---------- */}
      {slots.some((s) => s.hasKey) && (
        <div className="mt-4 rounded-lg border border-border bg-card/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <HardDrive className="size-4 text-primary" aria-hidden />
              <div>
                <h2 className="text-sm font-semibold">Gemini Cloud Storage (20 GB Quota Sweep)</h2>
                <p className="text-xs text-muted-foreground">
                  Purani temporary uploaded movie/short clips ko Files API se sweep karke 20 GB storage limit free rakhta hai.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => cleanGeminiStorage()}
              disabled={cleaningStorage}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
            >
              <Sparkles className="size-3.5 text-primary" aria-hidden />
              {cleaningStorage ? 'Sweeping Storage...' : 'Sweep Storage Now'}
            </button>
          </div>
          {cleanMsg && (
            <p className="mt-2 text-xs font-medium text-success">
              ✓ {cleanMsg}
            </p>
          )}
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Add 1 to 20 keys — the scan works with ANY number. All keys scan chunks in parallel first, then all keys run 24fps
        verification together, and whichever key is free picks up any pending work. Each key uses all 6 models with its own
        daily counters. More keys = faster scans. Keys are stored server-side only.
      </p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!slots[0]?.hasKey && <p className="mt-1 text-xs text-destructive">No Key 1 = no scan. Add it to enable scanning.</p>}
    </section>
  )
}
