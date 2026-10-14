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
import type { Venue, PipelineResult } from './types.js';

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

export async function processVenue(venue: Venue, slot: number): Promise<{ result: PipelineResult; log: SelectionLogEntry } | null> {
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

  const chosenProduct = judgement.recommendedProduct && productById(judgement.recommendedProduct)
    ? judgement.recommendedProduct
    : 'product-a-black-cylinder';
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

async function main() {
  const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? SELECTION.candidatePoolSize);
  console.log('1/3  Discovering candidate venues...');
  const candidates = await discover();
  if (!candidates.length) throw new Error('No candidates discovered – check GOOGLE_MAPS_API_KEY and Places API is enabled.');

  const delivered: PipelineResult[] = [];
  const selectionLog: SelectionLogEntry[] = [];
  let slot = 0;

  console.log(`2/3  Capturing + compositing (target ${SELECTION.targetCount} deliverables)...`);
  for (const venue of candidates.slice(0, limit)) {
    if (delivered.length >= SELECTION.targetCount) break;
    slot += 1;
    process.stdout.write(`  [${slot}] ${venue.name} … `);
    try {
      const out = await processVenue(venue, delivered.length + 1);
      if (!out) { console.log('skipped'); continue; }
      selectionLog.push(out.log);
      console.log(out.log.outcome);
      if (out.result.status === 'delivered') delivered.push(out.result);
    } catch (err) {
      console.log('error:', (err as Error).message);
      selectionLog.push({ name: venue.name, address: venue.address, postcode: venue.postcode, outcome: 'error', detail: (err as Error).message });
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
    selectionLog,
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
    chosenProduct: '', composite: { imagePath: '', qa: { productFaithful: false, scalePlausible: false, perspectiveConsistent: false, shadowGrounded: false, buildingUnaltered: false, artifacts: [], score: 0, reject: true, reasons: [] }, regenerated: false },
    status, generatedAt: new Date().toISOString(),
  };
}

// Run when invoked directly.
main().catch((err) => { console.error('\nPipeline failed:', err.message); process.exit(1); });
