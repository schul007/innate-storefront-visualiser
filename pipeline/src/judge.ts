// Stage 3 – Vision judge. Two jobs on the SAME image:
//   (a) is this a usable frontage capture? (shows entrance, well framed)
//   (b) is it a GOOD CANDIDATE? (bare / under-dressed frontage = high opportunity)
// It also recommends which of the client's three products best fits the frontage.
import { visionJSON, fileToInline } from './gemini.js';
import { catalogSummary } from './products.js';
import type { FrontageJudgement } from './types.js';

function buildPrompt(venueName?: string): string {
  const venueLine = venueName
    ? `The venue is named "${venueName}". A good capture shows ITS OWN shopfront – ideally with its signage/name or a recognisable storefront. A plain, unmarked, or clearly secondary/side/residential doorway that could belong to any building is NOT a good capture of this venue, even if it technically shows a door.`
    : `A good capture shows the venue's own shopfront – a recognisable storefront, ideally with signage.`;
  return `You are the automated frontage-vetting step of a pipeline that dresses London
shopfronts with outdoor planters for a sales mock-up. Judge the SINGLE street
photo provided. Be strict: at 5,000 venues/week a human never sees this, your
verdict alone decides whether we proceed.

${venueLine}

Answer THREE things:
1. CAPTURE QUALITY – does this image clearly show the venue's street-facing
   ENTRANCE/doorway, reasonably framed (not cropped off, not mostly road/sky,
   not blurred, not obscured by a passing vehicle/scaffolding)?
2. VENUE SHOPFRONT – does it clearly show THIS venue's own shopfront (its
   signage, window display or recognisable storefront), as opposed to a generic
   stone/brick doorway, a side entrance, or a neighbouring building? Set
   isVenueShopfront=false if you cannot tell this is the named venue's frontage.
3. OPPORTUNITY – is the frontage BARE or UNDER-DRESSED at ground level either
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
  "isVenueShopfront": boolean,     // clearly this venue's own shopfront?
  "frontageBareness": number,     // 0..1, 1 = completely bare
  "obstructions": string[],
  "surfaceAtEntrance": "pavement" | "step" | "recessed" | "unknown",
  "recommendedProduct": string,   // one product id from the catalogue
  "placementHint": string,        // short: where planters should sit
  "reject": boolean,
  "reasons": string[]             // brief justifications
}`;
}

export async function judgeFrontage(imageBuf: Buffer, venueName?: string): Promise<FrontageJudgement> {
  const img = fileToInline(imageBuf, 'image/jpeg');
  const j = await visionJSON<FrontageJudgement>(buildPrompt(venueName), [img]);
  // Defensive normalisation so one odd field can't crash the run.
  return {
    showsEntrance: !!j.showsEntrance,
    entranceConfidence: clamp01(j.entranceConfidence),
    framingUsable: !!j.framingUsable,
    isVenueShopfront: !!j.isVenueShopfront,
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
