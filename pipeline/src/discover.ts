// Stage 1 – Discover candidate venues via Google Places API (New).
// We pull a pool of independent, street-facing businesses across a few central
// London areas, filter out chains, and return them for frontage judging.
import { env, SELECTION, assertKey } from './config.js';
import type { Venue } from './types.js';

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.photos',
  'places.websiteUri',
].join(',');

// Queries chosen to surface independents with street frontages in areas where
// Street View coverage is strong. Breadth across type + area de-risks the pool.
const QUERIES = [
  'independent cafe in Shoreditch London',
  'independent coffee shop in Marylebone London',
  'independent restaurant in Soho London',
  'hair salon in Islington London',
  'independent cafe in Clerkenwell London',
  'bistro in Fitzrovia London',
  'nail salon in Notting Hill London',
  'independent deli in Bermondsey London',
];

interface RawPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  addressComponents?: { types: string[]; longText: string; shortText: string }[];
  location?: { latitude: number; longitude: number };
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  photos?: { name: string }[];
  websiteUri?: string;
}

function postcodeFrom(p: RawPlace): string {
  const comp = p.addressComponents?.find((c) => c.types.includes('postal_code'));
  if (comp) return comp.longText;
  // Fallback: UK postcode regex over the formatted address.
  const m = p.formattedAddress?.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i);
  return m ? m[0].toUpperCase() : '';
}

function isChain(name: string): boolean {
  const n = name.toLowerCase();
  return SELECTION.chainDenylist.some((brand) => n.includes(brand));
}

async function searchText(query: string): Promise<RawPlace[]> {
  const res = await fetch(PLACES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.googleKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 8, languageCode: 'en' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Places searchText failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { places?: RawPlace[] };
  return json.places ?? [];
}

export async function discover(): Promise<Venue[]> {
  assertKey('google');
  const seen = new Set<string>();
  const venues: Venue[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (const q of QUERIES) {
    let places: RawPlace[] = [];
    try {
      places = await searchText(q);
    } catch (err) {
      console.warn(`  ! query "${q}" errored: ${(err as Error).message}`);
      continue;
    }
    for (const p of places) {
      const name = p.displayName?.text ?? '';
      if (!p.id || seen.has(p.id) || !name || !p.location) continue;
      seen.add(p.id);

      if (isChain(name)) { rejected.push({ name, reason: 'chain denylist' }); continue; }
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') {
        rejected.push({ name, reason: `status ${p.businessStatus}` }); continue;
      }
      if ((p.userRatingCount ?? 0) < SELECTION.minRatingCount) {
        rejected.push({ name, reason: 'too few ratings (placeholder listing?)' }); continue;
      }

      venues.push({
        placeId: p.id,
        name,
        address: p.formattedAddress ?? '',
        postcode: postcodeFrom(p),
        lat: p.location.latitude,
        lng: p.location.longitude,
        types: p.types ?? [],
        rating: p.rating,
        userRatingCount: p.userRatingCount,
        businessStatus: p.businessStatus,
        photoNames: p.photos?.map((ph) => ph.name) ?? [],
        website: p.websiteUri,
      });
    }
  }

  console.log(`  discovered ${venues.length} independent candidates (rejected ${rejected.length})`);
  if (rejected.length) {
    console.log('  sample rejects:', rejected.slice(0, 6).map((r) => `${r.name} [${r.reason}]`).join('; '));
  }
  return venues;
}
