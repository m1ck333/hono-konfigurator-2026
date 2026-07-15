import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  requireAdmin,
  type JwtUser,
} from "./auth";
import { sendInquiryEmail } from "./email";
import { buildDoorImage, freeArena, type DoorConfig, type AssetLoader } from "./doorbuilder";
import { registerCatalog } from "./catalog";
import { registerPrice } from "./price";
import { registerAdmin } from "./admin";

type Bindings = {
  DB: D1Database;
  ASSETS: R2Bucket;
  JWT_SECRET: string;
  ALLOWED_ORIGIN?: string;
  RESEND_API_KEY?: string;
  INQUIRY_FROM?: string;
  INQUIRY_TO?: string;
};
type Variables = { user: JwtUser };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", (c, next) =>
  cors({ origin: c.env.ALLOWED_ORIGIN || "*", credentials: true })(c, next)
);

// Clean JSON errors instead of stack traces / HTML.
app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});
// Asset resolver — the FE builds image URLs three inconsistent ways:
//   `${API}/<key>`  `${API}/storage/<key>`  `${API}/api/<key>`
// All must resolve to the same clean R2 key. Strip the FE prefix and look it up.
function assetCandidates(rawPath: string): string[] {
  let p = decodeURIComponent(rawPath).replace(/^\/+/, "");
  p = p.replace(/^storage\//, "").replace(/^api\//, "");
  const cands = [p];
  // EquipmentGroup fallback requests `thumbnails/equipment/...`; our keys are `equipment/...`
  if (p.startsWith("thumbnails/equipment/")) cands.push(p.replace(/^thumbnails\//, ""));
  return cands;
}
async function serveAsset(c: Context<{ Bindings: Bindings; Variables: Variables }>, rawPath: string): Promise<Response | null> {
  for (const key of assetCandidates(rawPath)) {
    const obj = await c.env.ASSETS.get(key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "image/png",
          "cache-control": "public, max-age=31536000",
          etag: obj.httpEtag,
        },
      });
    }
  }
  return null;
}

// Any unmatched GET whose path maps to an R2 object is served as that asset.
app.notFound(async (c) => {
  if (c.req.method === "GET") {
    const asset = await serveAsset(c, c.req.path);
    if (asset) return asset;
  }
  return c.json({ error: "not found" }, 404);
});

interface Config { modelId: number; equipment?: number[] }

// ============================================================ health
app.get("/", (c) => c.json({ ok: true, service: "konfigurator-be" }));

// ============================================================ catalog (default-items + apiResource reads)
registerCatalog(app as never);

// ============================================================ asset serving (R2, replaces /storage symlink)
app.get("/storage/*", async (c) => {
  return (await serveAsset(c, c.req.path)) ?? c.json({ error: "not found" }, 404);
});

// Photon renders are memory-heavy (~15-25MB of WASM image buffers each, reclaimed only by
// GC between requests). Concurrent renders in one isolate sum past the 128MB limit →
// "Exceeded Memory Limit" 503s. Serialize them per isolate so only one peaks at a time;
// Cloudflare load-balances across many isolates, so overall throughput still scales.
let renderQueue: Promise<unknown> = Promise.resolve();
function queuedRender<T>(fn: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(fn, fn);
  renderQueue = run.then(() => {}, () => {});
  return run;
}

