// Stage 2 + fallback chain – get a well-framed frontage image for a venue.
//
// Strategy (see design.md §3):
//   1. Street View, heading derived from panorama -> venue bearing. If the judge
//      says this clearly shows THE VENUE'S OWN SHOPFRONT and is well framed, use
//      it – Street View is the primary "real street view" source and we stop here
//      (cheapest path, no extra calls).
//   2. If Street View is ambiguous / faces a side or generic doorway / doesn't
//      clearly show the venue, we ALSO evaluate the venue's Google Place (Business)
//      photos and pick the best-scoring frontage across all sources. This is the
//      brief's "fall back to Google Business photos when Street View doesn't
//      clearly show the entrance", with a smarter trigger than a hard reject.
//   3. Mapillary (free) only if nothing acceptable came from the above.
//
// Every candidate is scored by the vision judge; a candidate that clearly shows
// the venue's shopfront is strongly preferred. "One or two rejects before falling
// back" is expected and healthy.
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, CAPTURE } from './config.js';
import { bearing, distanceMeters } from './geo.js';
import { judgeFrontage } from './judge.js';
import type { Venue, CaptureResult, CaptureAttempt, ImageSource, FrontageJudgement } from './types.js';

const SV_META = 'https://maps.googleapis.com/maps/api/streetview/metadata';
const SV_IMAGE = 'https://maps.googleapis.com/maps/api/streetview';

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url.split('?')[0]}`);
  return Buffer.from(await res.arrayBuffer());
}

async function save(dir: string, name: string, buf: Buffer): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, buf);
  return p;
}

interface SvMeta {
  status: string;
  location?: { lat: number; lng: number };
  pano_id?: string;
  date?: string;
  copyright?: string;
}

async function streetViewMeta(v: Venue): Promise<SvMeta> {
  const url = `${SV_META}?location=${v.lat},${v.lng}&source=${CAPTURE.source}&key=${env.googleKey}`;
  return (await (await fetch(url)).json()) as SvMeta;
}

function svImageUrl(v: Venue, heading: number, fov: number): string {
  const params = new URLSearchParams({
    size: '640x640',
    location: `${v.lat},${v.lng}`,
    heading: heading.toFixed(1),
    fov: String(fov),
    pitch: String(CAPTURE.pitch),
    source: CAPTURE.source,
    key: env.googleKey,
  });
  return `${SV_IMAGE}?${params.toString()}`;
}

/**
 * Frontage-clarity score (0..1). A candidate that clearly shows the venue's own
 * shopfront is worth most – this is what lets a recognisable Google Business
 * photo beat a Street View frame pointed at a plain side doorway.
 */
function scoreOf(j: FrontageJudgement): number {
  if (!j.showsEntrance || j.reject) return 0;
  return (j.framingUsable ? 0.4 : 0.1) + j.entranceConfidence * 0.3 + (j.isVenueShopfront ? 0.3 : 0);
}

interface Candidate {
  source: ImageSource;
  imagePath: string;
  judge: FrontageJudgement;
  provenance: Record<string, unknown>;
  geom?: { heading: number; fov: number; pitch: number };
  score: number;
}

export async function capture(v: Venue, outDir: string): Promise<CaptureResult> {
  const attempts: CaptureAttempt[] = [];
  const candidates: Candidate[] = [];

  const record = async (
    source: ImageSource,
    params: Record<string, unknown>,
    buf: Buffer,
    fileName: string,
    provenance: Record<string, unknown>,
    geom?: { heading: number; fov: number; pitch: number },
  ): Promise<Candidate | null> => {
    const imagePath = await save(outDir, fileName, buf);
    let judge: FrontageJudgement;
    try {
      judge = await judgeFrontage(buf, v.name);
    } catch (err) {
      attempts.push({ source, params, outcome: 'error', reason: (err as Error).message });
      return null;
    }
    attempts.push({ source, params, judge, outcome: judge.reject ? 'rejected' : 'used', reason: judge.reasons.join('; ') });
    const cand: Candidate = { source, imagePath, judge, provenance, geom, score: scoreOf(judge) };
    candidates.push(cand);
    return cand;
  };

  const toResult = (c: Candidate): CaptureResult => ({
    ok: !c.judge.reject,
    source: c.source,
    imagePath: c.imagePath,
    heading: c.geom?.heading,
    fov: c.geom?.fov,
    pitch: c.geom?.pitch,
    provenance: c.provenance,
    attempts,
  });

  // --- 1. Street View (primary) ---------------------------------------------
  try {
    const meta = await streetViewMeta(v);
    if (meta.status === 'OK' && meta.location) {
      const dist = distanceMeters(meta.location.lat, meta.location.lng, v.lat, v.lng);
      const heading = bearing(meta.location.lat, meta.location.lng, v.lat, v.lng);
      const provenance = {
        panoId: meta.pano_id, captureDate: meta.date, copyright: meta.copyright,
        panoDistanceMeters: Math.round(dist),
      };
      if (dist <= CAPTURE.radiusMeters) {
        for (const fov of [CAPTURE.fov, 90]) {
          const buf = await download(svImageUrl(v, heading, fov));
          const c = await record(
            'streetview', { heading: Math.round(heading), fov, pitch: CAPTURE.pitch },
            buf, `frontage_streetview_fov${fov}.jpg`, provenance,
            { heading, fov, pitch: CAPTURE.pitch },
          );
          // Accept immediately only if Street View clearly shows the venue's own
          // shopfront – the cheap, primary path. Otherwise keep it as a candidate
          // and go look at the venue's Google photos too.
          if (c && !c.judge.reject && c.judge.isVenueShopfront && c.judge.framingUsable) {
            return toResult(c);
          }
        }
      } else {
        attempts.push({
          source: 'streetview', params: { panoDistanceMeters: Math.round(dist) },
          outcome: 'rejected', reason: `nearest panorama ${Math.round(dist)}m away (> ${CAPTURE.radiusMeters}m)`,
        });
      }
    } else {
      attempts.push({ source: 'streetview', params: {}, outcome: 'rejected', reason: `metadata ${meta.status}` });
    }
  } catch (err) {
    attempts.push({ source: 'streetview', params: {}, outcome: 'error', reason: (err as Error).message });
  }

  // --- 2. Google Place (Business) photos ------------------------------------
  // Reached whenever Street View didn't clearly show the venue's shopfront.
  for (const [i, photoName] of (v.photoNames ?? []).slice(0, 3).entries()) {
    try {
      const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1200&key=${env.googleKey}`;
      const buf = await download(url);
      await record('place-photo', { photoIndex: i }, buf, `frontage_placephoto_${i}.jpg`, { photoName });
    } catch (err) {
      attempts.push({ source: 'place-photo', params: { photoIndex: i }, outcome: 'error', reason: (err as Error).message });
    }
  }

  // --- 3. Mapillary (free fallback) -----------------------------------------
  if (env.mapillaryToken && !candidates.some((c) => !c.judge.reject)) {
    try {
      const buf = await mapillaryNearest(v);
      if (buf) await record('mapillary', {}, buf, 'frontage_mapillary.jpg', { source: 'mapillary' });
    } catch (err) {
      attempts.push({ source: 'mapillary', params: {}, outcome: 'error', reason: (err as Error).message });
    }
  }

  // --- Pick the best frontage across all sources ----------------------------
  // Prefer non-rejected candidates by score; tie-break toward Street View so the
  // authentic street view wins when a Google photo is only marginally better.
  const rank = (a: Candidate, b: Candidate) =>
    b.score - a.score || (a.source === 'streetview' ? -1 : b.source === 'streetview' ? 1 : 0);
  const passing = candidates.filter((c) => !c.judge.reject).sort(rank);
  if (passing.length) return toResult(passing[0]);

  // Nothing accepted – return the best-effort attempt (ok:false) for transparency.
  const anyBest = [...candidates].sort(rank)[0];
  if (anyBest) return { ...toResult(anyBest), ok: false, provenance: { ...anyBest.provenance, note: 'best-effort, judge rejected' } };
  return { ok: false, source: 'streetview', provenance: { note: 'no image obtained' }, attempts };
}

async function mapillaryNearest(v: Venue): Promise<Buffer | null> {
  const d = 0.0008; // ~80m bbox
  const bbox = `${v.lng - d},${v.lat - d},${v.lng + d},${v.lat + d}`;
  const url = `https://graph.mapillary.com/images?fields=id,thumb_2048_url,computed_geometry&bbox=${bbox}&limit=10&access_token=${env.mapillaryToken}`;
  const json = (await (await fetch(url)).json()) as {
    data?: { id: string; thumb_2048_url: string; computed_geometry?: { coordinates: [number, number] } }[];
  };
  const imgs = json.data ?? [];
  if (!imgs.length) return null;
  imgs.sort((a, b) => {
    const da = a.computed_geometry ? distanceMeters(a.computed_geometry.coordinates[1], a.computed_geometry.coordinates[0], v.lat, v.lng) : 1e9;
    const db = b.computed_geometry ? distanceMeters(b.computed_geometry.coordinates[1], b.computed_geometry.coordinates[0], v.lat, v.lng) : 1e9;
    return da - db;
  });
  return download(imgs[0].thumb_2048_url);
}
