// Data-integrity check: every asset path referenced by the catalog must resolve in R2.
// A 404 here = a broken image in the FE. Run against the Worker.  node tests/check-assets.mjs
import { WORKER } from "./config.mjs";
import { getJson, c } from "./lib.mjs";

// endpoint → function extracting [path,...] from its JSON
const SOURCES = [
  ["/api/doors", (d) => (d.doors || d).flatMap((x) => [x.thumbnail])],
  ["/api/colors", (d) => (d.colors || d).map((x) => x.thumbnail)],
  ["/api/equipment-systems", (d) => d.equipment_systems.map((x) => x.thumbnail)],
  ["/api/equipment-glasses", (d) => d.equipment_glasses.map((x) => x.thumbnail)],
  ["/api/equipment-locks", (d) => d.equipment_locks.map((x) => x.thumbnail)],
  ["/api/houses", (d) => d.houses.map((x) => x.image)],
  ["/api/house-colors", (d) => (d.colors || d).map((x) => x.thumbnail)],
  ["/api/equipment-others", (d) => Object.values(d.equipment_others).flatMap((g) => g.equipments.flatMap((e) => [e.image, e.inner_image]))],
];

const paths = new Set();
for (const [ep, extract] of SOURCES) {
  const { json } = await getJson(WORKER + ep);
  for (const p of extract(json)) if (p && typeof p === "string" && p.trim()) paths.add(p.replace(/^storage\//, ""));
}
const all = [...paths];
console.log(`Checking ${all.length} distinct catalog asset paths in R2…\n`);

const missing = [];
let done = 0;
const CONC = 16;
async function worker(queue) {
  for (const p of queue) {
    const r = await fetch(`${WORKER}/storage/${p}`, { method: "GET", headers: { "user-agent": "Mozilla/5.0" } });
    if (r.status !== 200) missing.push(`${p} (${r.status})`);
    if (++done % 50 === 0) process.stdout.write(c.dim(`${done}/${all.length}\r`));
  }
}
const chunks = Array.from({ length: CONC }, (_, i) => all.filter((_, j) => j % CONC === i));
await Promise.all(chunks.map(worker));

if (missing.length) {
  console.log(c.fail(`\n✗ ${missing.length} referenced assets MISSING from R2:`));
  for (const m of missing) console.log("  " + m);
  process.exit(1);
} else console.log(c.pass(`\n✓ all ${all.length} catalog assets resolve in R2`));
