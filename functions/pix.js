const { getSupabase } = require("./lib/supabase");

const POSEIDON_BASE   = "https://app.poseidonpay.site/api/v1";
const POSEIDON_PUB    = process.env.POSEIDON_PUBLIC_KEY;
const POSEIDON_SEC    = process.env.POSEIDON_SECRET_KEY;

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

function normalizeAmount(rawAmount) {
  if (rawAmount == null) return 81.70;
  const n = Number(rawAmount);
  if (!Number.isFinite(n)) return 81.70;
  if (Number.isInteger(n) && n >= 100) return n / 100;
  return n;
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
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
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
  const randId = randDigits(8);

  const rawAmount = body.amount ?? body.valor ?? body.total ?? 8170;
  const amount    = normalizeAmount(rawAmount);

  const customerName  = (body.nome || body.name || body.customer_name || `Cliente ${randId}`).toString().trim();
  const customerEmail = (body.email || body.customer_email || `cliente${randId}@gmail.com`).toString().trim();
  const customerPhone = (body.phone || body.customer_phone || "(11) 99999-9999").toString();
  const cpfRaw        = (body.cpf || body.document || body.customer_cpf || "").toString().replace(/\D/g, "");
  const customerCpf   = cpfRaw.length === 11 ? cpfRaw : gerarCpfValido();

  const payload = {
    identifier: `order_${randId}_${Date.now()}`,
    amount,
    client: {
      name:     customerName,
      email:    customerEmail,
      phone:    customerPhone,
      document: formatCpf(customerCpf),
    },
    products: [
      {
        id:       process.env.POSEIDON_PRODUCT_ID || "livro-falante-001",
        name:     "Livro Falante",
        quantity: 1,
        price:    amount,
      }
    ],
    dueDate: getDueDate(),
  };

  const headers = {
    "Content-Type":  "application/json",
    "x-public-key":  POSEIDON_PUB,
    "x-secret-key":  POSEIDON_SEC,
  };

  let resp;
  try {
    resp = await postWithRetry(`${POSEIDON_BASE}/gateway/pix/receive`, payload, headers);
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
    return jsonResponse(500, { success: false, error: "Resposta inválida da gateway", raw: text });
  }

  // PoseidonPay retorna: transactionId, status, pix.code, pix.base64
  const transactionId = parsed.transactionId || null;
  const pixCode       = parsed.pix?.code || null;

  try {
    const supabase = getSupabase();
    await supabase.from("transactions").insert({
      transaction_id: transactionId,
      amount,
      customer_name:  customerName,
      customer_email: customerEmail,
      customer_cpf:   customerCpf,
      status:         "PENDING",
      brcode:         pixCode,
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
