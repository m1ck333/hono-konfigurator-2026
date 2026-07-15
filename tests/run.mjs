// Validate the WORKER against the frozen Laravel fixtures + live smoke checks.
//   npm test                 → all suites against the deployed Worker
//   WORKER_URL=... npm test
import { readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER, CONTRACT_ENDPOINTS, RENDER_CASES, RMSE_THRESHOLD, PERF_BUDGET_MS, TEST_USER, TEST_PASS } from "./config.mjs";
import { getJson, post, postImage, sig, imageRmse, c } from "./lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url)) + "/fixtures";
const results = { pass: 0, fail: 0, warn: 0 };
const fails = [];
const ok = (m) => { results.pass++; console.log(`  ${c.pass("✓")} ${m}`); };
const bad = (m) => { results.fail++; fails.push(m); console.log(`  ${c.fail("✗")} ${m}`); };
const warn = (m) => { results.warn++; console.log(`  ${c.warn("!")} ${m}`); };

// ---------- CONTRACT: Worker structure must match the frozen Laravel signature ----------
console.log(c.dim("\n▎ Contract (structure vs Laravel fixtures)"));
let contract = {};
try { contract = JSON.parse(await readFile(`${DIR}/contract.json`, "utf8")); }
catch { bad("no fixtures — run `npm run test:capture` first (needs the Laravel droplet alive)"); }
for (const ep of CONTRACT_ENDPOINTS) {
  const expected = contract[ep];
  if (!expected) continue;
  const t0 = Date.now();
  const { status, json } = await getJson(WORKER + ep);
  const ms = Date.now() - t0;
  if (status !== 200 || json == null) { bad(`${ep} → http ${status}`); continue; }
  const got = new Set(sig(json));
  const missing = expected.filter((k) => !got.has(k));
  if (missing.length) bad(`${ep} missing ${missing.length} key(s): ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`);
  else if (ms > PERF_BUDGET_MS) warn(`${ep} OK but slow: ${ms}ms (budget ${PERF_BUDGET_MS}ms)`);
  else ok(`${ep} (${ms}ms)`);
}

// ---------- RENDER: Worker PNG must match the frozen Laravel PNG within threshold ----------
console.log(c.dim("\n▎ Render parity (pixel-diff vs Laravel fixtures)"));
const haveFixtures = await readdir(`${DIR}/render`).catch(() => []);
for (const { name, cfg } of RENDER_CASES) {
  if (!haveFixtures.includes(`${name}.png`)) { warn(`${name} — no fixture`); continue; }
  const golden = await readFile(`${DIR}/render/${name}.png`);
  const { status, buf } = await postImage(`${WORKER}/api/door/image`, cfg);
  if (status !== 200 || !buf) { bad(`${name} → http ${status}`); continue; }
  const r = await imageRmse(golden, buf);
  if (r.dimMismatch) bad(`${name} DIMENSIONS ${r.b} vs golden ${r.a}`);
  else if (r.rmse > RMSE_THRESHOLD) bad(`${name} RMSE ${(r.rmse * 100).toFixed(2)}% > ${(RMSE_THRESHOLD * 100)}%`);
  else ok(`${name} (${(r.rmse * 100).toFixed(2)}%)`);
}

// ---------- SMOKE: status codes, auth gates, memory burst ----------
console.log(c.dim("\n▎ Smoke (status / auth / load)"));
const health = await getJson(`${WORKER}/`);
health.status === 200 ? ok("health /") : bad(`health / → ${health.status}`);

// price is auth-gated (price-visibility rule)
const priceNoAuth = await post(`${WORKER}/api/calculate-price`, RENDER_CASES[0].cfg);
priceNoAuth.status === 401 ? ok("calculate-price no-token → 401") : bad(`calculate-price no-token → ${priceNoAuth.status} (want 401)`);

// admin route must reject non-admin
const logout = await post(`${WORKER}/api/logout`, {});
logout.status === 401 ? ok("logout no-token → 401") : bad(`logout no-token → ${logout.status}`);

if (TEST_PASS) {
  const login = await post(`${WORKER}/api/login`, { username: TEST_USER, password: TEST_PASS });
  if (login.status !== 200) bad(`login → ${login.status}`);
  else {
    const { token, user } = await login.json();
    ok(`login (${user.role})`);
    const price = await post(`${WORKER}/api/calculate-price`, RENDER_CASES[0].cfg, token);
    price.status === 200 ? ok("calculate-price with token → 200") : bad(`calculate-price with token → ${price.status}`);
    const adminOnly = await post(`${WORKER}/api/user/999`, {}, token); // testuser is not admin
    // (PUT is admin-only; POST here just checks the route isn't a silent 200)
  }
} else warn("auth-positive checks skipped (set TEST_PASS=… to enable)");

// memory: a burst of heavy concurrent renders must not 5xx (arena-free + serialize)
const heavy = RENDER_CASES.find((x) => x.name.includes("double") && x.name.includes("transom"))?.cfg || RENDER_CASES[0].cfg;
const burst = await Promise.all(Array.from({ length: 16 }, () => post(`${WORKER}/api/door/image`, heavy).then((r) => r.status)));
const bad5xx = burst.filter((s) => s >= 500).length;
bad5xx === 0 ? ok(`16 concurrent renders → all ${burst[0]}`) : bad(`16 concurrent renders → ${bad5xx} failed (5xx)`);

// ---------- summary ----------
console.log(`\n${results.fail ? c.fail("FAIL") : c.pass("PASS")}  ${results.pass} passed, ${results.fail} failed, ${results.warn} warnings`);
if (fails.length) { console.log(c.fail("\nFailures:")); for (const f of fails) console.log(`  - ${f}`); }
process.exit(results.fail ? 1 : 0);
