# Algreen Door-Image Compositing Recipe

Reverse-engineered from the Laravel `app/Services/DoorBuilder/*` service.
Rendering lib: **Intervention Image 2.6.1 on the GD driver**. This document is the
implementation spec for a re-write in Node.js (`sharp`) or a Cloudflare Worker
(`photon-rs`). All numbers are literal from the code.

> Anchor convention: Intervention `insert($src,$anchor,$x,$y)` places `$src` at an
> anchor on the destination (`top-left`, `center`, `right`, `bottom-left`, …) then
> offsets by `$x,$y` **inward** from that anchor. Replicating this anchor→absolute
> conversion is the single biggest re-implementation gotcha.

## Pipeline (DoorImageBuilder::buildDoorImageStepByStep)
0. Resolve model + colors, scale dims (`DimensionScaler`, RATIO = 3.5)
1. `BaseDoorCreator::create` — panel-color background + glass + dent + okvir + oplata
2. `DoorEquipmentAdder::add` — doorknob, handrail, accessControl, rosette, parapet, spy
3. `DinOpeningStandard::rotateBaseDoor` — horizontal mirror when DIN ∈ {left-outside, right-inside}
4. `DoorTypeCustomizer::customize` — side panels / transom / double door (grows canvas)
5. `FrameElementCreator::insertElements` — L/R/T frame sides, corners, hinges, closing device

`buildBothSideImages` runs the pipeline twice (interiorDoorShown true/false).

## Color application — NO tint/colorize anywhere
Three mechanisms, none is a hue/colorize of a grayscale door:
- **A. Base panel/frame color** — `createColoredCanvasOrImage($color,$w,$h)`:
  hex → `Image::canvas(w,h,hex)` (solid fill); path → `Image::make(path)->resize(w,h)`
  (texture stretched, aspect ignored). Detail PNGs (glass/dent/okvir/oplata) are then
  composited OVER this colored background — the color shows through their transparency.
- **B. Frame pieces** — color canvas then `->fill('frame/<mask>.png')` which **tiles the
  PNG as a pattern** over the element (GD). Frame appearance comes from the PNG.
- **C. Glass silhouette** — `mask($mask,true)` (alpha-channel mask); mask built via
  `greyscale()->brightness(-100)->contrast(100)`.
Compositing is plain source-over alpha (`insert()`), opacity always 100%.

## Key constants
RATIO=3.5 (mm→px) · FRAME_WIDTH=22 · TRANSOM_HEIGHT=150 · hinges 4 if originalHeight≥2400 else 3 ·
hinge margin 100, span=h−200 · double-door overlap ±15, totalWidth=w+halfPanelWidth+22 ·
transom newHeight=h+upperGlassHeight+22 · top-frame overhang −50 · closing-device x +30 ·
doorknob max h=0.15·h · handrail x=w·0.09+20 · rosette x=w·0.09,y=h·0.5.

## DB lookups / config keys
- `Door(+color)` by `model-id` → has_glass, color_hex, model-name (asset folder)
- `EquipmentGlass` by `inner-glass-id` / `transom-glass-id` / `side-glass-id` → thumbnail→PNG
- `EquipmentOther` by `equipment.<type>.id` (doorknobInside, handrail, accessControl, rosette,
  parapetProtection, spy, hinges, automaticClosingDevice) → image / inner_image
- Assets: doors `storage/app/public/images/doors/{modelCode}/` (staklo, sandblast, udubljenje,
  okvir, oplata .png); frame `images/frame/` (side-L/R/T/LT, corner-L/R, pillar-H/V);
  glass `images/glass/`; equipment images from DB (prefixed `storage/`).

## Portability verdict
NO hue/colorize/imagefilter tint is used → no color-tinting primitive needed. Everything is
solid fills, resize, flip/flop, rotate-90, and straight alpha compositing — all map cleanly to
BOTH `sharp` and `photon-rs`.

Three riskiest ops (mechanical, not fundamental):
1. `fill(path)` frame texture tiling — check if frame PNGs are element-sized (→ plain
   composite) or truly tiled (→ pre-tile).
2. `mask($m,true)` glass clip — reproduce as build-silhouette then alpha-clip (`dest-in`).
3. Anchor+offset math of `insert()` across all anchors + the (int) floors + ±15/−50/+30/−22
   fudges — port one central anchor→absolute helper and unit-test it.

(Full step-by-step detail with every insert position is in the conversation transcript that
produced this file.)
