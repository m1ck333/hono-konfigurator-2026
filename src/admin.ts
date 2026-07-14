import type { Hono } from "hono";
import { requireAuth, requireAdmin, hashPassword, type JwtUser } from "./auth";

type Env = { Bindings: { DB: D1Database; ASSETS: R2Bucket }; Variables: { user: JwtUser } };

const q = (id: string) => `"${id}"`;

// column names of a table (minus id), cached per isolate
const colCache: Record<string, string[]> = {};
async function columns(db: D1Database, table: string): Promise<string[]> {
  if (colCache[table]) return colCache[table];
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()).results as any[];
  return (colCache[table] = rows.map((r) => r.name).filter((n) => n !== "id"));
}

// entities that get generic create/update/delete + image upload (path -> table)
const ENTITIES: { path: string; table: string; imageCol: string }[] = [
  { path: "doors", table: "doors", imageCol: "thumbnail" },
  { path: "colors", table: "colors", imageCol: "thumbnail" },
  { path: "color-categories", table: "color_categories", imageCol: "" },
  { path: "equipment-systems", table: "equipment_systems", imageCol: "thumbnail" },
  { path: "equipment-glasses", table: "equipment_glasses", imageCol: "thumbnail" },
  { path: "equipment-locks", table: "equipment_locks", imageCol: "thumbnail" },
  { path: "equipment-others", table: "equipment_others", imageCol: "image" },
  { path: "equipment-other-categories", table: "equipment_other_categories", imageCol: "" },
  { path: "house-colors", table: "house_colors", imageCol: "thumbnail" },
  { path: "houses", table: "houses", imageCol: "image" },
];

export function registerAdmin(app: Hono<Env>) {
  for (const { path, table, imageCol } of ENTITIES) {
    // create
    app.post(`/api/${path}`, requireAuth, requireAdmin, async (c) => {
      const cols = await columns(c.env.DB, table);
      const body = await c.req.json<Record<string, unknown>>();
      const keys = cols.filter((k) => k in body);
      if (!keys.length) return c.json({ error: "no fields" }, 400);
      const r = await c.env.DB.prepare(
        `INSERT INTO ${table} (${keys.map(q).join(",")}) VALUES (${keys.map(() => "?").join(",")})`
      ).bind(...keys.map((k) => body[k] as never)).run();
      return c.json({ success: true, id: r.meta.last_row_id }, 201);
    });

    // update
    app.put(`/api/${path}/:id`, requireAuth, requireAdmin, async (c) => {
      const cols = await columns(c.env.DB, table);
      const body = await c.req.json<Record<string, unknown>>();
      const keys = cols.filter((k) => k in body);
      if (!keys.length) return c.json({ success: true });
      await c.env.DB.prepare(
        `UPDATE ${table} SET ${keys.map((k) => `${q(k)}=?`).join(",")} WHERE id=?`
      ).bind(...keys.map((k) => body[k] as never), c.req.param("id")).run();
      return c.json({ success: true });
    });

    // delete
    app.delete(`/api/${path}/:id`, requireAuth, requireAdmin, async (c) => {
      await c.env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(c.req.param("id")).run();
      return c.json({ success: true });
    });

    // image upload (raw PNG body) -> R2 under the clean key -> set path column
    if (imageCol) {
      app.put(`/api/${path}/:id/image`, requireAuth, requireAdmin, async (c) => {
        const id = c.req.param("id");
        // doors key by model_code; everything else by id
        let key = `${path}/${id}.png`;
        if (table === "doors") {
          const d = await c.env.DB.prepare("SELECT model_code FROM doors WHERE id=?").bind(id).first<{ model_code: string }>();
          key = `doors/${d?.model_code ?? id}/thumbnail.png`;
        }
        await c.env.ASSETS.put(key, await c.req.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
        await c.env.DB.prepare(`UPDATE ${table} SET ${q(imageCol)}=? WHERE id=?`).bind(key, id).run();
        return c.json({ success: true, [imageCol]: key });
      });
    }
  }

  // ---- users (special: hash password on create/update) ----
  app.get("/api/users", requireAuth, requireAdmin, async (c) =>
    c.json({ success: true, users: (await c.env.DB.prepare("SELECT id, username, role, company_name, city, email FROM users ORDER BY id").all()).results }));
  app.post("/api/register", requireAuth, requireAdmin, async (c) => {
    const b = await c.req.json<any>();
    if (!b.username || !b.password) return c.json({ error: "username and password required" }, 400);
    try {
      const r = await c.env.DB.prepare("INSERT INTO users (username, password, role) VALUES (?,?,?)")
        .bind(b.username, await hashPassword(b.password), b.role || "user").run();
      return c.json({ success: true, id: r.meta.last_row_id }, 201);
    } catch { return c.json({ error: "username taken" }, 409); }
  });
  app.delete("/api/users/:id", requireAuth, requireAdmin, async (c) => {
    await c.env.DB.prepare("DELETE FROM users WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ success: true });
  });
  app.post("/api/password-update", requireAuth, async (c) => {
    const user = c.get("user");
    const { password } = await c.req.json<{ password: string }>();
    if (!password) return c.json({ error: "password required" }, 400);
    await c.env.DB.prepare("UPDATE users SET password=? WHERE id=?").bind(await hashPassword(password), user.id).run();
    return c.json({ success: true });
  });

  // ---- markups (admin) ----
  app.get("/api/markups", requireAuth, requireAdmin, async (c) =>
    c.json({ success: true, markups: (await c.env.DB.prepare("SELECT * FROM markups ORDER BY id").all()).results }));
  app.post("/api/markups", requireAuth, requireAdmin, async (c) => {
    const b = await c.req.json<any>();
    const r = await c.env.DB.prepare("INSERT INTO markups (user_id, markup_label, markup_value, \"default\") VALUES (?,?,?,?)")
      .bind(b.user_id, b.markup_label ?? "default", b.markup_value ?? 0, b.default ?? 0).run();
    return c.json({ success: true, id: r.meta.last_row_id }, 201);
  });
  app.put("/api/markups/:id", requireAuth, requireAdmin, async (c) => {
    const b = await c.req.json<any>();
    await c.env.DB.prepare("UPDATE markups SET markup_label=COALESCE(?,markup_label), markup_value=COALESCE(?,markup_value), \"default\"=COALESCE(?,\"default\") WHERE id=?")
      .bind(b.markup_label ?? null, b.markup_value ?? null, b.default ?? null, c.req.param("id")).run();
    return c.json({ success: true });
  });
  app.delete("/api/markups/:id", requireAuth, requireAdmin, async (c) => {
    await c.env.DB.prepare("DELETE FROM markups WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ success: true });
  });
}
