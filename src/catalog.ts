import type { Hono } from "hono";

type Env = { Bindings: { DB: D1Database } };

// attach a `translations` array to each row. Fetches the whole (small) translations
// table and groups in JS — avoids D1's bound-variable limit on large IN clauses.
async function withTranslations(db: D1Database, rows: any[], transTable: string, fk: string) {
  if (!rows.length) return rows;
  const trans = (await db.prepare(`SELECT * FROM ${transTable}`).all()).results as any[];
  const byId: Record<number, any[]> = {};
  for (const t of trans) (byId[t[fk]] ??= []).push(t);
  return rows.map((r) => ({ ...r, translations: byId[r.id] ?? [] }));
}

const all = async (db: D1Database, sql: string) => (await db.prepare(sql).all()).results as any[];

// equipment_other category id -> canonical FE code (mirrors the migration)
const CAT_CODE: Record<number, string> = {
  1: "handrail", 2: "doorknobInside", 3: "rosette", 4: "parapetProtection",
  5: "accessControl", 6: "spy", 7: "cylinder", 8: "hinges",
  9: "electromagneticReceiver", 10: "automaticClosingDevice", 11: "houseNumbers",
};

export function registerCatalog(app: Hono<Env>) {
  // ---- default-items (seeds the FE config on load) ----
  app.get("/api/default-items", async (c) => {
    const db = c.env.DB;
    const door = await all(db, "SELECT * FROM doors WHERE is_default=1");
    for (const d of door) d.color = await db.prepare("SELECT * FROM colors WHERE id=?").bind(d.color_id).first();
    const equipment_system = await withTranslations(db, await all(db, "SELECT * FROM equipment_systems WHERE is_default=1"), "equipment_system_translations", "equipment_id");
    const equipment_glass = await withTranslations(db, await all(db, "SELECT * FROM equipment_glasses WHERE is_default=1"), "equipment_glass_translations", "glass_id");
    const equipment_lock = await withTranslations(db, await all(db, "SELECT * FROM equipment_locks WHERE is_default=1"), "equipment_lock_translations", "lock_id");
    const equipment_other = await withTranslations(db, await all(db, "SELECT * FROM equipment_others WHERE is_default=1"), "equipment_other_translations", "equipment_id");
    for (const e of equipment_other) e.category = await db.prepare("SELECT * FROM equipment_other_categories WHERE id=?").bind(e.category_id).first();
    return c.json({ door, equipment_system, equipment_glass, equipment_lock, equipment_other });
  });

  // ---- doors ----
  app.get("/api/doors", async (c) => {
    const doors = await all(c.env.DB, "SELECT * FROM doors ORDER BY sort_order IS NULL, sort_order ASC");
    for (const d of doors) d.color = await c.env.DB.prepare("SELECT * FROM colors WHERE id=?").bind(d.color_id).first();
    return c.json({ success: true, doors });
  });

  // ---- colors + categories ----
  app.get("/api/colors", async (c) => {
    const colors = await all(c.env.DB, "SELECT * FROM colors ORDER BY sort_order IS NULL, sort_order ASC");
    for (const col of colors) {
      const cat = col.color_category_id ? await c.env.DB.prepare("SELECT * FROM color_categories WHERE id=?").bind(col.color_category_id).first<any>() : null;
      col.color_category = cat ? { ...cat, translations: await all(c.env.DB, `SELECT * FROM color_category_translations WHERE color_category_id=${cat.id}`) } : null;
    }
    return c.json({ success: true, colors });
  });
  app.get("/api/color-categories", async (c) =>
    c.json({ success: true, color_categories: await withTranslations(c.env.DB, await all(c.env.DB, "SELECT * FROM color_categories ORDER BY sort_order"), "color_category_translations", "color_category_id") }));

  // ---- equipment (flat) ----
  app.get("/api/equipment-systems", async (c) =>
    c.json({ success: true, equipment_systems: await withTranslations(c.env.DB, await all(c.env.DB, "SELECT * FROM equipment_systems ORDER BY sort_order"), "equipment_system_translations", "equipment_id") }));
  app.get("/api/equipment-glasses", async (c) =>
    c.json({ success: true, equipment_glasses: await withTranslations(c.env.DB, await all(c.env.DB, "SELECT * FROM equipment_glasses ORDER BY sort_order"), "equipment_glass_translations", "glass_id") }));
  // default-glass: FE fetchDefaultGlass expects a BARE array of the is_default glasses (with translations)
  app.get("/api/default-glass", async (c) =>
    c.json(await withTranslations(c.env.DB, await all(c.env.DB, "SELECT * FROM equipment_glasses WHERE is_default=1 ORDER BY sort_order"), "equipment_glass_translations", "glass_id")));
  app.get("/api/equipment-locks", async (c) =>
    c.json({ success: true, equipment_locks: await withTranslations(c.env.DB, await all(c.env.DB, "SELECT * FROM equipment_locks ORDER BY sort_order"), "equipment_lock_translations", "lock_id") }));

  // ---- equipment-others (grouped by category, matches Laravel) ----
  app.get("/api/equipment-others", async (c) => {
    const db = c.env.DB;
    const rows = await withTranslations(db, await all(db, "SELECT * FROM equipment_others ORDER BY sort_order"), "equipment_other_translations", "equipment_id");
    const cats = await all(db, "SELECT * FROM equipment_other_categories");
    const catName = (id: number) => cats.find((x) => x.id === id)?.name ?? CAT_CODE[id] ?? `cat${id}`;
    const grouped: Record<string, any> = {};
    for (const e of rows) {
      const name = catName(e.category_id);
      const srName = (e.translations as any[]).find((t) => t.language === "sr")?.name ?? null;
      (grouped[name] ??= { category_name: name, category_id: e.category_id, groupedBySubcategory: {}, equipments: [] });
      grouped[name].equipments.push({ ...e, sr_name: srName });
      if (e.subcategory) (grouped[name].groupedBySubcategory[e.subcategory] ??= []).push(e);
    }
    return c.json({ success: true, equipment_others: grouped });
  });
  app.get("/api/equipment-other-categories", async (c) =>
    c.json({ success: true, equipment_other_categories: await all(c.env.DB, "SELECT * FROM equipment_other_categories") }));

  // ---- houses ----
  app.get("/api/houses", async (c) => c.json({ success: true, houses: await all(c.env.DB, "SELECT * FROM houses") }));
  app.get("/api/house-colors", async (c) => c.json({ success: true, house_colors: await all(c.env.DB, "SELECT * FROM house_colors ORDER BY sort_order") }));
}
