# OpenHiggsfield AI — Open-Source Alternative to Higgsfield AI

> **The free, open-source alternative to Higgsfield AI.** Generate images and
> videos with 40 models from one prompt bar — no closed ecosystem, no studio
> subscription.

## 🌐 Try it Online — No Install Required

**Hosted version:** [openhiggsfield.ai](https://openhiggsfield.ai)

Image and Video in one studio, in the browser — no Node.js or setup for the
hosted build. This fork also supports a local CUA runtime backed by Pine Token
Gateway.

---

**Why OpenHiggsfield AI instead of Higgsfield AI?**

- **Free & open-source** — no studio subscription, no vendor lock-in
- **Self-hosted** — clone it, run it, change it
- **Server-only key** — the CUA runtime reads its Gateway key from the environment
- **40 models** — 12 image, 28 video, one catalog, one composer

---

Next.js 16 App Router on Vercel · React 19 · plain CSS · Zustand · pnpm

---

## Features

### Generate

- **One composer for Image and Video.** A single prompt bar drives both; the
  model you pick decides image or video. `⌘/Ctrl + Enter` submits.
- **40 models in the catalog** — 12 image, 28 video: Nano Banana 2 / Lite / Pro,
  Soul 2, Soul Cinema, Gemini Omni Flash, Kling 3 (Turbo / Std / Pro / 4K /
  Motion), Veo 3.1, Wan, Flux, GPT Image 2, Ideogram, Recraft, LTX, MiniMax,
  PixVerse, Grok, Qwen and more. Searchable picker.
- **Per-model settings.** Aspect ratio, resolution, duration, output format,
  audio, batch size, prompt enhancement — each model declares its own allow-list
  and the studio renders exactly that. No parallel hardcoded list.
- **Media inputs by role.** Start frame, end frame, references, video and audio,
  each with the per-role cap the model declares. In CUA mode, files stay in the
  workspace under `uploads/`.
- **Asset picker.** Attach from your uploads library or from any finished run in
  history — two tabs over one library, filtered to the role's kind.
- **Batch.** Up to 4 results per press. Models with a native count setting use it;
  the rest are submitted once per result, each clearing its own tile.
- **Live run lifecycle.** Skeletons open in the grid on submit, the request is
  polled every 4s until a terminal status (10-minute deadline), and each finished
  result blooms into place on its own clock.

### Gallery

- **Four scopes** — Image, Video, Assets (every finished run) and Favorites —
  as an arrow-key-navigable tab rail.
- **Masonry grid** of real runs at their true aspect ratio, newest first, with a
  gradient placeholder while media loads.
- **Per-tile actions**: reuse, favorite, delete, select.
- **Reuse restores model, settings and prompt**, so the same run can be
  re-rendered, not just re-typed.
- **Viewer.** Full-size media with prompt (copy in one click), model, resolved
  settings, timestamp, download, favorite and Recreate.
- **Selection mode.** Click a tile's checkbox to enter; shift-click extends a
  range. Bulk download (sequential, with progress and a report of any files the
  CDN refused), bulk favorite/unfavorite, bulk delete. `Esc` exits.
- **Undo.** Deletion is reversible for 6 seconds via a bar with a draining
  hairline, in the strip the composer already reserves.
- **Empty states** that hand you a starter prompt instead of a blank grid.

### State and errors

- **History persists** in IndexedDB in this browser (60 records). Favorites are
  a deliberate keep and never age out of the cap. Result URLs belong to the
  generation platform, so old history can outlive its CDN lifetime and show gaps.
- **Failed, NSFW and canceled runs** are recorded as failed tiles carrying the
  reason and a retry that restores the prompt and model.
- **Server-only Gateway key.** CUA credentials are read from environment variables
  and never returned to the browser. The topbar lamp states Gateway readiness
  and whether a run is in flight.

---

## Architecture

Each generate is one object: `{ model, prompt, media, settings }`.

- **The UI builds that object** and hands it to a server action. The action
  resolves it against the catalog and maps it to the generation API's own
  fields (`image_urls`, `aspect_ratio`, …).
- **Server actions are the only caller.** The browser never talks to the
  generation API. The adapter uses OpenAI-compatible image/video endpoints and
  sends `Authorization: Bearer <api_key>` only from the server.
- **The catalog is the source of truth** (`src/generation/catalog/`). A new entry
  appears in the picker, brings its own settings rail and media roles, and needs
  no studio changes.
- **Five small Zustand stores** — shared image/video prompt, shared image/video
  media, `settings[modelId]`, and a tiny `active` store. No store per model.
- **Uploads and generated results** are stored in local `uploads/` and `outputs/`
  directories and served through same-origin routes.

---

## Getting started

```bash
cp .env.example .env
# fill in the server-only Gateway values
./scripts/start-cua.sh
```

The script installs pinned dependencies, builds the app, checks that the port is
free, and binds the server to `127.0.0.1:3000` by default.

The regular `pnpm dev` and `pnpm start` commands are also loopback-only. This is
a local CUA service with server-side billing credentials, not a public hosted
application. Set `CUA_ALLOW_REMOTE=1` only when a separate trusted access layer
protects the service.

### Environment

```bash
OPENAI_API_KEY=pmk_xxx
OPENAI_BASE_URL=https://your-token-gateway.example/v1
OPENAI_MODEL=gpt-image-1
```

### Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3000 |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm brand` | Rebuild the icons and OG card in `public/` |
| `./scripts/start-cua.sh` | Validate, build, and start the local CUA service |

---

## Layout

```
src/
  app/          /  is the full-viewport studio and the only page
                /api/cua stores and serves local media
                base.css owns the document canvas
  generation/   generate requests, server actions, API mapping, catalog, stores
  openhiggsfield/
                the studio surface: composer, gallery, viewer, model picker,
                settings, asset picker, selection bar — and openhiggsfield.css
```

---

## Design principles

Dark studio ground, a single lime accent `#d1fe17`, Inter throughout. The chrome
stays neutral so the generated work is the only color on the surface.

1. **The tool disappears into the task** — expression never obscures state or
   affordance.
2. **Accent is state, not decoration** — selection, primary action, liveness only.
3. **Data is data** — settings, counts and durations read in tabular numerals.
   One typeface throughout; no monospace anywhere.
4. **Motion conveys state** — the generation lifecycle, the arrival of a run.
   Nothing loops decoratively.
5. **Every control ships all its states** — hover, focus, active, disabled,
   loading, error, empty.
6. **The catalog is the source of truth** — the studio renders what the model
   declares, never a parallel hardcoded list.

The model catalog and its per-model parameter definitions remain the upstream
source of truth; the CUA adaptation does not replace or simplify those controls.
