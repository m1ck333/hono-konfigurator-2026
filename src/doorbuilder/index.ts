import init, {
  PhotonImage,
  watermark,
  crop,
  resize,
  fliph,
  SamplingFilter,
} from "@silvia-odwyer/photon";
import wasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";
import { anchorToTopLeft, type Anchor } from "./anchor";

// --- constants (DoorConstants.php) ---
const RATIO = 3.5;
const FRAME_WIDTH = 22;

let ready: Promise<unknown> | null = null;

// --- config (Laravel hyphenated keys — a subset the renderer needs) ---
export interface DoorConfig {
  "model-name": string; // asset folder, e.g. "1155"
  "panel-color"?: string | null; // hex "#3f4145" OR a texture path
  "frame-color"?: string | null;
  width: number; // mm (scaled by RATIO here)
  height: number;
  "DIN-opening-standard"?: string | null;
  type?: string;
  [k: string]: unknown;
}

// R2-backed asset loader; keys mirror Laravel storage paths under images/.
export interface AssetLoader {
  get(key: string): Promise<Uint8Array | null>;
}

// ---------- photon helpers ----------
const isHex = (c?: string | null) => !!c && c.startsWith("#");
const hexToRgb = (h: string) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});
const load = (bytes: Uint8Array) => PhotonImage.new_from_byteslice(bytes);
function solid(w: number, h: number, r: number, g: number, b: number) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return new PhotonImage(px, w, h);
}
const wm = (base: PhotonImage, top: PhotonImage, x: number, y: number) =>
  watermark(base, top, BigInt(Math.round(x)), BigInt(Math.round(y)));

// insert with Intervention anchor semantics
function insertAnchor(base: PhotonImage, src: PhotonImage, anchor: Anchor, offX = 0, offY = 0) {
  const { x, y } = anchorToTopLeft(anchor, base.get_width(), base.get_height(), src.get_width(), src.get_height(), offX, offY);
  wm(base, src, x, y);
}

// ImageHelper::createColoredCanvasOrImage — hex fill OR texture resized to WxH
async function coloredCanvas(color: string | null | undefined, w: number, h: number, assets: AssetLoader) {
  if (isHex(color)) {
    const { r, g, b } = hexToRgb(color as string);
    return solid(w, h, r, g, b);
  }
  if (color) {
    const bytes = await assets.get(color); // texture path
    if (bytes) return resize(load(bytes), w, h, SamplingFilter.Triangle);
  }
  return solid(w, h, 0x3f, 0x41, 0x45); // fallback neutral
}

// crop the center WxH out of a larger image (Intervention insert 'center', clipped)
function centerClip(img: PhotonImage, w: number, h: number) {
  const x = Math.trunc((img.get_width() - w) / 2);
  const y = Math.trunc((img.get_height() - h) / 2);
  return crop(img, x, y, x + w, y + h);
}

// a frame element: color canvas with the frame texture composited (approximates fill())
async function frameElement(texKey: string, w: number, h: number, frameColor: string | null | undefined, assets: AssetLoader) {
  const el = await coloredCanvas(frameColor ?? "#8a8f98", w, h, assets);
  const tex = await assets.get(texKey);
  if (tex) wm(el, resize(load(tex), w, h, SamplingFilter.Triangle), 0, 0);
  return el;
}

// ---------- main build ----------
export async function buildDoorImage(config: DoorConfig, assets: AssetLoader): Promise<Uint8Array> {
  if (!ready) ready = init(wasm);
  await ready;

  const model = config["model-name"];
  const W = Math.trunc(config.width / RATIO);
  const H = Math.trunc(config.height / RATIO);
  const panelColor = (config["panel-color"] as string) ?? "#3f4145";
  const frameColor = (config["frame-color"] as string) ?? "#8a8f98";
  const doorDir = `images/doors/${model}`;

  // Step 1: base door leaf ---------------------------------------------------
  const base = await coloredCanvas(panelColor, W, H, assets);

  // inner glass (default staklo.png if present)
  const staklo = await assets.get(`${doorDir}/staklo.png`);
  if (staklo) insertAnchor(base, centerClip(load(staklo), W, H), "top-left", 0, 0);

  // dent
  const dent = await assets.get(`${doorDir}/udubljenje.png`);
  if (dent) insertAnchor(base, centerClip(load(dent), W, H), "top-left", 0, 0);

  // glass frame (okvir) — centered manually (top-left with computed offset)
  const okvir = await assets.get(`${doorDir}/okvir.png`);
  if (okvir) {
    const o = load(okvir);
    const fx = Math.trunc((W - o.get_width()) / 2);
    const fy = Math.trunc((H - o.get_height()) / 2);
    wm(base, o, fx, fy);
  }
  // plating (oplata) — same centering
  const oplata = await assets.get(`${doorDir}/oplata.png`);
  if (oplata) {
    const p = load(oplata);
    const px = Math.trunc((W - p.get_width()) / 2);
    const py = Math.trunc((H - p.get_height()) / 2);
    wm(base, p, px, py);
  }

  // TODO Step 2: equipment overlays (doorknob/handrail/accessControl/rosette/parapet/spy)
  // TODO Step 3: DIN flip — if DIN ∈ {left-outside, right-inside} → fliph(base)
  // TODO Step 4: door type (side panels / transom / double door)

  // Step 5: frame (L / R / T sides + corners) --------------------------------
  const left = await frameElement("images/frame/side-L.png", FRAME_WIDTH, H, frameColor, assets);
  insertAnchor(base, left, "left", 0, 0);
  const right = await frameElement("images/frame/side-R.png", FRAME_WIDTH, H, frameColor, assets);
  insertAnchor(base, right, "right", 0, 0);
  const topTex = await assets.get("images/frame/side-LT.png");
  if (topTex) insertAnchor(base, resize(load(topTex), W, FRAME_WIDTH, SamplingFilter.Triangle), "top", 0, 0);
  const cornerL = await assets.get("images/frame/corner-L.png");
  if (cornerL) insertAnchor(base, load(cornerL), "top-left", 0, 0);
  const cornerR = await assets.get("images/frame/corner-R.png");
  if (cornerR) insertAnchor(base, load(cornerR), "top-right", 0, 0);

  // (DIN flip currently unused; will wrap the leaf before frame in Step 3)
  void fliph;

  return base.get_bytes();
}
