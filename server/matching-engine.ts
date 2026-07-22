/**
 * Server-side video matching engine — v2
 *
 * Improvements over v1:
 *  1. Bidirectional walk: from each seed, walk BACKWARD then FORWARD so that
 *     segments starting before the best seed frame are never missed.
 *  2. 10-frame gap lookahead (GAP_LOOKAHEAD): when confidence drops the walk
 *     keeps scanning up to 10 more short frames before ending the segment.
 *     - If a good frame is found within those 10 → the gap was noise; the
 *       segment continues (gap frames are silently skipped, not included).
 *     - If confidence stays low for all 10 → segment ends at the LAST good
 *       frame, NOT at the miss point.
 *     gapCount per segment records how many frames were skipped this way.
 *  3. Adaptive walk threshold: relaxes by 1 % per 25 matched frames so a
 *     well-established long segment tolerates minor encoding noise (floor 45 %).
 *  4. Pass 3 – forced best-match: after passes 1 & 2, every remaining run of
 *     ≥ minConsecutiveFrames unmatched frames receives a segment at whatever
 *     confidence is available. The result always covers the full clip.
 *  5. Returns { segments, unmatchedRanges } — the caller knows exactly which
 *     parts of the short clip have no match.
 */

import { FrameSignature } from '../src/shared/fingerprint';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FPData {
  frameIndex: number;
  timestamp: number;
  variants: Record<string, { hash: string }>;
  signature?: FrameSignature;
}

export interface MatchedSegment {
  shortStart: number;
  shortEnd: number;
  movieStart: number;
  movieEnd: number;
  confidence: number;
  frameCount: number;
  isApproximate: boolean;
  /** Short-clip frames skipped due to low confidence within this segment */
  gapCount: number;
  matchSequence: Array<{
    shortTime: number;
    movieTime: number;
    similarity: number;
  }>;
}

