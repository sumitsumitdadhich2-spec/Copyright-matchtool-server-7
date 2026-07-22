/**
 * Server-side video matching engine — v3 (accuracy-focused)
 *
 * Improvements over v2:
 *  1. Multi-hash similarity: average hash (aHash) is now combined with a
 *     gradient/difference hash (dHash). Gradient sign is invariant to
 *     brightness / contrast / gamma / color-grading edits, so heavily
 *     re-graded clips still score high.
 *  2. Mirror / horizontal-flip detection: every comparison also checks the
 *     flipped hashes (fhash / fdhash). Mirrored edits match transparently.
 *  3. Speed-change tolerant walk: the walk continuously estimates the local
 *     slope (movie frames per short frame) via regression over the recent
 *     match sequence, so 0.5x–3x speed-ramped edits stay locked instead of
 *     drifting out of the search window.
 *  4. Multi-candidate seeding: instead of walking only from the single best
 *     movie frame (which fails when the best frame is a false positive such
 *     as a dark/flat frame), the top distinct candidate positions are all
 *     tried and the longest / strongest resulting segment wins.
 *  5. Temporal-motion similarity: per-frame color-delta vectors (computed
 *     from the stored signatures) are compared with cosine similarity. Motion
 *     patterns survive color grading, overlays and crops, adding a third
 *     independent evidence channel.
 *  6. Normalized signature comparison: colorGrid values are z-score
 *     normalized per channel before comparison, so global tint / exposure
 *     shifts no longer poison the signature score.
 *  7. Wider gap tolerance (1s @ 25fps) with a search window that widens as
 *     the gap grows, surviving stickers, transitions, and text overlays.
 *  8. Backward compatible: fingerprints without dhash/fhash still work
 *     (aHash-only path), so old stored results don't crash.
 *
 * Retained from v2: bidirectional walk, scene-cut isolation, adaptive
 * threshold relaxation, three-pass structure with forced coverage, overlap
 * dedup, and unmatchedRanges reporting.
 */

