// Stage 2 + fallback chain – get a well-framed frontage image for a venue.
//
// Order of preference:
//   1. Google Street View Static, heading derived from panorama -> venue bearing
//      (two framings tried: tighter FOV, then wider if the first is rejected)
//   2. Google Place Photos (the venue's own / Google Business photos)
//   3. Mapillary (free crowdsourced street-level imagery)
//
// Each candidate image is scored by the vision judge; we stop at the first
// image the judge accepts, otherwise we return the best-scoring attempt so the
// orchestrator can decide. "One or two rejects before falling back" is expected.
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, CAPTURE } from './config.js';
import { bearing, distanceMeters } from './geo.js';
import { judgeFrontage } from './judge.js';
import type { Venue, CaptureResult, CaptureAttempt, FrontageJudgement } from './types.js';

const SV_META = 'https://maps.googleapis.com/maps/api/streetview/metadata';
const SV_IMAGE = 'https://maps.googleapis.com/maps/api/streetview';

async function download(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const res = await fetch(url, { headers });
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

/** Best-scoring attempt wins if none are outright accepted. */
function scoreOf(j: FrontageJudgement): number {
  if (!j.showsEntrance) return 0;
  return (j.framingUsable ? 0.6 : 0.2) + j.entranceConfidence * 0.4;
}

export async function capture(v: Venue, outDir: string): Promise<CaptureResult> {
  const attempts: CaptureAttempt[] = [];
  let best: { attempt: CaptureAttempt; path: string; score: number } | null = null;

  const consider = async (
    source: CaptureAttempt['source'],
    params: Record<string, unknown>,
    buf: Buffer,
    fileName: string,
    provenance: Record<string, unknown>,
    geom?: { heading: number; fov: number; pitch: number },
  ): Promise<CaptureResult | null> => {
    const imgPath = await save(outDir, fileName, buf);
    let judge: FrontageJudgement;
    try {
      judge = await judgeFrontage(buf);
    } catch (err) {
      attempts.push({ source, params, outcome: 'error', reason: (err as Error).message });
      return null;
    }
    const attempt: CaptureAttempt = {
      source, params, judge,
      outcome: judge.reject ? 'rejected' : 'used',
      reason: judge.reasons.join('; '),
    };
    attempts.push(attempt);
    const score = scoreOf(judge);
    if (!best || score > best.score) best = { attempt, path: imgPath, score };

    if (!judge.reject) {
      return {
        ok: true, source, imagePath: imgPath, provenance, attempts,
        ...(geom ?? {}),
      };
    }
    return null;
  };

  // --- 1. Street View --------------------------------------------------------
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
        for (const fov of [CAPTURE.fov, 90]) { // tighter framing, then wider
          const buf = await download(svImageUrl(v, heading, fov));
          const done = await consider(
            'streetview', { heading: Math.round(heading), fov, pitch: CAPTURE.pitch },
            buf, `frontage_streetview_fov${fov}.jpg`, provenance,
            { heading, fov, pitch: CAPTURE.pitch },
          );
          if (done) return done;
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

  // --- 2. Google Place Photos ------------------------------------------------
  for (const [i, photoName] of (v.photoNames ?? []).slice(0, 3).entries()) {
    try {
      const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1200&key=${env.googleKey}`;
      const buf = await download(url);
      const done = await consider(
        'place-photo', { photoIndex: i }, buf, `frontage_placephoto_${i}.jpg`,
        { photoName },
      );
      if (done) return done;
    } catch (err) {
      attempts.push({ source: 'place-photo', params: { photoIndex: i }, outcome: 'error', reason: (err as Error).message });
    }
  }

  // --- 3. Mapillary (free fallback) -----------------------------------------
  if (env.mapillaryToken) {
    try {
      const buf = await mapillaryNearest(v);
      if (buf) {
        const done = await consider('mapillary', {}, buf, 'frontage_mapillary.jpg', { source: 'mapillary' });
        if (done) return done;
      }
    } catch (err) {
      attempts.push({ source: 'mapillary', params: {}, outcome: 'error', reason: (err as Error).message });
    }
  }

  // Nothing accepted – hand back the best-scoring attempt (ok:false).
  if (best !== null) {
    const b: { attempt: CaptureAttempt; path: string; score: number } = best;
    return { ok: false, source: b.attempt.source, imagePath: b.path, provenance: { note: 'best-effort, judge rejected' }, attempts };
  }
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
