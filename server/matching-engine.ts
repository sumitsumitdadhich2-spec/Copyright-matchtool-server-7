/**
 * Server-side video matching engine — v5 (scene-chunk-first matching)
 *
 * v5 additions over v4:
 *  1. Multi-signal scene cut detection: aHash + dHash + temporal color magnitude.
 *     Catches cuts that v4 missed in outdoor/beach content with similar global color.
 *  2. Scene-chunk-first matching: short clip is pre-split at detected cuts, then
 *     each chunk is matched independently against the full movie. The bidirectional
 *     walk is bounded to [chunkStart, chunkEnd] so it can never cross a scene boundary.
 *  3. Guaranteed full-clip coverage: every chunk that passes Passes 1+2 without a
 *     match gets a forced best-match segment in Pass 3, so no scene is ever skipped.
 */

import { FrameSignature, VariantHashes } from '../src/shared/fingerprint';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FrameDetail {
  /** Human-readable name of the crop region that produced the best match */
  cropRegion: string;
  /** Hash-based (structural) similarity 0–100 — 84 % weight in final score */
  structureSim: number;
  /** Normalized colorGrid similarity 0–100 */
  colorSim: number;
  /** SkinScoreGrid similarity 0–100 (human / character presence) */
  skinSim: number;
  /** DetailGrid (edge / texture) similarity 0–100 */
  detailSim: number;
  /** 256-bit aHash of the best-matching movie frame (full variant), binary string */
  movieHash: string;
  /** 256-bit aHash of the best-matching short frame (full variant), binary string */
  shortHash: string;
}

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
  matchSequence: Array<{
    shortTime: number;
    movieTime: number;
    similarity: number;
  }>;
  /** Per-channel similarity breakdown for the best-matching frame in this segment */
  bestFrameDetail?: FrameDetail;
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
 * Extended by frameDrift (user param) + missCount (per missed frame),
 * capped at WALK_LOOK_AHEAD_MAX.
 */
const WALK_LOOK_AHEAD     = 7;
const WALK_LOOK_AHEAD_MAX = 18;

/** Base minimum similarity (%) for a frame to extend the segment walk */
const WALK_MIN_SIM = 50;

/**
 * How many consecutive low-confidence short frames we tolerate before ending
 * a segment. Lower than v4 (12 vs 25) so the walk stops sooner when it
 * drifts past the chunk boundary due to a missed cut.
 */
const GAP_LOOKAHEAD = 12;

/** Relax WALK_MIN_SIM by this many % per 25 matched frames */
const ADAPTIVE_DROP_PER_STEP = 1;
const ADAPTIVE_STEP_FRAMES   = 25;
const ADAPTIVE_FLOOR         = 40;

/** Multi-candidate seeding */
const MAX_SEED_CANDIDATES = 8;
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

function temporalSim(sSet: PreSet, si: number, mSet: PreSet, mi: number): number {
  if (!sSet.tDelta || !mSet.tDelta || si === 0 || mi === 0) return -1;
  const magS = sSet.tMag![si];
  const magM = mSet.tMag![mi];
  const STATIC = 6;
  if (magS < STATIC && magM < STATIC) return 78;
  if (magS < STATIC || magM < STATIC) return 38;
  let dot = 0;
  const so = si * 48, mo = mi * 48;
  for (let k = 0; k < 48; k++) dot += sSet.tDelta[so + k] * mSet.tDelta[mo + k];
  const cos = dot / (magS * magM);
  return ((cos + 1) / 2) * 100;
}

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
// Frame detail helpers (per-channel breakdown for the best-match frame)
// ---------------------------------------------------------------------------

function formatCropName(name: string): string {
  if (name === 'full')               return 'Full Frame';
  if (name === 'zoom_2_0_center')    return 'Zoom 2.0x Center';
  if (name === 'zoom_1_5_center')    return 'Zoom 1.5x Center';
  if (name === 'zoom_1_5_left')      return 'Zoom 1.5x Left';
  if (name === 'zoom_1_5_right')     return 'Zoom 1.5x Right';
  if (name === 'zoom_1_25_center')   return 'Zoom 1.25x Center';
  if (name === 'zoom_1_25_left')     return 'Zoom 1.25x Left';
  if (name === 'zoom_1_25_right')    return 'Zoom 1.25x Right';
  if (name.startsWith('crop_9_16_')) {
    const idx = parseInt(name.split('_').pop() ?? '0', 10);
    return `9:16 Crop ${idx + 1}`;
  }
  return name;
}

