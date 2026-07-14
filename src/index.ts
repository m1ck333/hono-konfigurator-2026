import { Hono } from "hono";
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
app.notFound((c) => c.json({ error: "not found" }, 404));

interface Config { modelId: number; equipment?: number[] }

// ============================================================ health
app.get("/", (c) => c.json({ ok: true, service: "konfigurator-be" }));

// ============================================================ catalog
app.get("/api/catalog", async (c) => {
  const [models, categories, equipment] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM models WHERE is_shown=1 ORDER BY sort_order").all(),
    c.env.DB.prepare("SELECT * FROM categories ORDER BY sort_order").all(),
    c.env.DB.prepare("SELECT * FROM equipment WHERE is_shown=1 ORDER BY sort_order").all(),
  ]);
  return c.json({ models: models.results, categories: categories.results, equipment: equipment.results });
});

// ============================================================ render (full DoorBuilder parity)
app.post("/api/door/image", async (c) => {
  const config = await c.req.json<DoorConfig>();
  const assets: AssetLoader = {
    get: async (key) => {
      const obj = await c.env.ASSETS.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
  };
  const png = await buildDoorImage(config, assets);
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
});

// ============================================================ price (auth — enforces price-visibility rule)
const round2 = (n: number) => Math.round(n * 100) / 100;

app.post("/api/calculate-price", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Config & { vat?: number; discount?: number; markupLabel?: string }>();
  const vat = body.vat ?? 0;
  const discount = body.discount ?? 0;
  const markupLabel = body.markupLabel ?? "default";

  // admin default markup applies only to non-admin users
  let adminMarkup = 0;
  if (user.role !== "admin") {
    const row = await c.env.DB.prepare(
      "SELECT m.markup_value AS v FROM markups m JOIN users u ON u.id=m.user_id WHERE u.role='admin' AND m.is_default=1 LIMIT 1"
    ).first<{ v: number }>();
    adminMarkup = row?.v ?? 0;
  }
  const um = await c.env.DB.prepare("SELECT markup_value AS v FROM markups WHERE user_id=? AND markup_label=? LIMIT 1")
    .bind(user.id, markupLabel).first<{ v: number }>();
  const userMarkup = um?.v ?? 0;

  // discount -> admin markup -> user markup -> VAT (mirrors Laravel PriceCalculator)
  const priceRow = (base: number) => {
    const withMarkups = base * (1 - discount / 100) * (1 + adminMarkup / 100) * (1 + userMarkup / 100);
    return { priceWithoutVat: round2(withMarkups), priceWithVat: round2(withMarkups * (1 + vat / 100)) };
  };

  const model = await c.env.DB.prepare("SELECT price FROM models WHERE id=?").bind(body.modelId).first<{ price: number }>();
  let equipTotal = 0;
  for (const id of body.equipment ?? []) {
    const eq = await c.env.DB.prepare("SELECT price FROM equipment WHERE id=?").bind(id).first<{ price: number }>();
    if (eq) equipTotal += eq.price;
  }
  const modelPrice = priceRow(model?.price ?? 0);
  const equipmentPrices = priceRow(equipTotal);
  const baseWithoutVat = round2(modelPrice.priceWithoutVat + equipmentPrices.priceWithoutVat);

  return c.json({
    data: {
      modelPrice,
      equipmentPrices,
      totalPrice: { priceWithoutVat: baseWithoutVat, priceWithVat: round2(baseWithoutVat * (1 + vat / 100)) },
      defaultAdminMarkup: adminMarkup,
      userMarkup,
      discount,
      vat,
    },
  });
});

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
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  const token = await signToken(c.env.JWT_SECRET, { id: user.id, username: user.username, role: user.role });
  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get("/api/me", requireAuth, (c) => c.json({ user: c.get("user") }));

// ============================================================ admin (auth + admin)
app.use("/api/admin/*", requireAuth, requireAdmin);

