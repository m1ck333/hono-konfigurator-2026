import {
  coloredCanvas,
  load,
  frameElement,
  fitCover,
  insertAnchor,
  blank,
  wm,
  fliph,
  type AssetLoader,
  type PhotonImage,
  type Anchor,
} from "./photon";
import type { DoorConfig } from "./index";

const RATIO = 3.5;
const FRAME_WIDTH = 22;
const scale = (v: number) => Math.trunc(v / RATIO);

type BuildLeaf = (config: DoorConfig, assets: AssetLoader, isHalfPanel: boolean) => Promise<PhotonImage>;

// DinOpeningStandard::needsToFlip — swaps main/secondary leaf in a double door.
function needsToFlip(config: DoorConfig): boolean {
  const din = config["DIN-opening-standard"];
  const exterior = !config.interiorDoorShown;
  const outsideSet = din === "left-outside" || din === "right-inside";
  const insideSet = din === "left-inside" || din === "right-outside";
  return (exterior && outsideSet) || (!exterior && insideSet);
}

// DoorTypeCustomizer::customize — dispatch order: double -> side panels -> transom.
export async function customizeType(
  leaf: PhotonImage,
  config: DoorConfig,
  assets: AssetLoader,
  buildLeaf: BuildLeaf
): Promise<PhotonImage> {
  const type = config.type ?? "single-leaf-door";
  let img = leaf;

  if (type.startsWith("double-leaf-door")) {
    img = await createDoubleDoor(leaf, config, assets, buildLeaf);
  }
  if (type.includes("both-side-panels")) img = await addSideGlassPanels(img, config, assets, "both");
  else if (type.includes("left-side-panel")) img = await addSideGlassPanels(img, config, assets, "left");
  else if (type.includes("right-side-panel")) img = await addSideGlassPanels(img, config, assets, "right");
  if (type.includes("transom")) img = await addTransom(img, config, assets);

  return img;
}

// ---- double door ----
async function createDoubleDoor(mainDoor: PhotonImage, config: DoorConfig, assets: AssetLoader, buildLeaf: BuildLeaf): Promise<PhotonImage> {
  const panelColor = (config["panel-color"] as string) ?? "#3f4145";
  const frameColor = (config["frame-color"] as string) ?? "#8a8f98";
  const secondaryWidth = scale(config.halfPanelWidth);
  const rightWidth = scale(config.width);
  const doorHeight = mainDoor.get_height();

  const secondary = await buildLeaf(config, assets, true);
  const pillar = await frameElement("images/frame/pillar-V.png", FRAME_WIDTH, doorHeight, frameColor, assets);
  const totalWidth = rightWidth + secondaryWidth + FRAME_WIDTH;
  const canvas = await coloredCanvas(panelColor, totalWidth, doorHeight, assets);

  if (needsToFlip(config)) {
    insertAnchor(canvas, mainDoor, "left", 15, 0);
    insertAnchor(canvas, secondary, "left", rightWidth + FRAME_WIDTH - 15, 0);
    insertAnchor(canvas, pillar, "left", rightWidth, 0);
  } else {
    insertAnchor(canvas, secondary, "left", 15, 0);
    insertAnchor(canvas, mainDoor, "left", secondaryWidth + FRAME_WIDTH - 15, 0);
    insertAnchor(canvas, pillar, "left", secondaryWidth, 0);
  }
  return canvas;
}

