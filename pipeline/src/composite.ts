// Stage 4 – Composite the client's REAL product into the frontage.
//
// Key decisions (see design.md):
//  * We pass the product REFERENCE PHOTO as an image input, not just a text
//    description, so the model reproduces the actual planter instead of
//    inventing a generic one ("image-conditioned", not "text-reinterpreted").
//  * We give an explicit scale anchor (door ~2m + the product's real cm) so the
//    planter lands at a believable real-world size.
//  * We forbid any change to the building/people/pavement.
import fs from 'node:fs/promises';
import path from 'node:path';
import { composite as geminiComposite, fileToInline } from './gemini.js';
import { qaComposite } from './qa.js';
import { productById, productImage } from './products.js';
import type { CompositeQA, FrontageJudgement } from './types.js';

export function buildPrompt(productId: string, judgement: FrontageJudgement): string {
  const p = productById(productId)!;
  const dims = Object.entries(p.dimensions_cm).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}cm`).join(', ');
  const placement = judgement.placementHint || 'to the side of the entrance, against the building frontage';

  return `Photorealistic product placement for a sales preview. Edit IMAGE 1 only by ADDING the planter(s) shown in IMAGE 2. Change nothing else.

IMAGE 1 = the real venue frontage. Treat the building, windows, door, signage, people, vehicles, road and pavement as FIXED – do not repaint, relight, move, remove or warp any of it.

IMAGE 2 = the client's ACTUAL product that must appear: "${p.name}" – ${p.form}, ${p.material}. Planting: ${p.planting}. Reproduce THIS exact planter and planting faithfully (same shape, material, colour, proportions and plants). Do NOT substitute a generic planter.

PLACEMENT (critical – this is how a real venue would style it):
- Suggested spot: ${placement}.
- Place the planter(s) to the SIDE(S) of the entrance, flanking the door or lining the frontage against the building wall / beneath the windows.
- NEVER place a planter directly in front of the door, in the doorway, or where it blocks the entrance. The doorway and the natural path walking INTO the venue must stay completely clear and unobstructed.
- Keep the pavement walking route clear – do not block where pedestrians pass. If the pavement is narrow, use fewer or smaller units kept tight against the wall.
- Do not place planters in the road or on top of existing seating/bins/signage.
- ${p.scale_notes}

Scale: the planter's real size is ${dims}. A standard doorway is about 2m tall and an adult about 1.7m – size the planter so it is correct relative to the door and any people in the shot. Do not make it oversized or toy-sized.

Perspective: match IMAGE 1's camera height, viewing angle and vanishing lines so the planter sits flat on the ground plane.

Light & shadow: match the existing sun direction and softness in IMAGE 1. Add a believable soft contact shadow where the planter meets the ground so it is grounded, not floating or pasted. Respect occlusion (e.g. a passing pedestrian in front stays in front).

Output: a single photorealistic image, same framing and resolution as IMAGE 1, indistinguishable from a real photograph of that doorway with the product present.`;
}

export interface CompositeOutput {
  imagePath: string;
  qa: CompositeQA;
  regenerated: boolean;
}

/**
 * Generate, QA, and – if rejected – regenerate once with a corrective nudge.
 * Returns the better of the two attempts even if both are rejected, so the
 * caller/UI can show what happened (the final deliver/hold decision is made by
 * the orchestrator on qa.reject).
 */
export async function compositeVenue(
  frontageBuf: Buffer,
  productId: string,
  judgement: FrontageJudgement,
  outDir: string,
): Promise<CompositeOutput | null> {
  const frontage = fileToInline(frontageBuf, 'image/jpeg');
  const products = [productImage(productId)];
  const basePrompt = buildPrompt(productId, judgement);

  const attempts: { buf: Buffer; qa: CompositeQA; path: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const prompt = i === 0
      ? basePrompt
      : `${basePrompt}\n\nThe previous attempt was rejected for: ${attempts[0].qa.reasons.join('; ')}. Fix these specifically while keeping the building unchanged.`;
    const out = await geminiComposite(prompt, frontage, products);
    if (!out) continue;
    const p = path.join(outDir, `composite_attempt${i + 1}.png`);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(p, out);
    const qa = await qaComposite(frontageBuf, out, productId);
    attempts.push({ buf: out, qa, path: p });
    if (!qa.reject) {
      return { imagePath: p, qa, regenerated: i > 0 };
    }
  }

  if (!attempts.length) return null;
  const best = attempts.sort((a, b) => b.qa.score - a.qa.score)[0];
  return { imagePath: best.path, qa: best.qa, regenerated: attempts.length > 1 };
}
