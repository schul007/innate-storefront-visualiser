# design.md — Storefront capture & visualisation

> Automated pipeline that finds under-dressed London frontages, captures each venue's
> **real** doorway, and composites the client's **actual** planters onto it at correct
> scale — a convincing "what it could look like" visual, with no human in the loop.

This note is written so a second engineer could rebuild the system from it. It covers the
two capabilities being tested — **frontage capture** and **product compositing** — plus the
automated venue selection that feeds them, the fallback logic, the imagery-rights position,
and the rejection criteria.

---

## 1. System at a glance

Five automated stages, each with its own accept/reject decision so that at 5,000 venues/week
nothing waits on a human:

```
discover ──▶ capture ──▶ judge ──▶ composite ──▶ QA gate ──▶ deliver / hold
(Places)    (Street     (vision:  (Gemini 2.5    (vision:
            View,        entrance  Flash Image,   fidelity,
            heading      + bare?)  "Nano Banana") scale,
            from geom)                            unaltered?)
```

**Why this shape.** The two graded capabilities are an image-sourcing problem and an
image-generation problem. Both are unreliable in isolation (Street View faces the wrong way;
generators hallucinate), so each is bracketed by an automated *vision judgement* that decides
whether to proceed, retry, fall back, or discard. The judgements are the product — the models
are interchangeable.

**Architecture — hybrid.** The pipeline is a Node/TypeScript batch job
([`pipeline/src/`](pipeline/src/)) that runs offline and commits its outputs to
[`results/`](results/) and [`src/data/results.json`](src/data/results.json). A static React site
([`src/`](src/)) renders those cached results, so the demo link always works regardless of live
API quota. The *same* capture/judge/composite/QA modules are also exposed as Vercel serverless
functions ([`api/generate.ts`](api/generate.ts), [`api/search.ts`](api/search.ts)) so a reviewer
can trigger the real pipeline on any London venue from the deployed page.

**Stack decisions (defensible on a call):**

| Concern | Choice | Why |
|---|---|---|
| Venue discovery | Google Places API (New) | One call returns business type, rating, address, postcode and Place Photos — rich signals for the "good fit" filter. Free tier covers prototype volume. |
| Frontage imagery | Google Street View Static API | Best coverage/quality in central London; exposes panorama geometry (location, heading, date) we need to frame the doorway. Same key as Places. |
| Vision judge + QA | Gemini 2.5 Flash (`gemini-2.5-flash`) | Fast, cheap multimodal reasoning; returns structured JSON verdicts. |
| Compositing | Gemini 2.5 Flash Image ("Nano Banana") | State-of-the-art at *reference-image-conditioned* editing — it can place **this** product rather than reinventing a generic planter, and edit in place without redrawing the building. |
| Fallback imagery | Google Place Photos → Mapillary | Keyless/free Mapillary is the no-billing escape hatch; Place Photos are the venue's own imagery. |

Alternatives considered and rejected: **OpenStreetMap Overpass** for discovery (no business
photos, thinner signals — kept only as a zero-billing fallback); **Replicate/SDXL inpainting**
for compositing (needs a hand-authored mask per image, which breaks "no human in the loop," and
is weaker at honouring a reference product); **classical cut-and-paste compositing** (can't
match lighting/perspective believably across arbitrary frontages).

---

## 2. Automated venue selection

**Goal:** independent, street-facing London businesses (cafés, restaurants, salons) whose
frontage is **bare or under-dressed** — where planters would visibly improve the entrance.

### 2.1 Candidate sourcing — [`discover.ts`](pipeline/src/discover.ts)

Google Places **Text Search** across a spread of central-London areas × business types
(Shoreditch/Marylebone/Soho/Islington/Clerkenwell/Fitzrovia/Notting Hill/Bermondsey ×
café/coffee/restaurant/salon/deli/bistro). Breadth across area and type de-risks the pool and
keeps us in neighbourhoods with strong Street View coverage. We request a field mask of
`id, displayName, formattedAddress, addressComponents, location, types, rating,
userRatingCount, businessStatus, photos, websiteUri` — everything the filter and the capture
fallback need, in one call.

Postcode is taken from the `postal_code` address component, falling back to a UK-postcode regex
over the formatted address.

