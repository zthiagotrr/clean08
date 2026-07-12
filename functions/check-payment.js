const { getSupabase } = require("./lib/supabase");

const MASTERFY_BASE = "https://api.masterfypagamentos.com/v1";
const MASTERFY_KEY  = process.env.MASTERFY_API_KEY;

const UTMIFY_TOKEN = "lzASZob4ldSJJc3jT1LILy9alPxWJgpnPhCh";

async function sendUtmifyOrder(txData, transactionId, paidAt) {
  try {
    const amountCents     = Math.round((txData.amount || 43.10) * 100);
    const gatewayFeeCents = Math.round(amountCents * 0.015);
    const netCents        = amountCents - gatewayFeeCents;
    const payload = {
      orderId: transactionId, platform: "Masterfy", paymentMethod: "pix", status: "paid",
      createdAt: txData.created_at || new Date().toISOString().replace("T"," ").slice(0,19),
      approvedDate: paidAt || new Date().toISOString().replace("T"," ").slice(0,19),
      refundedAt: null,
      customer: { name: txData.customer_name||null, email: txData.customer_email||null, phone: txData.customer_phone||null, document: txData.customer_cpf||null, country:"BR", ip:"177.0.0.1" },
      products: [{ id:"livro-falante-001", name:"Livro Falante", planId:null, planName:null, quantity:1, priceInCents:amountCents }],
      trackingParameters: { src:null, sck:null, utm_source:txData.utm_source||null, utm_campaign:txData.utm_campaign||null, utm_medium:txData.utm_medium||null, utm_content:txData.utm_content||null, utm_term:txData.utm_term||null },
      commission: { totalPriceInCents:amountCents, gatewayFeeInCents:gatewayFeeCents, userCommissionInCents:netCents, currency:"BRL" },
      isTest: false,
    };
    const resp = await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method:"POST", headers:{"Content-Type":"application/json","x-api-token":UTMIFY_TOKEN}, body:JSON.stringify(payload),
    });
    console.log(`[UTMify] status ${resp.status}: ${await resp.text()}`);
  } catch (err) { console.error("[UTMify] Erro:", err); }
}
      createdAt: txData.created_at || new Date().toISOString().replace("T"," ").slice(0,19),
      approvedDate: paidAt || new Date().toISOString().replace("T"," ").slice(0,19),
      refundedAt: null,
      customer: { name: txData.customer_name||null, email: txData.customer_email||null, phone: txData.customer_phone||null, document: txData.customer_cpf||null, country:"BR", ip:"177.0.0.1" },
      products: [{ id:"livro-falante-001", name:"Livro Falante", planId:null, planName:null, quantity:1, priceInCents:amountCents }],
      trackingParameters: { src:null, sck:null, utm_source:txData.utm_source||null, utm_campaign:txData.utm_campaign||null, utm_medium:txData.utm_medium||null, utm_content:txData.utm_content||null, utm_term:txData.utm_term||null },
      commission: { totalPriceInCents:amountCents, gatewayFeeInCents:gatewayFeeCents, userCommissionInCents:netCents, currency:"BRL" },
      isTest: false,
    };
    const resp = await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method:"POST", headers:{"Content-Type":"application/json","x-api-token":UTMIFY_TOKEN}, body:JSON.stringify(payload),
    });
    console.log(`[UTMify] status ${resp.status}: ${await resp.text()}`);
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET,POST,OPTIONS" }, body:"" };
  }

  let transactionId = event.queryStringParameters?.id || event.queryStringParameters?.transactionId;
  if (event.httpMethod === "POST") {
    try { const b = event.body ? JSON.parse(event.body) : {}; transactionId = b?.transactionId || b?.id || transactionId; } catch {}
  }

  if (!transactionId) return jsonResponse(400, { success: false, error: "Informe o transactionId" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let statusResp, text = "";
  try {
    // Masterfy: GET /payment/{id}
    statusResp = await fetch(`${MASTERFY_BASE}/payment/${encodeURIComponent(transactionId)}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${MASTERFY_KEY}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });
    text = await statusResp.text();
  } catch (err) {
    clearTimeout(timeout);
    return jsonResponse(502, { success: false, error: "Falha ao consultar status: " + String(err) });
  } finally { clearTimeout(timeout); }

  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }

  if (!statusResp.ok) {
    return jsonResponse(statusResp.status, { success: false, error: parsed?.message || text || "Erro ao consultar pagamento" });
  }

  // Masterfy status: PENDING | PAID | EXPIRED | REFUNDED | CANCELLED
  const rawStatus = (parsed.status || "PENDING").toUpperCase();
  const paid      = rawStatus === "PAID";
  const status    = paid ? "paid" : rawStatus.toLowerCase();
  const paidAt    = parsed.paidAt || null;

  try {
    const supabase = getSupabase();
    if (paid) {
      const { data: txData } = await supabase.from("transactions").select("status,customer_name,customer_email,customer_phone,customer_cpf,amount,created_at,utm_source,utm_campaign,utm_medium,utm_content,utm_term").eq("transaction_id", transactionId).single();
      const alreadyPaid = txData?.status === "paid";
      await supabase.from("transactions").update({ status, paid_at: paidAt || new Date().toISOString() }).eq("transaction_id", transactionId);
      if (!alreadyPaid && txData) await sendUtmifyOrder(txData, transactionId, paidAt);
    } else {
      await supabase.from("transactions").update({ status }).eq("transaction_id", transactionId);
    }
  } catch (_) {}

  return jsonResponse(200, { success: true, transactionId, status, paid, paidAt });
};
