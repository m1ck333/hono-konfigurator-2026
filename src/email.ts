// Best-effort inquiry notification email. Uses Resend if RESEND_API_KEY is set,
// otherwise no-ops (the inquiry is always stored in D1 regardless).
export interface EmailEnv {
  RESEND_API_KEY?: string;
  INQUIRY_FROM?: string;
  INQUIRY_TO?: string;
}

export async function sendInquiryEmail(
  env: EmailEnv,
  inquiry: { name?: string; email?: string; phone?: string; message?: string }
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.INQUIRY_TO || !env.INQUIRY_FROM) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.INQUIRY_FROM,
        to: env.INQUIRY_TO,
        subject: `Nova ponuda / upit${inquiry.name ? ` — ${inquiry.name}` : ""}`,
        text: [
          `Ime: ${inquiry.name ?? "-"}`,
          `Email: ${inquiry.email ?? "-"}`,
          `Telefon: ${inquiry.phone ?? "-"}`,
          "",
          inquiry.message ?? "",
        ].join("\n"),
      }),
    });
    if (!res.ok) console.error("inquiry email failed", res.status, await res.text());
  } catch (e) {
    console.error("inquiry email error", e);
  }
}
