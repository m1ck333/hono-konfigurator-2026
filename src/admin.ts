import type { Context, Hono } from "hono";
import { requireAuth, requireAdmin, hashPassword, verifyPassword, type JwtUser } from "./auth";

type Env = { Bindings: { DB: D1Database; ASSETS: R2Bucket }; Variables: { user: JwtUser } };

const q = (id: string) => `"${id}"`;

// Staff (admin/superadmin) accounts may only be managed by a superadmin. A plain admin may
// create/edit/delete dealer/user accounts, never staff — enforced on every user-mutating route.
const isStaffRole = (r?: string | null): boolean => r === "admin" || r === "superadmin";
async function callerMayManageTarget(c: Context<Env>, targetId: string | undefined): Promise<boolean> {
  if (c.get("user").role === "superadmin") return true;
  if (!targetId) return false;
  const target = await c.env.DB.prepare("SELECT role FROM users WHERE id=?").bind(targetId).first<{ role: string | null }>();
  return !isStaffRole(target?.role ?? null);
}

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
    // Only a superadmin may create staff (admin/superadmin) accounts; a plain admin can only make dealers/users.
    if (isStaffRole(b.role) && c.get("user").role !== "superadmin")
      return c.json({ error: "only a superadmin can create admin accounts" }, 403);
    try {
      const r = await c.env.DB.prepare("INSERT INTO users (username, password, role, city) VALUES (?,?,?,?)")
        .bind(b.username, await hashPassword(b.password), b.role || "user", b.city ?? null).run();
      return c.json({ success: true, id: r.meta.last_row_id }, 201);
    } catch { return c.json({ error: "username taken" }, 409); }
  });
  app.delete("/api/users/:id", requireAuth, requireAdmin, async (c) => {
    if (!(await callerMayManageTarget(c, c.req.param("id")))) return c.json({ error: "only a superadmin can delete admin accounts" }, 403);
    await c.env.DB.prepare("DELETE FROM users WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ success: true });
  });
  // The FE calls this with PUT (Laravel legacy); accept both PUT and POST so it can't drift again.
  // The change-password form sends { current_password, new_password, new_password_confirmation };
  // an admin reset sends { password }. Accept both, and verify the current password when supplied.
  app.on(["POST", "PUT"], "/api/password-update", requireAuth, async (c) => {
    const user = c.get("user");
    const b = await c.req.json<any>();
    const newPassword = b.new_password ?? b.password;
    if (!newPassword) return c.json({ error: "password required" }, 400);
    if (b.current_password !== undefined) {
      const row = await c.env.DB.prepare("SELECT password FROM users WHERE id=?").bind(user.id).first<{ password: string }>();
      if (!row || !(await verifyPassword(String(b.current_password), row.password)))
        return c.json({ error: "current password is incorrect", messageTranslation: "auth-messages.current-password-is-incorrect" }, 400);
    }
    await c.env.DB.prepare("UPDATE users SET password=? WHERE id=?").bind(await hashPassword(newPassword), user.id).run();
    return c.json({ success: true });
  });
  // Self-service profile update (PersonalInfo form) — updates the CALLER's own row (id from token).
  // Never lets a user change their own role or id (no self-escalation). FE uses PUT; accept POST too.
  app.on(["PUT", "POST"], "/api/update", requireAuth, async (c) => {
    const cols = await columns(c.env.DB, "users");
    const body = await c.req.json<Record<string, unknown>>();
    delete body.role;
    delete body.id;
    if (body.password) body.password = await hashPassword(String(body.password));
    const keys = cols.filter((k) => k in body);
    if (!keys.length) return c.json({ success: true });
    await c.env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${q(k)}=?`).join(",")} WHERE id=?`)
      .bind(...keys.map((k) => body[k] as never), c.get("user").id).run();
    return c.json({ success: true });
  });
  // edit / delete a user by id (FE uses the SINGULAR /api/user/:id)
  app.put("/api/user/:id", requireAuth, requireAdmin, async (c) => {
    const cols = await columns(c.env.DB, "users");
    const body = await c.req.json<Record<string, unknown>>();
    // Staff management is superadmin-only: block editing a staff account, or promoting anyone to staff.
    if ((!(await callerMayManageTarget(c, c.req.param("id"))) || (isStaffRole(body.role as string) && c.get("user").role !== "superadmin")))
      return c.json({ error: "only a superadmin can manage admin accounts" }, 403);
    if (body.password) body.password = await hashPassword(String(body.password));
    const keys = cols.filter((k) => k in body);
    if (!keys.length) return c.json({ success: true });
    await c.env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${q(k)}=?`).join(",")} WHERE id=?`)
      .bind(...keys.map((k) => body[k] as never), c.req.param("id")).run();
    return c.json({ success: true });
  });
  app.delete("/api/user/:id", requireAuth, requireAdmin, async (c) => {
    if (!(await callerMayManageTarget(c, c.req.param("id")))) return c.json({ error: "only a superadmin can delete admin accounts" }, 403);
    await c.env.DB.prepare("DELETE FROM users WHERE id=?").bind(c.req.param("id")).run();
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
  // set/clear the caller's default markup (must be registered BEFORE /api/markups/:id).
  // Scoped to the authenticated user's own markups (Laravel: $user->markups()).
  app.put("/api/markups/update-default", requireAuth, async (c) => {
    const user = c.get("user");
    const { id } = await c.req.json<{ id: number | null }>();
    await c.env.DB.prepare('UPDATE markups SET "default"=0 WHERE user_id=?').bind(user.id).run();
    if (id) {
      await c.env.DB.prepare('UPDATE markups SET "default"=1 WHERE id=? AND user_id=?').bind(id, user.id).run();
      return c.json({ success: true, message: "Default markup updated successfully" });
    }
    return c.json({ success: true, message: "Default markup cleared successfully" });
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
