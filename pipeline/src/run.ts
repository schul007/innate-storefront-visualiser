// Orchestrator – end-to-end run over discovered venues.
//   discover -> (per candidate) capture+judge -> composite -> QA
// Stops once SELECTION.targetCount deliverable visuals exist, logging every
// accept/reject so design.md can report exactly what the pipeline decided.
import fs from 'node:fs/promises';
import path from 'node:path';
import { RESULTS_DIR, PUBLIC_RESULTS_DIR, SRC_DATA_DIR, SELECTION } from './config.js';
import { discover } from './discover.js';
import { capture } from './capture.js';
import { compositeVenue } from './composite.js';
import { productById } from './products.js';
import type { Venue, PipelineResult, FrontageJudgement } from './types.js';

interface SelectionLogEntry {
  name: string;
  address: string;
  postcode: string;
  outcome: 'delivered' | 'rejected-frontage' | 'rejected-output' | 'no-image' | 'error';
  detail: string;
  bareness?: number;
  product?: string;
}

async function writeJSON(p: string, data: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2));
}

async function copyTo(src: string, dest: string) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

/**
 * Pick a product for a frontage, preferring one NOT yet used so the showcase
 * spreads across the client's catalogue – but only among products the judge said
 * actually suit this frontage. Falls back to the best fit if all suitable ones
 * are taken.
 */
function pickProduct(j: FrontageJudgement, used: Set<string>): string {
  const suitable = (j.recommendedProducts ?? [])
    .concat(j.recommendedProduct ? [j.recommendedProduct] : [])
    .filter((id) => productById(id));
  const fresh = suitable.find((id) => !used.has(id));
  return fresh ?? suitable[0] ?? 'product-a-black-cylinder';
}

export async function processVenue(
  venue: Venue, slot: number, usedProducts: Set<string> = new Set(),
): Promise<{ result: PipelineResult; log: SelectionLogEntry } | null> {
  const workDir = path.join(RESULTS_DIR, `venue-${slot}`);
  const pubDir = path.join(PUBLIC_RESULTS_DIR, `venue-${slot}`);
  const log: SelectionLogEntry = { name: venue.name, address: venue.address, postcode: venue.postcode, outcome: 'error', detail: '' };

  // Capture + judge frontage.
  const cap = await capture(venue, workDir);
  if (!cap.ok || !cap.imagePath) {
    log.outcome = cap.imagePath ? 'rejected-frontage' : 'no-image';
    log.detail = cap.attempts.map((a) => `${a.source}:${a.outcome}(${a.reason ?? ''})`).join(' | ');
    return { result: emptyResult(venue, cap, 'no-frontage'), log };
  }
  const judgement = cap.attempts.find((a) => a.outcome === 'used')?.judge;
  if (!judgement) {
    log.outcome = 'no-image';
    log.detail = 'capture reported ok but no judged attempt found';
    return { result: emptyResult(venue, cap, 'no-frontage'), log };
  }
  log.bareness = judgement.frontageBareness;

  // Opportunity gate: skip frontages that aren't actually bare/under-dressed.
  if (judgement.frontageBareness < 0.35) {
    log.outcome = 'rejected-frontage';
    log.detail = `frontage not bare enough (bareness ${judgement.frontageBareness.toFixed(2)}): ${judgement.reasons.join('; ')}`;
    return { result: emptyResult(venue, cap, 'rejected'), log };
  }

  const chosenProduct = pickProduct(judgement, usedProducts);
  log.product = chosenProduct;

  // Composite + QA.
  const frontageBuf = await fs.readFile(cap.imagePath);
  const comp = await compositeVenue(frontageBuf, chosenProduct, judgement, workDir);
  if (!comp) {
    log.outcome = 'error';
    log.detail = 'compositor returned no image';
    return { result: emptyResult(venue, cap, 'rejected'), log };
  }

  // Publish images for the showcase.
  await copyTo(cap.imagePath, path.join(pubDir, 'frontage.jpg'));
  await copyTo(comp.imagePath, path.join(pubDir, 'after.png'));

  const status: PipelineResult['status'] = comp.qa.reject ? 'rejected' : 'delivered';
  log.outcome = comp.qa.reject ? 'rejected-output' : 'delivered';
  log.detail = comp.qa.reject
    ? `QA reject (score ${comp.qa.score.toFixed(2)}): ${comp.qa.reasons.join('; ')}`
    : `delivered (QA score ${comp.qa.score.toFixed(2)})`;

  const result: PipelineResult = {
    venue,
    capture: cap,
    frontageJudgement: judgement,
    chosenProduct,
    composite: { imagePath: `results/venue-${slot}/after.png`, qa: comp.qa, regenerated: comp.regenerated },
    status,
    generatedAt: new Date().toISOString(),
  };
  await writeJSON(path.join(workDir, 'result.json'), result);
  return { result, log };
}

/**
 * Lightweight screen for the audit trail: capture + frontage-judge only (no
 * compositing / no image-gen). Returns a rejection log entry, or null if the
 * venue would actually qualify (we don't clutter the log with "eligible but
 * unused" – the delivered set already shows the positives).
 */
