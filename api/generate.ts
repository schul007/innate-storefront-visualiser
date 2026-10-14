// Vercel serverless function – the live "run the pipeline" path.
//
// POST /api/generate  { lat, lng, name, placeId?, photoNames?: string[] }
// Runs capture (Street View, heading-from-geometry) -> judge -> composite ->
// QA entirely in memory and returns data-URL images + the decision trail, so a
// reviewer can trigger the real pipeline from the deployed site.
//
// Kept deliberately self-contained (no disk writes – serverless FS is read-only)
// but reuses the exact same judge / compositor / QA modules as the batch run.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env, CAPTURE } from '../pipeline/src/config.js';
import { bearing, distanceMeters } from '../pipeline/src/geo.js';
import { judgeFrontage } from '../pipeline/src/judge.js';
import { buildPrompt } from '../pipeline/src/composite.js';
import { qaComposite } from '../pipeline/src/qa.js';
import { productById, productImage } from '../pipeline/src/products.js';
import { composite as geminiComposite, fileToInline } from '../pipeline/src/gemini.js';

const SV_META = 'https://maps.googleapis.com/maps/api/streetview/metadata';
const SV_IMAGE = 'https://maps.googleapis.com/maps/api/streetview';

async function dl(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!env.googleKey || !env.geminiKey) {
    return res.status(503).json({ error: 'Server missing GOOGLE_MAPS_API_KEY / GEMINI_API_KEY' });
  }
  try {
    const { lat, lng, name, photoNames } = req.body as {
      lat: number; lng: number; name?: string; photoNames?: string[];
    };
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng (numbers) required' });
    }

    // --- Capture: Street View first, Place Photo fallback ---
    let frontage: Buffer | null = null;
    let source = 'streetview';
    let geom: { heading?: number; fov?: number } = {};
    const meta = (await (await fetch(`${SV_META}?location=${lat},${lng}&source=outdoor&key=${env.googleKey}`)).json()) as {
      status: string; location?: { lat: number; lng: number };
    };
    if (meta.status === 'OK' && meta.location &&
        distanceMeters(meta.location.lat, meta.location.lng, lat, lng) <= CAPTURE.radiusMeters) {
      const heading = bearing(meta.location.lat, meta.location.lng, lat, lng);
      geom = { heading: Math.round(heading), fov: CAPTURE.fov };
      frontage = await dl(`${SV_IMAGE}?size=640x640&location=${lat},${lng}&heading=${heading.toFixed(1)}&fov=${CAPTURE.fov}&pitch=${CAPTURE.pitch}&source=outdoor&key=${env.googleKey}`);
    } else if (photoNames?.length) {
      source = 'place-photo';
      frontage = await dl(`https://places.googleapis.com/v1/${photoNames[0]}/media?maxWidthPx=1200&key=${env.googleKey}`);
    }
    if (!frontage) return res.status(422).json({ error: 'No usable street imagery for this location', meta });

    // --- Judge ---
    const judgement = await judgeFrontage(frontage);
    const product = judgement.recommendedProduct && productById(judgement.recommendedProduct)
      ? judgement.recommendedProduct : 'product-a-black-cylinder';

    // --- Composite + QA ---
    const out = await geminiComposite(
      buildPrompt(product, judgement),
      fileToInline(frontage, 'image/jpeg'),
      [productImage(product)],
    );
    if (!out) return res.status(502).json({ error: 'Compositor returned no image', judgement });
    const qa = await qaComposite(frontage, out, product);

    return res.status(200).json({
      name: name ?? 'venue',
      source, ...geom,
      product, productName: productById(product)?.name,
      judgement, qa,
      status: qa.reject ? 'held-by-qa' : 'delivered',
      frontage: dataUrl(frontage, 'image/jpeg'),
      after: dataUrl(out, 'image/png'),
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