// ---- side glass panels ----
async function addSideGlassPanels(image: PhotonImage, config: DoorConfig, assets: AssetLoader, side: "left" | "right" | "both"): Promise<PhotonImage> {
  const frameColor = (config["frame-color"] as string) ?? "#8a8f98";
  const interior = !!config.interiorDoorShown;
  const numLeft = side === "left" || side === "both" ? (config["left-side-glass-number"] ?? 1) : 0;
  const numRight = side === "right" || side === "both" ? (config["right-side-glass-number"] ?? 1) : 0;
  const leftGW = scale(config.leftSideWidth ?? 150 * RATIO);
  const rightGW = scale(config.rightSideWidth ?? 150 * RATIO);

  const sideGlassBytes = (await assets.get("images/glass/sandblast.png")) ?? null;
  if (!sideGlassBytes) return image;
  const sideGlass = () => load(sideGlassBytes);
  const glassHeight = image.get_height() - FRAME_WIDTH;

  const addPanels =
    (side === "left" || side === "both" ? leftGW * numLeft : 0) +
    (side === "right" || side === "both" ? rightGW * numRight : 0);
  const newWidth = image.get_width() + addPanels;
  const transparent = blank(newWidth, image.get_height());

  let originalImageX = 0;
  if (interior && (side === "right" || side === "both")) originalImageX = rightGW * numRight;
  if (!interior && (side === "left" || side === "both")) originalImageX = leftGW * numLeft;
  wm(transparent, image, originalImageX, 0);

  if (side === "left" || side === "both") {
    const posSide: "left" | "right" = interior ? "right" : "left";
    await insertGlassPanelWithPillars(transparent, sideGlass, leftGW, glassHeight, frameColor, numLeft, posSide, assets);
  }
  if (side === "right" || side === "both") {
    const posSide: "left" | "right" = interior ? "left" : "right";
    await insertGlassPanelWithPillars(transparent, sideGlass, rightGW, glassHeight, frameColor, numRight, posSide, assets);
  }
  return transparent;
}

async function insertGlassPanelWithPillars(
  canvas: PhotonImage,
  sideGlass: () => PhotonImage,
  glassWidth: number,
  glassHeight: number,
  frameColor: string,
  numPanels: number,
  positionSide: "left" | "right",
  assets: AssetLoader
) {
  const pillarV = await frameElement("images/frame/pillar-V.png", FRAME_WIDTH, glassHeight + FRAME_WIDTH, frameColor, assets);
  const pillarH = await frameElement("images/frame/pillar-H.png", Math.max(1, glassWidth - FRAME_WIDTH), FRAME_WIDTH, frameColor, assets);

  for (let i = 0; i < numPanels; i++) {
    const glassX = FRAME_WIDTH + glassWidth * i;
    const pillarX = glassWidth * (i + 1);
    const glassClone = fitCover(sideGlass(), Math.max(1, glassWidth - FRAME_WIDTH), glassHeight);
    insertAnchor(canvas, glassClone, `top-${positionSide}` as Anchor, glassX, 0);
    insertAnchor(canvas, pillarV, `top-${positionSide}` as Anchor, pillarX, 0);
    insertAnchor(canvas, pillarH, `bottom-${positionSide}` as Anchor, glassX, 0);
  }
}

// ---- transom ----
async function addTransom(image: PhotonImage, config: DoorConfig, assets: AssetLoader): Promise<PhotonImage> {
  const frameColor = (config["frame-color"] as string) ?? "#8a8f98";
  // getTransomGlassPath default = images/glass/default.png (absent → bail, matching Laravel)
  const glassBytes = await assets.get("images/glass/default.png");
  const pillarBytes = await assets.get("images/frame/pillar-H.png");
  if (!glassBytes || !pillarBytes) return image;

  let transomGlass = load(glassBytes);
  if (transomGlass.get_height() > transomGlass.get_width()) fliph(transomGlass); // (rotate 90 approx)
  const upperGlassHeight = scale(config.upperGlassHeight ?? 150 * RATIO);
  const transomWidth = image.get_width();
  const pillarWidth = FRAME_WIDTH;

  const transomCanvas = blank(transomWidth, upperGlassHeight);
  wm(transomCanvas, fitCover(transomGlass, transomWidth, upperGlassHeight), 0, 0);
  const coloredPillar = await frameElement("images/frame/pillar-H.png", transomWidth, pillarWidth, frameColor, assets);

  const newHeight = image.get_height() + upperGlassHeight + pillarWidth;
  const canvas = await coloredCanvas(frameColor, transomWidth, newHeight, assets);
  wm(canvas, transomCanvas, 0, pillarWidth);
  wm(canvas, coloredPillar, 0, upperGlassHeight);
  wm(canvas, image, 0, upperGlassHeight + pillarWidth);
  return canvas;
}
