// Convert Intervention's insert($src, $anchor, $x, $y) to photon's top-left (x,y).
// Intervention places $src at an anchor on the destination, then offsets by (x,y)
// INWARD from that anchor. This is the single biggest port gotcha — one helper,
// unit-tested, used everywhere.
export type Anchor =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";

export function anchorToTopLeft(
  anchor: Anchor,
  destW: number,
  destH: number,
  srcW: number,
  srcH: number,
  offX = 0,
  offY = 0
): { x: number; y: number } {
  let x: number;
  let y: number;

  // horizontal
  if (anchor.includes("left")) x = offX;
  else if (anchor.includes("right")) x = destW - srcW - offX;
  else x = Math.trunc((destW - srcW) / 2) + offX; // center column

  // vertical
  if (anchor.includes("top")) y = offY;
  else if (anchor.includes("bottom")) y = destH - srcH - offY;
  else y = Math.trunc((destH - srcH) / 2) + offY; // middle row

  return { x: Math.trunc(x), y: Math.trunc(y) };
}
