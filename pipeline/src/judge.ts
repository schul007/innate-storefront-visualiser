// Stage 3 – Vision judge. Two jobs on the SAME image:
//   (a) is this a usable frontage capture? (shows entrance, well framed)
//   (b) is it a GOOD CANDIDATE? (bare / under-dressed frontage = high opportunity)
// It also recommends which of the client's three products best fits the frontage.
import { visionJSON, fileToInline } from './gemini.js';
import { catalogSummary } from './products.js';
import type { FrontageJudgement } from './types.js';

const PROMPT = `You are the automated frontage-vetting step of a pipeline that dresses London
shopfronts with outdoor planters for a sales mock-up. Judge the SINGLE street
photo provided. Be strict: at 5,000 venues/week a human never sees this, your
verdict alone decides whether we proceed.

Answer TWO things:
1. CAPTURE QUALITY – does this image clearly show the venue's street-facing
   ENTRANCE/doorway, reasonably framed (not cropped off, not mostly road/sky,
   not blurred, not obscured by a passing vehicle/scaffolding)?
2. OPPORTUNITY – is the frontage BARE or UNDER-DRESSED at ground level either
   side of the door (no existing planters/greenery/benches), i.e. a place where
   adding planters would visibly improve the entrance? A frontage already full
   of plants, or with no usable pavement either side of the door, is a poor fit.

Also pick which product best suits this frontage from this catalogue:
${catalogSummary()}

Reject (reject=true) if: the entrance is not clearly visible; the image is
blurred/obstructed/too far; it's an interior shot; or there is simply nowhere
at ground level to place a planter.

Return ONLY JSON with exactly these keys:
{
  "showsEntrance": boolean,
  "entranceConfidence": number,   // 0..1
  "framingUsable": boolean,
  "frontageBareness": number,     // 0..1, 1 = completely bare
  "obstructions": string[],
  "surfaceAtEntrance": "pavement" | "step" | "recessed" | "unknown",
  "recommendedProduct": string,   // one product id from the catalogue
  "placementHint": string,        // short: where planters should sit
  "reject": boolean,
  "reasons": string[]             // brief justifications
}`;

export async function judgeFrontage(imageBuf: Buffer): Promise<FrontageJudgement> {
  const img = fileToInline(imageBuf, 'image/jpeg');
  const j = await visionJSON<FrontageJudgement>(PROMPT, [img]);
  // Defensive normalisation so one odd field can't crash the run.
  return {
    showsEntrance: !!j.showsEntrance,
    entranceConfidence: clamp01(j.entranceConfidence),
    framingUsable: !!j.framingUsable,
    frontageBareness: clamp01(j.frontageBareness),
    obstructions: j.obstructions ?? [],
    surfaceAtEntrance: j.surfaceAtEntrance ?? 'unknown',
    recommendedProduct: j.recommendedProduct,
    placementHint: j.placementHint ?? '',
    reject: !!j.reject,
    reasons: j.reasons ?? [],
  };
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : 0;
  return Math.max(0, Math.min(1, v));
}
