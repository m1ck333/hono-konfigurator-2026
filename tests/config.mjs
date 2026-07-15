// Shared test config: targets, the render matrix, endpoint list, thresholds.
// Fixtures are captured from LARAVEL (the oracle) and the Worker is checked against them.
export const LARAVEL = process.env.LARAVEL_URL || "https://konfigurator-api.online";
export const WORKER = process.env.WORKER_URL || "https://konfigurator-be.m1ck33kc1m.workers.dev";

// RMSE (0..1) above which a render is considered a real (structural) divergence.
// Known-cosmetic frosted-glass texture nuance sits ~2%; a real bug (missing transom) was ~7%.
export const RMSE_THRESHOLD = 0.03;
// Contract endpoints must respond within this (ms) — guards against N+1 regressions.
export const PERF_BUDGET_MS = 1500;

// Test user for auth-positive smoke tests. Password comes from env so it isn't committed;
// without it, the auth-positive checks are skipped (the 401/403 negative checks still run).
export const TEST_USER = process.env.TEST_USER || "testuser";
export const TEST_PASS = process.env.TEST_PASS || "";

const NULL_EQUIP = Object.fromEntries(
  ["handrail","doorknobInside","rosette","parapetProtection","accessControl","spy",
   "cylinder","hinges","electromagneticReceiver","automaticClosingDevice","houseNumbers","lock"]
    .map((k) => [k, { id: null }])
);

export function baseConfig(over = {}) {
  return {
    "model-id": 2, "model-name": "1155", "panel-color": null, "frame-color": null,
    width: 1050, height: 2100, halfPanelWidth: 1050,
    leftSideWidth: 500, rightSideWidth: 500, upperGlassHeight: 500,
    type: "single-leaf-door", "DIN-opening-standard": "left-inside",
    "transom-glass-id": 6, "transom-glass-name": "ornament",
    "side-glass-id": 6, "side-glass-name": "ornament",
    "inner-glass-id": null, "left-side-glass-number": 1, "right-side-glass-number": 1,
    interiorDoorShown: false, equipment: structuredClone(NULL_EQUIP),
    ...over,
  };
}
const eq = (type, id) => { const e = structuredClone(NULL_EQUIP); e[type] = { id }; return { equipment: e }; };

// GET endpoints whose JSON *structure* is frozen (data values may change; shape must not).
export const CONTRACT_ENDPOINTS = [
  "/api/default-items", "/api/doors", "/api/doors/2", "/api/colors", "/api/color-categories",
  "/api/equipment-systems", "/api/equipment-glasses", "/api/equipment-locks",
  "/api/equipment-others", "/api/equipment-other-categories", "/api/equipment-translations",
  "/api/houses", "/api/house-colors", "/api/default-glass",
];

// Render matrix — door types, DIN, models, interior, equipment, glass. Each → a golden PNG.
const TYPES = [
  "single-leaf-door", "single-leaf-door-transom", "single-leaf-door-left-side-panel",
  "single-leaf-door-right-side-panel-transom", "single-leaf-door-both-side-panels",
  "single-leaf-door-both-side-panels-transom", "single-leaf-door-left-side-panel-transom",
  "double-leaf-door-both-side-panels", "double-leaf-door-both-side-panels-transom",
];
export const RENDER_CASES = [
  ...TYPES.map((t) => ({ name: `type_${t}`, cfg: baseConfig({ type: t }) })),
  ...["left-inside","left-outside","right-inside","right-outside"].map((d) => ({
    name: `din_${d}`, cfg: baseConfig({ type: "single-leaf-door-left-side-panel", "DIN-opening-standard": d }) })),
  { name: "interior_view", cfg: baseConfig({ type: "single-leaf-door-both-side-panels-transom", interiorDoorShown: true }) },
  ...[["1150",1],["1160",3],["1155",2]].map(([n,id]) => ({ name: `model_${n}`, cfg: baseConfig({ "model-id": id, "model-name": n }) })),
  // equipment overlays (ids are a snapshot; capture freezes them)
  { name: "eq_handrail",      cfg: baseConfig({ type: "single-leaf-door", ...eq("handrail", 1) }) },
  { name: "eq_doorknob_inner",cfg: baseConfig({ type: "single-leaf-door", interiorDoorShown: true, ...eq("doorknobInside", 92) }) },
  { name: "eq_rosette",       cfg: baseConfig({ type: "single-leaf-door", ...eq("rosette", 105) }) },
  { name: "eq_accessControl", cfg: baseConfig({ type: "single-leaf-door", ...eq("accessControl", 117) }) },
  { name: "eq_parapet",       cfg: baseConfig({ type: "single-leaf-door", ...eq("parapetProtection", 113) }) },
  { name: "eq_spy",           cfg: baseConfig({ type: "single-leaf-door", ...eq("spy", 129) }) },
  // hinges + closing device only show on outside-opening exterior (or inside-opening interior)
  { name: "eq_hinges",  cfg: baseConfig({ type: "single-leaf-door", "DIN-opening-standard": "left-outside", ...eq("hinges", 136) }) },
  { name: "eq_closing", cfg: baseConfig({ type: "single-leaf-door", "DIN-opening-standard": "left-outside", ...eq("automaticClosingDevice", 151) }) },
  // in-door glass textures
  ...[["staklo",null],["chinchilla",1],["sandblast",6]].map(([n,id]) => ({
    name: `glass_${n}`, cfg: baseConfig({ type: "single-leaf-door", "inner-glass-id": id }) })),
];
