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
| Compositing | Gemini 3 Pro Image ("Nano Banana Pro"), aspect-ratio locked to the frontage | State-of-the-art at *reference-image-conditioned* editing — it reproduces **this** product's exact planter and planting rather than a generic approximation, grounds it with real contact shadows, and (with the aspect ratio pinned to the input) edits in place instead of re-cropping/redrawing the scene. The cheaper `gemini-3.1-flash-image` is a drop-in fallback via `GEMINI_IMAGE_MODEL`. |
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
- `isVenueShopfront` — is this clearly the named venue's own storefront (vs a side door / neighbour)? (see §3.2)
- `recommendedProducts` — all catalogue products that suit this frontage, ranked best-first (drives product choice + variety).
- `obstructions`, `surfaceAtEntrance`, `placementHint`, `reject`, `reasons`.

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
| **Vintage Café Shoreditch** | 17 Cheshire St, London | E2 6EH | Corten Tiered Set | Street View not the clear shopfront → **Google Business photo** | 0.92 |
| **Rise & Bloom – Shoreditch** | 28 Hackney Rd, London | E2 7DZ | Charcoal Cylinder | Street View not the clear shopfront → **Google Business photo** | 0.95 |
| **BOBO & WILD – Shoreditch** | 1 Poole St, London | N1 5EB | Charcoal Cylinder | Street View distant/car-obstructed → **Google Business photo** | 0.85 |

**Why these were picked:** each is an independent café with a genuinely bare/under-dressed
ground-level frontage (bareness ≥ 0.35) and a clearly-framed entrance, and each composite cleared
the QA gate. Selection is **first-fit past the bar** (not a global ranking): the pipeline walks the
candidate pool in order and keeps the first three that pass every gate.

**Product choice & variety.** The planter is the judge's per-frontage recommendation — the
warm-brick Vintage frontage suited the rust-toned **Corten Tiered Set**; the modern glazed shopfronts
suited the dark **Charcoal Cylinder**. The judge returns *all* products that suit a frontage (ranked),
and the orchestrator **rotates across the catalogue** — picking a not-yet-used product where the
frontage supports it — so the showcase spans the range rather than repeating one planter. (The **White
Tapered Pair** suits lighter/painted shopfronts and salons; it isn't forced onto these dark café
frontages, where it would look wrong — honest fit beats box-ticking.)

**What it rejected, and why** (the selection is automated — these were never hand-filtered):

| Venue | Reason |
|---|---|
| Small square cafe (6 Ravey St, EC2A 4QW) | Frontage **not bare enough** — existing greenery/seating already dresses the entrance. |
| Project 44 (44 Rivington St, EC2A 3QP) | Available imagery showed a **window display, no clear doorway** to dress. |
| WatchHouse Marylebone (32–34 New Cavendish St, W1G 8UE) | Frontage **not bare enough** for planters to add much. |

All three delivered venues show the **shopfront-aware capture working for real**: when the Street
View heading landed on a frame that didn't clearly show the venue's own storefront (or was distant /
car-obstructed), the judge rejected it and the pipeline fell back to the venue's Google Business
photo — exactly the "one or two rejects before falling back" behaviour the brief describes (see the
Regency Cafe worked example in §3.2).

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

### 3.2 Shopfront-aware source selection (the key fix)

The naive version — "use the first Street View frame that shows a door" — fails on a real and
common case: a venue's geocoded point can sit on the building centroid, so the derived heading
points at a **side or secondary doorway** rather than the recognisable shopfront. The judge would
pass it (it *is* a door), and we'd composite onto the wrong frontage.

So the judge is told the **venue name** and returns `isVenueShopfront` — *does this clearly show
THIS venue's own storefront (its signage/window), as opposed to a generic doorway or a neighbour?*
Selection then works like this:

1. **Street View first.** If the frame clearly shows the venue's own shopfront
   (`isVenueShopfront && framingUsable && !reject`), use it — Street View is the primary
   "real street view" source and we stop here (cheapest path, no extra calls).
2. **If Street View is ambiguous** (a plain/side doorway, no signage, or rejected), we re-shoot
   once at a wider **FOV 90°**, and — crucially — **also evaluate the venue's Google Place
   (Business) photos** and pick the **highest-scoring frontage across all sources**. A recognisable
   Business photo of the real shopfront beats a Street View frame pointed at a blank side door.
   This is exactly the brief's "fall back to Google Business photos when Street View doesn't
   clearly show the entrance," with a sharper trigger than a hard reject.
3. **Mapillary** — nearest free crowdsourced street-level image within an ~80 m bbox (optional
   token), only if nothing above is acceptable.

