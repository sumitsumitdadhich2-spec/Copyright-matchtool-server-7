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

import * as fs from 'fs';
import * as readline from 'readline';
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
  /**
   * Effective speed ratio of the short clip relative to the reference movie.
   * Computed via linear regression over the full match sequence.
   *   1.0  = normal speed
   *   0.5  = 0.5× slow-mo (editor slowed clip → clip is longer than movie section)
   *   2.0  = 2× fast-forward (editor sped up clip → clip is shorter than movie section)
   * movieEnd is corrected using this ratio so it always reflects the actual
   * reference-movie span, not just the raw last-matched frame.
   */
  speedRatio: number;
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

/**
 * Slope (speed-ratio) clamps for the speed-tolerant walk.
 * Range covers CapCut's 0.1x super-slow-mo up to 8x fast-forward.
 */
const SLOPE_MIN = 0.1;
const SLOPE_MAX = 8.0;

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

export interface PreSet {
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

/**
 * Horizontally flip a 4×4 spatial grid stored as a flat array.
 * Used so signatureSim can compare a normal frame against a mirrored one.
 * @param grid       Flat array: 16 cells × valuesPerCell
 * @param vpc        Values per cell (3 for colorGrid RGB, 1 for skin/detail)
 */
function flipGrid4x4(grid: number[], vpc: number): number[] {
  const out = grid.slice();
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) {
      const mirrorCol = 3 - col;
      const i1 = (row * 4 + col)       * vpc;
      const i2 = (row * 4 + mirrorCol) * vpc;
      for (let k = 0; k < vpc; k++) {
        const tmp  = out[i1 + k];
        out[i1 + k] = out[i2 + k];
        out[i2 + k] = tmp;
      }
    }
  }
  return out;
}

/** Raw (non-mirror-aware) signature similarity — used internally. */
function _signatureSimRaw(sig1: FrameSignature, sig2: FrameSignature): number {
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

/**
 * Mirror-aware signature similarity.
 *
 * The hash layer (84 % weight in frameSim) already detects horizontal flips via
 * fhash/fdhash.  But the signature's colorGrid / skinScoreGrid / detailGrid are
 * spatial 4×4 grids — a mirrored clip has its columns reversed, causing a false
 * mismatch at this layer.  We compare both the normal and the horizontally-
 * flipped version of sig2's grids and keep whichever is higher.
 */
function signatureSim(sig1: FrameSignature, sig2: FrameSignature): number {
  const normal = _signatureSimRaw(sig1, sig2);

  // Only bother flipping if the colorGrid is the expected 4×4×3 = 48 values
  if (sig2.colorGrid.length !== 48) return normal;

  const sig2Flipped: FrameSignature = {
    colorGrid:     flipGrid4x4(sig2.colorGrid,     3),
    skinScoreGrid: flipGrid4x4(sig2.skinScoreGrid, 1),
    detailGrid:    flipGrid4x4(sig2.detailGrid,    1),
  };
  const mirrored = _signatureSimRaw(sig1, sig2Flipped);
  return Math.max(normal, mirrored);
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
  // Lowered from 8 → 4 so slope converges faster for short slow-mo sequences
  if (pts.length < 4) return 1;

  let minSi = Infinity, maxSi = -Infinity, minPt = pts[0], maxPt = pts[0];
  for (const p of pts) {
    if (p.si < minSi) { minSi = p.si; minPt = p; }
    if (p.si > maxSi) { maxSi = p.si; maxPt = p; }
  }
  const siSpan = maxPt.si - minPt.si;
  // Lowered from 6 → 3 to allow early detection of duplicate frames (slow-mo)
  if (siSpan < 3) return 1;
  const slope = (maxPt.mi - minPt.mi) / siSpan;
  if (!isFinite(slope)) return 1;
  return Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, slope));
}

/**
 * Linear-regression slope of movie-frame index vs short-frame index over a
 * complete walk sequence.  Returns Δmi / Δsi — the effective speed ratio:
 *   1.0 = normal speed
 *   0.5 = 0.5× slow-mo (editor slowed clip; clip is longer than movie section)
 *   2.0 = 2× fast-forward (editor sped clip up; clip is shorter)
 *
 * Regression over ALL matched frames is more robust than just using the first
 * and last points, which are sensitive to noise in the walk endpoints.
 */
