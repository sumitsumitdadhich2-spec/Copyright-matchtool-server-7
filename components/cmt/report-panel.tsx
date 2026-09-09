'use client'

import { FileCheck2, Loader2, RefreshCw, Clock, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import type { Scan, ChunkMatch } from '@/lib/types'
import { fmtTime, fmtDuration } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { originLabel, isRejectedKept } from '@/lib/candidate-pick'
import { ScanUsageReport } from './scan-usage-report'
import { ScanTimingReport } from './scan-timing-report'

export function ReportPanel({ scan }: { scan: Scan }) {
  const report = scan.report
  if (!report) return null
  const matches = (scan.matches && scan.matches.length > 0) ? scan.matches : (report.matches || [])
  const chunksPending = report.chunksPending ?? 0
  // Older saved reports have no groupsPending — derive the gap so totals still add up.
  const groupsPending =
    report.groupsPending ??
    Math.max(0, (report.groupsTotal ?? 0) - (report.groupsConfirmed ?? 0) - (report.groupsRejected ?? 0) - (report.groupsUnverified ?? 0))

  const candidateGroups = scan.candidateGroups || []

  const getMatchLiveStatus = (m: ChunkMatch) => {
    // Find associated group in candidateGroups
    const group = candidateGroups.find(
      (g) => Math.abs(g.shortStart - m.shortStart) < 1.0 || (g.candidates || []).some((c) => c.chunkIndex === m.chunkIndex),
    )

    if (group) {
      if (group.status === 'verifying') {
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-semibold text-blue-500 animate-pulse border border-blue-500/30">
            <Loader2 className="size-3 animate-spin text-blue-500" />
            Verifying (24fps)...
          </span>
        )
      }
      if (group.status === 'rescanning') {
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-500/15 px-2 py-0.5 text-[11px] font-semibold text-purple-500 animate-pulse border border-purple-500/30">
            <RefreshCw className="size-3 animate-spin text-purple-500" />
            Rescanning Chunk...
          </span>
        )
      }
      if (group.status === 'pending') {
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500 border border-amber-500/20">
            <Clock className="size-3 text-amber-500" />
            Queued for Verifier
          </span>
        )
      }
      if (group.status === 'confirmed') {
        return (
          <span className="inline-flex items-center gap-1 text-emerald-500 font-semibold text-xs">
            <CheckCircle2 className="size-3.5" />
            yes ({group.confirmedViaRescan ? 'rescan verified' : '24fps batch'})
          </span>
        )
      }
      if (group.status === 'rejected') {
        return (
          <span className="inline-flex items-center gap-1 text-destructive font-medium text-xs">
            <XCircle className="size-3.5" />
            no (rejected)
          </span>
        )
      }
      if (group.status === 'unverified') {
        return (
          <span className="inline-flex items-center gap-1 text-amber-500 font-medium text-xs">
            <AlertTriangle className="size-3.5" />
            unverified (kept)
          </span>
        )
      }
    }

    // Static fallback if group state not present
    if (m.verified || m.batchVerified === 'confirmed') {
      return (
        <span className="inline-flex items-center gap-1 text-emerald-500 font-medium">
          <CheckCircle2 className="size-3.5" />
          {m.batchVerified === 'confirmed' ? 'yes (batch 24fps)' : m.viaRescan ? 'yes (rescan)' : 'yes'}
        </span>
      )
    }
    if (m.batchVerified === 'rejected') {
      return (
        <span className="inline-flex items-center gap-1 text-destructive font-medium">
          <XCircle className="size-3.5" />
          no (rejected)
        </span>
      )
    }

    return <span className="text-warning">no</span>
  }

  return (
    <section aria-label="Final report" className="panel border-success/30">
      <div className="flex flex-wrap items-center gap-2">
        <FileCheck2 className="size-4 text-success" aria-hidden />
        <h2 className="text-sm font-semibold">{report.partial ? 'Partial Report' : 'Final Report'}</h2>
        {report.partial && (
          <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-medium text-warning">
            INCOMPLETE — {chunksPending} chunk(s) not scanned · {groupsPending} group(s) unfinished
          </span>
        )}
        {report.prefilterMode != null && (
          <span
            className={`ml-auto rounded-full px-2.5 py-0.5 text-xs ${
              report.prefilterMode === 'twelvelabs' || report.prefilterMode === 'gemini'
                ? 'bg-primary/15 text-primary'
                : 'bg-secondary text-muted-foreground'
            }`}
          >
            {report.prefilterMode === 'twelvelabs'
              ? `Twelve Labs pre-filtered — ${report.prefilterSelected ?? 0} of ${report.prefilterTotal ?? 0} chunks`
              : report.prefilterMode === 'gemini'
                ? `Chunk set: Gemini Minute Finder (${scan.geminiPrescan?.appliedMinutes?.length ?? 0} minutes)`
                : 'Full scan'}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <Stat label="Scan time" value={fmtDuration(report.totalScanTimeMs)} />
        <Stat label="Chunks scanned" value={String(report.chunksScanned)} />
        <Stat label="Chunks failed" value={String(report.chunksFailed)} />
        <Stat label="Chunks not scanned" value={String(chunksPending)} warn={chunksPending > 0} />
        <Stat label="Matched segments" value={String(matches.length)} />
      </div>

      {report.groupsTotal != null && report.groupsTotal > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <Stat label="Candidate groups" value={String(report.groupsTotal)} />
          <Stat label="Verifier confirmed" value={String(report.groupsConfirmed ?? 0)} />
          <Stat label="Verifier rejected" value={String(report.groupsRejected ?? 0)} />
          <Stat label="Unverified" value={String(report.groupsUnverified ?? 0)} />
          <Stat label="Still verifying" value={String(groupsPending)} warn={groupsPending > 0} />
        </div>
      )}

      {report.coverage && (
        <div className="mt-2 rounded-md border border-border bg-background p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Short coverage: {report.coverage.pct}%</span>
            <span className="text-muted-foreground">{report.coverage.coveredSec.toFixed(1)}s / {report.coverage.totalSec.toFixed(1)}s</span>
            {report.coverage.missingSec > 0 && <span className="text-warning">MISSING {report.coverage.missingSec.toFixed(1)}s</span>}
          </div>
          {report.coverage.gaps.length > 0 && <p className="mt-1 font-mono text-warning">{report.coverage.gaps.map((g) => `${fmtTime(g.start)}–${fmtTime(g.end)}`).join(', ')}</p>}
          <div className="mt-2 flex flex-wrap gap-2 text-muted-foreground">
            <span>Rejected kept: {report.matchesRejectedKept ?? matches.filter(isRejectedKept).length}</span>
            {Object.entries(report.originCounts || {}).map(([origin, count]) => <span key={origin}>{originLabel(origin as never)}: {count}</span>)}
          </div>
        </div>
      )}

      {matches.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No matches found — the short video does not appear in this movie.</p>
      ) : (
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-muted-foreground">Short → Movie time map (parsed from HISSA 2)</h3>
          <div className="mt-1.5 overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">#</th>
                  <th className="py-1 pr-2 font-medium">Short video</th>
                  <th className="py-1 pr-2 font-medium">Movie (global)</th>
                  <th className="py-1 pr-2 font-medium">Duration</th>
                  <th className="py-1 pr-2 font-medium">Chunk</th>
                  <th className="py-1 pr-2 font-medium">Model</th>
                  <th className="py-1 pr-2 font-medium">Origin</th>
                  <th className="py-1 font-medium">Verified</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {matches.map((m, i) => (
                  <tr key={`${m.shortStart}-${m.movieStart}-${i}`} className="border-b border-border/50">
                    <td className="py-1 pr-2 font-semibold">{i + 1}</td>
                    <td className="py-1 pr-2">
                      {fmtTime(m.shortStart)} – {fmtTime(m.shortEnd)}
                    </td>
                    <td className="py-1 pr-2 text-success">
                      {fmtTime(m.movieStart)} – {fmtTime(m.movieEnd)}
                    </td>
                    <td className="py-1 pr-2">{(m.movieEnd - m.movieStart).toFixed(3)}s</td>
                    <td className="py-1 pr-2 text-muted-foreground">{m.chunkIndex}</td>
                    <td className="py-1 pr-2 text-muted-foreground">{displayModelName(m.model)}</td>
                    <td className="py-1 pr-2">
                      <span className={isRejectedKept(m) ? 'text-destructive' : 'text-muted-foreground'}>{isRejectedKept(m) ? 'rejected kept' : originLabel(m.origin, m.originWindow)}</span>
                    </td>
                    <td className="py-1">
                      {getMatchLiveStatus(m)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-4">
        <ScanTimingReport scan={scan} />
        <ScanUsageReport scan={scan} />
      </div>
    </section>
  )
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-md border p-2 ${warn ? 'border-warning/50 bg-warning/10' : 'border-border bg-background'}`}>
      <p className="text-muted-foreground">{label}</p>
      <p className={`font-mono text-sm font-semibold ${warn ? 'text-warning' : ''}`}>{value}</p>
    </div>
  )
}