// ---- users ----
app.get("/api/admin/users", async (c) => {
  const r = await c.env.DB.prepare("SELECT id, username, role FROM users ORDER BY id").all();
  return c.json({ users: r.results });
});
app.post("/api/admin/users", async (c) => {
  const { username, password, role } = await c.req.json<any>();
  if (!username || !password) return c.json({ error: "username and password required" }, 400);
  try {
    const r = await c.env.DB.prepare("INSERT INTO users (username, password_hash, role) VALUES (?,?,?)")
      .bind(username, await hashPassword(password), role || "user").run();
    return c.json({ id: r.meta.last_row_id, username, role: role || "user" }, 201);
  } catch (e) { console.error(e); return c.json({ error: "username taken" }, 409); }
});
app.put("/api/admin/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { username, password, role } = await c.req.json<any>();
  if (password) {
    await c.env.DB.prepare("UPDATE users SET username=COALESCE(?,username), role=COALESCE(?,role), password_hash=? WHERE id=?")
      .bind(username ?? null, role ?? null, await hashPassword(password), id).run();
  } else {
    await c.env.DB.prepare("UPDATE users SET username=COALESCE(?,username), role=COALESCE(?,role) WHERE id=?")
      .bind(username ?? null, role ?? null, id).run();
  }
  return c.json({ ok: true });
});
app.delete("/api/admin/users/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM users WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- models ----
app.get("/api/admin/models", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM models ORDER BY sort_order").all();
  return c.json({ models: r.results });
});
app.post("/api/admin/models", async (c) => {
  const b = await c.req.json<any>();
  const r = await c.env.DB.prepare(
    "INSERT INTO models (name, image_key, inner_image_key, price, width, height, is_shown, sort_order) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(b.name, b.image_key ?? "", b.inner_image_key ?? null, b.price ?? 0, b.width ?? 0, b.height ?? 0, b.is_shown ?? 1, b.sort_order ?? 0).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});
app.put("/api/admin/models/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<any>();
  await c.env.DB.prepare(
    "UPDATE models SET name=COALESCE(?,name), price=COALESCE(?,price), width=COALESCE(?,width), height=COALESCE(?,height), is_shown=COALESCE(?,is_shown), sort_order=COALESCE(?,sort_order) WHERE id=?"
  ).bind(b.name ?? null, b.price ?? null, b.width ?? null, b.height ?? null, b.is_shown ?? null, b.sort_order ?? null, id).run();
  return c.json({ ok: true });
});
app.delete("/api/admin/models/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM models WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});
// upload/replace a model's finished image (raw PNG body)
app.put("/api/admin/models/:id/image", async (c) => {
  const id = Number(c.req.param("id"));
  const key = `models/${id}.png`;
  await c.env.ASSETS.put(key, await c.req.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
  await c.env.DB.prepare("UPDATE models SET image_key=? WHERE id=?").bind(key, id).run();
  return c.json({ ok: true, image_key: key });
});

// ---- equipment ----
app.get("/api/admin/equipment", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM equipment ORDER BY sort_order").all();
  return c.json({ equipment: r.results });
});
app.post("/api/admin/equipment", async (c) => {
  const b = await c.req.json<any>();
  const r = await c.env.DB.prepare(
    "INSERT INTO equipment (category_id, name, image_key, price, anchor_x, anchor_y, is_shown, sort_order) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(b.category_id, b.name, b.image_key ?? "", b.price ?? 0, b.anchor_x ?? 0, b.anchor_y ?? 0, b.is_shown ?? 1, b.sort_order ?? 0).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});
app.put("/api/admin/equipment/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<any>();
  await c.env.DB.prepare(
    "UPDATE equipment SET name=COALESCE(?,name), price=COALESCE(?,price), anchor_x=COALESCE(?,anchor_x), anchor_y=COALESCE(?,anchor_y), is_shown=COALESCE(?,is_shown), sort_order=COALESCE(?,sort_order) WHERE id=?"
  ).bind(b.name ?? null, b.price ?? null, b.anchor_x ?? null, b.anchor_y ?? null, b.is_shown ?? null, b.sort_order ?? null, id).run();
  return c.json({ ok: true });
});
app.delete("/api/admin/equipment/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM equipment WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});
app.put("/api/admin/equipment/:id/image", async (c) => {
  const id = Number(c.req.param("id"));
  const key = `equipment/${id}.png`;
  await c.env.ASSETS.put(key, await c.req.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
  await c.env.DB.prepare("UPDATE equipment SET image_key=? WHERE id=?").bind(key, id).run();
  return c.json({ ok: true, image_key: key });
});

// ---- markups (admin) ----
app.get("/api/admin/markups", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM markups ORDER BY id").all();
  return c.json({ markups: r.results });
});
app.post("/api/admin/markups", async (c) => {
  const b = await c.req.json<any>();
  const r = await c.env.DB.prepare("INSERT INTO markups (user_id, markup_label, markup_value, is_default) VALUES (?,?,?,?)")
    .bind(b.user_id, b.markup_label ?? "default", b.markup_value ?? 0, b.is_default ?? 0).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});
app.put("/api/admin/markups/:id", async (c) => {
  const b = await c.req.json<any>();
  await c.env.DB.prepare("UPDATE markups SET markup_label=COALESCE(?,markup_label), markup_value=COALESCE(?,markup_value), is_default=COALESCE(?,is_default) WHERE id=?")
    .bind(b.markup_label ?? null, b.markup_value ?? null, b.is_default ?? null, Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});
app.delete("/api/admin/markups/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM markups WHERE id=?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- printed contents + inquiries (admin) ----
app.get("/api/admin/printed-contents", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT pc.id, pc.user_id, u.username, pc.created_at FROM printed_contents pc JOIN users u ON u.id=pc.user_id ORDER BY pc.id DESC"
  ).all();
  return c.json({ printedContents: r.results });
});
app.get("/api/admin/inquiries", async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM inquiries ORDER BY id DESC").all();
  return c.json({ inquiries: r.results });
});

export default app;