import { FrameSignature, VariantHashes } from '../src/shared/fingerprint';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FPData {
  frameIndex: number;
  timestamp: number;
  variants: Record<string, VariantHashes>;
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
  /** True when the segment matched against horizontally flipped movie hashes */
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

/** Movie-frame search window for Pass 3 grouping and seed verification */
const LOOK_AHEAD = 25;

/**
 * Base half-width of the movie-frame search window during the walk.
 * It widens by +1 per consecutive missed frame (up to WALK_LOOK_AHEAD_MAX)
 * because position uncertainty grows during gaps.
 */
const WALK_LOOK_AHEAD = 7;
const WALK_LOOK_AHEAD_MAX = 18;

/** Base minimum similarity (%) for a frame to extend the segment walk */
const WALK_MIN_SIM = 56;

/**
 * How many consecutive low-confidence short frames we tolerate before ending
 * a segment. 25 frames = 1 s @ 25 fps — survives stickers, flashes,
 * transitions, and text overlays that briefly obscure the content.
 */
const GAP_LOOKAHEAD = 25;

/** Relax WALK_MIN_SIM by this many % per 25 matched frames */
const ADAPTIVE_DROP_PER_STEP = 1;
const ADAPTIVE_STEP_FRAMES   = 25;
const ADAPTIVE_FLOOR         = 44;

/** Multi-candidate seeding */
const MAX_SEED_CANDIDATES = 6;
/** Candidates closer than this many movie frames are merged (2 s @ 25 fps) */
const SEED_SEPARATION = 50;

/** Slope (speed-ratio) clamps for the speed-tolerant walk */
const SLOPE_MIN = 0.33;
const SLOPE_MAX = 3.0;

/** aHash weight vs dHash weight when both are available */
const A_WEIGHT = 0.55;
const D_WEIGHT = 0.45;

// ---------------------------------------------------------------------------
// Fast Hamming distance using Uint32Array XOR + popcount32
// ---------------------------------------------------------------------------

function popcount32(x: number): number {
  x = x >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x  = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hashToU32(hash: string, words: number): Uint32Array {
  const arr = new Uint32Array(words);
  const len = Math.min(hash.length, words * 32);
  for (let i = 0; i < len; i++) {
    if (hash.charCodeAt(i) === 49 /* '1' */) {
      arr[i >>> 5] |= (1 << (i & 31));
    }
  }
  return arr;
}

function hammingN(
  a: Uint32Array, offsetA: number,
  b: Uint32Array, offsetB: number,
  words: number
): number {
  let d = 0;
  for (let k = 0; k < words; k++) d += popcount32(a[offsetA + k] ^ b[offsetB + k]);
  return d;
}

// ---------------------------------------------------------------------------
// Pre-computed per-set structure for O(1) per-frame lookups
// ---------------------------------------------------------------------------

interface PreSet {
  fps: FPData[];
  variantNames: string[];
  numVariants: number;
  /** aHash flat: stride A_WORDS u32 per (frame, variant) */
  aFlat: Uint32Array;
  /** Flipped aHash flat (null if fingerprints predate flip support) */
  faFlat: Uint32Array | null;
  /** dHash flat: stride dWords u32 per (frame, variant); null if unavailable */
  dFlat: Uint32Array | null;
  /** Flipped dHash flat */
  fdFlat: Uint32Array | null;
  aBits: number;
  aWords: number;
  dBits: number;
  dWords: number;
  variantIdx: Map<string, number>;
  /** Temporal color deltas: 48 floats per frame (frame i minus frame i-1); null if signatures missing */
  tDelta: Float32Array | null;
  /** L2 magnitude of each frame's tDelta */
  tMag: Float32Array | null;
}

function precompute(fps: FPData[]): PreSet {
  const empty: PreSet = {
    fps, variantNames: [], numVariants: 0,
    aFlat: new Uint32Array(0), faFlat: null, dFlat: null, fdFlat: null,
    aBits: 256, aWords: 8, dBits: 0, dWords: 0,
    variantIdx: new Map(), tDelta: null, tMag: null
  };
  if (fps.length === 0) return empty;

  const variantNames = Object.keys(fps[0].variants);
  const numVariants  = variantNames.length;
  const variantIdx   = new Map<string, number>();
  variantNames.forEach((n, i) => variantIdx.set(n, i));

  const firstVar = fps[0].variants[variantNames[0]];
  const aBits  = firstVar?.hash?.length || 256;
  const aWords = Math.max(1, Math.ceil(aBits / 32));
  const hasD    = typeof firstVar?.dhash === 'string' && firstVar.dhash.length > 0;
  const hasFlip = typeof firstVar?.fhash === 'string' && firstVar.fhash.length > 0;
  const dBits  = hasD ? firstVar.dhash!.length : 0;
  const dWords = hasD ? Math.max(1, Math.ceil(dBits / 32)) : 0;

  const aFlat  = new Uint32Array(fps.length * numVariants * aWords);
  const faFlat = hasFlip ? new Uint32Array(fps.length * numVariants * aWords) : null;
  const dFlat  = hasD ? new Uint32Array(fps.length * numVariants * dWords) : null;
  const fdFlat = hasD && hasFlip ? new Uint32Array(fps.length * numVariants * dWords) : null;

  for (let fi = 0; fi < fps.length; fi++) {
    for (let vi = 0; vi < numVariants; vi++) {
      const v = fps[fi].variants[variantNames[vi]];
      const aOff = (fi * numVariants + vi) * aWords;
      aFlat.set(hashToU32(v?.hash ?? '', aWords), aOff);
      if (faFlat) faFlat.set(hashToU32(v?.fhash ?? '', aWords), aOff);
      if (dFlat) {
        const dOff = (fi * numVariants + vi) * dWords;
        dFlat.set(hashToU32(v?.dhash ?? '', dWords), dOff);
        if (fdFlat) fdFlat.set(hashToU32(v?.fdhash ?? '', dWords), dOff);
      }
    }
  }

  // Temporal motion deltas from signatures (color grid frame-to-frame change)
  let tDelta: Float32Array | null = null;
  let tMag: Float32Array | null = null;
  const allHaveSig = fps.every(f => f.signature && f.signature.colorGrid.length === 48);
  if (allHaveSig && fps.length > 1) {
    tDelta = new Float32Array(fps.length * 48);
    tMag   = new Float32Array(fps.length);
    for (let fi = 1; fi < fps.length; fi++) {
      const cur  = fps[fi].signature!.colorGrid;
      const prev = fps[fi - 1].signature!.colorGrid;
      let mag = 0;
      for (let k = 0; k < 48; k++) {
        const d = cur[k] - prev[k];
        tDelta[fi * 48 + k] = d;
        mag += d * d;
      }
      tMag[fi] = Math.sqrt(mag);
    }
  }

  return {
    fps, variantNames, numVariants,
    aFlat, faFlat, dFlat, fdFlat,
    aBits, aWords, dBits, dWords,
    variantIdx, tDelta, tMag
  };
}

// ---------------------------------------------------------------------------
// Per-pair similarity helpers
// ---------------------------------------------------------------------------

/**
 * Similarity of one short variant vs one movie variant, 0–100.
 * Combines aHash + dHash (when available) and takes the max of the
 * normal-orientation and flipped-orientation scores.
 */
function pairSim(
  sSet: PreSet, si: number, svi: number,
  mSet: PreSet, mi: number, mvi: number
): number {
  const aWords = sSet.aWords;
  const sAOff = (si * sSet.numVariants + svi) * aWords;
  const mAOff = (mi * mSet.numVariants + mvi) * aWords;

  const aSim = 1 - hammingN(sSet.aFlat, sAOff, mSet.aFlat, mAOff, aWords) / sSet.aBits;

  const useD = sSet.dFlat !== null && mSet.dFlat !== null && sSet.dBits === mSet.dBits && sSet.dBits > 0;

  let normal = aSim;
  if (useD) {
    const dWords = sSet.dWords;
    const sDOff = (si * sSet.numVariants + svi) * dWords;
    const mDOff = (mi * mSet.numVariants + mvi) * dWords;
    const dSim = 1 - hammingN(sSet.dFlat!, sDOff, mSet.dFlat!, mDOff, dWords) / sSet.dBits;
    normal = A_WEIGHT * aSim + D_WEIGHT * dSim;
  }

  let best = normal;

  // Flip check: short (normal) vs movie (flipped) covers mirror edits
  if (mSet.faFlat !== null && sSet.aBits === mSet.aBits) {
    const faSim = 1 - hammingN(sSet.aFlat, sAOff, mSet.faFlat, mAOff, aWords) / sSet.aBits;
    let flip = faSim;
    if (useD && mSet.fdFlat !== null) {
      const dWords = sSet.dWords;
      const sDOff = (si * sSet.numVariants + svi) * dWords;
      const mDOff = (mi * mSet.numVariants + mvi) * dWords;
      const fdSim = 1 - hammingN(sSet.dFlat!, sDOff, mSet.fdFlat!, mDOff, dWords) / sSet.dBits;
      flip = A_WEIGHT * faSim + D_WEIGHT * fdSim;
    }
    if (flip > best) best = flip;
  }

  return best * 100;
}

/**
 * Fast pre-filter: short 'full' variant vs ALL movie variants.
 * Used in the O(n×m) brute-force seed scan.
 */
function hashSimFastCross(
  sSet: PreSet, si: number,
  mSet: PreSet, mi: number
): number {
  const svIdx = sSet.variantIdx.get('full') ?? 0;
  let best = 0;
  for (let mvi = 0; mvi < mSet.numVariants; mvi++) {
    const sim = pairSim(sSet, si, svIdx, mSet, mi, mvi);
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
  let best = 0;
  for (let svi = 0; svi < sSet.numVariants; svi++) {
    for (let mvi = 0; mvi < mSet.numVariants; mvi++) {
      const sim = pairSim(sSet, si, svi, mSet, mi, mvi);
      if (sim > best) best = sim;
    }
  }
  return best;
}

/** Z-score normalize a 48-value colorGrid per channel (R, G, B) */
function normalizeColorGrid(cg: number[]): Float32Array {
  const out = new Float32Array(48);
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let cell = 0; cell < 16; cell++) mean += cg[cell * 3 + c];
    mean /= 16;
    let variance = 0;
    for (let cell = 0; cell < 16; cell++) {
      const d = cg[cell * 3 + c] - mean;
      variance += d * d;
    }
    const std = Math.max(8, Math.sqrt(variance / 16));
    for (let cell = 0; cell < 16; cell++) {
      out[cell * 3 + c] = (cg[cell * 3 + c] - mean) / std;
    }
  }
  return out;
}

function signatureSim(sig1: FrameSignature, sig2: FrameSignature): number {
  let total = 0, count = 0;

  if (sig1.colorGrid.length === 48 && sig2.colorGrid.length === 48) {
    // Normalized comparison — robust to global tint / exposure / grading shifts
    const z1 = normalizeColorGrid(sig1.colorGrid);
    const z2 = normalizeColorGrid(sig2.colorGrid);
    let diff = 0;
    for (let i = 0; i < 48; i++) diff += Math.abs(z1[i] - z2[i]);
    const meanZDiff = diff / 48;
    total += Math.max(0, 1 - meanZDiff / 2);
    count++;
  } else if (sig1.colorGrid.length > 0 && sig1.colorGrid.length === sig2.colorGrid.length) {
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
 * Temporal-motion similarity via cosine of color-delta vectors, 0–100.
 * Returns -1 when unavailable (missing signatures or first frame).
 * Motion patterns survive color grading, overlays, and crops.
 */
function temporalSim(sSet: PreSet, si: number, mSet: PreSet, mi: number): number {
  if (!sSet.tDelta || !mSet.tDelta || si === 0 || mi === 0) return -1;
  const magS = sSet.tMag![si];
  const magM = mSet.tMag![mi];
  const STATIC = 6;
  if (magS < STATIC && magM < STATIC) return 78; // both static — mild agreement
  if (magS < STATIC || magM < STATIC) return 38; // one moving, one static — disagreement
  let dot = 0;
  const so = si * 48, mo = mi * 48;
  for (let k = 0; k < 48; k++) dot += sSet.tDelta[so + k] * mSet.tDelta[mo + k];
  const cos = dot / (magS * magM);
  return ((cos + 1) / 2) * 100;
}

/**
 * Weighted frame similarity combining structural hashes, spatial signature,
 * and temporal motion — three independent evidence channels.
 */
function frameSim(sSet: PreSet, si: number, mSet: PreSet, mi: number): number {
  const hSim = hashSimBestCross(sSet, si, mSet, mi);
  const sSig = sSet.fps[si].signature;
  const mSig = mSet.fps[mi].signature;
  const tSim = temporalSim(sSet, si, mSet, mi);

  if (sSig && mSig) {
    const gSim = signatureSim(sSig, mSig);
    if (tSim >= 0) return hSim * 0.70 + gSim * 0.14 + tSim * 0.16;
    return hSim * 0.84 + gSim * 0.16;
  }
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
 * Uses the 'full' variant aHash only for speed. Returns similarity 0–100.
 */
function shortConsecutiveSim(sSet: PreSet, si: number): number {
  const svIdx = sSet.variantIdx.get('full') ?? 0;
  const aWords = sSet.aWords;
  const off1 = ((si - 1) * sSet.numVariants + svIdx) * aWords;
  const off2 = (si       * sSet.numVariants + svIdx) * aWords;
  return (1 - hammingN(sSet.aFlat, off1, sSet.aFlat, off2, aWords) / sSet.aBits) * 100;
}

/**
 * Detect hard cuts in the short clip.
 * isCut[si] = 1  →  si is the FIRST frame of a new scene (hard cut before it).
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
// Directional walk (forward OR backward) with speed-ratio tracking
// ---------------------------------------------------------------------------

interface RawSeq { si: number; mi: number; sim: number }

/**
 * Estimate the local slope (movie frames advanced per short frame) from the
 * tail of the current sequence. Handles speed-ramped edits (0.33x–3x).
 */
function estimateSlope(seq: RawSeq[], seedSi: number, seedMi: number): number {
  // Use up to the last 25 entries plus the seed as anchors
  const pts: Array<{ si: number; mi: number }> = [{ si: seedSi, mi: seedMi }];
  const start = Math.max(0, seq.length - 25);
  for (let i = start; i < seq.length; i++) pts.push({ si: seq[i].si, mi: seq[i].mi });
  if (pts.length < 8) return 1;

  let minSi = Infinity, maxSi = -Infinity, minPt = pts[0], maxPt = pts[0];
  for (const p of pts) {
    if (p.si < minSi) { minSi = p.si; minPt = p; }
    if (p.si > maxSi) { maxSi = p.si; maxPt = p; }
  }
  const siSpan = maxPt.si - minPt.si;
  if (siSpan < 6) return 1;
  const slope = (maxPt.mi - minPt.mi) / siSpan;
  if (!isFinite(slope)) return 1;
  return Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, slope));
}

/**
 * Walk away from (startSi, startMi) in one direction through the short clip.
 *
 * v3 changes:
 *  - expectedMi is anchored on the LAST GOOD match and projected using the
 *    estimated slope, so speed-changed edits stay locked.
 *  - The search window widens with consecutive misses (position uncertainty
 *    grows during gaps), capped at WALK_LOOK_AHEAD_MAX.
 *  - GAP_LOOKAHEAD raised to 25 frames (1 s) for overlay/transition survival.
 */
function walkOneDir(
  sSet: PreSet,
  mSet: PreSet,
  startSi: number,
  startMi: number,
  usedShort: Uint8Array,
  direction: 1 | -1,
  isCut: Uint8Array
): RawSeq[] {
  const seq: RawSeq[] = [];
  let lastGoodSi = startSi;
  let lastGoodMi = startMi;
  let missCount  = 0;
  let slope      = 1;

  const limit = direction === 1 ? sSet.fps.length : -1;

  for (
    let nextSi = startSi + direction;
    direction === 1 ? nextSi < limit : nextSi > limit;
    nextSi += direction
  ) {
    if (usedShort[nextSi]) break; // collide with an already-accepted segment

    // Stop at scene cuts — each scene must become its own segment.
    if (direction === 1  && isCut[nextSi])     break;
    if (direction === -1 && isCut[nextSi + 1]) break;

    // Relax threshold as segment grows (encoding noise tolerance)
    const adaptiveMin = Math.max(
      ADAPTIVE_FLOOR,
      WALK_MIN_SIM - Math.floor(seq.length / ADAPTIVE_STEP_FRAMES) * ADAPTIVE_DROP_PER_STEP
    );

    // Project expected movie position using the estimated speed ratio,
    // anchored on the last confirmed match (robust across gaps).
    const expectedMi = lastGoodMi + Math.round(slope * (nextSi - lastGoodSi));
    const half = Math.min(WALK_LOOK_AHEAD_MAX, WALK_LOOK_AHEAD + missCount);
    const lo = Math.max(0, expectedMi - half);
    const hi = Math.min(mSet.fps.length - 1, expectedMi + half);
    if (lo > hi) break;

    let best = 0, bestMi = -1;
    for (let mi = lo; mi <= hi; mi++) {
      const s = frameSim(sSet, nextSi, mSet, mi);
      if (s > best) { best = s; bestMi = mi; }
    }

    if (best >= adaptiveMin && bestMi >= 0) {
      // Good frame found — include it, reset gap counter, refresh slope
      seq.push({ si: nextSi, mi: bestMi, sim: best });
      lastGoodSi = nextSi;
      lastGoodMi = bestMi;
      missCount  = 0;
      slope = estimateSlope(seq, startSi, startMi);
    } else {
      missCount++;
      if (missCount >= GAP_LOOKAHEAD) break;
    }
  }

  return seq;
}

// ---------------------------------------------------------------------------
// Build one segment bidirectionally from a seed
// ---------------------------------------------------------------------------

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

  const dEnabled    = sSet.dFlat !== null && mSet.dFlat !== null && sSet.dBits === mSet.dBits;
  const flipEnabled = mSet.faFlat !== null && sSet.aBits === mSet.aBits;
  const tEnabled    = sSet.tDelta !== null && mSet.tDelta !== null;
  console.log(`[Matcher] Feature channels: dHash=${dEnabled ? 'on' : 'off'} flipDetect=${flipEnabled ? 'on' : 'off'} temporalMotion=${tEnabled ? 'on' : 'off'}`);

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
  // Passes 1 & 2: brute-force multi-candidate seed scan + bidirectional walk
  // ------------------------------------------------------------------
  for (let pass = 1; pass <= 2; pass++) {
    const passMinSim  = pass === 1 ? minSimilarity : 40;
    const isApprox    = pass === 2;
    let   passCount   = 0;

    for (let si = 0; si < shortFps.length; si++) {
      if (usedShort[si]) continue;

      const yp = yieldIfNeeded(si);
      if (yp) await yp;

      // ---- Brute-force O(n×m): collect top DISTINCT candidate positions ----
      // Candidates within SEED_SEPARATION movie frames are merged (local max),
      // so we get up to MAX_SEED_CANDIDATES genuinely different locations.
      const fastFloor = passMinSim - 18;
      const cands: Array<{ mi: number; sim: number }> = [];
      let lastCand: { mi: number; sim: number } | null = null;

      for (let mi = 0; mi < movieFps.length; mi++) {
        const s = hashSimFastCross(sSet, si, mSet, mi);
        if (s < fastFloor) continue;
        if (lastCand && mi - lastCand.mi < SEED_SEPARATION) {
          if (s > lastCand.sim) { lastCand.mi = mi; lastCand.sim = s; }
        } else {
          lastCand = { mi, sim: s };
          cands.push(lastCand);
        }
      }

      if (cands.length === 0) continue;
      cands.sort((a, b) => b.sim - a.sim);
      const topCands = cands.slice(0, MAX_SEED_CANDIDATES);

      // Quick-reject before the more expensive full checks
      if (topCands[0].sim < passMinSim - 15) continue;

      // ---- Try a bidirectional walk from EACH candidate; keep the best ----
      let bestSeq: RawSeq[] | null = null;
      let bestSeqConf = 0;

      for (const cand of topCands) {
        // Verify with full weighted similarity (hash + signature + motion)
        const seedSim = frameSim(sSet, si, mSet, cand.mi);
        if (seedSim < passMinSim) continue;

        const seq = buildSegment(sSet, mSet, si, cand.mi, seedSim, usedShort, isCut);
        if (seq.length < minConsecutiveFrames) continue;

        const conf = seq.reduce((a, f) => a + f.sim, 0) / seq.length;
        // Prefer longer segments; tie-break on confidence
        if (
          bestSeq === null ||
          seq.length > bestSeq.length ||
          (seq.length === bestSeq.length && conf > bestSeqConf)
        ) {
          bestSeq = seq;
          bestSeqConf = conf;
        }
      }

      if (!bestSeq) continue;

      // Accept — mark all short frames in this sequence as used
      for (const item of bestSeq) usedShort[item.si] = 1;

      segments.push(acceptSegment(bestSeq, shortFps, movieFps, isApprox));
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
