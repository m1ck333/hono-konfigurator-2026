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
import { buildDoorImage, type DoorConfig, type AssetLoader } from "./doorbuilder";
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

// ============================================================ render (full DoorBuilder parity)
app.post("/api/door/image", async (c) => {
  const config = await c.req.json<DoorConfig>();
  // Laravel reads has_glass + the door's default color from the DB.
  const door = await c.env.DB
    .prepare("SELECT d.has_glass, c.color_hex FROM doors d LEFT JOIN colors c ON c.id = d.color_id WHERE d.id = ?")
    .bind(config["model-id"])
    .first<{ has_glass: number; color_hex: string | null }>();
  config.has_glass = door?.has_glass ?? 0;
  // Match DoorBuilder.php:65-66 — panel/frame fall back to the door's own color_hex
  // (NOT hardcoded gray) when the client doesn't send an explicit color.
  const defaultHex = door?.color_hex || "#3f4145";
  if (!config["panel-color"]) config["panel-color"] = defaultHex;
  if (!config["frame-color"]) config["frame-color"] = defaultHex;
  const assets: AssetLoader = {
    get: async (key) => {
      const obj = await c.env.ASSETS.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
  };
  const png = await buildDoorImage(config, assets);
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
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

// ============================================================ admin (catalog CRUD + users + markups)
registerAdmin(app as never);

app.get("/api/admin/inquiries", requireAuth, requireAdmin, async (c) =>
  c.json({ inquiries: (await c.env.DB.prepare("SELECT * FROM inquiries ORDER BY id DESC").all()).results }));
app.get("/api/admin/printed-contents", requireAuth, requireAdmin, async (c) =>
  c.json({ printedContents: (await c.env.DB.prepare("SELECT pc.id, pc.user_id, u.username, pc.created_at FROM printed_contents pc JOIN users u ON u.id=pc.user_id ORDER BY pc.id DESC").all()).results }));

export default app;
