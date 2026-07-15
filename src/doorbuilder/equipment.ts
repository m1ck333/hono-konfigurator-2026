import { load, resize, wm, insertAnchor, SamplingFilter, type AssetLoader, type PhotonImage, type Anchor } from "./photon";
import type { DoorConfig } from "./index";

const RATIO = 3.5;
const FRAME_WIDTH = 22;

// Ports Laravel's DoorEquipmentAdder + Components/Equipment/*. Equipment is composited onto
// the base leaf BEFORE the DIN flip, so it mirrors correctly on the interior view.
// Positions are in leaf pixels (the leaf is already RATIO-scaled); equipment images are
// inserted at native size (except doorknob/parapet which resize). The render endpoint injects
// each selection's `image`/`inner_image` R2 key onto config.equipment[type].

type Eq = { id?: number | null; image?: string | null; inner_image?: string | null };
const sel = (config: DoorConfig, type: string): Eq =>
  ((config.equipment as Record<string, Eq> | undefined)?.[type]) ?? {};

async function loadImg(assets: AssetLoader, key?: string | null): Promise<PhotonImage | null> {
  if (!key) return null;
  const bytes = await assets.get(key);
  return bytes ? load(bytes) : null;
}
const t = Math.trunc;

export async function addEquipment(leaf: PhotonImage, config: DoorConfig, assets: AssetLoader): Promise<void> {
  const W = leaf.get_width();
  const H = leaf.get_height();
  const interior = !!config.interiorDoorShown;
  const hasGlass = !!config.has_glass;

  // doorknob — interior side only; capped at 15% of door height (aspect preserved)
  if (interior) {
    let k = await loadImg(assets, sel(config, "doorknobInside").image);
    if (k) {
      const maxH = t(H * 0.15);
      if (k.get_height() > maxH) k = resize(k, Math.max(1, Math.round((k.get_width() * maxH) / k.get_height())), maxH, SamplingFilter.Triangle);
      wm(leaf, k, t(W * 0.7), t(H / 2 - k.get_height() / 2));
    }
  }

  // exterior-only overlays
  if (!interior) {
    const hr = await loadImg(assets, sel(config, "handrail").image);
    if (hr) wm(leaf, hr, t(W * 0.09 + 20), t(H / 2 - hr.get_height() / 2));

    const ac = await loadImg(assets, sel(config, "accessControl").image);
    if (ac) wm(leaf, ac, t(W * 0.09 + 45 - ac.get_width() / 2), t(H / 3));

    const ro = await loadImg(assets, sel(config, "rosette").image);
    if (ro) wm(leaf, ro, t(W * 0.09), t(H * 0.5));

    const pp = await loadImg(assets, sel(config, "parapetProtection").image);
    if (pp) {
      const nh = t(pp.get_height() * (W / pp.get_width()));
      wm(leaf, resize(pp, W, Math.max(1, nh), SamplingFilter.Triangle), 0, H - nh);
    }
  }

  // spy — shown on BOTH sides, different image + position per side
  const spy = sel(config, "spy");
  if (spy.id) {
    if (interior) {
      const si = await loadImg(assets, spy.inner_image);
      if (si) wm(leaf, si, hasGlass ? t(W * 0.7) : t(W * 0.5 - si.get_width() / 2), t(H / 4));
    } else {
      const so = await loadImg(assets, spy.image);
      if (so) wm(leaf, so, hasGlass ? t(W * 0.09 + 50) : t(W * 0.5), t(H / 4));
    }
  }
}

// ---- hinges + automatic-closing-device (frame step, DIN-positioned) ----
// Ported from FrameElementCreator + DinOpeningStandard. Added AFTER the frame, onto the
// full framed assembly. Config dimensions are raw mm here (Laravel pre-scales via
// DimensionScaler), so side/upper/height values are divided by RATIO to match.
const din = (c: DoorConfig) => (c["DIN-opening-standard"] as string) ?? "left-inside";
const isOutside = (c: DoorConfig) => din(c).includes("outside");

