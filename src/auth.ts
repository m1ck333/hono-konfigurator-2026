import { sign, verify } from "hono/jwt";
import type { Context, Next } from "hono";
import bcrypt from "bcryptjs";

// PBKDF2 password hashing via Web Crypto (Workers-safe; no bcrypt).
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = 100000;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // migrated Laravel hashes are bcrypt ($2y$); bcryptjs handles $2a/$2b, normalize $2y->$2b
  if (stored.startsWith("$2")) {
    return bcrypt.compareSync(password, stored.replace(/^\$2y\$/, "$2b$"));
  }
  const [algo, iterStr, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2") return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64(saltB64), iterations: Number(iterStr), hash: "SHA-256" }, key, 256);
  return b64(new Uint8Array(bits)) === hashB64;
}

export interface JwtUser { id: number; username: string; role: string }

export function signToken(secret: string, user: JwtUser): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 days
  return sign({ ...user, exp }, secret);
}

// Middleware — requireAuth sets c.get("user"); requireAdmin must run after it.
export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const payload = (await verify(token, c.env.JWT_SECRET, "HS256")) as unknown as JwtUser;
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: "invalid token" }, 401);
  }
}

export async function requireAdmin(c: Context, next: Next) {
  const user = c.get("user") as JwtUser | undefined;
  if (!user || user.role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
}
