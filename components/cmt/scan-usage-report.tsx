'use client'

import { useMemo } from 'react'
import { Cpu, Activity, RefreshCw, Eye, CheckCircle2, Layers, Zap } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { computeScanUsage } from '@/lib/scan-usage'
import { displayModelName } from '@/lib/models'

export function ScanUsageReport({ scan }: { scan: Scan }) {
  const usage = useMemo(() => computeScanUsage(scan), [scan])

  const { totalRequests, mainModels, byStage, byModel } = usage

  const sortedModelKeys = Object.keys(byModel).sort((a, b) => {
    // Keep 3.7, 3.8, 3.6 at top, then others by total descending
    const rank = (id: string) => (id.includes('3.7') ? 1 : id.includes('3.8') ? 2 : id.includes('3.6') ? 3 : 10)
    const rankDiff = rank(a) - rank(b)
    if (rankDiff !== 0) return rankDiff
    return (byModel[b]?.total || 0) - (byModel[a]?.total || 0)
  })

  return (
    <div className="rounded-xl border border-border/80 bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Cpu className="size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">AI Request Usage Breakdown</h3>
            <p className="text-xs text-muted-foreground">Detailed scan usage report by model & task type</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          <Zap className="size-3.5" />
          <span>Total Requests: {totalRequests}</span>
        </div>
      </div>

      {/* 3 Main Models Summary Cards */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ModelStatCard
          title="3.7-shiva"
          sub="gemini-3.7-flash"
          count={mainModels.gemini37}
          total={totalRequests}
          colorClass="text-emerald-500"
          bgClass="bg-emerald-500/10 border-emerald-500/20"
        />
        <ModelStatCard
          title="3.8-shiva"
          sub="gemini-3.8-flash"
          count={mainModels.gemini38}
          total={totalRequests}
          colorClass="text-blue-500"
          bgClass="bg-blue-500/10 border-blue-500/20"
        />
        <ModelStatCard
          title="3.6-shiva"
          sub="gemini-3.6-flash"
          count={mainModels.gemini36}
          total={totalRequests}
          colorClass="text-purple-500"
          bgClass="bg-purple-500/10 border-purple-500/20"
        />
        <ModelStatCard
          title="Other Models"
          sub="rescan/verify/lite"
          count={mainModels.others}
          total={totalRequests}
          colorClass="text-amber-500"
          bgClass="bg-amber-500/10 border-amber-500/20"
        />
      </div>

      {/* Stages / Task Types Totals */}
      <div className="mt-4 rounded-lg border border-border/60 bg-muted/40 p-3">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Task Stage Breakdown
        </h4>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <StageItem
            icon={<Layers className="size-3.5 text-primary" />}
            label="Chunk Mapping"
            count={byStage.chunkScan}
          />
          <StageItem
            icon={<RefreshCw className="size-3.5 text-blue-500" />}
            label="Targeted Rescan"
            count={byStage.rescan}
          />
          <StageItem
            icon={<Eye className="size-3.5 text-emerald-500" />}
            label="24fps Verifier"
            count={byStage.verifier}
          />
          <StageItem
            icon={<Activity className="size-3.5 text-purple-500" />}
            label="Minute Finder"
            count={byStage.minuteFinder}
          />
          <StageItem
            icon={<CheckCircle2 className="size-3.5 text-amber-500" />}
            label="Missing Scene"
            count={byStage.missingScene}
          />
        </div>
      </div>

      {/* Detailed Matrix Table */}
      <div className="mt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Model × Stage Details
        </h4>
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full min-w-[540px] text-left text-xs">
            <thead>
              <tr className="border-b border-border/80 bg-muted/60 text-muted-foreground font-medium">
                <th className="px-3 py-2">Model</th>
                <th className="px-2 py-2 text-center">Chunk Scan</th>
                <th className="px-2 py-2 text-center">Rescan</th>
                <th className="px-2 py-2 text-center">Verifier</th>
                <th className="px-2 py-2 text-center">Minute Finder</th>
                <th className="px-2 py-2 text-center">Missing Scene</th>
                <th className="px-3 py-2 text-right">Total Requests</th>
                <th className="px-3 py-2 text-right">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 font-mono">
              {sortedModelKeys.map((modelId) => {
                const data = byModel[modelId]
                if (!data) return null
                const sharePct = totalRequests > 0 ? ((data.total / totalRequests) * 100).toFixed(1) : '0.0'
                const isHighlight = data.total > 0

                return (
                  <tr
                    key={modelId}
                    className={`transition-colors hover:bg-muted/30 ${
                      isHighlight ? 'text-foreground' : 'text-muted-foreground/60'
                    }`}
                  >
                    <td className="px-3 py-2 font-medium font-sans">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-foreground">{displayModelName(modelId)}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">({modelId})</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-center">{data.chunkScan || '—'}</td>
                    <td className="px-2 py-2 text-center text-blue-500 font-semibold">{data.rescan || '—'}</td>
                    <td className="px-2 py-2 text-center">{data.verifier || '—'}</td>
                    <td className="px-2 py-2 text-center">{data.minuteFinder || '—'}</td>
                    <td className="px-2 py-2 text-center">{data.missingScene || '—'}</td>
                    <td className="px-3 py-2 text-right font-bold text-foreground">{data.total}</td>
                    <td className="px-3 py-2 text-right font-sans">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-xs font-semibold">{sharePct}%</span>
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${Math.min(100, Math.max(0, parseFloat(sharePct)))}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/60 font-sans text-xs font-semibold text-foreground">
                <td className="px-3 py-2">Grand Total</td>
                <td className="px-2 py-2 text-center font-mono">{byStage.chunkScan}</td>
                <td className="px-2 py-2 text-center font-mono text-blue-500">{byStage.rescan}</td>
                <td className="px-2 py-2 text-center font-mono">{byStage.verifier}</td>
                <td className="px-2 py-2 text-center font-mono">{byStage.minuteFinder}</td>
                <td className="px-2 py-2 text-center font-mono">{byStage.missingScene}</td>
                <td className="px-3 py-2 text-right font-mono font-bold text-primary">{totalRequests}</td>
                <td className="px-3 py-2 text-right">100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}

function ModelStatCard({
  title,
  sub,
  count,
  total,
  colorClass,
  bgClass,
}: {
  title: string
  sub: string
  count: number
  total: number
  colorClass: string
  bgClass: string
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0

  return (
    <div className={`rounded-xl border p-3 ${bgClass}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-foreground">{title}</span>
        <span className="text-[10px] text-muted-foreground font-mono">{pct}%</span>
      </div>
      <p className="text-[10px] text-muted-foreground truncate">{sub}</p>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`text-xl font-bold font-mono ${colorClass}`}>{count}</span>
        <span className="text-[10px] text-muted-foreground">req</span>
      </div>
    </div>
  )
}

function StageItem({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5">
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[10px] text-muted-foreground">{label}</p>
        <p className="font-mono text-xs font-bold text-foreground">{count}</p>
      </div>
    </div>
  )
}