### 2.2 "Independent & real" filter (cheap signals, applied first)

- **Chain denylist** — name-match against ~35 known chains (Starbucks, Pret, Greggs, Nando's,
  Toni & Guy, …). Independents are the target; chains have their own brand standards.
- **Operational only** — drop anything not `OPERATIONAL`.
- **Rating-count floor** (≥5 ratings) — filters placeholder/duplicate listings.

These run before any paid vision call, so we only spend image/vision quota on plausible
candidates. In a live run this pool was **57 independent candidates** from the query set.

### 2.3 "Good fit" judgement (vision, per candidate) — [`judge.ts`](pipeline/src/judge.ts)

Business type can't tell you whether a *specific doorway* is bare. So the real selection signal
is a vision-model judgement on the captured frontage itself. For each candidate image the judge
returns structured JSON:

- `showsEntrance` / `entranceConfidence` — is the street-facing door actually in frame?
- `framingUsable` — centred, not cropped/occluded/blurred?
- **`frontageBareness` (0–1)** — the opportunity signal: 1 = completely bare either side of the
  door; low if it's already planted or there's no usable pavement.
- `obstructions`, `surfaceAtEntrance`, `recommendedProduct`, `placementHint`, `reject`, `reasons`.

### 2.4 Accept / reject bar

A candidate is **delivered** only if all hold:

1. Capture produced an image the judge did **not** reject (`showsEntrance` and `framingUsable`), and
2. `frontageBareness ≥ 0.35` (the frontage is genuinely under-dressed), and
3. The composite passes the output QA gate (§5).

Anything else is logged with its reason and skipped. The pipeline keeps walking the candidate
pool until it has three delivered visuals. Deliberately **not** over-engineered: one or two
rejects before a fallback or a skip is an expected, healthy outcome — we grade that the decision
was automated, not that it was flawless. Every accept/reject is recorded in the **selection log**
(shown on the site and in [`src/data/results.json`](src/data/results.json)).

### 2.5 Selected venues (from the committed run)

The three the pipeline **delivered** (full trail in [`src/data/results.json`](src/data/results.json)
and on the deployed site):

| Venue | Address | Postcode | Product chosen | Capture | QA |
|---|---|---|---|---|---|
| **Small square cafe** | 6 Ravey St, London | EC2A 4QW | Corten Tiered Set | Street View rejected ×2 (construction hoarding) → **Place Photo** fallback | 0.85 |
| **Artist Cafe** | 311 Old St, Shoreditch | EC1V 9LA | Corten Tiered Set | **Street View** (heading 256°, Sep-2025 imagery), bareness 0.90 | 0.95 |
| **Kiss the Hippo Coffee** | 145 City Rd, London | EC1V 1AW | Charcoal Cylinder | Street View rejected ×2 (bus shelter) → **Place Photo**, **regenerated ×1** | 0.92 |

**Why these were picked:** each is an independent café with a genuinely bare/under-dressed
ground-level frontage (bareness ≥ 0.35) and a clearly-framed entrance, and each composite cleared
the QA gate. The product choice is the judge's per-frontage recommendation — the warm-brick corner
frontages suited the rust-toned **Corten Tiered Set**; the dark modern **Charcoal Cylinder** suited
Kiss the Hippo's glazed shopfront.

**What it rejected, and why** (the selection is automated — these were never hand-filtered):

| Venue | Reason |
|---|---|
| Vintage Café Shoreditch (17 Cheshire St, E2 6EH) | Frontage **not bare enough** — bareness 0.30; existing outdoor tables/diners already dress the entrance. |
| Rise & Bloom, Shoreditch (28 Hackney Rd, E2 7DZ) | Frontage **not bare enough** — bareness 0.30; existing outdoor seating. |

Two of the three delivered venues also show the **capture fallback working for real**: when Street
View showed a construction hoarding or a bus shelter instead of the doorway, the judge rejected it
and the pipeline fell back to the venue's Google Business photo — exactly the "one or two rejects
before falling back" behaviour the brief describes. One output also triggered a **single
regenerate** after the first QA pass flagged a weak contact shadow.

---

## 3. Getting the frontage image

