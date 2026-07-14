import { unstable_dev } from "wrangler";
const w = await unstable_dev("src/index.ts", { config: "wrangler.jsonc", local: true, persist: true, experimental: { disableExperimentalWarning: true } });
const j = async (m, p, b, t) => {
  const r = await w.fetch("http://l" + p, { method: m, headers: { "content-type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
try {
  const login = await j("POST", "/api/login", { username: "testadmin", password: "Algreen2026!!!" });
  console.log("login:", login.status, login.body?.token ? "token(role=" + login.body.user.role + ")" : JSON.stringify(login.body));
  const t = login.body?.token;
  const create = await j("POST", "/api/colors", { color_code: "TEST-1", price: 5, is_shown: 1 }, t);
  console.log("create color:", create.status, JSON.stringify(create.body));
  const id = create.body?.id;
  console.log("update:", (await j("PUT", "/api/colors/" + id, { price: 9 }, t)).status);
  const found = (await j("GET", "/api/colors")).body?.colors?.find((x) => x.id === id);
  console.log("verify: code=" + found?.color_code, "price=" + found?.price);
  console.log("delete:", (await j("DELETE", "/api/colors/" + id, null, t)).status);
  console.log("gone?", !(await j("GET", "/api/colors")).body?.colors?.some((x) => x.id === id));
  console.log("create (no token):", (await j("POST", "/api/colors", { color_code: "X" })).status);
} catch (e) { console.log("ERR", e.message); } finally { await w.stop(); }
