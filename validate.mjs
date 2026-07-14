import { unstable_dev } from "wrangler";
import sharp from "sharp";
import { writeFileSync } from "fs";

const LARAVEL = "https://konfigurator-api.online/api/door/image";

const baseConfig = {
  "model-id": 2, "model-name": "1155",
  "panel-color": "#3f4145", "frame-color": "#8a8f98",
  width: 1050, height: 2100, halfPanelWidth: 1050,
  leftSideWidth: 500, rightSideWidth: 500, upperGlassHeight: 500,
  type: "single-leaf-door", "DIN-opening-standard": "left-inside",
  "inner-glass-id": null, "left-side-glass-number": 1, "right-side-glass-number": 1,
  interiorDoorShown: false,
  equipment: {
    handrail: { id: null }, doorknobInside: { id: null }, rosette: { id: null },
    parapetProtection: { id: null }, accessControl: { id: null }, spy: { id: null },
    cylinder: { id: null }, hinges: { id: null }, electromagneticReceiver: { id: null },
    automaticClosingDevice: { id: null }, houseNumbers: { id: null }, lock: { id: null },
  },
};

// each case = overrides merged onto baseConfig
const CASES = [
  { name: "single-leaf left-inside", cfg: {} },
  { name: "door 1150 (sandblast glass fallback)", cfg: { "model-id": 1, "model-name": "1150" } },
  { name: "single-leaf left-outside (DIN flip)", cfg: { "DIN-opening-standard": "left-outside" } },
  { name: "single-leaf right-inside (DIN flip)", cfg: { "DIN-opening-standard": "right-inside" } },
  { name: "double-leaf-door", cfg: { type: "double-leaf-door" } },
  { name: "left-side-panel", cfg: { type: "single-leaf-door-left-side-panel", "side-glass-name": "default" } },
  { name: "right-side-panel", cfg: { type: "single-leaf-door-right-side-panel", "side-glass-name": "default" } },
  { name: "both-side-panels", cfg: { type: "single-leaf-door-both-side-panels", "side-glass-name": "default" } },
  { name: "transom (no glass -> no transom)", cfg: { type: "single-leaf-door-transom" } },
];

async function diff(beBuf, refBuf) {
  const a = await sharp(beBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(refBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height)
    return { pct: 100, note: `DIM be ${a.info.width}x${a.info.height} vs ref ${b.info.width}x${b.info.height}` };
  let d = 0; const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i++) d += Math.abs(a.data[i] - b.data[i]);
  return { pct: (d / n / 255) * 100, note: "" };
}

const w = await unstable_dev("src/index.ts", {
  config: "wrangler.jsonc", local: true, persist: true,
  experimental: { disableExperimentalWarning: true },
});
try {
  for (const cs of CASES) {
    const config = { ...baseConfig, ...cs.cfg };
    const [ref, be] = await Promise.all([
      fetch(LARAVEL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) }),
      w.fetch("http://l/api/door/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) }),
    ]);
    const refBuf = Buffer.from(await ref.arrayBuffer());
    const beBuf = Buffer.from(await be.arrayBuffer());
    if (be.status !== 200) { console.log(`❌ ${cs.name}: BE ${be.status} ${beBuf.toString("utf8").slice(0, 120)}`); continue; }
    if (ref.status !== 200) { console.log(`⚠️  ${cs.name}: Laravel ${ref.status} (skip)`); continue; }
    const { pct, note } = await diff(beBuf, refBuf);
    const mark = pct < 2 ? "✅" : "❌";
    console.log(`${mark} ${cs.name}: ${pct.toFixed(1)}% ${note}`);
    if (pct >= 2) { writeFileSync(`fail-${cs.name.replace(/\W+/g, "-")}-be.png`, beBuf); writeFileSync(`fail-${cs.name.replace(/\W+/g, "-")}-ref.png`, refBuf); }
  }
} finally {
  await w.stop();
}
