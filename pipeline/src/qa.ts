// Stage 5 – Output QA. A finished composite is graded by the vision model
// BEFORE it could ever reach a venue owner. This is the automated reject gate.
import { visionJSON, fileToInline } from './gemini.js';
import { productById, productImage } from './products.js';
import type { CompositeQA } from './types.js';

export async function qaComposite(
  frontageBuf: Buffer,
  compositeBuf: Buffer,
  productId: string,
): Promise<CompositeQA> {
  const p = productById(productId);
  const prompt = `You are the final quality gate before a mock-up is sent to a business owner.
IMAGE 1 = original frontage photo. IMAGE 2 = our composite (planter added).
IMAGE 3 = the real product that was supposed to be added: ${p?.name} – ${p?.form}, ${p?.material}, ${p?.planting}.

Grade the composite HARSHLY. It must look like a real photo of IMAGE 1 with the
real product from IMAGE 3 actually standing there. Check:
- productFaithful: does the added planter match IMAGE 3 (shape, material, colour,
  plants)? Reject if the model invented a generic/different planter.
- scalePlausible: is its real-world size believable vs the door (~2m) and people?
- perspectiveConsistent: does it sit on the ground plane at the right angle?
- shadowGrounded: is there a believable contact shadow (not floating, not a
  pasted cut-out)?
- entranceClear: set FALSE only if a planter sits DIRECTLY IN the doorway or
  clearly blocks the way into the venue. Planters beside / flanking / lining the
  frontage next to the door are FINE – that is the desired look. Only a genuine
  blockage counts.
- buildingUnaltered: compare IMAGE 1 and IMAGE 2 – are the building, windows,
  signage, door, people and pavement otherwise UNCHANGED? Reject if the model
  repainted/warped the facade or added extra objects.
- artifacts: list any visible defects (warping, duplicated/extra planters,
  melted plants, hard paste edges, wrong occlusion).

Set reject=true if ANY of productFaithful/scalePlausible/buildingUnaltered is
false, if a planter clearly blocks the doorway (entranceClear=false), or if
score < 0.6.

Return ONLY JSON:
{
  "productFaithful": boolean,
  "scalePlausible": boolean,
  "perspectiveConsistent": boolean,
  "shadowGrounded": boolean,
  "entranceClear": boolean,
  "buildingUnaltered": boolean,
  "artifacts": string[],
  "score": number,          // 0..1 overall deliverability
  "reject": boolean,
  "reasons": string[]
}`;

  const images = [
    fileToInline(frontageBuf, 'image/jpeg'),
    fileToInline(compositeBuf, 'image/png'),
    productImage(productId),
  ];
  const q = await visionJSON<CompositeQA>(prompt, images);
  return {
    productFaithful: !!q.productFaithful,
    scalePlausible: !!q.scalePlausible,
    perspectiveConsistent: !!q.perspectiveConsistent,
    shadowGrounded: !!q.shadowGrounded,
    entranceClear: !!q.entranceClear,
    buildingUnaltered: !!q.buildingUnaltered,
    artifacts: q.artifacts ?? [],
    score: typeof q.score === 'number' ? q.score : 0,
    reject: !!q.reject,
    reasons: q.reasons ?? [],
  };
}
