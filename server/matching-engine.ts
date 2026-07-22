/**
 * Server-side video matching engine.
 *
 * Ports the "groundMatchedSegments" algorithm from the old browser version:
 *  - Two-pass: Pass 1 high-confidence (≥ minSimilarity, default 82%)
 *               Pass 2 approximate/fallback (≥ 40%)
 *  - Brute-force O(n×m) scan using fast Uint32Array XOR + popcount Hamming
 *  - Look-ahead tolerance: ±20 frames when expected next frame doesn't match
 *  - Weighted similarity: 84% structural hash (best of 13 crop/zoom variants)
 *                       + 16% color/skin/detail signature
 *  - Minimum 9 consecutive matched frames per accepted segment
 *  - Overlap-based deduplication (>0.15 s overlap → keep highest confidence)
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
  matchSequence: Array<{
    shortTime: number;
    movieTime: number;
    similarity: number;
  }>;
}

// ---------------------------------------------------------------------------
// Fast Hamming distance using Uint32Array XOR + popcount32
// ---------------------------------------------------------------------------

function popcount32(x: number): number {
  // Kernighan/HAKMEM popcount, works on 32-bit unsigned
  x = x >>> 0;
  x -= (x >>> 1) & 0x55555555;
  x  = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Convert a binary hash string ('0'/'1', length 256) to 8 packed uint32s. */
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

/**
 * Hamming distance between two Uint32Arrays, starting at the given word offsets.
 * Each frame takes 8 consecutive uint32s (= 256 bits).
 */
function hammingAt(
  a: Uint32Array, offsetA: number,
  b: Uint32Array, offsetB: number
): number {
  let d = 0;
  for (let k = 0; k < 8; k++) {
    d += popcount32(a[offsetA + k] ^ b[offsetB + k]);
  }
  return d; // 0..256
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
    return {
      fps,
      variantNames: [],
      numVariants: 0,
      hashFlat: new Uint32Array(0),
      variantIdx: new Map()
    };
  }

  const variantNames = Object.keys(fps[0].variants);
  const numVariants = variantNames.length;
  const variantIdx = new Map<string, number>();
  variantNames.forEach((n, i) => variantIdx.set(n, i));

  const hashFlat = new Uint32Array(fps.length * numVariants * 8);

  for (let fi = 0; fi < fps.length; fi++) {
    const baseFrame = fi * numVariants * 8;
    for (let vi = 0; vi < numVariants; vi++) {
      const hash = fps[fi].variants[variantNames[vi]]?.hash ?? '';
      const u32 = hashToU32(hash);
      hashFlat.set(u32, baseFrame + vi * 8);
    }
  }

  return { fps, variantNames, numVariants, hashFlat, variantIdx };
}

// ---------------------------------------------------------------------------
// Per-pair similarity helpers
// ---------------------------------------------------------------------------

