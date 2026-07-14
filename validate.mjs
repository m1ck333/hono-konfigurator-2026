import { unstable_dev } from "wrangler";
import sharp from "sharp";
import { writeFileSync } from "fs";

const config = {
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

// 1. Live Laravel reference
const refRes = await fetch("https://konfigurator-api.online/api/door/image", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config),
});
const refBuf = Buffer.from(await refRes.arrayBuffer());

// 2. Our BE in local workerd
const w = await unstable_dev("src/index.ts", {
  config: "wrangler.jsonc", local: true, persist: true,
  experimental: { disableExperimentalWarning: true },
});
const beRes = await w.fetch("http://l/api/door/image", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config),
});
const beBuf = Buffer.from(await beRes.arrayBuffer());
await w.stop();

console.log("laravel:", refRes.status, refBuf.length, "bytes | be:", beRes.status, beBuf.length, "bytes");
if (beRes.status !== 200) { console.log("BE error:", beBuf.toString("utf8").slice(0, 300)); process.exit(1); }

writeFileSync("ref.png", refBuf);
writeFileSync("be.png", beBuf);
const a = await sharp(beBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const b = await sharp(refBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
console.log("dims  be:", `${a.info.width}x${a.info.height}`, "ref:", `${b.info.width}x${b.info.height}`);
let diff = 0; const n = Math.min(a.data.length, b.data.length);
for (let i = 0; i < n; i++) diff += Math.abs(a.data[i] - b.data[i]);
const mean = diff / n;
console.log(`mean abs diff vs Laravel: ${mean.toFixed(2)} / 255  (${((mean / 255) * 100).toFixed(1)}%)`);

// side-by-side
await sharp({ create: { width: a.info.width * 2 + 20, height: a.info.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
  .composite([{ input: "be.png", left: 0, top: 0 }, { input: "ref.png", left: a.info.width + 20, top: 0 }])
  .png().toFile("validate-side-by-side.png");