### 3.1 Deriving the framing — [`capture.ts`](pipeline/src/capture.ts), [`geo.ts`](pipeline/src/geo.ts)

A venue location alone doesn't tell the camera which way to look. The Street View **metadata**
endpoint gives the nearest panorama's own coordinates, `pano_id` and capture `date`. We then:

1. **Heading** = initial bearing from the *panorama* location → the *venue* location (great-circle
   formula in [`geo.ts`](pipeline/src/geo.ts)). This points the camera across the street at the
   frontage instead of down the road — the single most important framing decision.
2. **FOV 70°** for a tight doorway crop, **pitch +6°** to include signage above the door.
3. **Panorama distance gate** — if the nearest panorama is >60 m away, we don't trust it to show
   this venue and skip to fallback.

### 3.2 When the imagery is wrong — fallback chain

Each candidate image is scored by the same judge (§2.3). We stop at the first image it accepts;
otherwise:

1. **Retry framing** — re-shoot at a wider **FOV 90°** in case the entrance was cropped.
2. **Google Place Photos** — the venue's own / Google Business photos (first 3), judged in turn.
3. **Mapillary** — nearest free crowdsourced street-level image within an ~80 m bbox (optional
   token).

If nothing is accepted, we keep the **best-scoring** attempt and mark it `ok:false`; the
orchestrator then records `no-frontage`/`rejected-frontage` and moves on rather than shipping a
bad capture.

### 3.3 Accept / reject bar for a framing

A capture is usable iff the judge reports `showsEntrance = true` **and** `framingUsable = true`
**and** `reject = false`. "Nearest panorama >60 m," "interior shot," "entrance occluded by
vehicle/scaffolding," and "mostly road/sky" are explicit rejects. This is intentionally strict:
a bad frontage guarantees a bad composite.

---

## 4. Compositing the planters — [`composite.ts`](pipeline/src/composite.ts)

### 4.1 Keeping the product faithful (not reinterpreted)

The core decision: **the product is supplied to the model as a reference image, not as a text
description.** Gemini 2.5 Flash Image receives the frontage *and* the actual product photo
([`products/`](products/)) together, with an instruction to **reproduce that exact planter and
planting** and to **edit IMAGE 1 only by adding it** — not to redraw anything. Describing a
planter in words ("a tall black cylinder with ferns") invites the model to invent a plausible
but *different* object; conditioning on the photograph pins shape, material, colour and the
specific plants. The QA gate (§5) then explicitly checks fidelity against that same reference.

### 4.2 Estimating real-world scale

Believable size comes from anchoring the planter to things of known size in the scene:

- **Documented product dimensions** — each product in
  [`products/products.json`](products/products.json) carries real-world cm (e.g. Charcoal
  Cylinder H75 × Ø55; Corten tall cube H100 with a palm reaching ~2 m; White Tapered H70). These
  are stated assumptions (typical commercial-planter sizes) to be replaced by the client's spec
  sheet.
- **Scene reference objects** — the prompt tells the model a standard **doorway ≈ 2 m** and an
  **adult ≈ 1.7 m**, and to size the planter *relative to the door and any people in frame*. Door
  height is the most reliable anchor because almost every frontage has one; brick courses
  (~75 mm) and paving are secondary cues.

So scale is set twice over: the absolute cm the product *should* be, and the in-scene references
it must agree with.

### 4.3 Grounding, perspective, shadow

The prompt fixes the building/people/pavement as immutable and requires: the planter sits flat on
the ground plane matching the camera's vanishing lines; a **soft contact shadow** in the existing
sun direction so it reads as grounded, not pasted; and correct occlusion (a pedestrian in front
stays in front). Placement comes from the judge's `placementHint` (e.g. "left of the door, clear
of the swing").

---

## 5. Rejection criteria — what must never reach an owner

Output QA ([`qa.ts`](pipeline/src/qa.ts)) is a second vision pass comparing **original frontage
vs composite vs product reference**. A generation is **rejected** (`reject=true`) if *any* of:

- **Product not faithful** — the model invented a generic/different planter, or changed its
  material/colour/plants from the reference. *(hard reject)*
