import init, { PhotonImage, watermark } from "@silvia-odwyer/photon";
import wasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";

// photon WASM instantiates once per isolate.
let ready: Promise<unknown> | null = null;

export interface Overlay {
  bytes: Uint8Array;
  x: number; // absolute px (top-left) on the model canvas
  y: number;
}

// Model B render: finished model image + equipment overlays composited on top.
export async function renderDoor(modelBytes: Uint8Array, overlays: Overlay[]): Promise<Uint8Array> {
  if (!ready) ready = init(wasm);
  await ready;
  const base = PhotonImage.new_from_byteslice(modelBytes);
  for (const o of overlays) {
    const ov = PhotonImage.new_from_byteslice(o.bytes);
    watermark(base, ov, BigInt(Math.round(o.x)), BigInt(Math.round(o.y)));
  }
  return base.get_bytes();
}
