// Central config + env loading. Keys live in .env (never committed).
import 'dotenv/config';
import path from 'node:path';

// Resolve from the process working directory, not __dirname. This is the
// project root when running the pipeline locally (`npm run ...` sets cwd), and
// the deployment root (/var/task) on Vercel – where vercel.json's
// `includeFiles: "products/**"` places the product files. Using __dirname would
// break after the serverless bundler flattens the module layout.
export const ROOT = process.cwd();
export const PRODUCTS_DIR = path.join(ROOT, 'products');
export const RESULTS_DIR = path.join(ROOT, 'results');
export const PUBLIC_RESULTS_DIR = path.join(ROOT, 'public', 'results');
export const SRC_DATA_DIR = path.join(ROOT, 'src', 'data');

export const env = {
  googleKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  geminiKey: process.env.GEMINI_API_KEY ?? '',
  mapillaryToken: process.env.MAPILLARY_TOKEN ?? '',
};

export const MODELS = {
  // "Nano Banana Pro" image model – best reference fidelity, grounding and
  // in-place editing. NOTE: image generation needs a BILLED Gemini project
  // (free tier limit = 0). Set GEMINI_IMAGE_MODEL=gemini-3.1-flash-image for a
  // cheaper/faster (lower-fidelity) run.
  image: process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3-pro-image',
  // Vision judge / QA – fast multimodal model, free tier is fine.
  vision: process.env.GEMINI_VISION_MODEL ?? 'gemini-flash-lite-latest',
};

// Street View Static capture defaults.
export const CAPTURE = {
  size: '1024x1024',
  fov: 70,            // field of view in degrees; lower = more zoom
  pitch: 6,           // slight upward tilt to include signage above the door
  source: 'outdoor',  // avoid indoor/business-interior panoramas
  radiusMeters: 60,   // how far from the venue we'll accept a panorama
};

export const SELECTION = {
  // Chains / non-independent brands we exclude by name match (lower-cased).
  chainDenylist: [
    'starbucks', 'costa', 'pret', 'greggs', 'mcdonald', 'kfc', 'burger king',
    'nando', 'wagamama', 'subway', 'leon', 'itsu', 'caffe nero', 'gail',
    'wasabi', 'five guys', 'pizza express', 'franco manca', 'honest burger',
    'joe & the juice', 'joe and the juice', 'tortilla', 'wetherspoon',
    'all bar one', 'byron', 'shake shack', 'tgi', 'nando’s',
    'toni & guy', 'toni and guy', 'supercuts', 'regis',
  ],
  minRatingCount: 5,        // avoid brand-new/placeholder listings
  targetCount: 3,           // how many delivered visuals we want
  candidatePoolSize: 20,    // how many candidates to pull before judging
};

export function assertKey(name: 'google' | 'gemini'): void {
  if (name === 'google' && !env.googleKey) {
    throw new Error('GOOGLE_MAPS_API_KEY missing – set it in .env (see .env.example).');
  }
  if (name === 'gemini' && !env.geminiKey) {
    throw new Error('GEMINI_API_KEY missing – set it in .env (see .env.example).');
  }
}