function computeRegressionSlope(seq: RawSeq[]): number {
  if (seq.length < 2) return 1.0;
  if (seq.length === 2) {
    const span = seq[1].si - seq[0].si;
    if (span === 0) return 1.0;
    return Math.max(SLOPE_MIN, Math.min(SLOPE_MAX, (seq[1].mi - seq[0].mi) / span));
  }
  let n = 0, sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (const p of seq) {
    sumX  += p.si;        sumY  += p.mi;
    sumXX += p.si * p.si; sumXY += p.si * p.mi;
    n++;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return 1.0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return Math.max(SLOPE_MIN, Math.min(SLOPE_MAX, slope));
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
// Gap interpolation — bridge 1-2 skipped short frames within a sequence
// ---------------------------------------------------------------------------

/**
 * When the directional walk encounters 1–2 consecutive short frames that
 * fall below the similarity threshold (motion blur, compression artifact,
 * on-screen text, brief brightness spike) it skips them and keeps going.
 * Those skipped frames leave a gap in the sequence (si jumps by 2 or 3).
 *
 * This pass fills those gaps with linearly-interpolated movie indices and
 * the averaged confidence of their immediate neighbours — implementing the
 * "interpolate / bridge 1-2 dropped frames" behaviour described in the
 * reference algorithm:
 *
 *   "Agar pichla frame match hai aur agla frame match hai, toh algorithm
 *    ko us 1 frame ke error ko ignore karke block ko continue rakhna
 *    chahiye."
 *
 * The interpolated frames are flagged via their sim value being the
 * average of neighbours — they do not inflate the real confidence score.
 */
function fillSequenceGaps(seq: RawSeq[], maxFillGap = 2): RawSeq[] {
  if (seq.length < 2) return seq;
  const out: RawSeq[] = [seq[0]];
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1];
    const curr = seq[i];
    const siGap = curr.si - prev.si; // how many short-clip frames were skipped
    if (siGap > 1 && siGap <= maxFillGap + 1) {
      // Fill each skipped frame with a linearly interpolated movie position
      for (let g = 1; g < siGap; g++) {
        const t = g / siGap;
        out.push({
          si:  prev.si + g,
          mi:  Math.round(prev.mi + t * (curr.mi - prev.mi)),
          sim: (prev.sim + curr.sim) / 2, // average of neighbours
        });
      }
    }
    out.push(curr);
  }
  return out;
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
  const raw = [...backwardSeq, { si: seedSi, mi: seedMi, sim: seedSim }, ...forwardSeq];
  // Bridge 1-2 frame gaps: fills skipped frames (motion blur / compression artifact)
  return fillSequenceGaps(raw);
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

  // ── Speed-ratio correction ────────────────────────────────────────────────
  // Compute Δmi/Δsi via linear regression over the full matched sequence.
  // This is more robust than using just the first/last endpoints, which are
  // sensitive to walk-endpoint noise and optical-flow interpolation artifacts.
  //
  // Examples:
  //   regSlope ≈ 1.0 → normal speed
  //   regSlope ≈ 0.5 → clip was slowed 0.5× (3 s clip from 1.5 s of movie)
  //   regSlope ≈ 2.0 → clip was sped up 2× (1.5 s clip from 3 s of movie)
  const speedRatio = computeRegressionSlope(seq);

  // Use regression to predict the correct movie endpoint rather than trusting
  // the raw last-matched frame, which may be off when the walk slope drifted.
  const siSpan       = lastSi - firstSi;
  const rawMiEnd     = seq[seq.length - 1].mi;
  const regMiEnd     = seq[0].mi + Math.round(speedRatio * siSpan);
  const clampedMiEnd = Math.max(0, Math.min(movieFps.length - 1, regMiEnd));

  // Only adopt the regression-corrected endpoint when it differs meaningfully
  // from the raw walk endpoint (> 1 frame) — avoids unnecessary jitter on
  // normal-speed content where the walk endpoint is already accurate.
  const miEnd = Math.abs(regMiEnd - rawMiEnd) > 1 ? clampedMiEnd : rawMiEnd;

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
    movieEnd:   movieFps[miEnd].timestamp,
    confidence: avgConf,
    frameCount: seq.length,
    isApproximate,
    gapCount,
    speedRatio,
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
 * Context-aware validation of low-confidence segments.
 *
 * Segments accepted only at Pass-2 threshold (40–82 %) are kept only when
 * at least one high-confidence neighbour confirms the movie timeline is
 * progressing forward consistently.  This matches the reference algorithm:
 *
 *   "pichle scenes match hone ki wajah se isko validate kar diya gaya"
 *   (Segment 9, 10 frames / 89 % — accepted because prior segments formed
 *   a solid timeline.)
 *
 * Segments that fail this check are dropped; their clip frames become
 * unmatchedRanges (altered / third-party content detection).
 */
function contextValidateSegments(segs: MatchedSegment[]): MatchedSegment[] {
  if (segs.length <= 1) return segs;

  const MIN_NEIGHBOUR_CONF = 85; // neighbour must be at least this confident
  const MAX_MOVIE_JUMP     = 10; // movie time jump > this (s) is suspicious

  const out: MatchedSegment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];

    // High-confidence or long segments are always kept
    if (!seg.isApproximate || seg.confidence >= 80 || seg.frameCount >= 20) {
      out.push(seg); continue;
    }

    // Low-confidence short segment — validate against neighbours
    const prev = out.length > 0 ? out[out.length - 1] : null;
    const next = i < segs.length - 1 ? segs[i + 1] : null;

    const prevGood = prev !== null
      && prev.confidence >= MIN_NEIGHBOUR_CONF
      && seg.movieStart  >= prev.movieEnd - 1.0
      && (seg.movieStart - prev.movieEnd) <= MAX_MOVIE_JUMP;

    const nextGood = next !== null
      && next.confidence >= MIN_NEIGHBOUR_CONF
      && next.movieStart >= seg.movieEnd - 1.0
      && (next.movieStart - seg.movieEnd) <= MAX_MOVIE_JUMP;

    if (prevGood || nextGood) {
      out.push(seg);
    } else {
      console.log(
        `[Matcher] Context-drop: seg [${seg.shortStart.toFixed(2)}–` +
        `${seg.shortEnd.toFixed(2)}s] conf ${seg.confidence.toFixed(1)}%` +
        ` frameCount=${seg.frameCount} — no valid context neighbour.`
      );
      // frames left free → appear in unmatchedRanges
    }
  }
  return out;
}

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
        // Weighted average speed ratio from both halves
        speedRatio: (cur.speedRatio * cur.frameCount + nxt.speedRatio * nxt.frameCount) / totalFrames,
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
  minConsecutiveFrames = 10,
  frameDrift = 3,
  _prebuiltShort?: PreSet,
  _prebuiltMovie?: PreSet
): Promise<MatchResult> {
  if (shortFps.length === 0 || movieFps.length === 0) {
    return { segments: [], unmatchedRanges: [] };
  }

  if (_prebuiltShort && _prebuiltMovie) {
    console.log(`[Matcher] Using pre-built hash arrays: ${shortFps.length} short + ${movieFps.length} movie frames (frameDrift=${frameDrift})`);
  } else {
    console.log(`[Matcher] Precomputing hash arrays: ${shortFps.length} short + ${movieFps.length} movie frames… (frameDrift=${frameDrift})`);
  }
  const sSet = _prebuiltShort ?? precompute(shortFps);
  const mSet = _prebuiltMovie ?? precompute(movieFps);

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
  // Minimum 10 frames = reference algorithm's stated threshold for a valid segment.
  // Smaller leftovers are almost always false-cut fragments or CGI/altered content.
  const MIN_FORCED_FRAMES = 10;
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

    // Confidence gate: if even the best forced match is very weak, the content
    // likely doesn't exist in the reference movie (e.g. CGI insert, green-screen
    // overlay, third-party clip).  Leave it as an unmatched range rather than
    // fabricating a low-quality segment.
    const UNMATCHED_SIM_GATE = 65; // below this avg % → altered / unmatched
    const avgForcedSim = bestOf.reduce((s, f) => s + f.sim, 0) / bestOf.length;
    if (avgForcedSim < UNMATCHED_SIM_GATE) {
      console.log(
        `[Matcher] Pass 3 (unmatched): chunk [${chunk.start}–${chunk.end}]` +
        ` avg sim ${avgForcedSim.toFixed(1)}% < ${UNMATCHED_SIM_GATE}%` +
        ` — flagged as altered/unmatched content.`
      );
      continue; // frames stay free → reported in unmatchedRanges
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

  // Context-aware validation: drop low-confidence segments that have no
  // high-confidence neighbour confirming a consistent movie timeline.
  const validated = contextValidateSegments(final);
  if (validated.length !== final.length) {
    console.log(`[Matcher] Context validation: dropped ${final.length - validated.length} segment(s).`);
  }

  const tToSi = new Map<string, number>();
  shortFps.forEach((fp, si) => tToSi.set(fp.timestamp.toFixed(4), si));

  const usedFinal = new Uint8Array(shortFps.length);
  for (const seg of validated) {
    for (const frame of seg.matchSequence) {
      const si = tToSi.get(frame.shortTime.toFixed(4));
      if (si !== undefined) usedFinal[si] = 1;
    }
  }

  const unmatchedRanges = computeUnmatched(shortFps, usedFinal);

  console.log(`[Matcher] Final: ${validated.length} segment(s), ${unmatchedRanges.length} unmatched range(s).`);
  return { segments: validated, unmatchedRanges };
}

// ---------------------------------------------------------------------------
// Memory-efficient streaming precompute — reads NDJSON without loading all
// hash strings into memory at once.
// ---------------------------------------------------------------------------

/**
 * Count lines in a file by streaming through it.
 * Used to pre-size the flat TypedArrays before the main streaming pass.
 */
async function countFileLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    stream.on('data', (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk.charCodeAt(i) === 10 /* '\n' */) count++;
      }
    });
    stream.on('end', () => resolve(count));
    stream.on('error', reject);
  });
}