function hingesShown(c: DoorConfig): boolean {
  const interior = !!c.interiorDoorShown;
  return (!interior && isOutside(c)) || (interior && !isOutside(c));
}
function hingeSide(c: DoorConfig): Anchor {
  const map: Record<string, Record<string, Anchor>> = {
    interior: { "left-outside": "top-right", "left-inside": "top-left", "right-outside": "top-left", "right-inside": "top-right" },
    exterior: { "left-outside": "top-left", "left-inside": "top-right", "right-outside": "top-right", "right-inside": "top-left" },
  };
  return map[c.interiorDoorShown ? "interior" : "exterior"][din(c)] ?? "top-right";
}
function hingeXs(c: DoorConfig, hingeWidth: number): [number, number] {
  const type = c.type ?? "";
  let leftX = FRAME_WIDTH - hingeWidth / 2;
  let rightX = FRAME_WIDTH - hingeWidth / 2;
  if (type.includes("left") || type.includes("both")) leftX += ((c.leftSideWidth ?? 0) / RATIO) * ((c["left-side-glass-number"] as number) ?? 1);
  if (type.includes("right") || type.includes("both")) rightX += ((c.rightSideWidth ?? 0) / RATIO) * ((c["right-side-glass-number"] as number) ?? 1);
  return c.interiorDoorShown ? [rightX, leftX] : [leftX, rightX];
}
function closingShown(c: DoorConfig): boolean {
  const interior = !!c.interiorDoorShown;
  return (interior && din(c).includes("inside")) || (!interior && din(c).includes("outside"));
}
function closingSide(c: DoorConfig): Anchor {
  const d = din(c);
  const interiorSide: Anchor = d === "left-inside" || d === "right-outside" ? "top-left" : "top-right";
  return c.interiorDoorShown ? interiorSide : interiorSide === "top-left" ? "top-right" : "top-left";
}
function closingXOffset(c: DoorConfig, side: Anchor, hasLeft: boolean, hasRight: boolean): number {
  const interior = !!c.interiorDoorShown;
  const lsw = (c.leftSideWidth ?? 0) / RATIO;
  const rsw = (c.rightSideWidth ?? 0) / RATIO;
  if (side === "top-left") {
    if ((interior && hasRight) || (!interior && hasLeft)) return interior ? rsw : lsw;
  } else if ((interior && hasLeft) || (!interior && hasRight)) return interior ? lsw : rsw;
  return 0;
}

export async function addFrameEquipment(assembly: PhotonImage, config: DoorConfig, assets: AssetLoader): Promise<void> {
  const type = config.type ?? "";

  // hinges — a column of N (3, or 4 if door ≥2400mm) down the hinge side
  const hEq = sel(config, "hinges");
  if (hEq.id && hingesShown(config)) {
    const hinge = await loadImg(assets, hEq.image);
    if (hinge) {
      const [leftX, rightX] = hingeXs(config, hinge.get_width());
      const isDouble = type.includes("double");
      const hasTransom = type.includes("transom");
      const scaledHeight = config.height / RATIO;
      const numHinges = config.height >= 2400 ? 4 : 3;
      const yOffset = hasTransom ? (config.upperGlassHeight ?? 0) / RATIO - FRAME_WIDTH / 2 : -FRAME_WIDTH;
      const margin = 100;
      const gap = (scaledHeight - 2 * margin) / (numHinges - 1);
      const sides: Anchor[] = isDouble ? ["top-left", "top-right"] : [hingeSide(config)];
      for (const side of sides) {
        const x = side === "top-left" ? (isDouble ? leftX - 1 : leftX) : isDouble ? rightX - 1 : rightX;
        for (let i = 0; i < numHinges; i++) insertAnchor(assembly, hinge, side, t(x), t(yOffset + margin + gap * i));
      }
    }
  }

  // automatic closing device — single overlay at the top of the hinge/latch side
  const cEq = sel(config, "automaticClosingDevice");
  if (cEq.id && closingShown(config)) {
    const cd = await loadImg(assets, cEq.image);
    if (cd) {
      const hasTransom = type.includes("transom");
      const hasRight = type.includes("right-side-panel") || type.includes("both-side-panels");
      const hasLeft = type.includes("left-side-panel") || type.includes("both-side-panels");
      const side = closingSide(config);
      const transomY = hasTransom ? (config.upperGlassHeight ?? 0) / RATIO : 0;
      insertAnchor(assembly, cd, side, t(closingXOffset(config, side, hasLeft, hasRight) + 30), t(transomY));
    }
  }
}
