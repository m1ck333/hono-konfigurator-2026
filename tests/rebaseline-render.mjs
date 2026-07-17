// Re-baseline ONLY the render PNG fixtures to the current Worker output.
// Use this after an INTENTIONAL visual change to the renderer (metallic, glass, see-through, …):
// the render RMSE check then becomes a regression detector ("did anything change unexpectedly")
// instead of a now-obsolete pixel-parity-with-Laravel check. Leaves contract.json / prices.json
// (the Laravel oracle — structure + money) untouched; those must still hold.
//   node tests/rebaseline-render.mjs                    → from the deployed Worker (config.WORKER)
//   WORKER_URL=http://127.0.0.1:8787 node tests/rebaseline-render.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER, RENDER_CASES } from "./config.mjs";
import { postImage, c } from "./lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url)) + "/fixtures/render";
await mkdir(DIR, { recursive: true });

console.log(`Re-baselining render fixtures from ${c.dim(WORKER)}\n`);
let ok = 0;
for (const { name, cfg } of RENDER_CASES) {
  const { status, buf } = await postImage(`${WORKER}/api/door/image`, cfg);
  if (status !== 200 || !buf) { console.log(c.warn(`  skip ${name} (http ${status})`)); continue; }
  await writeFile(`${DIR}/${name}.png`, buf);
  ok++;
}
console.log(`\n${c.pass("✓")} re-baselined ${ok}/${RENDER_CASES.length} render fixtures`);
