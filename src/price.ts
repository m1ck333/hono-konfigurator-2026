import type { Hono } from "hono";
import { requireAuth, type JwtUser } from "./auth";

type Env = { Bindings: { DB: D1Database }; Variables: { user: JwtUser } };

const round = (n: number, d = 2) => { const p = 10 ** d; return Math.round(n * p) / p; };

function features(type = "single-leaf-door") {
  return {
    hasLeftGlass: type.includes("both") || type.includes("left"),
    hasRightGlass: type.includes("both") || type.includes("right"),
    hasTransom: type.includes("transom"),
    hasDoubleDoor: type.includes("double"),
  };
}

const price = async (db: D1Database, table: string, id: unknown): Promise<number> => {
  if (id == null) return 0;
  const r = await db.prepare(`SELECT price FROM ${table} WHERE id=?`).bind(id).first<{ price: number }>();
  return r ? Number(r.price) : 0;
};

export function registerPrice(app: Hono<Env>) {
  app.post("/api/calculate-price", requireAuth, async (c) => {
    const db = c.env.DB;
    const user = c.get("user");
    const d = await c.req.json<any>();
    const vat = Number(d.vat ?? 0);
    const discount = Number(d.discount ?? 0);
    const f = features(d.type);
    const width = Number(d.width), height = Number(d.height);

    // markups
    let adminMarkup = 0;
    if (user.role !== "admin") {
      const row = await db.prepare("SELECT m.markup_value AS v FROM markups m JOIN users u ON u.id=m.user_id WHERE u.role='admin' AND m.default=1 LIMIT 1").first<{ v: number }>();
      adminMarkup = row?.v ?? 0;
    }
    const um = await db.prepare("SELECT markup_value AS v FROM markups WHERE user_id=? AND markup_label=? LIMIT 1").bind(user.id, d.markupLabel ?? "default").first<{ v: number }>();
    const userMarkup = um?.v ?? 0;

    const section = (base: number) => {
      const withMarkups = base * (1 - discount / 100) * (1 + adminMarkup / 100) * (1 + userMarkup / 100);
      return { priceWithoutVat: round(withMarkups), priceWithVat: round(withMarkups * (1 + vat / 100)) };
    };

    // --- model (area * price) ---
    const doorPrice = await price(db, "doors", d["model-id"]);
    let mWidth = width;
    if (f.hasDoubleDoor) mWidth += Number(d.halfPanelWidth ?? 0);
    const modelPrice = section(round((mWidth * height) / 1e6 * doorPrice, 3));

    // --- system (perimeter formulas) ---
    const sysPrice = await price(db, "equipment_systems", d["system-id"]);
    const tH = Number(d.upperGlassHeight ?? 0), lW = Number(d.leftSideWidth ?? 0), rW = Number(d.rightSideWidth ?? 0);
    let sysBase: number;
    if (f.hasDoubleDoor) {
      sysBase = f.hasTransom && f.hasLeftGlass && f.hasRightGlass
        ? ((2 * (height + tH)) + (3 * (width * 2 + lW + rW)) + (7 * height) + (4 * width)) / 1000 * sysPrice
        : ((7 * height) + (4 * (width * 2))) / 1000 * sysPrice;
    } else if (f.hasTransom) {
      if (f.hasLeftGlass && f.hasRightGlass) sysBase = ((2 * (height + tH)) + (3 * (width + lW + rW)) + (4 * height) + (2 * width)) / 1000 * sysPrice;
      else if (f.hasLeftGlass) sysBase = ((2 * (height + tH)) + (3 * (width + lW)) + (3 * height) + (2 * width)) / 1000 * sysPrice;
      else if (f.hasRightGlass) sysBase = ((2 * (height + tH)) + (3 * (width + rW)) + (3 * height) + (2 * width)) / 1000 * sysPrice;
      else sysBase = ((2 * (height + tH)) + (5 * width) + (2 * height)) / 1000 * sysPrice;
    } else if (f.hasLeftGlass && f.hasRightGlass) {
      sysBase = ((5 * height) + (2 * (width + lW + rW)) + (2 * width)) / 1000 * sysPrice;
    } else if (f.hasLeftGlass) {
      sysBase = ((5 * height) + (2 * (width + lW)) + (2 * width)) / 1000 * sysPrice;
    } else if (f.hasRightGlass) {
      sysBase = ((5 * height) + (2 * (width + rW)) + (2 * width)) / 1000 * sysPrice;
    } else {
      sysBase = ((4 * height) + (4 * width)) / 1000 * sysPrice;
    }
    const systemPrice = section(sysBase);

    // --- color (flat) ---
    const colorPrice = section(await price(db, "colors", d["panel-color-id"]));

    // --- equipment (lock + others, hinges x3/x4) ---
    let equipBase = 0;
    const eq = d.equipment ?? {};
    if (eq.lock?.id) equipBase += await price(db, "equipment_locks", eq.lock.id);
    for (const [key, item] of Object.entries<any>(eq)) {
      if (key === "lock" || !item?.id) continue;
      let p = await price(db, "equipment_others", item.id);
      if (key === "hinges") p *= height >= 2400 ? 4 : 3;
      equipBase += p;
    }
    const equipmentPrices = section(equipBase);

    // --- glass (area * price per section) ---
    let glassBase = 0;
    let transomWidth = width;
    if (f.hasDoubleDoor) transomWidth += Number(d.halfPanelWidth ?? 0);
    if (f.hasLeftGlass) transomWidth += lW;
    if (f.hasRightGlass) transomWidth += rW;
    if (f.hasTransom && d["transom-glass-id"]) {
      glassBase += (transomWidth * tH) / 1e6 * await price(db, "equipment_glasses", d["transom-glass-id"]);
    }
    if (f.hasLeftGlass && d["side-glass-id"]) {
      glassBase += (height * lW) / 1e6 * await price(db, "equipment_glasses", d["side-glass-id"]) * Number(d["left-side-glass-number"] ?? 1);
    }
    if (f.hasRightGlass && d["side-glass-id"]) {
      glassBase += (height * rW) / 1e6 * await price(db, "equipment_glasses", d["side-glass-id"]) * Number(d["right-side-glass-number"] ?? 1);
    }
    const glassPrices = section(glassBase);

    const baseWithoutVat = round(modelPrice.priceWithoutVat + systemPrice.priceWithoutVat + colorPrice.priceWithoutVat + equipmentPrices.priceWithoutVat + glassPrices.priceWithoutVat);
    return c.json({
      data: {
        modelPrice, systemPrice, colorPrice, equipmentPrices, glassPrices,
        totalPrice: { priceWithoutVat: baseWithoutVat, priceWithVat: round(baseWithoutVat * (1 + vat / 100)) },
        defaultAdminMarkup: adminMarkup, userMarkup, discount, vat,
      },
    });
  });
}
