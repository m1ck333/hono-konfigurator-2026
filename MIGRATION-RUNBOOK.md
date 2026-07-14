# Migration runbook — Laravel/droplet → Hono/Cloudflare

End-to-end steps to take the configurator off the DigitalOcean droplet and onto Cloudflare,
with the **frontend unchanged**. Everything below is built and verified locally; this is the
prod execution. Needs a **Cloudflare account** (Workers Paid — the render is ~40ms CPU).

## 0. Prereqs
```bash
cd hono-konfigurator-be
npm install
npx wrangler login
```

## 1. Create D1 + R2
```bash
npx wrangler d1 create konfigurator          # paste the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create konfigurator-assets
```

## 2. Regenerate + apply the catalog (schema + seed) to REMOTE D1
The seed is generated from the local dump (kept out of git). If you don't have `migrate/data/`,
re-export it from the droplet first (see `migrate/build.mjs` header), then:
```bash
node migrate/build.mjs                        # -> migrate/out/{schema,seed,manifest}.sql/.tsv
cp migrate/out/schema.sql migrations/0001_catalog.sql
cp migrate/out/seed.sql   migrations/0002_catalog_seed.sql
for m in 0001_catalog 0002_catalog_seed 0003_app; do
  npx wrangler d1 execute konfigurator --remote --file="migrations/$m.sql"
done
```

## 3. Reorganize + upload assets to R2
On the **droplet** (has the files), resolve the messy paths into a clean tree:
```bash
scp migrate/out/manifest.tsv root@161.35.76.86:/tmp/manifest.tsv
ssh root@161.35.76.86 'bash -s' < migrate/reorg.sh      # -> /tmp/r2 (clean staging, ~49M)
```
Then upload `/tmp/r2` to R2 with **rclone** (S3-compatible; configure an `r2` remote with your
R2 Access Key + Secret + account endpoint):
```bash
# on the droplet, or pull /tmp/r2 down first
rclone copy /tmp/r2 r2:konfigurator-assets --transfers 32 --checkers 32 -P
```
(The ~115 "missing" files reported by reorg.sh are bad-data codes / deleted images — expected.)

## 4. Secrets + deploy
```bash
npx wrangler secret put JWT_SECRET            # a strong random value (NOT the dev default)
# optional: inquiry email
npx wrangler secret put RESEND_API_KEY
# set INQUIRY_FROM / INQUIRY_TO in wrangler.jsonc vars
npx wrangler deploy
```

## 5. Domain + FE cutover
- Add a **custom domain / route** to the Worker in the dashboard (e.g. `konfigurator-api.online`,
  or a new subdomain).
- Point the FE: set `REACT_APP_API_URL` to the Worker URL (App Platform env var) and redeploy the
  FE — **no code changes** (the API contract is identical).

## 6. Verify (prod)
- `GET /api/default-items`, `GET /api/doors` return the catalog.
- `POST /api/door/image` renders (spot-check a few models vs the old Laravel output).
- Login with an existing account (bcrypt hashes migrated); price shows for logged-in users.
- Admin CRUD works; images serve from `GET /storage/...`.

## 7. Rollback
Keep the droplet + Laravel running until confident. To roll back: point the FE
`REACT_APP_API_URL` back to `https://konfigurator-api.online` (Laravel). Instant.

## Notes
- Users log in with existing passwords (bcrypt via bcryptjs); no reset needed.
- Side-panel door types are ported but couldn't be diff-validated (Laravel 500s on those configs) —
  spot-check them in prod against the old renderer before fully trusting.
- Once stable, decommission the droplet → cost savings.
