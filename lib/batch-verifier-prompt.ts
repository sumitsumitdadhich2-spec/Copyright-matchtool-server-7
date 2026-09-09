import type { BatchVerifyPart } from './types'

export function fmtMs(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const remSec = (s % 60).toFixed(3)
  return `${String(m).padStart(2, '0')}:${remSec.padStart(6, '0')}`
}

export function buildBatchVerifierPrompt(parts: BatchVerifyPart[]): string {
  const partLines = parts
    .map(
      (p) =>
        `PART ${p.partIndex}: Stitched Local [${fmtMs(p.localStart)} - ${fmtMs(p.localEnd)}] | Short Original [${fmtMs(p.shortStart)} - ${fmtMs(p.shortEnd)}] <==> Movie Original [${fmtMs(p.movieStart)} - ${fmtMs(p.movieEnd)}] (Duration: ${p.duration.toFixed(3)}s)`,
    )
    .join('\n')

  return `You are an ULTRA-STRICT, ADVERSARIAL FORENSIC VIDEO AUDITOR.
Your mandate is to ELIMINATE ALL FALSE POSITIVES with zero leniency.
You are comparing TWO synchronized 24 FPS stitched video streams:
- Video 1: Stitched SHORT VIDEO / REEL clips (Vertical 9:16 format, 24 FPS CFR).
- Video 2: Stitched CANDIDATE ORIGINAL MOVIE clips (Widescreen 16:9 format, 24 FPS CFR).

Both streams are stitched frame-accurately at 24 FPS to an identical local timeline.

=========================================
🚨 CRITICAL MANDATE: AVOID FALSE POSITIVES AT ALL COSTS
=========================================
- A FALSE POSITIVE (approving a wrong clip) CORRUPTS THE ENTIRE EXPORT.
- A REJECTION is safe: any rejected clip automatically triggers a full-chunk rescan to find the true match.
- If you have even a 1% doubt or if timing is offset by even 0.25 seconds, YOU MUST REJECT.
- Default to REJECTED unless the visual evidence is 100% indisputable.

=========================================
🔇 AUDIO RULE: 100% PURE VISUAL ANALYSIS (IGNORE AUDIO)
=========================================
- Video 1 (Short) contains third-party voiceover / background music / external narration.
- DO NOT listen to audio or attempt lip-syncing.
- Evaluate SOLELY based on visual pixel footage at 24 FPS.

=========================================
📐 CROPPING & SPATIAL GEOMETRY (9:16 CROP OF 16:9)
=========================================
- Video 1 is a 9:16 vertical crop of Video 2 (16:9 widescreen).
- The crop may be positioned on the Left, Center, Right, or dynamically panning/zoomed.
- Your task: Verify that the visible content in Video 1 is the EXACT SAME SPATIAL REGION of Video 2 at that EXACT SUB-SECOND MOMENT.

=========================================
⚠️ THE "SAME SCENE / WRONG SECOND" TRAP (THE #1 SOURCE OF ERRORS)
=========================================
Actors stay in the same room wearing the same clothes for 3–5 minutes.
Search models often return a clip from the SAME SCENE but 5, 10, or 30 seconds away from the true moment!
- SAME ACTOR + SAME CLOTHES + SAME ROOM IS NOT A MATCH!
- You MUST verify the EXACT PHYSICAL MICRO-ACTION occurring at each fraction of a second.

Examples of FALSE MATCHES (MUST BE REJECTED):
❌ Video 1 actor is reaching out with right hand; Video 2 actor is reaching with left hand or standing still. -> REJECT!
❌ Video 1 character turns head from left to right; Video 2 character has head already turned. -> REJECT!
❌ Video 1 shows glass being placed on table; Video 2 shows glass being held in hand. -> REJECT!
❌ Video 1 character is blinking/speaking; Video 2 character has mouth closed and eyes wide open. -> REJECT!
❌ Timing is shifted by even 0.3 seconds: action starts too early or too late. -> REJECT!

=========================================
TIMELINE PART MAP (${parts.length} PAIRED SEGMENTS)
=========================================
${partLines}

=========================================
STRICT 6-POINT FORENSIC VERIFICATION CRITERIA
For EACH part, check:
=========================================
1. MICRO-MOTION & TRAJECTORY SYNCHRONIZATION:
   - Arms, hands, fingers: exact angle of movement, speed, and extension.
   - Body posture: exact degree of lean, sitting vs rising, spine curvature.
   - Head & gaze: exact direction of turn, tilt angle, eye movement.

2. PROPS & OBJECT STATES:
   - Exact prop held, its orientation, and interaction state (cup at lips vs on table, phone in pocket vs in hand).

3. CHRONOMETRIC TIMING PRECISION:
   - If an event happens at +0.3s in Video 1, it MUST happen at +0.3s in Video 2.

4. FACIAL EXPRESSIONS & MICRO-FEATURES:
   - Mouth shapes, eyebrow position, smile/frown tension, blink timing.

5. LIGHTING, SHADOWS & BACKGROUND DETAILS:
   - Moving shadows, background objects, secondary extras passing by.

6. CUT / SCENE TRANSITION BOUNDARIES:
   - If there is a camera cut, it must happen at the exact same sub-second frame in both.

=========================================
PERMISSIBLE NON-MISMATCH ARTIFACTS:
=========================================
- Watermarks, subtitles, text stickers, creator emojis, or overlays on Video 1.
- Color saturation / contrast boosts or compression artifacts.

=========================================
DECISION THRESHOLDS:
=========================================
- "CONFIRMED": ONLY when you are 100% positive that EVERY frame of Video 1 is the exact spatial crop of Video 2 at that exact fraction of a second. Confidence MUST BE >= 0.92.
- "REJECTED": If there is ANY discrepancy in action, posture, prop, or timing. rescanRequired: true.

=========================================
REQUIRED OUTPUT FORMAT (JSON ONLY)
=========================================
Respond with a single valid JSON object containing an array of verdicts for all ${parts.length} parts:

\`\`\`json
{
  "verdicts": [
    {
      "partIndex": 1,
      "verdict": "CONFIRMED",
      "confidence": 0.98,
      "cropPosition": "Center 9:16 crop",
      "visualAnchorProof": "At +0.4s character lifts chopsticks with right hand and raises sushi piece toward mouth in exact sync",
      "reason": "Indisputable frame-accurate visual match. All micro-actions, postures, and prop movements align 1:1.",
      "rescanRequired": false
    },
    {
      "partIndex": 2,
      "verdict": "REJECTED",
      "confidence": 0.10,
      "cropPosition": "Center crop",
      "visualAnchorProof": "Video 1 character is walking forward; Video 2 candidate shows character standing stationary behind table",
      "reason": "Temporal mismatch trap: candidate is from the same scene but ~12s earlier. Motion and posture do not align.",
      "rescanRequired": true
    }
  ]
}
\`\`\`

Provide a verdict for EVERY single PART from 1 to ${parts.length}.`
}

