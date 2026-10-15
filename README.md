# Storefront Capture & Visualisation

Automated pipeline that finds under-dressed independent London frontages, captures each
venue's **real** doorway, and composites the client's **actual** planters onto it at correct
scale — a convincing "what it could look like" visual, fully automated.

Built for the Innate AI contract-developer brief. **Read [`design.md`](design.md)** for the
technical rationale, selection logic, fallback logic, imagery-rights position and rejection
criteria. This README is setup + operation.

---

## What's in here

```
pipeline/src/     The automated pipeline (Node + TypeScript, run offline)
  run.ts            Orchestrator:  discover → capture → judge → composite → QA
  discover.ts       Google Places: independent London venues + chain filter
  capture.ts        Street View framing (heading from geometry) + fallbacks
  geo.ts            Bearing / distance helpers
  judge.ts          Vision judge: entrance visible? frontage bare? which product?
  composite.ts      Reference-faithful compositing ("Nano Banana Pro") + regenerate
  qa.ts             Output QA / rejection gate
  gemini.ts         Gemini client (structured vision JSON + image editing, with retry)
  imageutil.ts      Image dims + aspect-ratio lock (keeps edits in place, no re-crop)
products/         The client's three REAL products + documented dimensions
results/          Committed pipeline outputs (before/after + decision JSON)
api/              Vercel serverless: live /api/search + /api/generate
src/              React showcase (renders cached results + live demo)
```

Architecture is **hybrid**: the pipeline runs offline and commits results that the static site
always renders (demo never depends on live quota), while the same modules are exposed as
serverless functions so reviewers can run the real pipeline live. See design.md §1.

---

## Prerequisites

- **Node 20+**
- **Google Maps Platform API key** with **Places API (New)** and **Street View Static API**
  enabled. (Billing must be enabled on the Google Cloud project, but the free monthly tier
  covers prototype volume.)
- **Gemini API key** (Google AI Studio). ⚠️ **Image generation is not on the free tier** — the
  key's project needs **billing / prepaid credits**. Vision judging is cheap; the default image
  model is **Gemini 3 Pro Image** (best fidelity) at roughly **$0.15–0.30 per composite**, so a
  full run is on the order of a few dollars. Set `GEMINI_IMAGE_MODEL=gemini-3.1-flash-image` to run
  ~5× cheaper at lower fidelity. See *Costs & quotas* below.
- *(Optional)* **Mapillary token** — free fallback street imagery when Street View is poor.

## Setup

```bash
npm install
cp .env.example .env     # then fill in your keys
```

`.env`:

```
GOOGLE_MAPS_API_KEY=...   # Places (New) + Street View Static
GEMINI_API_KEY=...        # vision judge + compositing (needs billing for image gen)
MAPILLARY_TOKEN=...        # optional fallback
# GEMINI_IMAGE_MODEL=gemini-3.1-flash-image     # optional: ~5x cheaper than the default Pro model
# GEMINI_VISION_MODEL=gemini-flash-lite-latest  # optional override (this is the default)
```

## Run

```bash
npm run discover    # stage 1 only: print the candidate pool (cheap, Places only)
npm run pipeline    # full run: produces 3 delivered visuals into results/ + src/data/results.json
npm run dev         # view the showcase at http://localhost:5173
npm run build       # production build (static site)
```

`npm run pipeline` walks the discovered candidates, captures + judges each frontage, composites
the best-fit product, QA-gates the output, and stops once **three** venues pass. It overwrites
[`src/data/results.json`](src/data/results.json) and writes before/after images under
[`public/results/`](public/results/). Every accept/reject is logged (shown on the site under
*What the pipeline decided*).

Flags: `npm run pipeline -- --limit=10` caps how many candidates to process.

## Deploy (Vercel)

The repo is Vercel-ready ([`vercel.json`](vercel.json)): Vite static build + `/api` serverless
functions.

```bash
npm i -g vercel
vercel            # first deploy (links project)
vercel --prod     # production
```

Set `GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY` (and optionally `MAPILLARY_TOKEN`) as **Environment
Variables** in the Vercel project settings so the live `/api/generate` demo works. The cached
showcase works even without them.

---

## Costs & quotas

| Service | Prototype cost |
|---|---|
| Google Places (discovery) | Free tier covers it |
| Street View Static | Free tier covers it |
| Gemini vision (judge + QA) | Cheap; ~2 calls per venue |
| **Gemini image (compositing)** | **Needs billing.** Default Pro model ~\$0.15–0.30/image (`gemini-3.1-flash-image` ~5× cheaper). Free tier limit = 0. |

If a run stops with *"Gemini image/model quota is 0 …enable billing"* or a **402 prepayment
depleted** error, top up the Gemini project's billing/credits — that's the only paid dependency.

## Assumptions

- Product real-world dimensions in [`products/products.json`](products/products.json) are
  **documented assumptions** (typical commercial-planter sizes), used as scale anchors — replace
  with the client's spec sheet when available.
- Query set targets central-London areas with strong Street View coverage; elsewhere the Place
  Photos / Mapillary fallback does more of the work.
- Model output is nondeterministic; the QA gate + single regenerate is the quality control, not
  a guarantee. See design.md §5 and §7.
