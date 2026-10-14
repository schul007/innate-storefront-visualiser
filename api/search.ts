// Vercel serverless function – venue lookup for the live demo.
// POST /api/search { query }  -> up to 6 candidate venues (name, coords, photos)
// so the UI can hand a chosen venue straight to /api/generate.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../pipeline/src/config.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.types', 'places.rating', 'places.userRatingCount', 'places.photos',
].join(',');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!env.googleKey) return res.status(503).json({ error: 'Server missing GOOGLE_MAPS_API_KEY' });
  try {
    const { query } = req.body as { query?: string };
    if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });

    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.googleKey,
        'X-Goog-FieldMask': FIELDS,
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 6, languageCode: 'en' }),
    });
    if (!r.ok) return res.status(502).json({ error: `Places ${r.status}`, detail: (await r.text()).slice(0, 200) });
    const json = (await r.json()) as { places?: any[] };
    const results = (json.places ?? []).map((p) => ({
      placeId: p.id,
      name: p.displayName?.text ?? '',
      address: p.formattedAddress ?? '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      types: p.types ?? [],
      rating: p.rating,
      userRatingCount: p.userRatingCount,
      photoNames: (p.photos ?? []).map((ph: { name: string }) => ph.name),
    }));
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
