// Test helpers: HTTP (with a browser UA so Cloudflare doesn't bot-filter), structure
// signatures for contract diffing, and pixel RMSE via sharp.
import sharp from "sharp";

const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36" };

export async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}
export async function post(url, body, token) {
  const headers = { ...UA, "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}
export async function postImage(url, body) {
  const r = await post(url, body);
  return { status: r.status, buf: r.ok ? Buffer.from(await r.arrayBuffer()) : null };
}

// Set of key-paths (arrays collapsed to [*], merged across the first 8 items). Ignores
// scalar VALUES — so catalog data can change freely; only the SHAPE is frozen.
export function signature(o, p = "", acc = new Set()) {
  if (o === null || typeof o !== "object") return acc;
  if (Array.isArray(o)) for (const it of o.slice(0, 8)) signature(it, `${p}[*]`, acc);
  else for (const [k, v] of Object.entries(o)) { acc.add(`${p}.${k}`); signature(v, `${p}.${k}`, acc); }
  return acc;
}
export const sig = (o) => [...signature(o)].sort();

// RMSE (0..1) between two PNG buffers. Returns { dimMismatch } if dimensions differ.
export async function imageRmse(a, b) {
  const [A, B] = await Promise.all([
    sharp(a).raw().toBuffer({ resolveWithObject: true }),
    sharp(b).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (A.info.width !== B.info.width || A.info.height !== B.info.height)
    return { dimMismatch: true, a: `${A.info.width}x${A.info.height}`, b: `${B.info.width}x${B.info.height}` };
  let sum = 0;
  const n = Math.min(A.data.length, B.data.length);
  for (let i = 0; i < n; i++) { const d = A.data[i] - B.data[i]; sum += d * d; }
  return { rmse: Math.sqrt(sum / n) / 255 };
}

// tiny colored console
export const c = {
  pass: (s) => `\x1b[32m${s}\x1b[0m`, fail: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
