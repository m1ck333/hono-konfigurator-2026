# Hono Konfigurator BE

Cloudflare Workers backend for the Algreen door configurator (**Model B**: finished door
images + equipment overlays). Hono · D1 · R2 · photon (WASM render) · JWT/PBKDF2.

See `CLAUDE.md` for the project rules and API surface.

## Local dev
```bash
npm install

# create + seed local D1 and R2
npm run db:local                                   # runs migrations 0001+0002
npx wrangler d1 execute konfigurator --local --file=migrations/0003_pricing_offers.sql
npx wrangler r2 object put konfigurator-assets/models/1.png --local --file=assets/model1.png
npx wrangler r2 object put konfigurator-assets/equipment/1.png --local --file=assets/handle.png

npm run dev            # wrangler dev — local workerd on :8787
node be-test.mjs       # smoke-test every endpoint in local workerd
```
Seeded admin username: **Admin** (local dev seed). Password comes from the Laravel migration — keep it in your password manager, and set `ADMIN_TEST_PASSWORD` (optionally `ADMIN_TEST_USER`) for `admin-test.mjs`. Never commit a real password.

## Deploy to Cloudflare (needs an account)
```bash
npx wrangler login

# 1. Create the D1 database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create konfigurator

# 2. Create the R2 bucket
npx wrangler r2 bucket create konfigurator-assets

# 3. Apply migrations to the REMOTE D1
npx wrangler d1 execute konfigurator --remote --file=migrations/0001_init.sql
npx wrangler d1 execute konfigurator --remote --file=migrations/0002_seed.sql
npx wrangler d1 execute konfigurator --remote --file=migrations/0003_pricing_offers.sql

# 4. Upload assets to REMOTE R2
npx wrangler r2 object put konfigurator-assets/models/1.png --file=assets/model1.png
npx wrangler r2 object put konfigurator-assets/equipment/1.png --file=assets/handle.png

# 5. Set the JWT secret (do NOT keep the dev value in prod)
npx wrangler secret put JWT_SECRET

# 6. Deploy
npx wrangler deploy
```
Then add a **custom domain / route** in the Cloudflare dashboard (e.g. `konfigurator-api.online`),
and point the frontend's `REACT_APP_API_URL` at it.

> Requires **Workers Paid** ($5/mo) — the door render is ~40ms CPU, over the free 10ms cap.

## Env vars (wrangler.jsonc `vars` / secrets)
- `JWT_SECRET` (secret) — token signing.
- `ALLOWED_ORIGIN` — CORS origin for the FE (default `*`).
- `RESEND_API_KEY` (secret), `INQUIRY_FROM`, `INQUIRY_TO` — enable inquiry emails (Resend).
  If unset, inquiries are still stored in D1; email is just skipped.

## Notes / TODO
- Inquiry email is wired (Resend, best-effort, fire-and-forget) — set the 3 vars above to enable.
- Passwords use PBKDF2 (not bcrypt) — migrated users need a password reset.
- Equipment `anchor_x/anchor_y` (0..1 fractions) position overlays; set per item in admin.
- Full-compositing parity port (all Laravel door types/color/glass) is feasible (see the POC)
  but intentionally NOT built — product is moving to Model B, so it'd be throwaway.