/**
 * Compute per-channel similarity breakdown for the given frame pair
 * plus identify which crop region produced the best structural match.
 */
function getFrameDetail(sSet: PreSet, si: number, mSet: PreSet, mi: number): FrameDetail {
  // ── Best crop region ──
  let bestVariantSim = 0;
  let bestMovieVariant = 'full';
  for (let svi = 0; svi < sSet.numVariants; svi++) {
    for (let mvi = 0; mvi < mSet.numVariants; mvi++) {
      const sim = pairSim(sSet, si, svi, mSet, mi, mvi);
      if (sim > bestVariantSim) {
        bestVariantSim = sim;
        bestMovieVariant = mSet.variantNames[mvi];
      }
    }
  }

  // ── Structure sim (hash-based, 0–100) ──
  const structureSim = hashSimBestCross(sSet, si, mSet, mi);

  // ── Signature-based breakdown ──
  const sSig = sSet.fps[si].signature;
  const mSig = mSet.fps[mi].signature;
  let colorSim = 50, skinSim = 50, detailSim = 50;

  if (sSig && mSig) {
    // Color grid — normalized
    if (sSig.colorGrid.length === 48 && mSig.colorGrid.length === 48) {
      const z1 = normalizeColorGrid(sSig.colorGrid);
      const z2 = normalizeColorGrid(mSig.colorGrid);
      let diff = 0;
      for (let i = 0; i < 48; i++) diff += Math.abs(z1[i] - z2[i]);
      colorSim = Math.max(0, Math.min(100, (1 - diff / 48 / 2) * 100));
    }

    // Skin grid
    if (sSig.skinScoreGrid.length > 0 && sSig.skinScoreGrid.length === mSig.skinScoreGrid.length) {
      let diff = 0;
      for (let i = 0; i < sSig.skinScoreGrid.length; i++)
        diff += Math.abs(sSig.skinScoreGrid[i] - mSig.skinScoreGrid[i]);
      skinSim = Math.max(0, Math.min(100, (1 - diff / sSig.skinScoreGrid.length) * 100));
    }

    // Detail grid
    if (sSig.detailGrid.length > 0 && sSig.detailGrid.length === mSig.detailGrid.length) {
      let maxVal = 1;
      for (let i = 0; i < sSig.detailGrid.length; i++) {
        if (sSig.detailGrid[i] > maxVal) maxVal = sSig.detailGrid[i];
        if (mSig.detailGrid[i] > maxVal) maxVal = mSig.detailGrid[i];
      }
      let diff = 0;
      for (let i = 0; i < sSig.detailGrid.length; i++)
        diff += Math.abs(sSig.detailGrid[i] - mSig.detailGrid[i]) / maxVal;
      detailSim = Math.max(0, Math.min(100, (1 - diff / sSig.detailGrid.length) * 100));
    }
  }

  const movieHash = mSet.fps[mi].variants['full']?.hash ?? mSet.fps[mi].variants[mSet.variantNames[0]]?.hash ?? '';
  const shortHash = sSet.fps[si].variants['full']?.hash ?? sSet.fps[si].variants[sSet.variantNames[0]]?.hash ?? '';

  return {
    cropRegion: formatCropName(bestMovieVariant),
    structureSim,
    colorSim,
    skinSim,
    detailSim,
    movieHash,
    shortHash,
  };
}

// ---------------------------------------------------------------------------
// Yield helper
// ---------------------------------------------------------------------------
function yieldIfNeeded(iter: number, every = 400): Promise<void> | null {
  return iter % every === 0 ? new Promise<void>(r => setImmediate(r)) : null;
}

