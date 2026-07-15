import { load, resize, wm, SamplingFilter, type AssetLoader, type PhotonImage } from "./photon";
import type { DoorConfig } from "./index";

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