/**
 * Fast pre-filter for the O(n×m) brute-force scan.
 * Compares the short frame's 'full' variant against ALL movie frame variants and
 * returns the best similarity. This catches aspect-ratio mismatches where the
 * short clip's full frame matches a crop/zoom variant of the movie frame
 * (e.g. 720×720 short vs 968×720 movie → short 'full' ≈ movie 'crop_9_16_2').
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
    const sim = (1 - hammingAt(sSet.hashFlat, sOff, mSet.hashFlat, mOff) / 256) * 100;
    if (sim > best) best = sim;
  }
  return best;
}

/**
 * Full cross-comparison: ALL short frame variants × ALL movie frame variants.
 * Returns the maximum similarity across every combination.
 *
 * This is equivalent to the old browser version's getFrameSimilarity() which
 * tried every short-crop against every movie-crop. Critical for matching
 * content that differs in aspect ratio, zoom level, or pan/crop treatment
 * between the reference movie and the target clip.
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
      const sim = (1 - hammingAt(sSet.hashFlat, sOff, mSet.hashFlat, mOff) / 256) * 100;
      if (sim > best) best = sim;
    }
  }
  return best;
}

/** Similarity between two FrameSignatures (color + skin + detail grids). */
function signatureSim(sig1: FrameSignature, sig2: FrameSignature): number {
  let total = 0;
  let count = 0;

  // Color grid: 48 values, 0-255 each
  if (sig1.colorGrid.length > 0 && sig1.colorGrid.length === sig2.colorGrid.length) {
    let diff = 0;
    for (let i = 0; i < sig1.colorGrid.length; i++) {
      diff += Math.abs(sig1.colorGrid[i] - sig2.colorGrid[i]);
    }
    total += 1 - diff / (sig1.colorGrid.length * 255);
    count++;
  }

  // Skin score grid: 16 values, 0-1 each
  if (sig1.skinScoreGrid.length > 0 && sig1.skinScoreGrid.length === sig2.skinScoreGrid.length) {
    let diff = 0;
    for (let i = 0; i < sig1.skinScoreGrid.length; i++) {
      diff += Math.abs(sig1.skinScoreGrid[i] - sig2.skinScoreGrid[i]);
    }
    total += 1 - diff / sig1.skinScoreGrid.length;
    count++;
  }

  // Detail grid: 16 values, normalised by max
  if (sig1.detailGrid.length > 0 && sig1.detailGrid.length === sig2.detailGrid.length) {
    let maxVal = 1;
    for (let i = 0; i < sig1.detailGrid.length; i++) {
      if (sig1.detailGrid[i] > maxVal) maxVal = sig1.detailGrid[i];
      if (sig2.detailGrid[i] > maxVal) maxVal = sig2.detailGrid[i];
    }
    let diff = 0;
    for (let i = 0; i < sig1.detailGrid.length; i++) {
      diff += Math.abs(sig1.detailGrid[i] - sig2.detailGrid[i]) / maxVal;
    }
    total += 1 - diff / sig1.detailGrid.length;
    count++;
  }

  return count > 0 ? (total / count) * 100 : 50;
}

/**
 * Weighted frame similarity:
 *   84% structural hash (best cross-variant match) + 16% signature (if available)
 */
function frameSim(
  sSet: PreSet, si: number,
  mSet: PreSet, mi: number
): number {
  const hSim = hashSimBestCross(sSet, si, mSet, mi);

  const sSig = sSet.fps[si].signature;
  const mSig = mSet.fps[mi].signature;
  if (sSig && mSig) {
    return hSim * 0.84 + signatureSim(sSig, mSig) * 0.16;
  }
  return hSim;
}

