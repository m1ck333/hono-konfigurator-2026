// Inquiry notification email — CF-native (Email Routing `send_email` binding, no third party).
// Builds an HTML summary of the whole configuration the customer created + attaches the two
// rendered door images. Best-effort: the inquiry is always stored in D1 regardless of email.
//
// cloudflare:email is a workerd built-in (available with nodejs_compat). mimetext builds the MIME.
// @ts-ignore -- workerd built-in module, no types on the Node side
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

interface Mailer {
  send(message: unknown): Promise<void>;
}
export interface EmailEnv {
  INQUIRY_MAILER?: Mailer; // send_email binding
  INQUIRY_FROM?: string; // e.g. konfigurator@vrebajpopust.rs
  INQUIRY_TO?: string; // e.g. info@algreen.rs
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

  const sections = Array.isArray(inq.configuration)
    ? (inq.configuration as Array<{ title?: string; data?: unknown }>)
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
  if (!env.INQUIRY_MAILER || !env.INQUIRY_FROM || !env.INQUIRY_TO) return;
  try {
    const msg = createMimeMessage();
    msg.setSender({ name: "Algreen Konfigurator", addr: env.INQUIRY_FROM });
    msg.setRecipient(env.INQUIRY_TO);
    msg.setSubject(
      `Nova ponuda / upit${inquiry.fullName || inquiry.name ? ` — ${inquiry.fullName || inquiry.name}` : ""}`
    );
    msg.addMessage({ contentType: "text/html", data: buildHtml(inquiry) });
    for (const [filename, b64] of [
      ["spoljni-izgled.png", inquiry.outerDoorImage],
      ["unutrasnji-izgled.png", inquiry.innerDoorImage],
    ] as const) {
      if (b64) msg.addAttachment({ filename, contentType: "image/png", data: b64 });
    }
    const message = new EmailMessage(env.INQUIRY_FROM, env.INQUIRY_TO, msg.asRaw());
    await env.INQUIRY_MAILER.send(message);
  } catch (e) {
    console.error("inquiry email error", e);
  }
}
