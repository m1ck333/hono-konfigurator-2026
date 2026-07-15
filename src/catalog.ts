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

// attach the dmodels relation (via the dmodel_door pivot) to each door — the DoorModel
// sidebar uses door.dmodels[].suffix to build the display name (e.g. "1155-AG").
// Batched: ONE join query, grouped in JS (D1 round-trips are the bottleneck — never N+1).
async function attachDmodels(db: D1Database, doors: any[]) {
  const links = await all(db,
    `SELECT dd.door_id, dd.dmodel_id, dm.id, dm.dmodel_name, dm.suffix
     FROM dmodel_door dd JOIN dmodels dm ON dm.id = dd.dmodel_id`);
  const byDoor: Record<number, any[]> = {};
  for (const r of links) (byDoor[r.door_id] ??= []).push({
    id: r.id, dmodel_name: r.dmodel_name, suffix: r.suffix,
    pivot: { door_id: r.door_id, dmodel_id: r.dmodel_id },
  });
  for (const d of doors) d.dmodels = byDoor[d.id] ?? [];
}

// attach each row's `color` from the colors table — batched (one query, map in JS).
async function attachColors(db: D1Database, rows: any[]) {
  const colors = await all(db, "SELECT * FROM colors");
  const byId: Record<number, any> = {};
  for (const c of colors) byId[c.id] = c;
  for (const r of rows) r.color = r.color_id ? (byId[r.color_id] ?? null) : null;
}

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
    await attachColors(c.env.DB, doors);
    await attachDmodels(c.env.DB, doors);
    return c.json({ success: true, doors });
  });
  // single door (bare object) — the Glass sidebar reads has_glass/decorative_glass_name from here
  app.get("/api/doors/:id", async (c) => {
    const db = c.env.DB;
    const door = await db.prepare("SELECT * FROM doors WHERE id=?").bind(c.req.param("id")).first<any>();
    if (!door) return c.json({ error: "not found" }, 404);
    await attachColors(db, [door]);
    await attachDmodels(db, [door]);
    return c.json(door);
  });

  // ---- colors + categories (Laravel returns BARE arrays here) ----
  app.get("/api/colors", async (c) => {
    const db = c.env.DB;
    // 3 queries total (colors + categories + category-translations), grouped in JS — NOT N+1.
    const colors = await all(db, "SELECT * FROM colors ORDER BY sort_order IS NULL, sort_order ASC");
    const cats = await all(db, "SELECT * FROM color_categories");
    const trans = await all(db, "SELECT * FROM color_category_translations");
    const transByCat: Record<number, any[]> = {};
    for (const t of trans) (transByCat[t.color_category_id] ??= []).push(t);
    const catById: Record<number, any> = {};
    for (const cat of cats) catById[cat.id] = { ...cat, translations: transByCat[cat.id] ?? [] };
    for (const col of colors) col.color_category = col.color_category_id ? (catById[col.color_category_id] ?? null) : null;
    return c.json(colors);
  });
  app.get("/api/color-categories", async (c) =>
    c.json(await withTranslations(c.env.DB, await all(c.env.DB, "SELECT * FROM color_categories ORDER BY sort_order"), "color_category_translations", "color_category_id")));

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
      // Laravel attaches the category relation to the groupedBySubcategory items
      if (e.subcategory) (grouped[name].groupedBySubcategory[e.subcategory] ??= []).push({ ...e, category: { id: e.category_id, name } });
    }
    // subcategory parent items (is_subcategory=1), each with category {id,name} — matches Laravel
    const subcategories = await withTranslations(db, await all(db, "SELECT * FROM equipment_others WHERE is_subcategory=1 ORDER BY sort_order"), "equipment_other_translations", "equipment_id");
    for (const s of subcategories) s.category = { id: s.category_id, name: catName(s.category_id) };
    return c.json({ success: true, equipment_others: grouped, subcategories });
  });
  app.get("/api/equipment-other-categories", async (c) =>
    c.json({ success: true, categories: await all(c.env.DB, "SELECT * FROM equipment_other_categories") }));

  // ---- equipment-translations: all equipment names, grouped for the FE's getTranslation() ----
  app.get("/api/equipment-translations", async (c) => {
    const db = c.env.DB;
    const kebab = (s: string) => (s ?? "unknown_category").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const data: Record<string, any[]> = {};
    const cats = await all(db, "SELECT id, name FROM equipment_other_categories");
    const catKey: Record<number, string> = {};
    for (const cat of cats) catKey[cat.id] = kebab(cat.name);
    const eq = await all(db, "SELECT eo.category_id, t.equipment_id, t.language, t.name FROM equipment_other_translations t JOIN equipment_others eo ON eo.id = t.equipment_id");
    for (const r of eq) (data[catKey[r.category_id] ?? "unknown_category"] ??= []).push({ equipment_id: r.equipment_id, language: r.language, name: r.name });
    data.equipment_locks = (await all(db, "SELECT lock_id, language, name FROM equipment_lock_translations")).map((r) => ({ lock_id: r.lock_id, language: r.language, name: r.name }));
    data.equipment_glasses = (await all(db, "SELECT glass_id, language, name FROM equipment_glass_translations")).map((r) => ({ glass_id: r.glass_id, language: r.language, name: r.name }));
    data.equipment_systems = (await all(db, "SELECT equipment_id, language, description AS name FROM equipment_system_translations")).map((r) => ({ equipment_id: r.equipment_id, language: r.language, name: r.name }));
    return c.json({ success: true, data });
  });

  // ---- houses ----
  app.get("/api/houses", async (c) => c.json({ success: true, houses: await all(c.env.DB, "SELECT * FROM houses") }));
  app.get("/api/house-colors", async (c) => c.json({ success: true, colors: await all(c.env.DB, "SELECT * FROM house_colors ORDER BY id") }));
}
