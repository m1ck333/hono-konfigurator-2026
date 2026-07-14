# Migration runbook — Laravel/droplet → Hono/Cloudflare

End-to-end steps to take the configurator off the DigitalOcean droplet and onto Cloudflare,
with the **frontend unchanged**. Everything below is built and verified locally; this is the
prod execution.

## Account is already set up (from the jamogu.rs migration)
- **Workers Paid + R2 are already active on this CF account — per-account, so nothing to
  subscribe/pay again.** (Render is ~40ms CPU; bundle is well under limits regardless.)
- A **Workers/D1/R2 API token** exists at `~/.jamogu-cf-token`. It CAN: deploy, create/manage
  D1 + R2, attach the Worker as a custom domain, read analytics. It CANNOT: edit raw DNS, purge
  cache, toggle DNSSEC (do those in the dashboard). Use it via `CLOUDFLARE_API_TOKEN=$(cat ~/.jamogu-cf-token)`.
- Hono runs **natively** on Workers — the Next.js/Prisma/OpenNext gotchas (Prisma adapter,
  per-request D1 client, webpack chunks) do NOT apply here. Reference: `~/Projects/CLOUDFLARE_MIGRATION_GUIDE.md`.
- Our D1 dates are TEXT in one consistent format and we use raw D1 SQL (no Prisma), so the
  "inconsistent column data" date gotcha does not apply.
- No GitHub-Actions/cron writes to the DB — all writes go through the Worker (admin CRUD). So the
  "D1 unreachable from CI" trap does not apply either.

## 0. Prereqs
```bash
cd hono-konfigurator-be
npm install
export CLOUDFLARE_API_TOKEN=$(cat ~/.jamogu-cf-token)   # or: npx wrangler login
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

## 5. FE cutover (NO DNS zone move needed)
Unlike jamogu (where the app *served* the domain), our FE just reads an API base URL — so we can
skip the entire DNS-cutover dance:
- The Worker gets a free `https://konfigurator-be.<your-subdomain>.workers.dev` URL on deploy.
- Point the FE at it: set `REACT_APP_API_URL` to that Worker URL (DigitalOcean App Platform env
  var) and redeploy the FE — **no FE code changes**, the API contract is identical.
- The Laravel droplet + `konfigurator-api.online` stay untouched → instant rollback.
- **Optional, later:** attach a custom domain (e.g. `konfigurator-api.online`) to the Worker. That
  needs the zone on Cloudflare (move nameservers — see the DNS-cutover section of the CF guide) and
  is a separate, non-urgent step. Not required for the cutover.

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