export interface MatchResult {
  segments: MatchedSegment[];
  /** Short-clip time ranges that no segment covers */
  unmatchedRanges: Array<{ shortStart: number; shortEnd: number }>;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Movie-frame search window used in the BRUTE-FORCE SCAN (Pass 3 grouping)
 * and for seed verification. Kept large so nothing is missed.
 */
const LOOK_AHEAD = 25;

/**
 * Movie-frame search window used during the DIRECTIONAL WALK.
 * MUST be small: if it equals or exceeds the typical scene-cut jump,
 * the walk bridges deliberate editor cuts and merges separate scenes
 * into one giant segment.
 *
 * At 25 fps a ±6 frame window allows up to 0.24 s of natural encode
 * drift without breaking the segment.  Any larger jump is a real cut.
 */
const WALK_LOOK_AHEAD = 6;

/** Base minimum similarity (%) for a frame to extend the segment walk */
const WALK_MIN_SIM = 58;

/**
 * How many consecutive low-confidence short frames we tolerate before ending
 * a segment. After this many misses the segment stops at the last good frame.
 */
const GAP_LOOKAHEAD = 10;

/** Relax WALK_MIN_SIM by this many % per 25 matched frames */
const ADAPTIVE_DROP_PER_STEP = 1;
const ADAPTIVE_STEP_FRAMES   = 25;
const ADAPTIVE_FLOOR         = 45;

// ---------------------------------------------------------------------------
// Fast Hamming distance using Uint32Array XOR + popcount32
// ---------------------------------------------------------------------------

function popcount32(x: number): number {
  x = x >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x  = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hashToU32(hash: string): Uint32Array {
  const arr = new Uint32Array(8);
  const len = Math.min(hash.length, 256);
  for (let i = 0; i < len; i++) {
    if (hash.charCodeAt(i) === 49 /* '1' */) {
      arr[i >>> 5] |= (1 << (i & 31));
    }
  }
  return arr;
}

function hammingAt(
  a: Uint32Array, offsetA: number,
  b: Uint32Array, offsetB: number
): number {
  let d = 0;
  for (let k = 0; k < 8; k++) d += popcount32(a[offsetA + k] ^ b[offsetB + k]);
  return d; // 0–256
}

// ---------------------------------------------------------------------------
// Pre-computed per-set structure for O(1) per-frame lookups
// ---------------------------------------------------------------------------

interface PreSet {
  fps: FPData[];
  variantNames: string[];
  numVariants: number;
  /** Flat: [frame0_var0 × 8 u32][frame0_var1 × 8 u32]…[frame1_var0 × 8 u32]… */
  hashFlat: Uint32Array;
  variantIdx: Map<string, number>;
}

function precompute(fps: FPData[]): PreSet {
  if (fps.length === 0) {
    return { fps, variantNames: [], numVariants: 0, hashFlat: new Uint32Array(0), variantIdx: new Map() };
  }
  const variantNames = Object.keys(fps[0].variants);
  const numVariants  = variantNames.length;
  const variantIdx   = new Map<string, number>();
  variantNames.forEach((n, i) => variantIdx.set(n, i));

  const hashFlat = new Uint32Array(fps.length * numVariants * 8);
  for (let fi = 0; fi < fps.length; fi++) {
    const baseFrame = fi * numVariants * 8;
    for (let vi = 0; vi < numVariants; vi++) {
      const hash = fps[fi].variants[variantNames[vi]]?.hash ?? '';
      hashFlat.set(hashToU32(hash), baseFrame + vi * 8);
    }
  }
  return { fps, variantNames, numVariants, hashFlat, variantIdx };
}

// ---------------------------------------------------------------------------
// Per-pair similarity helpers
// ---------------------------------------------------------------------------

/**
 * Fast pre-filter: short 'full' variant vs ALL movie variants.
 * Used in the O(n×m) brute-force scan.
 */
function hashSimFastCross(
  sSet: PreSet, si: number,
  mSet: PreSet, mi: number
): number {
  const svIdx = sSet.variantIdx.get('full') ?? 0;
  const sOff  = (si * sSet.numVariants + svIdx) * 8;
  const mBase = mi * mSet.numVariants;
  let best = 0;
  for (let vi = 0; vi < mSet.numVariants; vi++) {
    const mOff = (mBase + vi) * 8;
    const sim  = (1 - hammingAt(sSet.hashFlat, sOff, mSet.hashFlat, mOff) / 256) * 100;
    if (sim > best) best = sim;
  }
  return best;
}

/**
 * Full cross-comparison: ALL short variants × ALL movie variants.
 * Returns the maximum similarity across every combination.
 */
function hashSimBestCross(
  sSet: PreSet, si: number,
  mSet: PreSet, mi: number
): number {
  const sBase = si * sSet.numVariants;
  const mBase = mi * mSet.numVariants;
  let best = 0;
  for (let svi = 0; svi < sSet.numVariants; svi++) {
    const sOff = (sBase + svi) * 8;
    for (let mvi = 0; mvi < mSet.numVariants; mvi++) {
      const mOff = (mBase + mvi) * 8;
      const sim  = (1 - hammingAt(sSet.hashFlat, sOff, mSet.hashFlat, mOff) / 256) * 100;
      if (sim > best) best = sim;
    }
  }
  return best;
}

function signatureSim(sig1: FrameSignature, sig2: FrameSignature): number {
  let total = 0, count = 0;

  if (sig1.colorGrid.length > 0 && sig1.colorGrid.length === sig2.colorGrid.length) {
    let diff = 0;
    for (let i = 0; i < sig1.colorGrid.length; i++) diff += Math.abs(sig1.colorGrid[i] - sig2.colorGrid[i]);
    total += 1 - diff / (sig1.colorGrid.length * 255);
    count++;
  }
  if (sig1.skinScoreGrid.length > 0 && sig1.skinScoreGrid.length === sig2.skinScoreGrid.length) {
    let diff = 0;
    for (let i = 0; i < sig1.skinScoreGrid.length; i++) diff += Math.abs(sig1.skinScoreGrid[i] - sig2.skinScoreGrid[i]);
    total += 1 - diff / sig1.skinScoreGrid.length;
    count++;
  }
  if (sig1.detailGrid.length > 0 && sig1.detailGrid.length === sig2.detailGrid.length) {
    let maxVal = 1;
    for (let i = 0; i < sig1.detailGrid.length; i++) {
      if (sig1.detailGrid[i] > maxVal) maxVal = sig1.detailGrid[i];
      if (sig2.detailGrid[i] > maxVal) maxVal = sig2.detailGrid[i];
    }
    let diff = 0;
    for (let i = 0; i < sig1.detailGrid.length; i++) diff += Math.abs(sig1.detailGrid[i] - sig2.detailGrid[i]) / maxVal;
    total += 1 - diff / sig1.detailGrid.length;
    count++;
  }
  return count > 0 ? (total / count) * 100 : 50;
}

/**
 * Weighted frame similarity: 84% structural hash (best cross-variant) + 16% signature
 */
function frameSim(sSet: PreSet, si: number, mSet: PreSet, mi: number): number {
  const hSim = hashSimBestCross(sSet, si, mSet, mi);
  const sSig = sSet.fps[si].signature;
  const mSig = mSet.fps[mi].signature;
  if (sSig && mSig) return hSim * 0.84 + signatureSim(sSig, mSig) * 0.16;
  return hSim;
}

// ---------------------------------------------------------------------------
// Yield helper
// ---------------------------------------------------------------------------
function yieldIfNeeded(iter: number, every = 400): Promise<void> | null {
  return iter % every === 0 ? new Promise<void>(r => setImmediate(r)) : null;
}

// ---------------------------------------------------------------------------
// Scene-cut detection (short-clip only)
// ---------------------------------------------------------------------------

/**
 * Compare two consecutive frames WITHIN sSet (for scene-cut detection).
 * Uses the 'full' variant only for speed. Returns similarity 0–100.
 */
function shortConsecutiveSim(sSet: PreSet, si: number): number {
  const svIdx = sSet.variantIdx.get('full') ?? 0;
  const off1  = ((si - 1) * sSet.numVariants + svIdx) * 8;
  const off2  = (si       * sSet.numVariants + svIdx) * 8;
  return (1 - hammingAt(sSet.hashFlat, off1, sSet.hashFlat, off2) / 256) * 100;
}

/**
 * Detect hard cuts in the short clip.
 * isCut[si] = 1  →  si is the FIRST frame of a new scene (hard cut before it).
 * isCut[0]  is always 0 (no cut before the first frame).
 *
 * Threshold 45 %: normal motion between consecutive frames at 25 fps is
 * typically > 70 %; a hard cut drops it below ~35 %.  45 % gives comfortable
 * headroom for heavy compression and fast motion without false positives.
 */
function detectSceneCuts(sSet: PreSet, threshold = 45): Uint8Array {
  const isCut = new Uint8Array(sSet.fps.length);
  for (let si = 1; si < sSet.fps.length; si++) {
    if (shortConsecutiveSim(sSet, si) < threshold) {
      isCut[si] = 1;
    }
  }
  return isCut;
}

// ---------------------------------------------------------------------------
// Directional walk (forward OR backward) from a seed position
// ---------------------------------------------------------------------------

/**
 * Walk away from (startSi, startMi) in one direction through the short clip.
 *
 * direction = +1 → forward  (nextSi = startSi+1, startSi+2, …)
 * direction = -1 → backward (nextSi = startSi-1, startSi-2, …)
 *
 * Gap-lookahead behaviour:
 *   - Low-confidence frames are NOT added to the sequence.
 *   - We keep scanning up to GAP_LOOKAHEAD consecutive low-confidence frames.
 *   - If we find a good frame within that window → the gap was noise; segment
 *     continues (gap frames remain unmatched / counted in gapCount later).
 *   - If no good frame within GAP_LOOKAHEAD → truly stop.
 *
 * The sequence is always returned in the order frames were visited
 * (forward: ascending si; backward: descending si).
 * The caller is responsible for reversing the backward result before merging.
 */
function walkOneDir(
  sSet: PreSet,
  mSet: PreSet,
  startSi: number,
  startMi: number,
  usedShort: Uint8Array,
  direction: 1 | -1,
  isCut: Uint8Array
): Array<{ si: number; mi: number; sim: number }> {
  const seq: Array<{ si: number; mi: number; sim: number }> = [];
  let curMi     = startMi;
  let missCount = 0;

  const limit = direction === 1 ? sSet.fps.length : -1;

  for (
    let nextSi = startSi + direction;
    direction === 1 ? nextSi < limit : nextSi > limit;
    nextSi += direction
  ) {
    if (usedShort[nextSi]) break; // collide with an already-accepted segment

    // Stop at scene cuts — each scene must become its own segment.
    // Forward walk: nextSi is the first frame of a new scene → stop before it.
    // Backward walk: nextSi+1 was a scene-cut boundary → don't cross it backward.
    if (direction === 1  && isCut[nextSi])          break;
    if (direction === -1 && isCut[nextSi + 1])      break;

    // Relax threshold as segment grows (encoding noise tolerance)
    const adaptiveMin = Math.max(
      ADAPTIVE_FLOOR,
      WALK_MIN_SIM - Math.floor(seq.length / ADAPTIVE_STEP_FRAMES) * ADAPTIVE_DROP_PER_STEP
    );

    const expectedMi = curMi + direction;
    const lo = Math.max(0, expectedMi - WALK_LOOK_AHEAD);
    const hi = Math.min(mSet.fps.length - 1, expectedMi + WALK_LOOK_AHEAD);

    let best = 0, bestMi = -1;
    for (let mi = lo; mi <= hi; mi++) {
      const s = frameSim(sSet, nextSi, mSet, mi);
      if (s > best) { best = s; bestMi = mi; }
    }

    if (best >= adaptiveMin && bestMi >= 0) {
      // Good frame found — include it, reset gap counter
      seq.push({ si: nextSi, mi: bestMi, sim: best });
      curMi     = bestMi;
      missCount = 0;
    } else {
      // Low confidence — advance estimated movie position and count the miss
      missCount++;
      curMi = expectedMi; // keep estimate in sync even for missed frames
      if (missCount >= GAP_LOOKAHEAD) break; // 10 consecutive misses → truly done
    }
  }

  return seq;
}

// ---------------------------------------------------------------------------
// Build one segment bidirectionally from a seed
// ---------------------------------------------------------------------------

interface RawSeq { si: number; mi: number; sim: number }

function buildSegment(
  sSet: PreSet,
  mSet: PreSet,
  seedSi: number,
  seedMi: number,
  seedSim: number,
  usedShort: Uint8Array,
  isCut: Uint8Array
): RawSeq[] {
  const backwardSeq = walkOneDir(sSet, mSet, seedSi, seedMi, usedShort, -1, isCut);
  const forwardSeq  = walkOneDir(sSet, mSet, seedSi, seedMi, usedShort,  1, isCut);

  // Backward seq is in descending si order → reverse to get ascending
  backwardSeq.reverse();

  return [...backwardSeq, { si: seedSi, mi: seedMi, sim: seedSim }, ...forwardSeq];
}

// ---------------------------------------------------------------------------
// Compute unmatched short-clip ranges from usedShort flags
// ---------------------------------------------------------------------------

function computeUnmatched(
  shortFps: FPData[],
  usedShort: Uint8Array
): Array<{ shortStart: number; shortEnd: number }> {
  const ranges: Array<{ shortStart: number; shortEnd: number }> = [];
  let rangeStart = -1;

  for (let i = 0; i <= shortFps.length; i++) {
    const free = i < shortFps.length && !usedShort[i];
    if (free) {
      if (rangeStart < 0) rangeStart = i;
    } else {
      if (rangeStart >= 0) {
        ranges.push({
          shortStart: shortFps[rangeStart].timestamp,
          shortEnd:   shortFps[i - 1].timestamp
        });
        rangeStart = -1;
      }
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Accept a raw sequence as a MatchedSegment
// ---------------------------------------------------------------------------

function acceptSegment(seq: RawSeq[], shortFps: FPData[], movieFps: FPData[], isApproximate: boolean): MatchedSegment {
  const avgConf = seq.reduce((s, f) => s + f.sim, 0) / seq.length;

  // Count gap frames: short indices inside [first.si, last.si] not in seq
  const firstSi = seq[0].si;
  const lastSi  = seq[seq.length - 1].si;
  const inSeq   = new Set(seq.map(f => f.si));
  let gapCount  = 0;
  for (let g = firstSi + 1; g < lastSi; g++) {
    if (!inSeq.has(g)) gapCount++;
  }

  return {
    shortStart: shortFps[firstSi].timestamp,
    shortEnd:   shortFps[lastSi].timestamp,
    movieStart: movieFps[seq[0].mi].timestamp,
    movieEnd:   movieFps[seq[seq.length - 1].mi].timestamp,
    confidence: avgConf,
    frameCount: seq.length,
    isApproximate,
    gapCount,
    matchSequence: seq.map(f => ({
      shortTime: shortFps[f.si].timestamp,
      movieTime: movieFps[f.mi].timestamp,
      similarity: f.sim
    }))
  };
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

/**
 * Find ALL matched segments of shortFps inside movieFps.
 *
 * Three passes:
 *  Pass 1 – High confidence  (≥ minSimilarity, default 82 %)
 *  Pass 2 – Approximate      (≥ 40 %)
 *  Pass 3 – Forced best-match (no threshold — guarantees full clip coverage)
 *
 * @returns { segments, unmatchedRanges }
 */
export async function groundMatchedSegments(
  shortFps: FPData[],
  movieFps: FPData[],
  minSimilarity = 82,
  minConsecutiveFrames = 9
): Promise<MatchResult> {
  if (shortFps.length === 0 || movieFps.length === 0) {
    return { segments: [], unmatchedRanges: [] };
  }

  console.log(`[Matcher] Precomputing hash arrays: ${shortFps.length} short + ${movieFps.length} movie frames…`);
  const sSet = precompute(shortFps);
  const mSet = precompute(movieFps);

  // Detect hard scene cuts in the short clip so the walk never bridges them.
  const isCut   = detectSceneCuts(sSet);
  const numCuts = isCut.reduce((n, v) => n + v, 0);
  if (numCuts > 0) {
    console.log(`[Matcher] Detected ${numCuts} scene cut(s) in short clip — each scene will be matched independently.`);
  }

  console.log('[Matcher] Precompute done. Starting three-pass scan…');

  const usedShort = new Uint8Array(shortFps.length);
  const segments: MatchedSegment[] = [];

  // ------------------------------------------------------------------
  // Passes 1 & 2: brute-force seed scan + bidirectional walk
  // ------------------------------------------------------------------
  for (let pass = 1; pass <= 2; pass++) {
    const passMinSim  = pass === 1 ? minSimilarity : 40;
    const isApprox    = pass === 2;
    let   passCount   = 0;

    for (let si = 0; si < shortFps.length; si++) {
      if (usedShort[si]) continue;

      const yp = yieldIfNeeded(si);
      if (yp) await yp;

      // ---- Brute-force O(n×m): find best movie frame for this short frame ----
      let bestMi = -1, bestFast = 0;
      for (let mi = 0; mi < movieFps.length; mi++) {
        const s = hashSimFastCross(sSet, si, mSet, mi);
        if (s > bestFast) { bestFast = s; bestMi = mi; }
      }

      // Quick-reject before the more expensive full check
      if (bestFast < passMinSim - 15 || bestMi < 0) continue;

      // Verify with full weighted similarity (hash + signature)
      const seedSim = frameSim(sSet, si, mSet, bestMi);
      if (seedSim < passMinSim) continue;

      // ---- Bidirectional walk ----
      const seq = buildSegment(sSet, mSet, si, bestMi, seedSim, usedShort, isCut);

      if (seq.length < minConsecutiveFrames) continue;

      // Accept — mark all short frames in this sequence as used
      for (const item of seq) usedShort[item.si] = 1;

      segments.push(acceptSegment(seq, shortFps, movieFps, isApprox));
      passCount++;
    }

    console.log(`[Matcher] Pass ${pass} (minSim=${passMinSim}%): ${passCount} segment(s).`);
  }

  // ------------------------------------------------------------------
  // Pass 3: forced best-match — ensures no clip portion goes unmatched
  // ------------------------------------------------------------------
  // Collect still-unmatched short frame indices
  const remaining: number[] = [];
  for (let si = 0; si < shortFps.length; si++) {
    if (!usedShort[si]) remaining.push(si);
  }

  if (remaining.length >= minConsecutiveFrames) {
    console.log(`[Matcher] Pass 3 (forced): ${remaining.length} unmatched short frames, finding best movie positions…`);

    // For each remaining frame find its globally best movie match (no threshold)
    const bestOf: Array<{ si: number; mi: number; sim: number }> = [];
    for (let k = 0; k < remaining.length; k++) {
      const si = remaining[k];

      const yp = yieldIfNeeded(k, 200);
      if (yp) await yp;

      let bestMi = 0, bestSim = 0;
      for (let mi = 0; mi < movieFps.length; mi++) {
        const s = frameSim(sSet, si, mSet, mi);
        if (s > bestSim) { bestSim = s; bestMi = mi; }
      }
      bestOf.push({ si, mi: bestMi, sim: bestSim });
    }

    // Group consecutive si values whose best movie matches are roughly in-sequence
    let k = 0;
    while (k < bestOf.length) {
      const group: typeof bestOf = [bestOf[k]];
      let curMi = bestOf[k].mi;

      for (let j = k + 1; j < bestOf.length; j++) {
        const item = bestOf[j];
        // Never merge across a scene cut — each scene must be its own segment
        if (isCut[item.si]) break;
        // Gap in si indices between item and predecessor (already-matched frames between them)
        const siGap      = item.si - bestOf[j - 1].si;
        const expectedMi = curMi + siGap;
        if (Math.abs(item.mi - expectedMi) <= LOOK_AHEAD * 2) {
          group.push(item);
          curMi = item.mi;
        } else {
          break;
        }
      }

      if (group.length >= minConsecutiveFrames) {
        for (const item of group) usedShort[item.si] = 1;
        segments.push(acceptSegment(group, shortFps, movieFps, true));
        console.log(`[Matcher] Pass 3 forced segment: ${group.length} frames`);
      }

      k += Math.max(1, group.length);
    }
  }

  // ------------------------------------------------------------------
  // Deduplication: keep highest-confidence segment when short-clip
  // overlap exceeds 0.15 s
  // ------------------------------------------------------------------
  segments.sort((a, b) => b.confidence - a.confidence);

  const final: MatchedSegment[] = [];
  for (const seg of segments) {
    const overlaps = final.some(kept => {
      const oStart = Math.max(kept.shortStart, seg.shortStart);
      const oEnd   = Math.min(kept.shortEnd,   seg.shortEnd);
      return oEnd - oStart > 0.15;
    });
    if (!overlaps) final.push(seg);
  }

  // Sort by clip timeline for display
  final.sort((a, b) => a.shortStart - b.shortStart);

  // Recompute usedShort from accepted segments only (for unmatched range calc).
  // Use the exact frame timestamps stored in matchSequence — NOT a time-range
  // sweep, which would incorrectly mark gap frames (between scenes) as matched.
  const tToSi = new Map<string, number>();
  shortFps.forEach((fp, si) => tToSi.set(fp.timestamp.toFixed(4), si));

  const usedFinal = new Uint8Array(shortFps.length);
  for (const seg of final) {
    for (const frame of seg.matchSequence) {
      const si = tToSi.get(frame.shortTime.toFixed(4));
      if (si !== undefined) usedFinal[si] = 1;
    }
  }

  const unmatchedRanges = computeUnmatched(shortFps, usedFinal);

  console.log(`[Matcher] Final: ${final.length} segment(s), ${unmatchedRanges.length} unmatched range(s).`);
  return { segments: final, unmatchedRanges };
}
