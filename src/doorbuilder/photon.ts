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

export { PhotonImage, crop, resize, fliph, SamplingFilter };
export type { Anchor };

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

export const load = (bytes: Uint8Array) => PhotonImage.new_from_byteslice(bytes);

export function solid(w: number, h: number, r: number, g: number, b: number) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return new PhotonImage(px, w, h);
}

// fully transparent canvas (Intervention Image::canvas(w,h))
export function blank(w: number, h: number) {
  return new PhotonImage(new Uint8Array(w * h * 4), w, h);
}

export const wm = (base: PhotonImage, top: PhotonImage, x: number, y: number) =>
  watermark(base, top, BigInt(Math.round(x)), BigInt(Math.round(y)));

// insert with Intervention anchor semantics
export function insertAnchor(base: PhotonImage, src: PhotonImage, anchor: Anchor, offX = 0, offY = 0) {
  const { x, y } = anchorToTopLeft(anchor, base.get_width(), base.get_height(), src.get_width(), src.get_height(), offX, offY);
  wm(base, src, x, y);
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
