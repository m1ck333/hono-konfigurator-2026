import { unstable_dev } from "wrangler";
import { writeFileSync } from "fs";

const w = await unstable_dev("src/index.ts", {
  config: "wrangler.jsonc",
  local: true,
  persist: true,
  experimental: { disableExperimentalWarning: true },
});

const j = async (r) => ({ status: r.status, body: await r.json() });
try {
  // catalog
  const cat = await j(await w.fetch("http://l/api/catalog"));
  console.log("catalog:", cat.status, "models=", cat.body.models?.length, "equip=", cat.body.equipment?.length, "cats=", cat.body.categories?.length);

  // render (model 1 + handle overlay)
  const img = await w.fetch("http://l/api/door/image", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: 1, equipment: [1] }),
  });
  const buf = Buffer.from(await img.arrayBuffer());
  console.log("render:", img.status, img.headers.get("content-type"), buf.length, "bytes");
  if (img.headers.get("content-type") === "image/png") writeFileSync("out.png", buf);

  // login
  const login = await j(await w.fetch("http://l/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Admin", password: "Algreen2026!!!" }),
  }));
  console.log("login:", login.status, login.body.token ? `token(role=${login.body.user.role})` : JSON.stringify(login.body));
  const token = login.body.token;

  // me
  const me = await j(await w.fetch("http://l/api/me", { headers: { Authorization: `Bearer ${token}` } }));
  console.log("me:", me.status, JSON.stringify(me.body.user));

  // admin users list (protected)
  const users = await j(await w.fetch("http://l/api/admin/users", { headers: { Authorization: `Bearer ${token}` } }));
  console.log("admin/users:", users.status, JSON.stringify(users.body.users));

  // admin without token -> should 401
  const noauth = await w.fetch("http://l/api/admin/users");
  console.log("admin/users (no token):", noauth.status);

  // price WITHOUT token -> 401 (price-visibility rule enforced at API)
  const priceNoAuth = await w.fetch("http://l/api/calculate-price", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: 1, equipment: [1] }),
  });
  console.log("price (no token):", priceNoAuth.status);

  // price WITH token, vat 20% + discount 10%
  const price = await j(await w.fetch("http://l/api/calculate-price", {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ modelId: 1, equipment: [1], vat: 20, discount: 10 }),
  }));
  console.log("price (auth, vat20 disc10):", price.status, JSON.stringify(price.body.data?.totalPrice), "adminMarkup=" + price.body.data?.defaultAdminMarkup);

  // inquiry (public)
  const inq = await w.fetch("http://l/api/submit-inquiry", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Test", email: "t@t.rs", message: "hi", config: { modelId: 1 } }),
  });
  console.log("submit-inquiry:", inq.status);

  // printed content store + list
  const pc = await j(await w.fetch("http://l/api/printed-contents", {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: "<h1>Offer</h1>" }),
  }));
  console.log("printed-contents store:", pc.status, JSON.stringify(pc.body));
  const pcList = await j(await w.fetch("http://l/api/user/printed-contents", { headers: { Authorization: `Bearer ${token}` } }));
  console.log("printed-contents list:", pcList.status, "count=" + pcList.body.printedContents?.length);
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await w.stop();
}
