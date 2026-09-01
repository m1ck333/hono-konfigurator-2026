// Inquiry notification email — sent through the existing Algreen mailbox via Loopia SMTP
// (worker-mailer over the Worker's TCP socket). No third-party mail service. Builds an HTML
// summary of the whole configuration the customer created + attaches the two rendered door images.
// Best-effort: the inquiry is always stored in D1 regardless of whether email succeeds.
import { WorkerMailer } from "worker-mailer";

export interface EmailEnv {
  SMTP_HOST?: string; // mailcluster.loopia.se
  SMTP_PORT?: string; // "465" (implicit TLS) or "587" (STARTTLS)
  SMTP_USER?: string; // upit@algreen.rs
  SMTP_PASS?: string; // secret
  INQUIRY_FROM?: string; // upit@algreen.rs
  INQUIRY_TO?: string; // info@algreen.rs (or the test address)
}

export interface Inquiry {
  fullName?: string;
  name?: string;
  email?: string;
  phone?: string;
  city?: string;
  postalCode?: string;
  street?: string;
  message?: string;
  configuration?: unknown; // sectionsSerbian: [{ title, data }, ...]
  innerDoorImage?: string | null; // raw base64 PNG
  outerDoorImage?: string | null;
}

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// Render an arbitrary (possibly nested) value from a config section as rows.
function renderValue(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "object") return esc(value);
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v != null && v !== "");
  if (!entries.length) return "";
  return `<table style="border-collapse:collapse;width:100%">${entries
    .map(
      ([k, v]) =>
        `<tr><td style="padding:3px 10px 3px 0;color:#555;vertical-align:top;white-space:nowrap">${esc(
          k
        )}</td><td style="padding:3px 0">${renderValue(v)}</td></tr>`
    )
    .join("")}</table>`;
}

function buildHtml(inq: Inquiry): string {
  const customer = [
    ["Ime", inq.fullName || inq.name],
    ["Email", inq.email],
    ["Telefon", inq.phone],
    ["Grad", inq.city],
    ["Poštanski broj", inq.postalCode],
    ["Adresa", inq.street],
    ["Poruka", inq.message],
  ]
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:3px 10px 3px 0;color:#555;white-space:nowrap">${k}</td><td style="padding:3px 0"><b>${esc(
          v
        )}</b></td></tr>`
    )
    .join("");

  // The FE sends `configuration` as an OBJECT keyed by section ({ construction:{title,data}, ... }),
  // not an array — accept both so the settings actually render (not just the door image).
  const rawCfg = inq.configuration;
  const sections: Array<{ title?: string; data?: unknown }> = Array.isArray(rawCfg)
    ? (rawCfg as Array<{ title?: string; data?: unknown }>)
    : rawCfg && typeof rawCfg === "object"
    ? (Object.values(rawCfg as Record<string, unknown>) as Array<{ title?: string; data?: unknown }>)
    : [];
  const configHtml = sections
    .map((s) => {
      const body = renderValue(s?.data ?? s);
      if (!body) return "";
      return `<h3 style="margin:18px 0 6px;font-size:15px;color:#0a6b5e;border-bottom:1px solid #e5e5e5;padding-bottom:4px">${esc(
        s?.title ?? ""
      )}</h3>${body}`;
    })
    .join("");

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px">
    <h2 style="color:#0a6b5e;margin:0 0 4px">Nova ponuda / upit — Algreen konfigurator</h2>
    <table style="border-collapse:collapse;margin:8px 0 4px">${customer}</table>
    <h3 style="margin:20px 0 2px">Konfiguracija</h3>
    ${configHtml || "<p>(nema podataka o konfiguraciji)</p>"}
    <p style="margin-top:18px;color:#888;font-size:12px">Slike vrata (spoljni/unutrašnji izgled) su u prilogu.</p>
  </div>`;
}

export async function sendInquiryEmail(env: EmailEnv, inquiry: Inquiry): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.INQUIRY_FROM || !env.INQUIRY_TO) return;
  try {
    const port = Number(env.SMTP_PORT) || 465;
    const attachments: { filename: string; content: string; mimeType: string }[] = [];
    if (inquiry.outerDoorImage)
      attachments.push({ filename: "spoljni-izgled.png", content: inquiry.outerDoorImage, mimeType: "image/png" });
    if (inquiry.innerDoorImage)
      attachments.push({ filename: "unutrasnji-izgled.png", content: inquiry.innerDoorImage, mimeType: "image/png" });

    const who = inquiry.fullName || inquiry.name;
    await WorkerMailer.send(
      {
        host: env.SMTP_HOST,
        port,
        secure: port === 465, // implicit TLS on 465
        startTls: port === 587, // STARTTLS on 587
        credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
        authType: ["login", "plain"],
      },
      {
        from: { name: "Algreen Konfigurator", email: env.INQUIRY_FROM },
        to: env.INQUIRY_TO,
        reply: inquiry.email || undefined,
        subject: `Nova ponuda / upit${who ? ` — ${who}` : ""}`,
        html: buildHtml(inquiry),
        text: `Nova ponuda / upit${who ? ` — ${who}` : ""}. Detalji konfiguracije su u HTML verziji poruke; slike vrata su u prilogu.`,
        attachments,
      }
    );
  } catch (e) {
    console.error("inquiry email error", e);
  }
}
