# Tests

Validates the Hono Worker against the **live Laravel backend** as a source of truth. Three suites,
one command, no framework.

```bash
npm test                       # run all suites against the deployed Worker
WORKER_URL=http://… npm test   # …against a different target (e.g. a local `wrangler dev`)
TEST_PASS=… npm test           # also run the auth-positive checks (login + priced calc)
```

## The suites

| Suite | Guards against | How |
|---|---|---|
| **Contract** | empty sidebars, missing endpoints/fields, wrong shapes, N+1 slowness | GET each endpoint → its JSON **structure** (key-paths, not values) must match the frozen Laravel signature, within a per-request time budget |
| **Render parity** | missing transom, wrong frame color, misplaced corner/pillar, unrendered equipment, wrong glass | POST a matrix of configs → PNG → pixel **RMSE** vs the frozen Laravel PNG must stay under `RMSE_THRESHOLD` (3%) |
| **Smoke** | 500s, price leaking to logged-out users, broken login, memory-limit 503s | status codes, auth gates (401/403), 16-way concurrent render burst |

Every bug found during the migration maps to one of these rows.

## Fixtures = the frozen oracle

`tests/fixtures/` holds Laravel's captured outputs (contract signatures + 26 render PNGs). They are
**committed** — once the DigitalOcean droplet is gone, this is the only remaining ground truth.

Re-capture only while the Laravel droplet is still alive:

```bash
npm run test:capture           # overwrites tests/fixtures/ from Laravel
```

## Config

`tests/config.mjs` — targets, the render matrix, the endpoint list, and thresholds. The render
matrix covers every door type, DIN variant, 3 models, interior view, all 6 equipment overlays,
and the in-door glass textures. Equipment ids in the matrix are a snapshot; `capture` freezes them.

## Notes

- Cosmetic frosted-glass texture nuance sits ~2% RMSE; the 3% threshold passes those and still
  catches structural regressions (the missing-transom bug was ~7%).
- `default-glass` is intentionally skipped in capture (Laravel returns the SPA HTML for it).
