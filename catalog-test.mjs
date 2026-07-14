import { unstable_dev } from "wrangler";

const w = await unstable_dev("src/index.ts", {
  config: "wrangler.jsonc", local: true, persist: true,
  experimental: { disableExperimentalWarning: true },
});
const j = async (p) => (await w.fetch("http://l" + p)).json();
try {
  const di = await j("/api/default-items");
  console.log("default-items keys:", Object.keys(di).join(","));
  console.log("  door:", di.door?.length, "sys:", di.equipment_system?.length, "glass:", di.equipment_glass?.length, "lock:", di.equipment_lock?.length, "other:", di.equipment_other?.length);
  console.log("  door[0].color:", !!di.door?.[0]?.color, "other[0].translations:", di.equipment_other?.[0]?.translations?.length, "other[0].category:", di.equipment_other?.[0]?.category?.name);

  const doors = await j("/api/doors");
  console.log("doors:", doors.success, "count:", doors.doors?.length, "color?", !!doors.doors?.[0]?.color, "thumb:", doors.doors?.[0]?.thumbnail);

  const eo = await j("/api/equipment-others");
  console.log("equipment-others:", eo.success, "categories:", Object.keys(eo.equipment_others || {}).length, "| e.g.", Object.keys(eo.equipment_others || {}).slice(0, 4).join(","));

  const colors = await j("/api/colors");
  console.log("colors:", colors.success, "count:", colors.colors?.length, "cat?", !!colors.colors?.[0]?.color_category);
  const glasses = await j("/api/equipment-glasses");
  console.log("glasses:", glasses.success, "count:", glasses.equipment_glasses?.length, "trans?", glasses.equipment_glasses?.[0]?.translations?.length);
  const houses = await j("/api/houses");
  console.log("houses:", houses.success, "count:", houses.houses?.length);
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await w.stop();
}