The frontage-clarity **score** is `framingUsable (0.4) + entranceConfidence×0.3 +
isVenueShopfront (0.3)`, so a clear venue shopfront is worth most; ties break toward Street View to
keep the authentic street view when a Business photo is only marginally better. If nothing is
accepted we keep the **best-effort** attempt marked `ok:false` and the orchestrator records
`rejected-frontage` rather than shipping a bad capture.

**Worked example (Regency Cafe, Westminster, SW1P 4BY).** Street View heading 70° landed on a plain
stone side doorway — the judge returned `isVenueShopfront:false` ("no signage identifying this as
Regency Cafe; looks like a residential/office entrance") and rejected it. The pipeline then scored
the Google Business photos, picked the one showing the famous black-tiled "REGENCY CAFE" corner
shopfront (`isVenueShopfront:true`, score ~1.0), and correctly skipped the breakfast-plate photos.

### 3.3 Accept / reject bar for a framing

A capture is usable iff the judge reports `showsEntrance = true`, `framingUsable = true`,
`reject = false`, and the chosen image is the one with the **highest frontage-clarity score**
(which rewards `isVenueShopfront`). "Nearest panorama >60 m," "interior/food shot," "entrance
occluded by vehicle/scaffolding," "mostly road/sky," and "a door that isn't clearly this venue's
shopfront" are explicit rejects/downweights. Intentionally strict: a bad or wrong frontage
guarantees a bad composite.

---

## 4. Compositing the planters — [`composite.ts`](pipeline/src/composite.ts)

### 4.1 Keeping the product faithful (not reinterpreted)

The core decision: **the product is supplied to the model as a reference image, not as a text
description.** Gemini 3 Pro Image receives the frontage *and* the actual product photo
([`products/`](products/)) together, with an instruction to **reproduce that exact planter and
planting** (same silhouette, material, colour, plant species, leaf shapes, flower colours) and to
**edit IMAGE 1 only by adding it** — not to redraw anything. Describing a planter in words ("a tall
black cylinder with ferns") invites the model to invent a plausible but *different* object;
conditioning on the photograph pins shape, material, colour and the specific plants. The QA gate
(§5) then explicitly checks fidelity against that same reference.

**Two things that moved fidelity from "plausible" to "the actual product":** (1) using the **Pro**
image model rather than the flash tier — the flash model drifts the planting toward a generic green
mass, the Pro model preserves the reference's specific foliage; (2) **pinning the output aspect ratio
to the frontage** ([`imageutil.ts`](pipeline/src/imageutil.ts) `nearestAspectRatio`), which stops the
model re-cropping/recomposing the scene — so the building, signage and people stay as photographed
and only the planters are added. Each product's **arrangement grammar** (cluster of drums / tiered
corner statement / side-by-side pair) is authored once from its reference photo in
[`products.json`](products/products.json) `placement_style`, so the model styles it the way the
client does rather than improvising.

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

### 4.3 Placement, grounding, perspective, shadow

**Placement rules (critical).** The prompt instructs the model to place planters **to the side(s)
of / flanking the entrance, lining the frontage against the wall or beneath the windows — never in
the doorway or blocking the way in**, and to keep the pedestrian path clear. This is how a real venue
styles its frontage, and it fixes the common failure where a generator drops a planter right across
the door. The output QA then checks `entranceClear` and rejects a composite whose planter genuinely
blocks the entrance (§5). Placement also takes the judge's `placementHint` (e.g. "flank the corner
entrance on the wide pavement").

**Grounding.** The prompt fixes the building/people/pavement as immutable and requires: the planter
sits flat on the ground plane matching the camera's vanishing lines; a **soft contact shadow** in the
existing sun direction so it reads as grounded, not pasted; and correct occlusion (a pedestrian in
front stays in front).

---

## 5. Rejection criteria — what must never reach an owner

Output QA ([`qa.ts`](pipeline/src/qa.ts)) is a second vision pass comparing **original frontage
vs composite vs product reference**. A generation is **rejected** (`reject=true`) if *any* of:

- **Product not faithful** — the model invented a generic/different planter, or changed its
  material/colour/plants from the reference. *(hard reject)*
- **Implausible scale** — oversized or toy-sized versus the door/people. *(hard reject)*
- **Building altered** — facade repainted/warped, signage changed, people/objects added or
  removed, pavement redrawn. The brief requires everything but the planter left unaltered. *(hard reject)*
- **Entrance blocked** — a planter sits in the doorway or clearly obstructs the way into the venue
  (`entranceClear = false`). Flanking/lining the frontage is the goal; blocking the door is a reject. *(hard reject)*
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
