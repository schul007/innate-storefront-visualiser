# design.md — Storefront Capture & Visualisation

**Audience: a second engineer.** This note is written so you could rebuild or extend the system
from it. It covers the two graded capabilities — **frontage capture** and **product compositing** —
plus the **automated venue selection** that feeds them, with the accept/reject bars, fallback logic,
imagery-rights position and rejection criteria the brief asks for. Code anchors are given as
`path::symbol` so you can jump straight to the implementation.

**What it does, in one line:** find under-dressed independent London frontages → capture each
venue's real doorway → composite the client's *actual* planters onto it at believable scale →
output a convincing "what it could look like," fully automated, no human in the loop.

---

## Contents

0. [System overview & stack](#0-system-overview--stack)
1. [Architecture](#1-architecture)
2. [Automated venue selection](#2-automated-venue-selection) — *incl. selected venues + rejections*
3. [Getting the frontage image](#3-getting-the-frontage-image) — *heading/FOV, fallback, imagery rights*
4. [Compositing the planters](#4-compositing-the-planters) — *fidelity, scale, product choice*
5. [Rejection criteria (output QA)](#5-rejection-criteria--output-qa)
6. [Imagery rights](#6-imagery-rights)
7. [Scale, cost, assumptions & limitations](#7-scale-cost-assumptions--limitations)
8. [Repo map & how to run](#8-repo-map--how-to-run)

---

## 0. System overview & stack

Five automated stages, each with its **own accept/reject decision**, so that at 5,000 venues/week
no step waits on a human:

```
discover ──▶ capture ──▶ judge ──▶ composite ──▶ QA gate ──▶ deliver / hold
(Places)     (Street     (vision:   (Gemini 3     (vision:
             View,        entrance,  Pro Image,    fidelity,
             heading      shopfront, "Nano         scale,
             from geom)   bare?)     Banana Pro")  unaltered,
                                                   entrance clear?)
```

**Design principle.** The two graded capabilities are an *image-sourcing* problem and an
*image-generation* problem. Both are unreliable in isolation (Street View faces the wrong way;
generators drift). So each is bracketed by an **automated vision judgement** that decides whether to
proceed, retry, fall back, or discard. The judgements are the product; the models behind them are
swappable via `MODELS` in `config.ts`.

| Concern | Choice | Why |
|---|---|---|
| Venue discovery | **Google Places API (New)** | One call returns business type, rating, address, postcode and Place Photos — rich signals + a capture fallback source. Free tier covers prototype volume. |
| Frontage imagery | **Google Street View Static API** | Best central-London coverage; exposes panorama geometry (location, heading, date) needed to frame the doorway. Same key as Places. |
| Vision judge + output QA | **Gemini `gemini-flash-lite-latest`** | Fast, cheap multimodal reasoning returning structured JSON verdicts. |
| Compositing | **Gemini 3 Pro Image** ("Nano Banana Pro") | Best at *reference-image-conditioned* editing: reproduces **this** product rather than a generic planter, grounds it, and edits in place. |
| Fallback imagery | **Google Place Photos → Mapillary** | The venue's own Business photos, then free crowdsourced street imagery. |

Alternatives weighed and rejected: **OSM Overpass** for discovery (no business photos, thinner
signals — kept only as a zero-billing fallback); **SDXL/Flux inpainting** for compositing (needs a
hand-authored mask per image, breaking "no human in the loop," and weaker at honouring a reference
product); **classical cut-and-paste** compositing (can't match lighting/perspective across arbitrary
frontages).

---

## 1. Architecture

**Hybrid.** A Node/TypeScript **batch pipeline** (`pipeline/src/`) runs offline and commits its
outputs; a **static React site** (`src/`) renders those committed results so the demo link always
works regardless of live quota; and the *same* capture/judge/composite/QA modules are exposed as
**Vercel serverless functions** (`api/generate.ts`, `api/search.ts`) so a reviewer can trigger the
real pipeline live.

```
pipeline/src/*  ──run offline──▶  results/ + src/data/results.json ──commit──▶  src/ (static showcase)
       │                                                                              +
       └────────────── same modules imported by ──────────────▶  api/*  (live "Try it" path)
```

Why hybrid: the brief wants a link that "we can open and test" *and* evidence the pipeline is real
and automated. Committed results guarantee the first; the live serverless path proves the second on
demand without the demo depending on API uptime at review time.

---

## 2. Automated venue selection

**Goal:** independent, street-facing London businesses (cafés, restaurants, salons) whose frontage
is **bare or under-dressed** — where planters would visibly improve the entrance. No hand-curation.

### 2.1 Candidate sourcing — `discover.ts::discover`

Google Places **Text Search** across a spread of central-London areas × business types
(Shoreditch / Marylebone / Soho / Islington / Clerkenwell / Fitzrovia / Notting Hill / Bermondsey ×
café / coffee / restaurant / salon / deli / bistro). Breadth de-risks the pool and keeps us where
Street View coverage is strong. Field mask requests `id, displayName, formattedAddress,
addressComponents, location, types, rating, userRatingCount, businessStatus, photos, websiteUri` —
everything the filter and the capture fallback need, in one call. Postcode comes from the
`postal_code` address component, falling back to a UK-postcode regex over the formatted address.

### 2.2 Cheap "independent & real" filters (applied first, before any paid call)

- **Chain denylist** (`SELECTION.chainDenylist`, ~35 brands) — name-match against Starbucks, Pret,
  Greggs, Nando's, Toni & Guy, … Independents are the target.
- **Operational only** — drop anything not `OPERATIONAL`.
- **Rating-count floor** — `userRatingCount ≥ 5` (`SELECTION.minRatingCount`), to skip
  placeholder/duplicate listings.

A live run yields **57 independent candidates** from the query set.

### 2.3 Vision fit judgement (per candidate frontage) — `judge.ts::judgeFrontage`

Business type can't tell you whether a *specific doorway* is bare. The real signal is a vision-model
judgement on the captured frontage image, given the venue name + a compact product catalogue. It
returns structured JSON:

```jsonc
{
  "showsEntrance": true,          // is the street-facing door actually in frame?
  "entranceConfidence": 0.0..1.0,
  "framingUsable": true,          // close & prominent, not distant/obstructed/blurred
  "isVenueShopfront": true,       // clearly THIS venue's own storefront (see §3.2)
  "frontageBareness": 0.0..1.0,   // 1 = completely bare → high opportunity
  "obstructions": ["parked van"],
  "surfaceAtEntrance": "pavement|step|recessed|unknown",
  "recommendedProduct": "product-id",      // single best fit
  "recommendedProducts": ["id", "id"],     // all that suit, best-first (drives variety, §4.4)
  "placementHint": "flank the corner entrance on the wide pavement",
  "reject": false,
  "reasons": ["..."]
}
```

### 2.4 Accept / reject bar

A candidate is **delivered** only if *all* hold:

1. Capture produced an image the judge did **not** reject, with `showsEntrance` and `framingUsable`
   (see §3.3), **and**
2. `frontageBareness ≥ 0.35` (`run.ts::processVenue`) — the frontage is genuinely under-dressed,
   **and**
3. The composite passes the **output QA gate** (§5).

Selection is **first-fit past the bar**, not a global ranking: the pipeline walks the candidate pool
in discovery order and keeps the first `SELECTION.targetCount = 3` that pass every gate
(`run.ts::main`). Every accept/reject is written to the **selection log**. After the three are
delivered, the pipeline keeps *screening* a few more candidates (frontage-judge only, no image-gen —
`run.ts::screenForLog`) purely so the audit trail reliably shows genuine rejections even when the
first three all pass. "One or two rejects before a fallback or skip" is an expected, healthy outcome.

### 2.5 Selected venues

The three venues the pipeline selected, captured, composited and QA-gated. Full trail in
`src/data/results.json` and on the deployed site.

| # | Venue | Address | Postcode | Product | Capture source | QA |
|---|---|---|---|---|---|---|
| 1 | **Archetype Coffee** | 31 Riding House St, London | W1W 7DY | Charcoal Cylinder | Street View | 0.95 |
| 2 | **Artist Cafe** | 311 Old St, Shoreditch, London | EC1V 9LA | White Tapered Pair | Street View | 0.75 |
| 3 | **Franze & Evans – Shoreditch** | 101 Redchurch St, Shoreditch, London | E2 7DL | Corten Tiered Set | Google Business photo | 0.95 |

One product from each is used across the three frontages (Charcoal / White / Corten).

**Rejected in the same run** (automated, never hand-filtered):

| Venue | Reason — which gate fired |
|---|---|
| Vintage Café Shoreditch (17 Cheshire St, E2 6EH) | **Output QA** (0.55) — planter not faithful enough to the reference → held, not shipped. |
| Rise & Bloom (28 Hackney Rd, E2 7DZ) | **Frontage** — not bare enough (bareness 0.30). |
| Small square cafe (6 Ravey St, EC2A 4QW) | **Frontage** — not bare enough (0.30). |
| Project 44 (44 Rivington St, EC2A 3QP) | **Capture** — no clear entrance in frame. |
| Kiss the Hippo Coffee (145 City Rd, EC1V 1AW) | **Capture** — entrance distant / heavily obstructed. |

This single run exercises every gate: a frontage reject, a capture reject (→ Business-photo
fallback), and an output-QA reject.

---

## 3. Getting the frontage image

### 3.1 Deriving a usable framing from location + panorama data — `capture.ts`, `geo.ts`

A venue's lat/lng alone doesn't tell the camera which way to look. The Street View **metadata**
endpoint returns the nearest panorama's own coordinates, `pano_id` and capture `date`. From that:

1. **Heading** = initial great-circle bearing from the *panorama* location → the *venue* location
   (`geo.ts::bearing`). This points the camera across the street at the frontage instead of down the
   road — the single most important framing decision.
   ```
   θ = atan2( sin Δλ · cos φ₂ ,  cos φ₁ · sin φ₂ − sin φ₁ · cos φ₂ · cos Δλ )
   ```
   (φ = latitude, λ = longitude, pano → venue; result normalised to 0–360°.)
2. **Field of view 70°** (`CAPTURE.fov`) for a tight doorway crop; a **90°** retry if the first is
   rejected (entrance cropped).
3. **Pitch +6°** (`CAPTURE.pitch`) to include signage above the door.
4. **Panorama distance gate** — if the nearest panorama is **> 60 m** (`CAPTURE.radiusMeters`) from
   the venue (`geo.ts::distanceMeters`), we don't trust it to show this venue and skip to fallback.

Images are requested from the Street View Static API at **640×640** (free-tier cap).

### 3.2 Shopfront-aware source selection + fallback chain — `capture.ts::capture`

The naive rule — "use the first Street View frame that shows a door" — fails on a real, common case:
a venue's geocoded point can sit on the building centroid, so the derived heading points at a **side
or secondary doorway** rather than the recognisable shopfront. The judge would pass it (it *is* a
door) and we'd dress the wrong frontage.

So the judge is told the **venue name** and returns `isVenueShopfront` — *does this clearly show
THIS venue's own storefront as the dominant element?* Selection then works like this:

1. **Street View first.** If the frame clearly shows the venue's own shopfront
   (`isVenueShopfront && framingUsable && !reject`), use it — Street View is the primary "real street
   view" source and we stop here (cheapest path).
2. **If Street View is ambiguous** (side/secondary door, distant, obstructed, or not clearly this
   venue), we re-shoot once at FOV 90° **and** evaluate the venue's **Google Place (Business)
   photos**, then pick the **highest-scoring frontage across all sources**. This is the brief's "fall
   back to Google Business photos when Street View doesn't clearly show the entrance," with a sharper
   trigger than a hard reject.
3. **Mapillary** (free crowdsourced imagery within an ~80 m bbox) only if nothing above is
   acceptable.

**Frontage-clarity score** (`capture.ts::scoreOf`):
```
score = (framingUsable ? 0.4 : 0.1) + entranceConfidence·0.3 + (isVenueShopfront ? 0.3 : 0)
```
A clear venue shopfront is worth most, so a recognisable Business photo beats a Street View frame
pointed at a blank side door; ties break toward Street View to keep the authentic street view when a
Business photo is only marginally better.

**Worked example — Regency Cafe, Westminster (SW1P 4BY).** Street View heading 70° landed on a plain
stone side doorway; the judge returned `isVenueShopfront:false` ("no signage identifying this as
Regency Cafe; looks like a residential/office entrance") and rejected it. The pipeline then scored
the Business photos, picked the one showing the famous black-tiled "REGENCY CAFE" corner shopfront
(`isVenueShopfront:true`, score ~1.0), and correctly skipped the breakfast-plate photos.

### 3.3 Accept / reject bar for a framing

A capture is usable iff the judge reports `showsEntrance = true`, `framingUsable = true`,
`reject = false`, and the chosen image is the **highest-scoring** candidate (rewarding
`isVenueShopfront`). Explicit rejects/down-weights: "nearest panorama > 60 m," "interior/food shot,"
"entrance occluded by vehicle/scaffolding/bus shelter," "mostly road/sky," and "a door that isn't
clearly this venue's shopfront." Intentionally strict: a bad or wrong frontage guarantees a bad
composite. If nothing is accepted, the best-effort attempt is kept (`ok:false`) and the orchestrator
records `rejected-frontage`.

---

## 4. Compositing the planters — `composite.ts`

### 4.1 Keeping the product faithful (not reinterpreted)

The core decision: **the product is supplied to the model as a reference image, not a text
description.** Gemini 3 Pro Image receives the frontage *and* the actual product photo
(`products/`) together, with an instruction to **reproduce that exact planter and planting** (same
silhouette, material, colour, plant species, leaf shapes, flower colours) and to **edit IMAGE 1 only
by adding it**. Describing a planter in words ("a tall black cylinder with ferns") invites a
plausible but *different* object; conditioning on the photograph pins the specifics.

Two things moved fidelity from "plausible" to "the actual product":

- **The Pro image model** rather than the flash tier — the flash model drifts the planting toward a
  generic green mass; the Pro model preserves the reference's specific foliage (the fatsia / hosta /
  grasses, the Corten palm + red-flower/fern mix).
- **Pinning the output aspect ratio to the frontage** (`imageutil.ts::nearestAspectRatio`, passed
  through `gemini.ts::composite` as `imageConfig.aspectRatio`). Without it the model re-crops and
  re-renders the whole scene (garbling signage, altering the building); with it, the model edits in
  place and the building, signage and people stay as photographed.

### 4.2 Estimating real-world scale from a reference object

Believable size comes from anchoring the planter to things of known size *in the photo*:

- **A standard doorway ≈ 2 m** and **an adult ≈ 1.7 m** — stated in the prompt as the primary
  reference objects, because almost every frontage has a door and often a person. The model is told
  to size the planter *relative to the door and any people in frame*. (Brick courses ≈ 75 mm and
  paving are secondary cues.)
- **Documented product dimensions** — each product in `products/products.json` carries real-world cm
  (e.g. Charcoal Cylinder H60 × Ø60; Corten tall column H105 with a palm reaching ~2.1 m; White
  Tapered H68). These are *documented assumptions* (typical commercial-planter sizes) to be replaced
  by the client's spec sheet.

So scale is set twice over: the absolute cm the product *should* be, and the in-scene references it
must agree with. A planter that violates either is caught by the QA `scalePlausible` check (§5).

### 4.3 Placement, grounding, perspective, shadow

**Product-true placement.** Each product's *arrangement grammar* is authored once from its reference
photo in `products.json` `placement_style`, so the model styles it the way the client does rather
than improvising:
- *Charcoal Cylinder* → a cluster/row of broad low drums forming a continuous low green border.
- *Corten Tiered Set* → a one-side/corner vertical statement (palm → stepped cube → trough border),
  never a matching pair of 2 m palms.
- *White Tapered Pair* → the two side by side as a low band under a window.

The prompt combines this with the judge's frontage-specific `placementHint` and **hard rules**: never
in/across the doorway or the walking path; tight against the building; a believable **soft contact
shadow** in the existing sun direction so the base is grounded, not floating; match the camera's
vanishing lines; respect occlusion (a pedestrian in front stays in front). The QA gate checks
`entranceClear` and rejects a composite whose planter blocks the entrance.

### 4.4 Product choice & catalogue variety — `judge.ts`, `run.ts::pickProduct`

Product fit is a vision judgement: the judge returns `recommendedProducts`, a ranked list of *every*
product that suits a frontage. The orchestrator (`pickProduct`) then picks, among the suitable set,
the first product **not yet used** by an earlier delivered venue — so the showcase spans the
catalogue instead of repeating one planter — falling back to the best fit if all suitable ones are
taken. It only ever rotates *within* what the judge deemed suitable, so it never forces the White
Tapered onto a dark café frontage where it would look wrong.

---

## 5. Rejection criteria — output QA (`qa.ts::qaComposite`)

A finished composite is graded by a second vision pass comparing **original frontage vs composite vs
product reference** *before* it could reach an owner. It returns:

```jsonc
{ "productFaithful", "scalePlausible", "perspectiveConsistent",
  "shadowGrounded", "entranceClear", "buildingUnaltered",
  "artifacts": ["..."], "score": 0.0..1.0, "reject": bool, "reasons": ["..."] }
```

A generation is **rejected** if *any* of these hold:

- **Product not faithful** — the model invented a generic/different planter, or changed its
  material/colour/plants from the reference. *(hard)*
- **Implausible scale** — oversized or toy-sized vs the door/people. *(hard)*
- **Building altered** — facade repainted/warped, signage changed, people/objects added/removed,
  pavement redrawn. *(hard)*
- **Entrance blocked** — a planter sits in the doorway or obstructs the way in (`entranceClear =
  false`). *(hard)*
- **Floating / not grounded** — no believable contact shadow, hard paste edges, wrong occlusion.
- **Visible artefacts** — warping, duplicated/extra planters, melted/smeared plants.
- **Overall `score < 0.6`.**

On rejection the compositor **regenerates once** with the QA reasons fed back as a corrective
instruction (`composite.ts::compositeVenue`). If the retry also fails, the venue is **held** (shown
as "Held by QA" with reasons), never delivered. Showing an owner a warped facade or a fake-looking
planter is worse than showing nothing.

---

## 6. Imagery rights — our position

We capture and reuse a photo of someone's real property, at commercial scale, without their
involvement at the capture stage. Our considered position:

- **Street View is licensed imagery, not ours to redistribute freely.** Google's terms allow display
  of Street View via their APIs/embeds but restrict scraping, storage and derivative imagery for
  independent commercial redistribution. Compositing and then *sending* a derived image to a third
  party sits outside normal API display terms. Acceptable for a prototype; **for production we move
  the capture source to imagery we have the right to reuse** — the venue's own website / Google
  Business photos, a licensed/commercial Street View tier, or a one-off field capture — before any
  derived image is sent externally. The fallback chain is already built with this in mind, and each
  capture stores its panorama id, date and source for the provenance trail.
- **The building / property owner.** In the UK there is generally no copyright in the *appearance* of
  a building, and photographing a frontage from a public highway is lawful. The sensitivity is
  commercial reuse of a recognisable property in a sales mock-up. We treat the output as a **private
  1:1 proposal to that venue's owner** (the subject themselves), not public marketing, and honour any
  opt-out / takedown immediately.
- **People and plates.** Street View blurs faces/plates at source; our QA also rejects frames
  dominated by identifiable passers-by, and we would blur any residual third-party faces / number
  plates before sending.
- **Honesty.** The image is a clearly-labelled *visualisation* ("what it could look like"), never
  passed off as a real photo of an existing installation.

Net: fine for this prototype and for a consensual proposal to the depicted owner; before scaling
outreach we switch the capture source to rights-clean imagery and keep a per-venue
provenance/consent/takedown record.

---

## 7. Scale, cost, assumptions & limitations

**Built for the 5,000+/week framing.** Every stage decides *unaided* (no human eyeballs a candidate
or a framing). The cheap filters run before any paid call; the vision judge gates both selection and
capture; the QA gate + single regenerate gate output. First-fit selection means we stop as soon as we
have enough, rather than judging the whole pool.

**Cost per venue (rough).** Discovery + Street View are free-tier. Vision judge/QA are fractions of a
cent. The paid driver is **image generation** (Gemini image gen needs a *billed* project — free-tier
limit is 0); the Pro model is ~\$0.10–0.20 per composite, flash-image a few cents
(`GEMINI_IMAGE_MODEL` swaps them). The committed showcase exists so the demo never depends on live
spend; the live `/api/generate` path is the only thing that bills at review time.

**Assumptions & limitations:**
- Product dimensions are documented assumptions, not a spec sheet — swap `products.json` when real
  dimensions are available.
- Model output is nondeterministic; the QA gate + one regenerate is the control, not a guarantee. A
  production system would widen to best-of-N and add a mask-blend to *prove* the building is
  byte-unaltered rather than relying on the aspect-lock + QA check.
- Central-London query bias (strong Street View coverage); elsewhere the Business-photo / Mapillary
  fallback does more of the work.
- One product + one placement per venue; multiple options per venue is an obvious next step.
- Multi-shopfront frames can occasionally place onto a neighbour; the `isVenueShopfront` "dominant
  storefront" signal mitigates this but doesn't eliminate it.

---

## 8. Repo map & how to run

| Path | What |
|---|---|
| `pipeline/src/run.ts` | Orchestrator — `npm run pipeline` |
| `pipeline/src/discover.ts` | Places discovery + chain/independence filter |
| `pipeline/src/capture.ts` | Street View framing + shopfront-aware Business-photo / Mapillary fallback |
| `pipeline/src/geo.ts` | Bearing / distance for heading derivation |
| `pipeline/src/judge.ts` | Vision judge (entrance, shopfront, bareness, product fit) |
| `pipeline/src/composite.ts` | Reference-faithful compositing + regenerate |
| `pipeline/src/qa.ts` | Output QA / rejection gate |
| `pipeline/src/imageutil.ts` | Image dims + aspect-ratio lock (pure JS, Vercel-safe) |
| `pipeline/src/gemini.ts` | Gemini client (structured vision JSON + image edit, with retry) |
| `pipeline/src/products.ts` + `products/products.json` | The client's three real products, dimensions & placement styles |
| `results/`, `src/data/results.json` | Committed outputs + selection log |
| `api/generate.ts`, `api/search.ts` | Vercel serverless live pipeline |
| `src/` | React showcase |

Setup, required API keys and commands are in **`README.md`**. In short: `npm install`, fill `.env`
(`GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY`, optional `MAPILLARY_TOKEN`), then `npm run pipeline` to
regenerate results and `npm run dev` to view the showcase.
