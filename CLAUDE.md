# Hono Konfigurator BE — project rules (AI-maintained)

This backend is **vibecoded / AI-maintained** — optimized for an AI to pick up cold and
stay consistent, NOT for a team of human programmers. Favor **flat, obvious, self-contained**
code over clever abstractions. When in doubt, choose the boring, explicit option.

## What this is — DIRECTION: FULL LARAVEL PARITY (2026-07)
A **faithful reimplementation of the legacy Laravel BE** on Cloudflare Workers, so the EXISTING
frontend (`vite-konfigurator-2026`, unchanged) works against it and we can migrate off the
droplet. Same API contract, same door-image compositing output.

- The door image is **built from layers** (`DoorBuilder`): base door PNG + panel color (hex fill
  or texture) + glass + dent + okvir + oplata + equipment + DIN flip + door type (side panels /
  transom / double) + frame. Full recipe: `../door-renderer-recipe.md`.
- Ported to **photon-rs** (WASM, runs in workerd) — the POC proved it matches PHP at ~0.7%.
- **Match Laravel exactly.** Validate every case by POSTing the same config to the live Laravel
  API (`https://konfigurator-api.online/api/door/image`) and diffing the PNG (see `poc`/`be-test`).
- The API keeps Laravel's shapes incl. the **hyphenated config keys** (`model-id`, `panel-color`,
  `inner-glass-id`, `DIN-opening-standard`, `equipment.<type>.id`, …) so the FE is unchanged.

> NOTE: an earlier "Model B" (finished images + overlays) design was scrapped — the client never
> confirmed it, so we port full Laravel parity instead. The Model-B commits (schema `0001-0002`
> render.ts overlay version) are being replaced. If the client later wants Model B, it becomes a
> simplification ON TOP of this.

## Stack (do not swap without updating this file)
- **Hono** on **Cloudflare Workers** (`wrangler`). Hono is runtime-portable — keep code
  Workers-compatible (no Node built-ins beyond `nodejs_compat`, no filesystem, no native modules).
- **D1** (SQLite) via the `DB` binding — the database.
- **R2** via the `ASSETS` binding — stores all catalog assets (door layer PNGs, colors, glass,
  equipment, houses, thumbnails). Clean-key scheme (see Conventions); served at `GET /storage/*`.
- **photon-rs** (`@silvia-odwyer/photon`) — WASM image compositing (proven to run in workerd).
- **JWT** via `hono/jwt`. Passwords: NEW users hashed with **PBKDF2 via Web Crypto**; MIGRATED
  Laravel users verify against their **bcrypt** `$2y$` hash via **bcryptjs** (pure-JS, Workers-safe).

## File layout (keep it flat — few files)
- `src/index.ts` — Hono app + wiring: health, `GET /storage/*` (R2), render, offers, auth; calls `registerCatalog/registerPrice/registerAdmin`.
- `src/doorbuilder/` — photon DoorBuilder renderer: `index` (pipeline), `photon` (helpers), `types` (door types), `anchor` (Intervention→photon coord math). Full recipe: `../door-renderer-recipe.md`.
- `src/catalog.ts` — GET reads (`default-items` + apiResource indexes) from D1, in Laravel shapes.
- `src/price.ts` — full-parity price calc (area/perimeter, markups/VAT), auth-gated.
- `src/admin.ts` — generic catalog CRUD (create/update/delete + R2 image upload) + users/markups.
- `src/auth.ts` — `verifyPassword` (bcrypt for migrated Laravel hashes, PBKDF2 for new) + JWT + `requireAuth`/`requireAdmin`.
- `src/email.ts` — inquiry email (Resend, best-effort).
- `migrations/` — `0001_catalog` (schema), `0002_catalog_seed` (generated, gitignored), `0003_app`.
- `migrate/` — `build.mjs` (dump→schema+seed+manifest), `reorg.sh` (droplet path resolver). See `STORAGE.md`, `MIGRATION-RUNBOOK.md`.

## Conventions (follow every time)
- **Routes:** all under `/api/*`. Return `c.json(data)` or `c.json({ error }, status)`.
  The render route returns a raw PNG `Response` with `content-type: image/png`.
- **DB columns are snake_case; API returns rows as-is (snake_case).** Don't add a camelCase
  mapping layer — the FE adapts. Keep one naming world.
- **DB access:** always `c.env.DB.prepare(sql).bind(...).all()/.first()`. Parameterize — never
  string-concat user input into SQL.
- **Auth:** protected routes use `requireAuth`; admin routes use `requireAdmin`. JWT is a Bearer
  token; payload = `{ id, username, role }`. Passwords live in `users.password` — bcrypt (migrated)
  or PBKDF2 (new); `verifyPassword` in `auth.ts` handles both by sniffing the `$2` prefix.
