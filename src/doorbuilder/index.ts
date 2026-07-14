import {
  ensurePhoton,
  coloredCanvas,
  load,
  centerClip,
  insertAnchor,
  frameElement,
  resize,
  SamplingFilter,
  fliph,
  wm,
  type AssetLoader,
  type PhotonImage,
} from "./photon";
import { customizeType } from "./types";

export const RATIO = 3.5;
export const FRAME_WIDTH = 22;

export interface DoorConfig {
  "model-name": string;
  "panel-color"?: string | null;
  "frame-color"?: string | null;
  width: number;
  height: number;
  halfPanelWidth: number;
  leftSideWidth?: number;
  rightSideWidth?: number;
  upperGlassHeight?: number;
  "DIN-opening-standard"?: string | null;
  type?: string;
  "left-side-glass-number"?: number;
  "right-side-glass-number"?: number;
  interiorDoorShown?: boolean;
  has_glass?: number; // filled by the render endpoint from the doors table
  [k: string]: unknown;
}

export type { AssetLoader };

// Build one door leaf (BaseDoorCreator): panel color + glass + dent + okvir + oplata.
// isHalfPanel → secondary leaf of a double door (uses halfPanelWidth + flips overlays).
export async function buildLeaf(
  config: DoorConfig,
  assets: AssetLoader,
  isHalfPanel = false
): Promise<PhotonImage> {
  const model = config["model-name"];
  const width = Math.trunc((isHalfPanel ? config.halfPanelWidth : config.width) / RATIO);
  const H = Math.trunc(config.height / RATIO);
  const panelColor = (config["panel-color"] as string) ?? "#3f4145";
  const doorDir = `doors/${model}`;

  const base = await coloredCanvas(panelColor, width, H, assets);

  const compose = async (key: string, mode: "center" | "manual"): Promise<boolean> => {
    const bytes = await assets.get(key);
    if (!bytes) return false;
    const img = load(bytes);
    if (isHalfPanel) fliph(img);
    if (mode === "center") {
      insertAnchor(base, centerClip(img, width, H), "top-left", 0, 0);
    } else {
      const fx = Math.trunc((width - img.get_width()) / 2);
      const fy = Math.trunc((H - img.get_height()) / 2);
      wm(base, img, fx, fy);
    }
    return true;
  };

  // inner glass (only if the model has glass): default staklo.png, else sandblast.png
  if (config.has_glass) {
    if (!(await compose(`${doorDir}/staklo.png`, "center"))) {
      await compose(`${doorDir}/sandblast.png`, "center");
    }
  }
  await compose(`${doorDir}/udubljenje.png`, "center"); // dent
  await compose(`${doorDir}/okvir.png`, "manual"); // glass frame
  await compose(`${doorDir}/oplata.png`, "manual"); // plating
  return base;
}

// FrameElementCreator: L/R/T sides + corners onto the (possibly grown) assembly.
export async function applyFrame(assembly: PhotonImage, config: DoorConfig, assets: AssetLoader) {
  const frameColor = (config["frame-color"] as string) ?? "#8a8f98";
  const W = assembly.get_width();
  const H = assembly.get_height();

  const left = await frameElement("frame/side-L.png", FRAME_WIDTH, H, frameColor, assets);
  insertAnchor(assembly, left, "left", 0, 0);
  const right = await frameElement("frame/side-R.png", FRAME_WIDTH, H, frameColor, assets);
  insertAnchor(assembly, right, "right", 0, 0);
  const topTex = await assets.get("frame/side-LT.png");
  if (topTex) insertAnchor(assembly, resize(load(topTex), W, FRAME_WIDTH, SamplingFilter.Triangle), "top", 0, 0);
  const cornerL = await assets.get("frame/corner-L.png");
  if (cornerL) insertAnchor(assembly, load(cornerL), "top-left", 0, 0);
  const cornerR = await assets.get("frame/corner-R.png");
  if (cornerR) insertAnchor(assembly, load(cornerR), "top-right", 0, 0);
}

export async function buildDoorImage(config: DoorConfig, assets: AssetLoader): Promise<Uint8Array> {
  await ensurePhoton();

  // Step 1-2: leaf (+ equipment TODO)
  const leaf = await buildLeaf(config, assets, false);

  // Step 3: DIN flip
  const din = config["DIN-opening-standard"];
  if (din === "left-outside" || din === "right-inside") fliph(leaf);

  // Step 4: door type (side panels / transom / double door)
  const assembly = await customizeType(leaf, config, assets, buildLeaf);

  // Step 5: frame
  await applyFrame(assembly, config, assets);

  return assembly.get_bytes();
}
