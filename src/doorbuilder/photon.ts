import init, {
  PhotonImage,
  watermark,
  crop as _crop,
  resize as _resize,
  fliph,
  SamplingFilter,
} from "@silvia-odwyer/photon";
import wasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";
import { anchorToTopLeft, type Anchor } from "./anchor";

export { PhotonImage, fliph, SamplingFilter };
export type { Anchor };

// --- WASM memory arena ------------------------------------------------------
// Every PhotonImage holds WASM-linear memory that GC reclaims only between requests,
// so a single render's intermediates would otherwise pile up (and concurrent renders
// blow the 128MB isolate cap). We track every image created during a render and free
// them all once the final PNG bytes are extracted. Safe because the render endpoint
// serializes renders, so only one render populates the arena at a time.
let arena: PhotonImage[] = [];
const track = <T extends PhotonImage>(img: T): T => { arena.push(img); return img; };
export function freeArena() {
  for (const img of arena) { try { img.free(); } catch { /* already freed */ } }
  arena = [];
}

// tracked wrappers — all image creation funnels through these five primitives.
export const crop = (img: PhotonImage, x1: number, y1: number, x2: number, y2: number) =>
  track(_crop(img, x1, y1, x2, y2));
export const resize = (img: PhotonImage, w: number, h: number, f: SamplingFilter) =>
  track(_resize(img, w, h, f));

// photon WASM instantiates once per isolate.
let ready: Promise<unknown> | null = null;
export async function ensurePhoton() {
  if (!ready) ready = init(wasm);
  await ready;
}

export interface AssetLoader {
  get(key: string): Promise<Uint8Array | null>;
}

export const isHex = (c?: string | null) => !!c && c.startsWith("#");
const hexToRgb = (h: string) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

export const load = (bytes: Uint8Array) => track(PhotonImage.new_from_byteslice(bytes));

export function solid(w: number, h: number, r: number, g: number, b: number) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return track(new PhotonImage(px, w, h));
}

// fully transparent canvas (Intervention Image::canvas(w,h))
export function blank(w: number, h: number) {
  return track(new PhotonImage(new Uint8Array(w * h * 4), w, h));
}

export const wm = (base: PhotonImage, top: PhotonImage, x: number, y: number) =>
  watermark(base, top, BigInt(Math.round(x)), BigInt(Math.round(y)));

// insert with Intervention anchor semantics. Intervention CLIPS parts of src that fall off the
// canvas (e.g. a hinge placed at negative x hangs off the left edge); photon's watermark does
// not, so we crop src to its visible rectangle first.
export function insertAnchor(base: PhotonImage, src: PhotonImage, anchor: Anchor, offX = 0, offY = 0) {
  const dw = base.get_width(), dh = base.get_height();
  const sw = src.get_width(), sh = src.get_height();
  let { x, y } = anchorToTopLeft(anchor, dw, dh, sw, sh, offX, offY);
  let cx1 = 0, cy1 = 0, cx2 = sw, cy2 = sh;
  if (x < 0) { cx1 = -x; x = 0; }
  if (y < 0) { cy1 = -y; y = 0; }
  if (x + (cx2 - cx1) > dw) cx2 = cx1 + (dw - x);
  if (y + (cy2 - cy1) > dh) cy2 = cy1 + (dh - y);
  if (cx2 <= cx1 || cy2 <= cy1) return; // fully off-canvas
  const clipped = cx1 === 0 && cy1 === 0 && cx2 === sw && cy2 === sh ? src : crop(src, cx1, cy1, cx2, cy2);
  wm(base, clipped, x, y);
}

// ImageHelper::createColoredCanvasOrImage — hex fill OR texture resized to WxH
export async function coloredCanvas(color: string | null | undefined, w: number, h: number, assets: AssetLoader) {
  if (isHex(color)) {
    const { r, g, b } = hexToRgb(color as string);
    return solid(w, h, r, g, b);
  }
  if (color) {
    const bytes = await assets.get(color);
    if (bytes) return resize(load(bytes), w, h, SamplingFilter.Triangle);
  }
  return solid(w, h, 0x3f, 0x41, 0x45);
}

