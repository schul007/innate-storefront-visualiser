// Shared types for the storefront capture & visualisation pipeline.

export interface Venue {
  placeId: string;
  name: string;
  address: string;
  postcode: string;
  lat: number;
  lng: number;
  types: string[];
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  /** Google Place Photo resource names, used as a capture fallback. */
  photoNames?: string[];
  website?: string;
}

export type ImageSource = 'streetview' | 'place-photo' | 'mapillary';

export interface CaptureResult {
  ok: boolean;
  source: ImageSource;
  /** Local path to the saved frontage image. */
  imagePath?: string;
  /** Capture geometry when it applies (Street View). */
  heading?: number;
  fov?: number;
  pitch?: number;
  /** Panorama / image provenance for the rights trail. */
  provenance: Record<string, unknown>;
  attempts: CaptureAttempt[];
}

export interface CaptureAttempt {
  source: ImageSource;
  params: Record<string, unknown>;
  outcome: 'used' | 'rejected' | 'error';
  reason?: string;
  judge?: FrontageJudgement;
}

/** Vision-model judgement on a candidate frontage image. */
export interface FrontageJudgement {
  showsEntrance: boolean;        // does the image clearly contain the street-facing entrance?
  entranceConfidence: number;    // 0..1
  framingUsable: boolean;        // entrance reasonably centred, not occluded/cropped/blurred
  isVenueShopfront: boolean;     // does it clearly show THIS venue's own shopfront (signage/storefront), not a generic/secondary door?
  frontageBareness: number;      // 0..1  (1 = totally bare, high opportunity)
  obstructions: string[];        // e.g. ["scaffolding", "parked van", "A-board"]
  surfaceAtEntrance: string;     // "pavement" | "step" | "recessed" | "unknown"
  recommendedProduct?: string;   // product id the judge thinks fits best
  recommendedProducts?: string[]; // all products that suit this frontage, best first
  placementHint?: string;        // where planters should go, in words
  reject: boolean;               // hard reject this image for capture
  reasons: string[];
}

/** Vision-model QA verdict on a finished composite. */
export interface CompositeQA {
  productFaithful: boolean;      // do the planters match the reference products?
  scalePlausible: boolean;       // believable real-world size vs door/bricks?
  perspectiveConsistent: boolean;
  shadowGrounded: boolean;       // contact shadow / grounded, not floating
  entranceClear: boolean;        // doorway + walking path NOT blocked by the planters
  buildingUnaltered: boolean;    // facade/signage/people unchanged
  artifacts: string[];           // visible defects
  score: number;                 // 0..1 overall deliverability
  reject: boolean;               // never send to owner
  reasons: string[];
}

export interface PipelineResult {
  venue: Venue;
  capture: CaptureResult;
  frontageJudgement: FrontageJudgement;
  chosenProduct: string;
  composite: {
    imagePath: string;
    qa: CompositeQA;
    regenerated: boolean;
  };
  status: 'delivered' | 'rejected' | 'no-frontage';
  generatedAt: string;
}