// ---------------------------------------------------------------------------
// Scene-cut detection — multi-signal (v5)
// ---------------------------------------------------------------------------

function shortConsecutiveSim(sSet: PreSet, si: number): number {
  const svIdx = sSet.variantIdx.get('full') ?? 0;
  const aWords = sSet.aWords;
  const off1 = ((si - 1) * sSet.numVariants + svIdx) * aWords;
  const off2 = (si       * sSet.numVariants + svIdx) * aWords;
  return (1 - hammingN(sSet.aFlat, off1, sSet.aFlat, off2, aWords) / sSet.aBits) * 100;
}

/**
 * Detect scene cuts in the short clip using three independent signals.
 * A frame is a cut if ANY signal exceeds its threshold:
 *
 *  Signal 1 — aHash consecutive similarity < aThreshold (25)
 *              aHash is brightness-distribution based; only catches very dramatic
 *              global lighting changes (real hard cuts), not camera motion.
 *
 *  Signal 2 — dHash consecutive similarity < dThreshold (28)
 *              dHash is gradient/edge based; only catches very dramatic edge pattern
 *              changes, not pans/zooms within the same scene.
 *
 *  Signal 3 — Temporal color-grid magnitude > colorMagThreshold (100)
 *              L2 norm of frame-to-frame color grid delta (colorGrid is 0-255 per
 *              channel, 48 values).  A real hard cut between visually distinct scenes
 *              produces tMag >> 100.  Camera motion within a scene produces tMag < 50.
 *              Old value (28) ≈ 4 per cell change = 1.6 % of full range — far too
 *              sensitive; triggered on any pan/zoom and caused 49 false cuts.
 */
function detectSceneCuts(
  sSet: PreSet,
  aThreshold       = 25,
  dThreshold       = 28,
  colorMagThreshold = 100
): Uint8Array {
  const isCut = new Uint8Array(sSet.fps.length);

  for (let si = 1; si < sSet.fps.length; si++) {
    // Signal 1: aHash
    const aSim = shortConsecutiveSim(sSet, si);
    if (aSim < aThreshold) { isCut[si] = 1; continue; }

    // Signal 2: dHash (if available)
    if (sSet.dFlat && sSet.dBits > 0) {
      const svIdx  = sSet.variantIdx.get('full') ?? 0;
      const dWords = sSet.dWords;
      const off1   = ((si - 1) * sSet.numVariants + svIdx) * dWords;
      const off2   = (si       * sSet.numVariants + svIdx) * dWords;
      const dSim   = (1 - hammingN(sSet.dFlat, off1, sSet.dFlat, off2, dWords) / sSet.dBits) * 100;
      if (dSim < dThreshold) { isCut[si] = 1; continue; }
    }

    // Signal 3: temporal color magnitude
    if (sSet.tMag) {
      if (sSet.tMag[si] > colorMagThreshold) { isCut[si] = 1; continue; }
    }
  }

  return isCut;
}

/**
 * Split FPData array into scene chunks at detected cut positions.
 * Returns array of {start, end} frame index pairs (inclusive).
 */
