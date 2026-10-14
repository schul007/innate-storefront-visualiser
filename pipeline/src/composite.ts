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
import { nearestAspectRatio } from './imageutil.js';
import type { CompositeQA, FrontageJudgement } from './types.js';

export function buildPrompt(productId: string, judgement: FrontageJudgement): string {
  const p = productById(productId)!;
  const dims = Object.entries(p.dimensions_cm).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}cm`).join(', ');
  const placement = judgement.placementHint || 'to the side of the entrance, against the building frontage';

  return `You are compositing a REAL product into a REAL photograph for a sales preview. The only change is to ADD the planter(s) from IMAGE 2 onto the pavement in IMAGE 1. Everything else stays exactly as photographed.

IMAGE 1 = the fixed background photograph. Keep its FRAMING, crop, camera angle and resolution identical – do NOT zoom, re-crop, recompose or re-render the scene. Treat the building, windows, door, signage TEXT, people, vehicles, road and pavement as FIXED pixels – do not repaint, relight, move, remove or warp any of them.

IMAGE 2 = the client's ACTUAL product that must appear: "${p.name}" – ${p.form}, ${p.material}. Planting: ${p.planting}.
PRODUCT FIDELITY (critical): reproduce the EXACT planter AND the EXACT planting from IMAGE 2 – same silhouette, material finish and colour, and the SAME plant species, leaf shapes, flower colours, arrangement and proportions. A viewer must recognise it as the identical catalogue item. Do NOT redesign the plants, swap species, or produce a generic "nice planter". If multiple units are shown, every unit is identical to IMAGE 2.

HOW THIS PRODUCT IS STYLED (follow this exactly – it is how the client arranges it):
${p.placement_style}
Typical quantity: ${p.typical_quantity}. Every unit must be IDENTICAL to IMAGE 2 and at matching scale.

PLACEMENT ON THIS FRONTAGE (critical):
- Best spot here: ${placement}.
- Follow the styling above, adapted to this frontage. Keep the arrangement deliberate and balanced – not a single lonely pot, not scattered, not a symmetric pair where the styling calls for a grouping.
- NEVER place a planter directly in front of the door, in the doorway, or where it blocks the entrance. The doorway and the natural path walking INTO the venue must stay completely clear and unobstructed.
- Keep the pavement walking route clear – set planters tight against the building frontage, not out in the pedestrian line or the road. Do not place them on top of existing seating/bins/signage.
- If the pavement is genuinely too narrow for the full arrangement, use fewer units kept tight to the wall rather than crowding the path.
- ${p.scale_notes}

Scale: the planter's real size is ${dims}. A standard doorway is about 2m tall and an adult about 1.7m – size the planter so it is correct relative to the door and any people in the shot. Do not make it oversized or toy-sized.

Perspective: match IMAGE 1's camera height, viewing angle and vanishing lines so the planter sits flat on the ground plane.

Light & shadow (grounding is critical): match the existing sun direction and softness in IMAGE 1. Each planter's base must sit FLAT ON the pavement with a clear, soft-edged CONTACT SHADOW pooling on the ground away from the light – no gap, no floating, no pasted-cut-out look. Respect occlusion (a passing pedestrian in front stays in front).

Output: a single photorealistic image at the SAME framing and aspect ratio as IMAGE 1, indistinguishable from a real photograph of that doorway with the product actually present.`;
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
  const aspectRatio = nearestAspectRatio(frontageBuf);

  const attempts: { buf: Buffer; qa: CompositeQA; path: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const prompt = i === 0
      ? basePrompt
      : `${basePrompt}\n\nThe previous attempt was rejected for: ${attempts[0].qa.reasons.join('; ')}. Fix these specifically while keeping the building and framing unchanged.`;
    const out = await geminiComposite(prompt, frontage, products, aspectRatio);
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
