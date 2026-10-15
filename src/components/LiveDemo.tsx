import { useState } from 'react';
import { BeforeAfter } from './BeforeAfter';

interface SearchResult {
  placeId: string; name: string; address: string;
  lat: number; lng: number; photoNames: string[];
}
interface GenResult {
  name: string; source: string; heading?: number; product: string; productName?: string;
  status: string; frontage: string; after: string;
  judgement: { frontageBareness: number; placementHint: string; reasons: string[] };
  qa: {
    score: number; reject: boolean; reasons: string[]; artifacts: string[];
    productFaithful?: boolean; scalePlausible?: boolean; perspectiveConsistent?: boolean;
    shadowGrounded?: boolean; entranceClear?: boolean; buildingUnaltered?: boolean;
  };
}

/** Plain-English summary of the QA verdict (no "Image 1/3" jargon). */
function plainQa(qa: GenResult['qa']): string {
  if (!qa.reject) {
    return 'Looks ready to send: the planters match the real product, sit at a believable size, and the rest of the photo is unchanged.';
  }
  const issues: string[] = [];
  if (qa.productFaithful === false) issues.push("the planters didn't match the real product closely enough");
  if (qa.scalePlausible === false) issues.push('the size looked off');
  if (qa.entranceClear === false) issues.push('a planter blocked the entrance');
  if (qa.buildingUnaltered === false) issues.push('part of the building changed');
  if (qa.shadowGrounded === false) issues.push('the planters looked like they were floating');
  if (!issues.length) issues.push("the result wasn't convincing enough");
  return `Held back because ${issues.join(', and ')}.`;
}

/** Live "run the real pipeline" panel – calls /api/search then /api/generate. */
export function LiveDemo() {
  const [query, setQuery] = useState('independent cafe in Hackney London');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [gen, setGen] = useState<GenResult | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true); setStatus('Searching Places…'); setResults([]); setGen(null);
    try {
      const r = await fetch('/api/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'search failed');
      setResults(j.results ?? []);
      setStatus(j.results?.length ? '' : 'No venues found.');
    } catch (e) {
      setStatus(`${(e as Error).message}. (The live demo needs API keys configured on the deployment.)`);
    } finally { setBusy(false); }
  }

  async function generate(v: SearchResult) {
    setBusy(true); setGen(null);
    setStatus(`Capturing & compositing "${v.name}" — Street View → vision judge → Nano Banana → QA (~20–40s)…`);
    try {
      const r = await fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: v.lat, lng: v.lng, name: v.name, photoNames: v.photoNames }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'generation failed');
      setGen(j); setStatus('');
    } catch (e) {
      setStatus((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="live">
      <div className="live-controls">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && search()}
          placeholder="e.g. independent cafe in Hackney London"
          aria-label="Venue search query"
        />
        <button onClick={search} disabled={busy}>{busy ? 'Working…' : 'Find venues'}</button>
      </div>
      {status && <p className="live-status">{status}</p>}

      {results.length > 0 && !gen && (
        <ul className="live-results">
          {results.map((v) => (
            <li key={v.placeId}>
              <div>
                <strong>{v.name}</strong>
                <span>{v.address}</span>
              </div>
              <button onClick={() => generate(v)} disabled={busy}>Generate →</button>
            </li>
          ))}
        </ul>
      )}

      {gen && (
        <div className="live-output">
          <BeforeAfter before={gen.frontage} after={gen.after} />
          <div className="live-meta">
            <span className={`pill ${gen.status === 'delivered' ? 'pill-ok' : 'pill-hold'}`}>
              {gen.status === 'delivered' ? 'Passed QA' : 'Held by QA'}
            </span>
            <span className="pill">Source: {gen.source}{gen.heading != null ? ` · heading ${gen.heading}°` : ''}</span>
            <span className="pill">Product: {gen.productName}</span>
            <span className="pill">QA {Math.round(gen.qa.score * 100)}%</span>
            <span className="pill">Bareness {Math.round(gen.judgement.frontageBareness * 100)}%</span>
          </div>
          <p className="live-reasons">{plainQa(gen.qa)}</p>
          <button className="live-reset" onClick={() => { setGen(null); }}>← Back to results</button>
        </div>
      )}
    </div>
  );
}
