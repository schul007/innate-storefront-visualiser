// Vercel serverless function – the live "run the pipeline" path.
//
// POST /api/generate  { lat, lng, name, placeId?, photoNames?: string[] }
// Runs the SAME capture (Street View heading-from-geometry + shopfront-aware
// Google Business photo selection) -> judge -> composite -> QA as the batch
// pipeline, in a writable /tmp workdir, and returns data-URL images + the full
// decision trail so a reviewer can trigger the real pipeline from the site.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../pipeline/src/config.js';
import { capture } from '../pipeline/src/capture.js';
import { compositeVenue } from '../pipeline/src/composite.js';
import { productById } from '../pipeline/src/products.js';
import type { Venue } from '../pipeline/src/types.js';

const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!env.googleKey || !env.geminiKey) {
    return res.status(503).json({ error: 'Server missing GOOGLE_MAPS_API_KEY / GEMINI_API_KEY' });
  }
  try {
    const { lat, lng, name, placeId, photoNames } = req.body as {
      lat: number; lng: number; name?: string; placeId?: string; photoNames?: string[];
    };
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng (numbers) required' });
    }

    const venue: Venue = {
      placeId: placeId ?? '', name: name ?? 'venue', address: '', postcode: '',
      lat, lng, types: [], photoNames: photoNames ?? [],
    };
    const workDir = path.join(os.tmpdir(), `gen-${Date.now()}`);

    // --- Capture (Street View + shopfront-aware Google photo selection) ---
    const cap = await capture(venue, workDir);
    if (!cap.imagePath) {
      return res.status(422).json({ error: 'No usable street imagery for this location', attempts: cap.attempts });
    }
    const judgement = cap.attempts.find((a) => a.outcome === 'used')?.judge
      ?? cap.attempts.filter((a) => a.judge).sort((a, b) => (b.judge!.entranceConfidence) - (a.judge!.entranceConfidence))[0]?.judge;
    if (!judgement) return res.status(422).json({ error: 'Could not judge any frontage', attempts: cap.attempts });

    const product = judgement.recommendedProduct && productById(judgement.recommendedProduct)
      ? judgement.recommendedProduct : 'product-a-black-cylinder';

    // --- Composite + QA ---
    const frontageBuf = await fs.readFile(cap.imagePath);
    const comp = await compositeVenue(frontageBuf, product, judgement, workDir);
    if (!comp) return res.status(502).json({ error: 'Compositor returned no image', judgement });
    const afterBuf = await fs.readFile(comp.imagePath);

    return res.status(200).json({
      name: venue.name,
      source: cap.source,
      heading: cap.heading != null ? Math.round(cap.heading) : undefined,
      fov: cap.fov,
      product, productName: productById(product)?.name,
      judgement, qa: comp.qa,
      regenerated: comp.regenerated,
      status: comp.qa.reject ? 'held-by-qa' : 'delivered',
      attempts: cap.attempts.map((a) => ({ source: a.source, outcome: a.outcome, reason: a.reason })),
      frontage: dataUrl(frontageBuf, 'image/jpeg'),
      after: dataUrl(afterBuf, 'image/png'),
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