// ============================================================ render (full DoorBuilder parity)
// Fill has_glass + the door's default color from the DB (Laravel DoorBuilder.php:65-66 —
// panel/frame fall back to the door's own color_hex, not a hardcoded gray).
async function prepareConfig(db: D1Database, config: DoorConfig): Promise<DoorConfig> {
  const door = await db
    .prepare("SELECT d.has_glass, c.color_hex FROM doors d LEFT JOIN colors c ON c.id = d.color_id WHERE d.id = ?")
    .bind(config["model-id"])
    .first<{ has_glass: number; color_hex: string | null }>();
  config.has_glass = door?.has_glass ?? 0;
  const hex = door?.color_hex || "#3f4145";
  if (!config["panel-color"]) config["panel-color"] = hex;
  if (!config["frame-color"]) config["frame-color"] = hex;

  // resolve glass selections to texture filenames (Laravel resolves these from the glass
  // thumbnail's basename; we kept it in equipment_glasses.texture). in-door + transom use the
  // door-folder / glass/ texture; side glass can also be a model-specific sideglass/{model}.jpg.
  const glassTexture = async (id: unknown) =>
    id ? (await db.prepare("SELECT texture FROM equipment_glasses WHERE id=?").bind(id).first<{ texture: string | null }>())?.texture ?? null : null;
  if (config["inner-glass-id"]) config.innerGlassTexture = await glassTexture(config["inner-glass-id"]);
  if (config["transom-glass-id"]) config.transomGlassTexture = await glassTexture(config["transom-glass-id"]);
  const sgName = config["side-glass-name"] as string | null;
  const sgId = config["side-glass-id"];
  config.sideGlassTexture =
    sgName === "default" ? (config["model-name"] as string)
    : sgId ? await glassTexture(sgId)
    : sgName || null;

  // inject each selected equipment's image/inner_image R2 key so the renderer can composite it
  const eq = (config.equipment ?? {}) as Record<string, { id?: number | null; image?: string | null; inner_image?: string | null }>;
  const ids = Object.values(eq).map((e) => e?.id).filter((x): x is number => !!x);
  if (ids.length) {
    const rows = (await db.prepare(
      `SELECT id, image, inner_image FROM equipment_others WHERE id IN (${ids.map(() => "?").join(",")})`
    ).bind(...ids).all()).results as Array<{ id: number; image: string | null; inner_image: string | null }>;
    const byId: Record<number, { image: string | null; inner_image: string | null }> = {};
    for (const r of rows) byId[r.id] = r;
    for (const e of Object.values(eq)) {
      if (e?.id && byId[e.id]) { e.image = byId[e.id].image; e.inner_image = byId[e.id].inner_image; }
    }
  }
  return config;
}
const makeAssets = (env: Bindings): AssetLoader => ({
  get: async (key) => {
    const obj = await env.ASSETS.get(key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  },
});
// serialized render → clone bytes out of WASM memory → free the arena
const renderPng = (config: DoorConfig, assets: AssetLoader) =>
  queuedRender(async () => {
    try { return new Uint8Array(await buildDoorImage(config, assets)); }
    finally { freeArena(); }
  });
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

app.post("/api/door/image", async (c) => {
  const config = await prepareConfig(c.env.DB, await c.req.json<DoorConfig>());
  const png = await renderPng(config, makeAssets(c.env));
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
});

// both exterior + interior renders, returned as base64 PNGs ({ innerDoor, outerDoor }).
app.post("/api/door/both-sides-images", async (c) => {
  const base = await prepareConfig(c.env.DB, await c.req.json<DoorConfig>());
  const assets = makeAssets(c.env);
  const outerDoor = bytesToBase64(await renderPng({ ...base, interiorDoorShown: false }, assets));
  const innerDoor = bytesToBase64(await renderPng({ ...base, interiorDoorShown: true }, assets));
  return c.json({ innerDoor, outerDoor });
});

// ============================================================ price (full parity, auth-gated)
registerPrice(app as never);

// ============================================================ offers
app.post("/api/submit-inquiry", async (c) => {
  const b = await c.req.json<any>();
  await c.env.DB.prepare("INSERT INTO inquiries (name,email,phone,message,config) VALUES (?,?,?,?,?)")
    .bind(b.name ?? null, b.email ?? null, b.phone ?? null, b.message ?? null, JSON.stringify(b.config ?? {})).run();
  // fire-and-forget email notification (no-op unless RESEND_API_KEY is configured)
  c.executionCtx.waitUntil(sendInquiryEmail(c.env, b));
  return c.json({ ok: true });
});

app.post("/api/printed-contents", requireAuth, async (c) => {
  const user = c.get("user");
  const { content } = await c.req.json<{ content: string }>();
  if (!content) return c.json({ error: "content required" }, 400);
  const r = await c.env.DB.prepare("INSERT INTO printed_contents (user_id, content) VALUES (?,?)").bind(user.id, content).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});
app.get("/api/user/printed-contents", requireAuth, async (c) => {
  const user = c.get("user");
  const r = await c.env.DB.prepare("SELECT id, created_at FROM printed_contents WHERE user_id=? ORDER BY id DESC").bind(user.id).all();
  return c.json({ printedContents: r.results });
});
app.get("/api/printed-contents/:id", requireAuth, async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM printed_contents WHERE id=?").bind(Number(c.req.param("id"))).first<any>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

// ============================================================ auth
app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password) return c.json({ error: "username and password required" }, 400);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username).first<any>();
  if (!user || !(await verifyPassword(password, user.password))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  const token = await signToken(c.env.JWT_SECRET, { id: user.id, username: user.username, role: user.role });
  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get("/api/me", requireAuth, (c) => c.json({ user: c.get("user") }));
// JWT is stateless — logout is client-side (drop the token); just acknowledge.
app.post("/api/logout", requireAuth, (c) => c.json({ success: true, message: "logged out" }));

// ============================================================ admin (catalog CRUD + users + markups)
registerAdmin(app as never);

app.get("/api/admin/inquiries", requireAuth, requireAdmin, async (c) =>
  c.json({ inquiries: (await c.env.DB.prepare("SELECT * FROM inquiries ORDER BY id DESC").all()).results }));
app.get("/api/admin/printed-contents", requireAuth, requireAdmin, async (c) =>
  c.json({ printedContents: (await c.env.DB.prepare("SELECT pc.id, pc.user_id, u.username, pc.created_at FROM printed_contents pc JOIN users u ON u.id=pc.user_id ORDER BY pc.id DESC").all()).results }));

export default app;