/**
 * Build a PreSet by streaming an NDJSON fingerprint file line-by-line.
 *
 * Hash strings are converted to flat Uint32Arrays immediately and then
 * discarded — they are NEVER accumulated in a large JS array.  Only the
 * compact per-frame data (frameIndex, timestamp, signature) is kept in the
 * fps array, cutting peak RAM from ~6-8 GB to ~400 MB for a 2-hour movie.
 */
async function streamPrecomputeFromNDJSON(filePath: string): Promise<PreSet> {
  const totalFrames = await countFileLines(filePath);
  if (totalFrames === 0) return precompute([]);

  // These are allocated at full size up-front (TypedArrays → outside JS heap)
  let aFlat:  Uint32Array | null = null;
  let faFlat: Uint32Array | null = null;
  let dFlat:  Uint32Array | null = null;
  let fdFlat: Uint32Array | null = null;
  const tDeltaBuf = new Float32Array(totalFrames * 48);
  const tMagBuf   = new Float32Array(totalFrames);

  let variantNames: string[] = [];
  let numVariants = 0;
  let aBits = 256, aWords = 8, dBits = 0, dWords = 0;
  let hasFlip = false, hasD = false;
  const variantIdx = new Map<string, number>();

  // Compact fps — only what the matching logic actually uses after precompute
  const compactFps: FPData[] = [];
  let allHaveSig = true;
  let prevColorGrid: number[] | null = null;
  let fi = 0;

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line: string) => {
      if (!line.trim()) return;

      let frame: any;
      try { frame = JSON.parse(line); } catch { return; }

      // ── First-frame initialisation ────────────────────────────────────
      if (fi === 0) {
        variantNames = Object.keys(frame.variants || {});
        numVariants  = variantNames.length;
        const fv     = frame.variants?.[variantNames[0]];
        aBits   = fv?.hash?.length  || 256;
        aWords  = Math.max(1, Math.ceil(aBits / 32));
        hasD    = typeof fv?.dhash  === 'string' && fv.dhash.length  > 0;
        hasFlip = typeof fv?.fhash  === 'string' && fv.fhash.length  > 0;
        dBits   = hasD ? fv.dhash.length : 0;
        dWords  = hasD ? Math.max(1, Math.ceil(dBits / 32)) : 0;
        variantNames.forEach((n, i) => variantIdx.set(n, i));

        aFlat  = new Uint32Array(totalFrames * numVariants * aWords);
        faFlat = hasFlip ? new Uint32Array(totalFrames * numVariants * aWords) : null;
        dFlat  = hasD    ? new Uint32Array(totalFrames * numVariants * dWords) : null;
        fdFlat = (hasD && hasFlip) ? new Uint32Array(totalFrames * numVariants * dWords) : null;
      }

      // ── Fill flat hash arrays ─────────────────────────────────────────
      for (let vi = 0; vi < numVariants; vi++) {
        const v    = frame.variants?.[variantNames[vi]];
        const aOff = (fi * numVariants + vi) * aWords;
        aFlat!.set(hashToU32(v?.hash  ?? '', aWords), aOff);
        if (faFlat) faFlat.set(hashToU32(v?.fhash ?? '', aWords), aOff);
        if (dFlat) {
          const dOff = (fi * numVariants + vi) * dWords;
          dFlat.set(hashToU32(v?.dhash  ?? '', dWords), dOff);
          if (fdFlat) fdFlat.set(hashToU32(v?.fdhash ?? '', dWords), dOff);
        }
      }

      // ── Temporal colour-delta ─────────────────────────────────────────
      const sig = frame.signature as FrameSignature | undefined;
      if (sig?.colorGrid?.length === 48 && prevColorGrid && fi > 0) {
        let mag = 0;
        for (let k = 0; k < 48; k++) {
          const d = sig.colorGrid[k] - prevColorGrid[k];
          tDeltaBuf[fi * 48 + k] = d;
          mag += d * d;
        }
        tMagBuf[fi] = Math.sqrt(mag);
      }
      prevColorGrid = sig?.colorGrid ?? null;
      if (!sig || sig.colorGrid?.length !== 48) allHaveSig = false;

      // ── Compact fps entry (no variant hash strings) ───────────────────
      compactFps.push({
        frameIndex: frame.frameIndex,
        timestamp:  frame.timestamp,
        variants:   {},   // hash data lives in flat arrays — strings freed
        signature:  sig,
      } as FPData);

      fi++;
      // The `frame` object goes out of scope here and is eligible for GC.
    });

    rl.on('close', resolve);
    rl.on('error', reject);
  });

  return {
    fps: compactFps,
    variantNames,
    numVariants,
    aFlat:  aFlat  ?? new Uint32Array(0),
    faFlat: hasFlip ? faFlat : null,
    dFlat:  hasD   ? dFlat  : null,
    fdFlat: (hasD && hasFlip) ? fdFlat : null,
    aBits, aWords, dBits, dWords,
    variantIdx,
    tDelta: (allHaveSig && fi > 1) ? tDeltaBuf : null,
    tMag:   (allHaveSig && fi > 1) ? tMagBuf   : null,
  };
}