- **Assets in R2 (clean scheme):** `doors/{model_code}/{staklo,udubljenje,okvir,oplata,thumbnail}.png`,
  `frame/*`, `glass/*`, `sideglass/*`, `colors/{id}.png`, `glasses/{id}.png`, `locks/{id}.png`,
  `systems/{id}.png`, `equipment/{cat}/{id}.png`, `houses/{id}.png`, `house-colors/{id}.png`.
  DB path columns hold these keys; served at `GET /storage/<key>`. See `STORAGE.md`.
- **Door compositing:** follows Laravel `DoorBuilder` exactly (RATIO=3.5, FRAME_WIDTH=22,
  Intervention anchor→top-left via `anchor.ts`). Match live Laravel output; validate with `validate.mjs`.
- **Errors:** fail loud in logs (`console.error`), return a clean JSON error to the client. Never
  silently skip a missing asset the way the old Laravel `addTransom` did — log it.
- **No secrets in code:** `JWT_SECRET` comes from env/`wrangler.jsonc` vars (dev) or a secret (prod).

## Data model (D1) — full Laravel catalog (schema generated by migrate/build.mjs)
- `doors`, `colors` (+`color_categories` +`color_category_translations`), `dmodels`/`dmodel_door`
- `equipment_systems`, `equipment_glasses`, `equipment_locks`, `equipment_others`
  (+`equipment_other_categories`) — each has a `*_translations` table
- `house_colors`, `houses`, `users` (Laravel columns incl. **`password`**), `markups` (has a `default` col)
- app-only: `inquiries`, `printed_contents`
- Asset paths in these tables are the CLEAN R2 keys (see below), rewritten during migration.

## Pricing (faithful Laravel PriceCalculator — src/price.ts)
`/api/calculate-price` is **auth-gated** — the price-visibility rule (no token → 401). Sections:
**model** (area×price), **system** (perimeter formula per door type), **color** (flat),
**equipment** (lock + others; hinges ×3/×4), **glass** (area×price per side/transom). Each section:
`base·(1−discount/100)·(1+adminMarkup/100)·(1+userMarkup/100)`, then `·(1+vat/100)`.
adminMarkup = admin's `default=1` markup (non-admins only); userMarkup = user's for `markupLabel`.

## API surface (keep this list current)
- `GET /` health · `GET /storage/*` — serve an R2 asset by key
- `POST /api/door/image` — full Laravel config (hyphenated keys) → composited PNG
- Catalog reads: `GET /api/default-items`, `/api/doors`, `/api/colors`, `/api/color-categories`,
  `/api/equipment-systems|glasses|locks`, `/api/equipment-others` (grouped), `/api/equipment-other-categories`,
  `/api/houses`, `/api/house-colors`
- `POST /api/calculate-price` — **(auth)** full config + vat/discount/markupLabel → `{ data: {...} }`
- `POST /api/login`, `GET /api/me`, `POST /api/password-update`
- `POST /api/submit-inquiry` (public); `POST /api/printed-contents` (auth) + `GET /api/user/printed-contents`, `GET /api/printed-contents/:id`
- **Admin (auth+admin):** `POST/PUT/DELETE /api/{entity}` (+ `PUT :id/image`) for each catalog entity;
  `POST /api/register`, `GET/DELETE /api/users`, `GET/POST/PUT/DELETE /api/markups`;
  `GET /api/admin/inquiries`, `GET /api/admin/printed-contents`

## Commands
- `npm run dev` — `wrangler dev` (local workerd + local D1/R2)
- `npm run db:local` — apply migrations + seed to local D1
- `npm run deploy` — `wrangler deploy`
- `npm test` — validate the Worker vs frozen Laravel fixtures (contract + render RMSE + smoke). See `tests/README.md`.
- `npm run test:capture` — re-freeze `tests/fixtures/` from live Laravel (only while the droplet exists).

## Testing (run after any BE change)
`tests/` checks the Worker against **Laravel's captured output** (the oracle): contract (endpoint
JSON *structure* must match), render parity (config matrix → PNG → pixel RMSE < 3%), and smoke
(status/auth/concurrent-burst). Fixtures in `tests/fixtures/` are committed — they're the only
ground truth once the droplet is gone. Every migration bug we hit maps to one of these suites.

## Golden rules
1. Full Laravel parity — same API contract, same rendered pixels; the FE stays unchanged.
2. Workers-safe — no native modules, no fs; PBKDF2 (new) / bcryptjs (migrated); photon for images.
3. Flat & explicit — small files, snake_case throughout, no premature abstraction.
4. Parameterized SQL, logged errors, JSON responses.
5. Keep THIS file updated when adding routes/tables/patterns.
