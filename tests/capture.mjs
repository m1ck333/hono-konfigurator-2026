// Capture golden fixtures from the LARAVEL oracle. Run this WHILE the droplet is alive
// (once); the Worker is then validated against these frozen files forever.
//   node tests/capture.mjs            → capture from Laravel (default)
//   SOURCE_URL=... node tests/capture.mjs
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LARAVEL, CONTRACT_ENDPOINTS, RENDER_CASES } from "./config.mjs";
import { getJson, postImage, sig, c } from "./lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url)) + "/fixtures";
const SOURCE = process.env.SOURCE_URL || LARAVEL;

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR + "/render", { recursive: true });

console.log(`Capturing fixtures from ${c.dim(SOURCE)}\n`);

// --- contract: freeze each endpoint's structure signature ---
const contract = {};
for (const ep of CONTRACT_ENDPOINTS) {
  const { status, json } = await getJson(SOURCE + ep);
  if (status !== 200 || json == null) { console.log(c.warn(`  skip ${ep} (http ${status})`)); continue; }
  contract[ep] = sig(json);
  console.log(`  contract ${ep} (${contract[ep].length} keys)`);
}
await writeFile(`${DIR}/contract.json`, JSON.stringify(contract, null, 2));

// --- render: freeze each config's PNG ---
let ok = 0;
for (const { name, cfg } of RENDER_CASES) {
  const { status, buf } = await postImage(`${SOURCE}/api/door/image`, cfg);
  if (status !== 200 || !buf) { console.log(c.warn(`  skip render ${name} (http ${status})`)); continue; }
  await writeFile(`${DIR}/render/${name}.png`, buf);
  ok++;
}
console.log(`  render: ${ok}/${RENDER_CASES.length} PNGs captured`);

await writeFile(`${DIR}/meta.json`, JSON.stringify({ source: SOURCE, capturedAt: new Date().toISOString(), cases: RENDER_CASES.length }, null, 2));
console.log(`\n${c.pass("✓")} fixtures written to tests/fixtures/`);