function splitBySceneCuts(
  fps: FPData[],
  isCut: Uint8Array
): Array<{ start: number; end: number }> {
  const chunks: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 1; i <= fps.length; i++) {
    if (i === fps.length || isCut[i]) {
      chunks.push({ start, end: i - 1 });
      start = i;
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Directional walk — bounded to a scene chunk [siMin, siMax]
// ---------------------------------------------------------------------------

interface RawSeq { si: number; mi: number; sim: number }

function estimateSlope(seq: RawSeq[], seedSi: number, seedMi: number): number {
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
 * Walk away from (startSi, startMi) in one direction, bounded to [siMin, siMax].
 *
 * v5: siMin/siMax enforce chunk boundaries so the walk cannot cross scene cuts.
 *     isCut is kept as an additional safety check.
 */
function walkOneDir(
  sSet: PreSet,
  mSet: PreSet,
  startSi: number,
  startMi: number,
  usedShort: Uint8Array,
  direction: 1 | -1,
  isCut: Uint8Array,
  frameDrift: number,
  siMin: number = 0,
  siMax: number = sSet.fps.length - 1
): RawSeq[] {
  const seq: RawSeq[] = [];
  let lastGoodSi = startSi;
  let lastGoodMi = startMi;
  let missCount  = 0;
  let slope      = 1;

  for (
    let nextSi = startSi + direction;
    direction === 1 ? nextSi <= siMax : nextSi >= siMin;
    nextSi += direction
  ) {
    if (usedShort[nextSi]) break;

    // Respect scene cuts (shouldn't trigger inside a chunk, but kept as safety)
    if (direction === 1  && isCut[nextSi])     break;
    if (direction === -1 && isCut[nextSi + 1]) break;

    const adaptiveMin = Math.max(
      ADAPTIVE_FLOOR,
      WALK_MIN_SIM - Math.floor(seq.length / ADAPTIVE_STEP_FRAMES) * ADAPTIVE_DROP_PER_STEP
    );

    const expectedMi = lastGoodMi + Math.round(slope * (nextSi - lastGoodSi));
    const baseHalf = Math.min(WALK_LOOK_AHEAD_MAX, WALK_LOOK_AHEAD + frameDrift + missCount);
    const half = Math.min(WALK_LOOK_AHEAD_MAX, baseHalf);
    const lo = Math.max(0, expectedMi - half);
    const hi = Math.min(mSet.fps.length - 1, expectedMi + half);
    if (lo > hi) break;

    let best = 0, bestMi = -1;
    for (let mi = lo; mi <= hi; mi++) {
      const s = frameSim(sSet, nextSi, mSet, mi);
      if (s > best) { best = s; bestMi = mi; }
    }

    if (best >= adaptiveMin && bestMi >= 0) {
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
// Build one segment bidirectionally from a seed, bounded to [siMin, siMax]
// ---------------------------------------------------------------------------

function buildSegment(
  sSet: PreSet,
  mSet: PreSet,
  seedSi: number,
  seedMi: number,
  seedSim: number,
  usedShort: Uint8Array,
  isCut: Uint8Array,
  frameDrift: number,
  siMin: number = 0,
  siMax: number = sSet.fps.length - 1
): RawSeq[] {
  const backwardSeq = walkOneDir(sSet, mSet, seedSi, seedMi, usedShort, -1, isCut, frameDrift, siMin, siMax);
  const forwardSeq  = walkOneDir(sSet, mSet, seedSi, seedMi, usedShort,  1, isCut, frameDrift, siMin, siMax);

  backwardSeq.reverse();
  return [...backwardSeq, { si: seedSi, mi: seedMi, sim: seedSim }, ...forwardSeq];
}

// ---------------------------------------------------------------------------
// Compute unmatched short-clip ranges
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
// Accept a raw sequence as a MatchedSegment (with optional frame detail)
// ---------------------------------------------------------------------------

function acceptSegment(
  seq: RawSeq[],
  shortFps: FPData[],
  movieFps: FPData[],
  isApproximate: boolean,
  sSet?: PreSet,
  mSet?: PreSet
): MatchedSegment {
  const avgConf = seq.reduce((s, f) => s + f.sim, 0) / seq.length;

  const firstSi = seq[0].si;
  const lastSi  = seq[seq.length - 1].si;
  const inSeq   = new Set(seq.map(f => f.si));
  let gapCount  = 0;
  for (let g = firstSi + 1; g < lastSi; g++) {
    if (!inSeq.has(g)) gapCount++;
  }

  // Find best frame for detail computation
  let bestFrameDetail: FrameDetail | undefined;
  if (sSet && mSet) {
    let bestSim = -1, bestSi = seq[0].si, bestMi = seq[0].mi;
    for (const f of seq) {
      if (f.sim > bestSim) { bestSim = f.sim; bestSi = f.si; bestMi = f.mi; }
    }
    bestFrameDetail = getFrameDetail(sSet, bestSi, mSet, bestMi);
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
    })),
    bestFrameDetail
  };
}

// ---------------------------------------------------------------------------
// Post-process: merge temporally adjacent segments that belong to the same run
// ---------------------------------------------------------------------------

/**
 * Merge consecutive segments where:
 *  - The gap in the short clip is small (< SHORT_GAP_MAX seconds)
 *  - The movie timeline is progressing forward and proportionally
 *
 * This repairs over-segmentation caused by false scene cuts: two segments
 * that should be one continuous match get re-joined here.
 *
 * Example: seg A ends at clip 9.76s/movie 15.44s, seg B starts at clip
 * 9.80s/movie 14.04s.  Short gap = 0.04 s (1 frame).  Movie gap = -1.4 s
 * (backward — likely a false cut inside a static/slow scene).  These should
 * NOT be merged (movie goes backward too far).
 *
 * Example: seg A ends clip 1.33s/movie 2.83s, seg B starts clip 1.38s/movie
 * 3.42s.  Short gap = 0.05 s, movie gap = 0.59 s.  Merge → single segment.
 */
function mergeAdjacentSegments(segs: MatchedSegment[]): MatchedSegment[] {
  if (segs.length <= 1) return segs;

  // Work in short-clip time order
  const sorted = [...segs].sort((a, b) => a.shortStart - b.shortStart);

  // Max allowed gap (seconds) in the short clip between two segments to merge
  const SHORT_GAP_MAX = 0.52; // ~13 frames @ 25 fps

  const result: MatchedSegment[] = [];
  let cur = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const nxt = sorted[i];

    const shortGap = nxt.shortStart - cur.shortEnd;   // gap in clip  (s)
    const movieGap = nxt.movieStart - cur.movieEnd;   // gap in movie (s)

    // Allow merge when:
    //  1. Short gap is small (same scene, brief false-cut boundary)
    //  2. Movie time is moving forward (or very slightly backward — 1 frame jitter)
    //  3. Movie gap is proportional to short gap (same speed ratio, ±4 s tolerance)
    const mergeable =
      shortGap >= -0.04 &&
      shortGap <= SHORT_GAP_MAX &&
      movieGap >= -0.08 &&                             // not jumping backward in movie
      movieGap <= shortGap * 5 + 2.5;                 // movie gap roughly proportional

    if (mergeable) {
      const totalFrames = cur.frameCount + nxt.frameCount;
      cur = {
        ...cur,
        shortEnd:   nxt.shortEnd,
        movieEnd:   nxt.movieEnd,
        frameCount: totalFrames,
        confidence: (cur.confidence * cur.frameCount + nxt.confidence * nxt.frameCount) / totalFrames,
        isApproximate: cur.isApproximate || nxt.isApproximate,
        gapCount:   cur.gapCount + nxt.gapCount + Math.round(shortGap * 25),
        matchSequence:  [...cur.matchSequence, ...nxt.matchSequence],
        bestFrameDetail: (cur.bestFrameDetail && nxt.bestFrameDetail)
          ? (cur.confidence >= nxt.confidence ? cur.bestFrameDetail : nxt.bestFrameDetail)
          : (cur.bestFrameDetail ?? nxt.bestFrameDetail),
      };
    } else {
      result.push(cur);
      cur = nxt;
    }
  }
  result.push(cur);
  return result;
}

// ---------------------------------------------------------------------------
// Main engine — v5 scene-chunk-first
// ---------------------------------------------------------------------------

/**
 * Find ALL matched segments of shortFps inside movieFps.
 *
 * v5 strategy — three passes, per scene chunk:
 *
 *  1. Pre-split the short clip at detected scene cuts → N chunks.
 *     Each chunk is one continuous scene from the edited compilation.
 *
 *  2. Pass 1 — for each chunk, seed-search + bounded bidirectional walk
 *     (confidence ≥ minSimilarity).  Walk cannot cross chunk boundaries.
 *
 *  3. Pass 2 — same for still-unmatched chunks, lower threshold (≥ 40 %).
 *
 *  4. Pass 3 — forced best-match: any chunk still unmatched gets assigned
 *     the best-scoring movie region regardless of threshold, so every scene
 *     in the short clip is guaranteed to produce at least one segment.
 *
 * @param frameDrift  Extra frames to add to the base walk search window.
 */
export async function groundMatchedSegments(
  shortFps: FPData[],
  movieFps: FPData[],
  minSimilarity = 82,
  minConsecutiveFrames = 9,
  frameDrift = 3
): Promise<MatchResult> {
  if (shortFps.length === 0 || movieFps.length === 0) {
    return { segments: [], unmatchedRanges: [] };
  }

  console.log(`[Matcher] Precomputing hash arrays: ${shortFps.length} short + ${movieFps.length} movie frames… (frameDrift=${frameDrift})`);
  const sSet = precompute(shortFps);
  const mSet = precompute(movieFps);

  const dEnabled    = sSet.dFlat !== null && mSet.dFlat !== null && sSet.dBits === mSet.dBits;
  const flipEnabled = mSet.faFlat !== null && sSet.aBits === mSet.aBits;
  const tEnabled    = sSet.tDelta !== null && mSet.tDelta !== null;
  console.log(`[Matcher] Feature channels: dHash=${dEnabled ? 'on' : 'off'} flipDetect=${flipEnabled ? 'on' : 'off'} temporalMotion=${tEnabled ? 'on' : 'off'}`);

  // Scene cut detection — multi-signal
  const isCut   = detectSceneCuts(sSet);
  const numCuts = isCut.reduce((n, v) => n + v, 0);

  // Split short clip into scene chunks
  const chunks = splitBySceneCuts(shortFps, isCut);
  console.log(`[Matcher] Detected ${numCuts} scene cut(s) → ${chunks.length} scene chunk(s).`);

  console.log('[Matcher] Precompute done. Starting scene-chunk scan…');

  const usedShort = new Uint8Array(shortFps.length);
  const segments: MatchedSegment[] = [];

  // ------------------------------------------------------------------
  // Passes 1 & 2: per-chunk seeded matching
  // ------------------------------------------------------------------
  for (let pass = 1; pass <= 2; pass++) {
    const passMinSim = pass === 1 ? minSimilarity : 40;
    const isApprox   = pass === 2;
    let   passCount  = 0;

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk     = chunks[ci];
      const chunkSize = chunk.end - chunk.start + 1;

      // Skip if already fully matched
      let hasUnmatched = false;
      for (let si = chunk.start; si <= chunk.end; si++) {
        if (!usedShort[si]) { hasUnmatched = true; break; }
      }
      if (!hasUnmatched) continue;

      // Minimum frames needed to accept a segment (scales with chunk size)
      const chunkMinFrames = Math.min(minConsecutiveFrames, Math.max(3, Math.floor(chunkSize * 0.4)));

      // Try seeding from 5 strategic positions within the chunk:
      // 0%, 25%, 50%, 75%, 100%
      const seedPositions = new Set<number>();
      for (let p = 0; p <= 4; p++) {
        seedPositions.add(chunk.start + Math.round(p * (chunkSize - 1) / 4));
      }

      let bestSeq: RawSeq[] | null = null;
      let bestSeqConf = 0;

      for (const scanSi of seedPositions) {
        // Use closest unmatched frame if scanSi is already used
        let si = scanSi;
        if (usedShort[si]) {
          let found = false;
          for (let d = 1; d <= chunkSize; d++) {
            if (si + d <= chunk.end && !usedShort[si + d]) { si = si + d; found = true; break; }
            if (si - d >= chunk.start && !usedShort[si - d]) { si = si - d; found = true; break; }
          }
          if (!found) continue;
        }

        const yp = yieldIfNeeded(ci * 5);
        if (yp) await yp;

        const fastFloor = passMinSim - 20;
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
        if (topCands[0].sim < passMinSim - 18) continue;

        for (const cand of topCands) {
          const seedSim = frameSim(sSet, si, mSet, cand.mi);
          if (seedSim < passMinSim) continue;

          const seq = buildSegment(
            sSet, mSet, si, cand.mi, seedSim,
            usedShort, isCut, frameDrift,
            chunk.start, chunk.end
          );
          if (seq.length < chunkMinFrames) continue;

          const conf = seq.reduce((a, f) => a + f.sim, 0) / seq.length;
          if (
            bestSeq === null ||
            seq.length > bestSeq.length ||
            (seq.length === bestSeq.length && conf > bestSeqConf)
          ) {
            bestSeq = seq;
            bestSeqConf = conf;
          }
        }
      }

      if (!bestSeq) continue;

      for (const item of bestSeq) usedShort[item.si] = 1;
      segments.push(acceptSegment(bestSeq, shortFps, movieFps, isApprox, sSet, mSet));
      passCount++;
    }

    console.log(`[Matcher] Pass ${pass} (minSim=${passMinSim}%): ${passCount} chunk(s) matched.`);
  }

  // ------------------------------------------------------------------
  // Pass 3: forced best-match — only for chunks large enough to be real scenes
  // ------------------------------------------------------------------
  // Small chunks (< MIN_FORCED_FRAMES) are almost always caused by false scene
  // cuts (e.g. a single-frame brightness spike, motion blur, etc.).  Forcing a
  // segment for them produces spurious 1–4 frame segments with random movie
  // times.  Skip them; they'll become tiny "unmatched" ranges (< 0.2 s) which
  // are invisible to the user.
  const MIN_FORCED_FRAMES = 6;
  let pass3Count = 0;

  for (const chunk of chunks) {
    const remaining: number[] = [];
    for (let si = chunk.start; si <= chunk.end; si++) {
      if (!usedShort[si]) remaining.push(si);
    }
    if (remaining.length === 0) continue;

    if (remaining.length < MIN_FORCED_FRAMES) {
      console.log(`[Matcher] Pass 3 (skip): chunk [${chunk.start}–${chunk.end}], only ${remaining.length} frame(s) — too small to force-match.`);
      continue;
    }

    console.log(`[Matcher] Pass 3 (forced): chunk [${chunk.start}–${chunk.end}], ${remaining.length} unmatched frame(s)…`);

    // For each remaining frame, find the globally best-matching movie frame
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

    // Group temporally-contiguous frames into sub-segments
    let k = 0;
    while (k < bestOf.length) {
      const group: typeof bestOf = [bestOf[k]];
      let curMi = bestOf[k].mi;

      for (let j = k + 1; j < bestOf.length; j++) {
        const item     = bestOf[j];
        const siGap    = item.si - bestOf[j - 1].si;
        const expected = curMi + siGap;
        if (Math.abs(item.mi - expected) <= LOOK_AHEAD * 2) {
          group.push(item);
          curMi = item.mi;
        } else {
          break;
        }
      }

      for (const item of group) usedShort[item.si] = 1;
      segments.push(acceptSegment(group, shortFps, movieFps, true, sSet, mSet));
      pass3Count++;
      k += Math.max(1, group.length);
    }
  }

  if (pass3Count > 0) {
    console.log(`[Matcher] Pass 3: ${pass3Count} forced segment(s).`);
  }

  // ------------------------------------------------------------------
  // Merge adjacent segments that belong to the same continuous run.
  // This repairs over-segmentation from false scene cuts: two segments
  // that should be one get re-joined if their short-clip gap is small
  // and the movie timeline progresses forward proportionally.
  // ------------------------------------------------------------------
  const preDedup = mergeAdjacentSegments(segments);
  console.log(`[Matcher] After merge: ${preDedup.length} segment(s) (was ${segments.length}).`);

  // ------------------------------------------------------------------
  // Deduplication — keep highest-confidence segment when short-clip
  // ranges overlap by more than 0.15 s
  // ------------------------------------------------------------------
  preDedup.sort((a, b) => b.confidence - a.confidence);

  const final: MatchedSegment[] = [];
  for (const seg of preDedup) {
    const overlaps = final.some(kept => {
      const oStart = Math.max(kept.shortStart, seg.shortStart);
      const oEnd   = Math.min(kept.shortEnd,   seg.shortEnd);
      return oEnd - oStart > 0.15;
    });
    if (!overlaps) final.push(seg);
  }

  final.sort((a, b) => a.shortStart - b.shortStart);

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
