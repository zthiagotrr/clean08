const { getSupabase } = require("./lib/supabase");

const VOID_BASE    = "https://dash.voidpay.com.br/api/v1";
const VOID_PUB     = process.env.VOID_PUBLIC_KEY;
const VOID_SEC     = process.env.VOID_SECRET_KEY;
const UTMIFY_TOKEN = "lzASZob4ldSJJc3jT1LILy9alPxWJgpnPhCh";

async function sendUtmifyWaiting(transactionId, customerName, customerEmail, customerPhone, customerCpf, amountCents, utms) {
  try {
    const gatewayFeeCents = Math.round(amountCents * 0.015);
    const netCents        = amountCents - gatewayFeeCents;
    const now = new Date().toISOString().replace("T"," ").slice(0,19);
    const payload = {
      orderId:       transactionId,
      platform:      "VoidPay",
      paymentMethod: "pix",
      status:        "waiting_payment",
      createdAt:     now,
      approvedDate:  null,
      refundedAt:    null,
      customer: { name: customerName||null, email: customerEmail||null, phone: customerPhone||null, document: customerCpf||null, country:"BR", ip:"177.0.0.1" },
      products: [{ id:"5000-exercicios-expert-001", name:"5.000 Exercicios Expert", planId:null, planName:null, quantity:1, priceInCents:amountCents }],
      trackingParameters: { src:null, sck:null, utm_source:utms?.utm_source||null, utm_campaign:utms?.utm_campaign||null, utm_medium:utms?.utm_medium||null, utm_content:utms?.utm_content||null, utm_term:utms?.utm_term||null },
      commission: { totalPriceInCents:amountCents, gatewayFeeInCents:gatewayFeeCents, userCommissionInCents:netCents, currency:"BRL" },
      isTest: false,
    };
    const resp = await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method:"POST", headers:{"Content-Type":"application/json","x-api-token":UTMIFY_TOKEN}, body:JSON.stringify(payload),
    });
    console.log(`[UTMify waiting_payment] ${resp.status}: ${await resp.text()}`);
  } catch (err) { console.error("[UTMify] Erro:", err); }
}

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

function formatCpf(cpf) {
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

function getDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

async function postWithRetry(url, payload, headers) {
  const delays = [1000, 2000, 4000];
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, { method:"POST", headers, body:JSON.stringify(payload), signal:controller.signal });
      clearTimeout(timeout);
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
    return { statusCode:204, headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET,POST,OPTIONS"}, body:"" };
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }

  const randDigits = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join("");
  const randId = randDigits(8);

  const rawAmount   = body.amount ?? body.valor ?? body.total ?? 6170;
  const amountCents = normalizeAmountCents(rawAmount);

  const customerName  = (body.nome || body.name || body.customer_name || `Cliente ${randId}`).toString().trim();
  const customerEmail = (body.email || body.customer_email || `cliente${randId}@gmail.com`).toString().trim();
  const customerPhone = (body.phone || body.customer_phone || "(11) 99999-9999").toString();
  const cpfRaw        = (body.cpf || body.document || body.customer_cpf || "").toString().replace(/\D/g, "");
  const customerCpf   = cpfRaw.length === 11 ? cpfRaw : gerarCpfValido();
  const utms          = body.utm || {};

  const amount = amountCents / 100;

  const payload = {
    identifier: `order_${randId}_${Date.now()}`,
    amount,
    client: {
      name:     customerName,
      email:    customerEmail,
      phone:    customerPhone,
      document: formatCpf(customerCpf),
    },
    products: [{
      id:       "5000-exercicios-expert-001",
      name:     "5.000 Exercicios Expert",
      quantity: 1,
      price:    amount,
    }],
    dueDate:     getDueDate(),
    callbackUrl: "https://lighthearted-swan-2eba8b.netlify.app/api/webhook-void",
    metadata: {
      utm_source:   utms.utm_source   || utms.source   || null,
      utm_medium:   utms.utm_medium   || utms.medium   || null,
      utm_campaign: utms.utm_campaign || utms.campaign || utms.campaign_name || null,
      utm_content:  utms.utm_content  || utms.content  || null,
      utm_term:     utms.utm_term     || utms.term     || null,
      fbclid:       utms.fbclid       || null,
      ttclid:       utms.ttclid       || null,
      gclid:        utms.gclid        || null,
      campaign_id:  utms.campaign_id  || null,
      campaign_name:utms.campaign_name|| null,
      adset_id:     utms.adset_id     || null,
      ad_id:        utms.ad_id        || null,
      placement:    utms.placement    || null,
    },
  };

  const headers = {
    "Content-Type":  "application/json",
    "x-public-key":  VOID_PUB,
    "x-secret-key":  VOID_SEC,
  };

  let resp;
  try {
    resp = await postWithRetry(`${VOID_BASE}/gateway/pix/receive`, payload, headers);
  } catch (err) {
    return jsonResponse(502, { success: false, error: "Falha ao conectar com gateway: " + String(err) });
  }

  const text = await resp.text();
  if (!resp.ok) {
    let errMsg = text;
    try { errMsg = JSON.parse(text)?.message || errMsg; } catch {}
    return jsonResponse(resp.status, { success: false, error: errMsg, raw: text });
  }

  let parsed = {};
  try { parsed = JSON.parse(text); } catch {
    return jsonResponse(500, { success: false, error: "Resposta invÃ¡lida da gateway", raw: text });
  }

  // VoidPay retorna: transactionId, status, pix.code
  const transactionId = parsed.transactionId || null;
  const pixCode       = parsed.pix?.code || null;

  try {
    const supabase = getSupabase();
    await supabase.from("transactions").insert({
      transaction_id: transactionId,
      amount:         amount,
      customer_name:  customerName,
      customer_email: customerEmail,
      customer_cpf:   customerCpf,
      customer_phone: customerPhone,
      status:         "PENDING",
      brcode:         pixCode,
      utm_source:     utms.utm_source   || null,
      utm_campaign:   utms.utm_campaign || null,
      utm_medium:     utms.utm_medium   || null,
      utm_content:    utms.utm_content  || null,
      utm_term:       utms.utm_term     || null,
    });
  } catch (_) {}

  // Dispara UTMify waiting_payment
  await sendUtmifyWaiting(transactionId, customerName, customerEmail, customerPhone, customerCpf, amountCents, utms);

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
