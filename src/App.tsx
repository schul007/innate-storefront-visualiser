import './App.css';
import productsData from '../products/products.json';
import resultsData from './data/results.json';
import type { Product, ResultsSummary, ResultVenue, SelectionLogEntry } from './types';
import { BeforeAfter } from './components/BeforeAfter';
import { LiveDemo } from './components/LiveDemo';

const products = (productsData as unknown as { products: Product[] }).products;
const results = resultsData as unknown as ResultsSummary;

const STAGES = [
  { n: '01', title: 'Discover', body: 'Google Places pulls independent cafés, restaurants & salons across central London. Chains are filtered out by name & type.' },
  { n: '02', title: 'Capture', body: 'Street View heading is derived from the panorama→venue bearing, so the camera faces the real doorway — not the road.' },
  { n: '03', title: 'Judge', body: 'A vision model vets every frame: does it clearly show the entrance, and is the frontage bare enough to be worth dressing?' },
  { n: '04', title: 'Composite', body: 'Gemini 2.5 Flash Image places the client’s actual planter into the shot at correct scale, perspective & shadow.' },
  { n: '05', title: 'QA gate', body: 'A second vision pass checks product fidelity, scale and that the building is unaltered — bad generations never reach an owner.' },
];

function Hero({ delivered }: { delivered: number }) {
  return (
    <header className="hero">
      <div className="hero-inner">
        <p className="eyebrow">Innate AI · storefront capture &amp; visualisation</p>
        <h1>See the planters<br />on the <em>real</em> doorway.</h1>
        <p className="lede">
          An automated pipeline that finds under-dressed London frontages, captures each
          venue’s actual entrance, and composites the client’s real planters onto it —
          a convincing “what it could look like,” with no human in the loop.
        </p>
        <div className="hero-stats">
          <div><strong>{delivered || 3}</strong><span>venues visualised</span></div>
          <div><strong>3</strong><span>real products, pinned</span></div>
          <div><strong>5</strong><span>automated stages</span></div>
        </div>
      </div>
    </header>
  );
}