// Satin-metallic finish: scale every pixel's RGB by a single grayscale sheen texture (sheen/128),
// so highlights (>128) lighten and shadows (<128) darken while the R:G:B ratio — i.e. the exact
// picked colour/hue — is preserved. (A blend mode like soft-light is non-linear per channel and
// hue-shifts dark colours, e.g. anthracite→navy.) One reusable texture, tinted by the colour below.
export async function applyMetallic(base: PhotonImage, assets: AssetLoader): Promise<PhotonImage> {
  const bytes = await assets.get("fx/metallic-sheen.png");
  if (!bytes) return base;
  const w = base.get_width(), h = base.get_height();
  const sheen = resize(load(bytes), w, h, SamplingFilter.Triangle);
  const bp = base.get_raw_pixels();
  const sp = sheen.get_raw_pixels();
  for (let i = 0; i < bp.length; i += 4) {
    const f = sp[i] / 128; // sheen luminance → lightness factor (hue-preserving)
    const r = bp[i] * f, g = bp[i + 1] * f, b = bp[i + 2] * f;
    bp[i] = r > 255 ? 255 : r;
    bp[i + 1] = g > 255 ? 255 : g;
    bp[i + 2] = b > 255 ? 255 : b;
  }
  return track(new PhotonImage(bp, w, h));
}

// See-through privacy glass: composite a heavily-blurred backdrop scene BEHIND translucent
// frosted glass, so the pane reads as real glass with a room/garden behind it rather than a
// flat frosted panel. `glassTile` is the frost texture already sized to the pane — its alpha
// encodes the opening shape (full rectangle for side/transom, the cut-out silhouette for a leaf
// pane). `scene` is the blurred backdrop; we cover-fit it to the pane so each opening reveals its
// own slice. Result keeps the glass tile's exact alpha, RGB = frost*w + scene*(1-w). Lower w =
// more see-through. (Same hue-preserving per-pixel approach as applyMetallic.)
export function seeThroughGlass(glassTile: PhotonImage, scene: PhotonImage, frostWeight: number): PhotonImage {
  const w = glassTile.get_width(), h = glassTile.get_height();
  const bg = fitCover(scene, w, h);
  const gp = glassTile.get_raw_pixels();
  const bp = bg.get_raw_pixels();
  const out = new Uint8Array(gp.length);
  const kf = frostWeight, ks = 1 - frostWeight;
  for (let i = 0; i < gp.length; i += 4) {
    out[i] = gp[i] * kf + bp[i] * ks;
    out[i + 1] = gp[i + 1] * kf + bp[i + 1] * ks;
    out[i + 2] = gp[i + 2] * kf + bp[i + 2] * ks;
    out[i + 3] = gp[i + 3]; // keep frost/opening alpha so only the pane is placed
  }
  return track(new PhotonImage(out, w, h));
}

// crop the center WxH out of a larger image (Intervention insert 'center', clipped)
export function centerClip(img: PhotonImage, w: number, h: number) {
  const x = Math.trunc((img.get_width() - w) / 2);
  const y = Math.trunc((img.get_height() - h) / 2);
  return crop(img, x, y, x + w, y + h);
}

// "fit" cover-crop to exactly w x h (Intervention fit())
export function fitCover(img: PhotonImage, w: number, h: number) {
  const iw = img.get_width(), ih = img.get_height();
  const scale = Math.max(w / iw, h / ih);
  const rw = Math.max(1, Math.round(iw * scale)), rh = Math.max(1, Math.round(ih * scale));
  const resized = resize(img, rw, rh, SamplingFilter.Triangle);
  const x = Math.trunc((rw - w) / 2), y = Math.trunc((rh - h) / 2);
  return crop(resized, x, y, x + w, y + h);
}

// a frame element: color canvas with the frame texture composited (approximates fill())
export async function frameElement(texKey: string, w: number, h: number, frameColor: string | null | undefined, assets: AssetLoader) {
  const el = await coloredCanvas(frameColor ?? "#8a8f98", w, h, assets);
  const tex = await assets.get(texKey);
  if (tex) wm(el, resize(load(tex), w, h, SamplingFilter.Triangle), 0, 0);
  return el;
}
