// One-off diagnostic: render EVERY door (default single-leaf config) on both the Worker and
// Laravel and pixel-diff them. Surfaces door-specific data problems (missing textures, wrong
// has_glass) that the sampled matrix can't. Run while the droplet is alive.
//   node tests/sweep-doors.mjs
import { LARAVEL, WORKER, baseConfig, RMSE_THRESHOLD } from "./config.mjs";
import { getJson, postImage, imageRmse, c } from "./lib.mjs";

const { json: doors } = await getJson(`${WORKER}/api/doors`);
const list = (doors.doors || doors).filter((d) => d.is_shown !== 0);
console.log(`Sweeping ${list.length} doors (Worker vs Laravel)…\n`);

const bad = [];
let worst = 0;
for (const d of list) {
  const cfg = baseConfig({ "model-id": d.id, "model-name": d.model_code, type: "single-leaf-door" });
  const [W, L] = await Promise.all([
    postImage(`${WORKER}/api/door/image`, cfg),
    postImage(`${LARAVEL}/api/door/image`, cfg),
  ]);
  if (W.status !== 200 || L.status !== 200) { bad.push(`${d.model_code}: http W=${W.status} L=${L.status}`); process.stdout.write(c.fail("!")); continue; }
  const r = await imageRmse(L.buf, W.buf);
  if (r.dimMismatch) { bad.push(`${d.model_code}: DIMS W=${r.b} L=${r.a}`); process.stdout.write(c.fail("D")); continue; }
  worst = Math.max(worst, r.rmse);
  if (r.rmse > RMSE_THRESHOLD) { bad.push(`${d.model_code} (id ${d.id}): ${(r.rmse * 100).toFixed(2)}%`); process.stdout.write(c.fail("✗")); }
  else process.stdout.write(c.pass("."));
}
console.log(`\n\nworst-in-tolerance: ${(worst * 100).toFixed(2)}%  |  threshold ${RMSE_THRESHOLD * 100}%`);
if (bad.length) { console.log(c.fail(`\n${bad.length} doors diverge:`)); for (const b of bad) console.log("  " + b); }
else console.log(c.pass(`\n✓ all ${list.length} doors within tolerance`));