function Pipeline() {
  return (
    <section className="section" id="pipeline">
      <h2 className="section-title">The pipeline</h2>
      <div className="stages">
        {STAGES.map((s) => (
          <div className="stage" key={s.n}>
            <span className="stage-n">{s.n}</span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Products() {
  return (
    <section className="section" id="products">
      <h2 className="section-title">The client’s three products</h2>
      <p className="section-sub">
        The composite must use these <em>actual</em> planters — not a generic AI idea of “some planters.”
        Each is passed to the model as a reference image, with documented real-world dimensions used as a scale anchor.
      </p>
      <div className="products">
        {products.map((p) => (
          <figure className="product" key={p.id}>
            <img src={`/products/${p.image}`} alt={p.name} loading="lazy" />
            <figcaption>
              <h3>{p.name}</h3>
              <p className="product-form">{p.form}</p>
              <dl>
                <div><dt>Material</dt><dd>{p.material}</dd></div>
                <div><dt>Size</dt><dd>{Object.entries(p.dimensions_cm).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}cm`).join(', ')}</dd></div>
                <div><dt>Best for</dt><dd>{p.best_for}</dd></div>
              </dl>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  streetview: 'Google Street View',
  'place-photo': 'Google Business photo',
  mapillary: 'Mapillary street photo',
};

function VenueCard({ v }: { v: ResultVenue }) {
  return (
    <article className="venue">
      <div className="venue-media">
        <BeforeAfter before={`/${v.frontage}`} after={`/${v.after}`} />
      </div>
      <div className="venue-body">
        <div className="venue-head">
          <h3>{v.name}</h3>
          <a href={v.mapsUrl} target="_blank" rel="noreferrer">{v.address}</a>
        </div>
        <div className="venue-pills">
          <span className={`pill ${v.qaScore >= 0.6 ? 'pill-ok' : 'pill-hold'}`} title="Automated quality score of the final image">Quality {Math.round(v.qaScore * 100)}%</span>
          <span className="pill">{v.productName}</span>
          <span className="pill" title="Where the real frontage photo came from">Photo: {SOURCE_LABELS[v.source] ?? v.source}</span>
          {v.panoDate && <span className="pill">Imagery {v.panoDate}</span>}
          <span className="pill" title="How bare the frontage was — higher means more room to improve">Bareness {Math.round(v.bareness * 100)}%</span>
          {v.regenerated && <span className="pill" title="First attempt was auto-rejected and regenerated">Regenerated ×1</span>}
        </div>
        {v.placement && <p className="venue-note"><strong>Placement:</strong> {v.placement}</p>}
      </div>
    </article>
  );
}

function Venues({ venues }: { venues: ResultVenue[] }) {
  return (
    <section className="section" id="venues">
      <h2 className="section-title">Selected venues</h2>
      {venues.length === 0 ? (
        <div className="empty">
          <p>No generated results committed yet.</p>
          <p className="empty-sub">
            Add API keys and run <code>npm run pipeline</code> to populate this section with three
            real before/after visuals. Until then, try the live demo below or browse the products above.
          </p>
        </div>
      ) : (
        <div className="venues">{venues.map((v) => <VenueCard key={v.slot} v={v} />)}</div>
      )}
    </section>
  );
}

/** Turn a raw pipeline outcome + detail into plain English for a general visitor. */
function humanizeDecision(e: SelectionLogEntry): { label: string; tone: 'ok' | 'skip' | 'hold'; reason: string } {
  const d = (e.detail || '').toLowerCase();
  if (e.outcome.startsWith('delivered')) {
    return { label: 'Chosen', tone: 'ok', reason: 'Clear, bare entrance — a great fit, so we dressed it with the planters.' };
  }
  if (e.outcome === 'rejected-output') {
    return { label: 'Held back', tone: 'hold', reason: 'The generated image didn’t meet our quality bar, so it was never used.' };
  }
  if (e.outcome === 'no-image' || e.outcome === 'error') {
    return { label: 'Skipped', tone: 'skip', reason: 'Couldn’t get a clear, usable street photo of this venue’s entrance.' };
  }
  // rejected-frontage
  if (d.includes('not bare') || d.includes('bareness')) {
    return { label: 'Skipped', tone: 'skip', reason: 'The entrance already has greenery or seating — planters wouldn’t add much here.' };
  }
  if (d.includes('mannequin') || d.includes('window display')) {
    return { label: 'Skipped', tone: 'skip', reason: 'The available photo showed a window display, not a clear doorway to dress.' };
  }
  return { label: 'Skipped', tone: 'skip', reason: 'Couldn’t get a clear, usable photo of this venue’s entrance.' };
}

const SRC_WORDS: Record<string, string> = {
  streetview: 'Street View', 'place-photo': 'Google photo', mapillary: 'Mapillary',
};

// Strip model-ese ("Image 1/3") so the detail reads like plain English.
const tidy = (s: string) => s
  .replace(/\bImage 1\b/gi, 'the original photo')
  .replace(/\bImage [23]\b/gi, 'the product photo');

/** Turn the raw pipeline detail into readable, natural lines for the expander. */
function technicalLines(e: SelectionLogEntry): string[] {
  const d = e.detail || '';
  // Per-source capture attempts: "streetview:rejected(a; b) | place-photo:rejected(c) | …"
  if (/[\w-]+:(rejected|used|error)\(/.test(d)) {
    return d.split(' | ').map((part) => {
      const m = part.match(/^([\w-]+):(\w+)\(([\s\S]*)\)$/);
      if (!m) return tidy(part);
      const src = SRC_WORDS[m[1]] ?? m[1];
      const verb = m[2] === 'used' ? 'used' : m[2] === 'error' ? 'errored' : 'rejected';
      const reasons = m[3].split(';').map((s) => s.trim()).filter(Boolean).join(' ');
      return tidy(`${src} — ${verb}: ${reasons}`);
    });
  }
  // Bareness / QA / delivered single-line details.
  const line = d
    .replace(/^frontage not bare enough \(bareness ([\d.]+)\):?\s*/i, 'Frontage wasn’t bare enough (score $1 of 1). ')
    .replace(/^QA reject \(score ([\d.]+)\):?\s*/i, 'Didn’t pass the quality check (score $1 of 1). ')
    .replace(/^delivered \(QA score ([\d.]+)\)/i, 'Delivered — quality score $1 of 1.');
  return line ? [tidy(line)] : [];
}

function SelectionLog({ log }: { log: SelectionLogEntry[] }) {
  if (!log.length) return null;
  const chosen = log.filter((e) => e.outcome.startsWith('delivered')).length;
  const skipped = log.length - chosen;
  return (
    <section className="section" id="log">
      <h2 className="section-title">What the pipeline decided</h2>
      <p className="section-sub">
        Nobody hand-picked these venues. The system automatically screened real London cafés,
        looked at each entrance, and kept the first few with a bare frontage worth dressing.
        Here’s every call it made — <strong>{chosen} chosen, {skipped} skipped</strong> — and why.
      </p>
      <ul className="decided">
        {log.map((e, i) => {
          const h = humanizeDecision(e);
          return (
            <li className="decided-item" key={i}>
              <span className={`decided-badge decided-${h.tone}`}>
                {h.tone === 'ok' ? '✓' : h.tone === 'hold' ? '!' : '—'} {h.label}
              </span>
              <div className="decided-body">
                <div className="decided-head">
                  <strong>{e.name}</strong>
                  {e.postcode && <span className="decided-pc">{e.postcode}</span>}
                </div>
                <p className="decided-reason">{h.reason}</p>
                {technicalLines(e).length > 0 && (
                  <details className="decided-tech">
                    <summary>What the system saw</summary>
                    <ul>{technicalLines(e).map((l, j) => <li key={j}>{l}</li>)}</ul>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function App() {
  return (
    <div className="page">
      <Hero delivered={results.deliveredCount} />
      <main>
        <Pipeline />
        <Products />
        <Venues venues={results.venues} />
        <SelectionLog log={results.selectionLog} />
        <section className="section" id="live">
          <h2 className="section-title">Try it live</h2>
          <p className="section-sub">
            Search for any London venue and run the real pipeline on it — Street View capture,
            vision judgement, compositing and QA, end to end. (Requires the deployment to have API keys.)
          </p>
          <LiveDemo />
        </section>
      </main>
      <footer className="footer">
        <p>Built for the Innate AI contract-developer brief. See <code>design.md</code> for the full technical rationale,
          imagery-rights position and rejection criteria.</p>
      </footer>
    </div>
  );
}