- **Implausible scale** — oversized or toy-sized versus the door/people. *(hard reject)*
- **Building altered** — facade repainted/warped, signage changed, people/objects added or
  removed, pavement redrawn. The brief requires everything but the planter left unaltered. *(hard reject)*
- **Floating / not grounded** — no believable contact shadow, hard paste edges, wrong occlusion.
- **Visible artefacts** — warping, duplicated/extra planters, melted or smeared plants.
- **Overall score < 0.6.**

On rejection the compositor **regenerates once** with the specific QA reasons fed back as a
corrective instruction. If the retry also fails, the venue is **held** (surfaced on the site as
"Held by QA" with the reasons) rather than delivered. Showing a venue owner a warped facade or a
fake-looking planter is worse than showing nothing.

---

## 6. Imagery rights — our position

This pipeline captures and reuses a photo of someone's real property, at commercial scale,
without their involvement at the capture stage. Our considered position:

- **Street View is licensed imagery, not ours to redistribute freely.** Google's terms allow
  display of Street View via their APIs/embeds but restrict scraping, storage and the creation of
  derivative imagery for independent commercial redistribution. Compositing and then *sending* a
  derived image to a third party sits outside normal API display terms. For a prototype this is
  acceptable; **for production we would move the capture source to imagery we have the right to
  reuse** — the venue's own website/Google Business photos, a licensed Street View/commercial
  tier, or a one-off field capture — before any derived image is sent externally. The fallback
  chain is already built with this in mind.
- **The building/property owner.** In the UK there is generally no copyright in the *appearance*
  of a building, and photographing a frontage from a public highway is lawful. The sensitivity is
  commercial reuse of a recognisable property in a sales mock-up. We treat the output as a
  **private 1:1 proposal to that venue's owner** (the subject themselves), not as public
  marketing, and honour any opt-out/takedown immediately.
- **People and plates.** Street View blurs faces/plates at source; our QA also rejects frames
  dominated by identifiable passers-by, and we would blur any residual third-party faces/number
  plates before sending.
- **Honesty.** The image is a clearly-labelled *visualisation* ("what it could look like"), never
  passed off as a real photo of an existing installation.

Net: fine for this prototype and for a consensual proposal to the depicted owner; before scaling
outreach we switch the capture source to rights-clean imagery and keep a per-venue
provenance/consent/takedown record (the pipeline already stores panorama id, date and source for
each capture).

---

## 7. Assumptions & limitations

- **Product dimensions are documented assumptions**, not a manufacturer spec — swap
  [`products/products.json`](products/products.json) when real dimensions are available.
- **Model nondeterminism** — compositing quality varies run to run; the QA gate + single
  regenerate is the control, not a guarantee. A production system would widen to best-of-N.
- **Central-London bias** — the query set targets areas with strong Street View coverage; other
  areas lean harder on the Place Photos / Mapillary fallback.
- **Cost/quota** — the live `/api/generate` path makes real Places + Street View + 2× Gemini
  calls per venue; the committed cached results exist so the demo never depends on that.
- **No automated A/B of placement** — one product and one placement per venue; multiple options
  per venue is an obvious next step.

---

## 8. Where everything lives

| Path | What |
|---|---|
| [`pipeline/src/run.ts`](pipeline/src/run.ts) | Orchestrator — `npm run pipeline` |
| [`pipeline/src/discover.ts`](pipeline/src/discover.ts) | Places discovery + chain/independence filter |
| [`pipeline/src/capture.ts`](pipeline/src/capture.ts) | Street View framing + Place Photo/Mapillary fallback |
| [`pipeline/src/geo.ts`](pipeline/src/geo.ts) | Bearing / distance for heading derivation |
| [`pipeline/src/judge.ts`](pipeline/src/judge.ts) | Vision judge (entrance + bareness + product pick) |
| [`pipeline/src/composite.ts`](pipeline/src/composite.ts) | Reference-faithful compositing + regenerate |
| [`pipeline/src/qa.ts`](pipeline/src/qa.ts) | Output QA / rejection gate |
| [`products/`](products/) | The client's three real products + dimensions |
| [`results/`](results/), [`src/data/results.json`](src/data/results.json) | Committed outputs + selection log |
| [`api/`](api/) | Vercel serverless live pipeline |
| [`src/`](src/) | React showcase |