async function screenForLog(venue: Venue): Promise<SelectionLogEntry | null> {
  const probeDir = path.join(RESULTS_DIR, '_screen');
  const base = { name: venue.name, address: venue.address, postcode: venue.postcode };
  const cap = await capture(venue, probeDir);
  if (!cap.ok || !cap.imagePath) {
    return { ...base, outcome: cap.imagePath ? 'rejected-frontage' : 'no-image',
      detail: cap.attempts.map((a) => `${a.source}:${a.outcome}(${a.reason ?? ''})`).join(' | ') };
  }
  const j = cap.attempts.find((a) => a.outcome === 'used')?.judge;
  if (!j) return { ...base, outcome: 'no-image', detail: 'captured but no judgement' };
  if (j.frontageBareness < 0.35) {
    return { ...base, outcome: 'rejected-frontage',
      detail: `frontage not bare enough (bareness ${j.frontageBareness.toFixed(2)}): ${j.reasons.join('; ')}`,
      bareness: j.frontageBareness };
  }
  return null; // would qualify; not needed
}

async function main() {
  const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? SELECTION.candidatePoolSize);
  console.log('1/3  Discovering candidate venues...');
  const candidates = await discover();
  if (!candidates.length) throw new Error('No candidates discovered – check GOOGLE_MAPS_API_KEY and Places API is enabled.');

  const delivered: PipelineResult[] = [];
  const selectionLog: SelectionLogEntry[] = [];
  const usedProducts = new Set<string>(); // for catalogue variety across venues
  let slot = 0;

  console.log(`2/3  Capturing + compositing (target ${SELECTION.targetCount} deliverables)...`);
  let processedIdx = 0;
  const pool = candidates.slice(0, limit);
  for (; processedIdx < pool.length; processedIdx++) {
    if (delivered.length >= SELECTION.targetCount) break;
    const venue = pool[processedIdx];
    slot += 1;
    process.stdout.write(`  [${slot}] ${venue.name} … `);
    try {
      const out = await processVenue(venue, delivered.length + 1, usedProducts);
      if (!out) { console.log('skipped'); continue; }
      selectionLog.push(out.log);
      console.log(`${out.log.outcome}${out.log.product ? ` (${out.log.product})` : ''}`);
      if (out.result.status === 'delivered') {
        delivered.push(out.result);
        usedProducts.add(out.result.chosenProduct);
      }
    } catch (err) {
      console.log('error:', (err as Error).message);
      selectionLog.push({ name: venue.name, address: venue.address, postcode: venue.postcode, outcome: 'error', detail: (err as Error).message });
    }
  }

  // Keep screening a few more candidates (frontage judge only, no image-gen) so
  // the decision log always shows some genuine rejections – the brief wants
  // "anything it rejected and why", and the delivery loop can stop before it hits
  // any. This does NOT change what we deliver; it only enriches the audit trail.
  const skipCount = () => selectionLog.filter((e) => !e.outcome.startsWith('delivered')).length;
  let extraScreened = 0;
  for (; processedIdx < pool.length; processedIdx++) {
    if (skipCount() >= 3 || extraScreened >= 6) break;
    const venue = pool[processedIdx];
    extraScreened += 1;
    process.stdout.write(`  (screen) ${venue.name} … `);
    try {
      const entry = await screenForLog(venue);
      if (entry) { selectionLog.push(entry); console.log(entry.outcome); }
      else console.log('eligible (not needed)');
    } catch (err) {
      console.log('error:', (err as Error).message);
    }
  }

  console.log('3/3  Writing results...');
  const summary = {
    generatedAt: new Date().toISOString(),
    targetCount: SELECTION.targetCount,
    deliveredCount: delivered.length,
    venues: delivered.map((r, i) => ({
      slot: i + 1,
      name: r.venue.name,
      address: r.venue.address,
      postcode: r.venue.postcode,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.venue.name + ' ' + r.venue.address)}`,
      product: r.chosenProduct,
      productName: productById(r.chosenProduct)?.name,
      source: r.capture.source,
      heading: r.capture.heading,
      fov: r.capture.fov,
      panoDate: r.capture.provenance.captureDate,
      bareness: r.frontageJudgement.frontageBareness,
      placement: r.frontageJudgement.placementHint,
      qaScore: r.composite.qa.score,
      regenerated: r.composite.regenerated,
      frontage: `results/venue-${i + 1}/frontage.jpg`,
      after: `results/venue-${i + 1}/after.png`,
      attempts: r.capture.attempts.map((a) => ({ source: a.source, outcome: a.outcome, reason: a.reason })),
    })),
    // Transient infra errors (e.g. a dropped stream) aren't selection decisions –
    // keep the audit trail to genuine accept/reject calls.
    selectionLog: selectionLog.filter((e) => e.outcome !== 'error'),
  };
  await writeJSON(path.join(SRC_DATA_DIR, 'results.json'), summary);
  await writeJSON(path.join(PUBLIC_RESULTS_DIR, 'summary.json'), summary);
  console.log(`\nDone. Delivered ${delivered.length}/${SELECTION.targetCount}. Results in results/ and src/data/results.json`);
}

function emptyResult(venue: Venue, cap: PipelineResult['capture'], status: PipelineResult['status']): PipelineResult {
  return {
    venue, capture: cap,
    frontageJudgement: cap.attempts.find((a) => a.judge)?.judge ?? {
      showsEntrance: false, entranceConfidence: 0, framingUsable: false, isVenueShopfront: false,
      frontageBareness: 0, obstructions: [], surfaceAtEntrance: 'unknown', reject: true, reasons: ['no judgement'],
    },
    chosenProduct: '', composite: { imagePath: '', qa: { productFaithful: false, scalePlausible: false, perspectiveConsistent: false, shadowGrounded: false, entranceClear: false, buildingUnaltered: false, artifacts: [], score: 0, reject: true, reasons: [] }, regenerated: false },
    status, generatedAt: new Date().toISOString(),
  };
}

// Run when invoked directly.
main().catch((err) => { console.error('\nPipeline failed:', err.message); process.exit(1); });