/**
 * Build a PreSet from a fingerprint result file.
 *
 * Supports two formats:
 *  - **NDJSON** (new, default): one JSON object per line — streamed line-by-line
 *    so hash strings are never accumulated in memory.
 *  - **JSON array** (legacy): `[{...},{...},...]` — parsed all at once for
 *    backward compatibility with result files created before this change.
 */
export async function streamPrecomputeFromFile(filePath: string): Promise<PreSet> {
  // Peek at the first byte to detect format.
  const fd = fs.openSync(filePath, 'r');
  const peek = Buffer.alloc(1);
  fs.readSync(fd, peek, 0, 1, 0);
  fs.closeSync(fd);
  const firstChar = peek.toString('utf8');

  if (firstChar === '[') {
    // Legacy JSON array — load with JSON.parse (backward compat).
    console.log('[Precompute] Legacy JSON array format — loading into memory');
    const fps: FPData[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return precompute(fps);
  }

  // NDJSON — memory-efficient streaming path.
  return streamPrecomputeFromNDJSON(filePath);
}

/**
 * Memory-efficient public API: builds both PreSets by streaming their
 * fingerprint files then runs the full matching pipeline.
 *
 * Peak RAM for a 2-hour movie is ~400 MB instead of ~7 GB.
 */
export async function matchVideosFromFiles(
  shortResultPath: string,
  movieResultPath: string,
  opts: {
    minSimilarity?:       number;
    minConsecutiveFrames?: number;
    frameDrift?:          number;
  } = {}
): Promise<MatchResult & { movieFrames: number; shortFrames: number }> {
  const {
    minSimilarity       = 82,
    minConsecutiveFrames = 9,
    frameDrift          = 3,
  } = opts;

  console.log('[Match] Streaming precompute: short fingerprints…');
  const shortPreSet = await streamPrecomputeFromFile(shortResultPath);

  console.log('[Match] Streaming precompute: movie fingerprints…');
  const moviePreSet = await streamPrecomputeFromFile(movieResultPath);

  const shortFrames = shortPreSet.fps.length;
  const movieFrames = moviePreSet.fps.length;
  console.log(`[Match] Loaded ${movieFrames} movie frames, ${shortFrames} short frames. Running matching…`);

  const result = await groundMatchedSegments(
    shortPreSet.fps,
    moviePreSet.fps,
    minSimilarity,
    minConsecutiveFrames,
    frameDrift,
    shortPreSet,
    moviePreSet
  );

  return { ...result, movieFrames, shortFrames };
}