// ---------------------------------------------------------------------------
// Yield helper (avoid blocking Node.js event loop on long scans)
// ---------------------------------------------------------------------------
function yieldIfNeeded(iter: number, every = 400): Promise<void> | null {
  return iter % every === 0 ? new Promise<void>(r => setImmediate(r)) : null;
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

/**
 * Find all matched segments of shortFps inside movieFps.
 *
 * @param shortFps   Target/short-clip fingerprints
 * @param movieFps   Reference/movie fingerprints
 * @param minSimilarity  Minimum similarity for high-confidence pass (default 82)
 * @param minConsecutiveFrames  Minimum run length to accept a segment (default 9)
 */
export async function groundMatchedSegments(
  shortFps: FPData[],
  movieFps: FPData[],
  minSimilarity = 82,
  minConsecutiveFrames = 9
): Promise<MatchedSegment[]> {
  if (shortFps.length === 0 || movieFps.length === 0) return [];

  console.log(`[Matcher] Precomputing hash arrays for ${shortFps.length} short + ${movieFps.length} movie frames…`);
  const sSet = precompute(shortFps);
  const mSet = precompute(movieFps);
  console.log(`[Matcher] Precompute done. Starting two-pass scan…`);

  const usedShort = new Uint8Array(shortFps.length); // 0 = free, 1 = in a segment
  const segments: MatchedSegment[] = [];

  const LOOK_AHEAD = 20;
  const WALK_MIN_SIM = 60;
  const MAX_MISS = 3;

  for (let pass = 1; pass <= 2; pass++) {
    const passMinSim = pass === 1 ? minSimilarity : 40;
    const isApproximate = pass === 2;
    let passSegments = 0;

    for (let si = 0; si < shortFps.length; si++) {
      if (usedShort[si]) continue;

      // Yield to event loop periodically
      const yp = yieldIfNeeded(si);
      if (yp) await yp;

      // ---- Brute-force scan: find best matching movie frame ----
      // Uses short 'full' vs ALL movie variants so aspect-ratio / crop mismatches
      // are caught here rather than silently rejected.
      let bestMi = -1;
      let bestFastSim = 0;
      for (let mi = 0; mi < movieFps.length; mi++) {
        const sim = hashSimFastCross(sSet, si, mSet, mi);
        if (sim > bestFastSim) {
          bestFastSim = sim;
          bestMi = mi;
        }
      }

      // Quick-reject before the more expensive full cross-variant check
      if (bestFastSim < passMinSim - 10 || bestMi < 0) continue;

      // ---- Verify with weighted full similarity (hash + signature) ----
      const startSim = frameSim(sSet, si, mSet, bestMi);
      if (startSim < passMinSim) continue;

      // ---- Walk forward to build segment ----
      const seq: Array<{ si: number; mi: number; sim: number }> = [
        { si, mi: bestMi, sim: startSim }
      ];
      let curMi = bestMi;
      let missCount = 0;

      for (let nextSi = si + 1; nextSi < shortFps.length; nextSi++) {
        if (usedShort[nextSi]) break;

        const expectedMi = curMi + 1;

        // Try exact next position first
        if (expectedMi >= 0 && expectedMi < movieFps.length) {
          const sim = frameSim(sSet, nextSi, mSet, expectedMi);
          if (sim >= WALK_MIN_SIM) {
            seq.push({ si: nextSi, mi: expectedMi, sim });
            curMi = expectedMi;
            missCount = 0;
            continue;
          }
        }

        // Look-ahead: try ±LOOK_AHEAD around the expected position
        let bestLookSim = 0;
        let bestLookMi = -1;
        const lo = Math.max(0, expectedMi - LOOK_AHEAD);
        const hi = Math.min(movieFps.length - 1, expectedMi + LOOK_AHEAD);

        for (let lookMi = lo; lookMi <= hi; lookMi++) {
          if (lookMi === expectedMi) continue;
          const sim = frameSim(sSet, nextSi, mSet, lookMi);
          if (sim > bestLookSim) {
            bestLookSim = sim;
            bestLookMi = lookMi;
          }
        }

        if (bestLookSim >= WALK_MIN_SIM && bestLookMi >= 0) {
          seq.push({ si: nextSi, mi: bestLookMi, sim: bestLookSim });
          curMi = bestLookMi;
          missCount = 0;
        } else {
          missCount++;
          if (missCount > MAX_MISS) break;
        }
      }

      if (seq.length < minConsecutiveFrames) continue;

      // Accept segment — mark short frames as used
      for (const item of seq) usedShort[item.si] = 1;

      const avgConf = seq.reduce((s, item) => s + item.sim, 0) / seq.length;
      passSegments++;

      segments.push({
        shortStart: shortFps[seq[0].si].timestamp,
        shortEnd:   shortFps[seq[seq.length - 1].si].timestamp,
        movieStart: movieFps[seq[0].mi].timestamp,
        movieEnd:   movieFps[seq[seq.length - 1].mi].timestamp,
        confidence: avgConf,
        frameCount: seq.length,
        isApproximate,
        matchSequence: seq.map(item => ({
          shortTime: shortFps[item.si].timestamp,
          movieTime: movieFps[item.mi].timestamp,
          similarity: item.sim
        }))
      });
    }

    console.log(`[Matcher] Pass ${pass} (minSim=${passMinSim}%): found ${passSegments} segments.`);
  }

  // ---- Overlap-based deduplication ----
  // Sort by confidence desc; keep highest-confidence non-overlapping segments
  segments.sort((a, b) => b.confidence - a.confidence);

  const final: MatchedSegment[] = [];
  for (const seg of segments) {
    const overlaps = final.some(kept => {
      const overlapStart = Math.max(kept.shortStart, seg.shortStart);
      const overlapEnd   = Math.min(kept.shortEnd,   seg.shortEnd);
      return overlapEnd - overlapStart > 0.15;
    });
    if (!overlaps) final.push(seg);
  }

  // Return sorted by clip timeline
  final.sort((a, b) => a.shortStart - b.shortStart);
  console.log(`[Matcher] Final: ${final.length} non-overlapping segments.`);
  return final;
}
