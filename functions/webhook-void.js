const { getSupabase } = require("./lib/supabase");

const UTMIFY_TOKEN = "lzASZob4ldSJJc3jT1LILy9alPxWJgpnPhCh";

async function sendUtmify(status, transaction, client, orderItems, utmData) {
  try {
    const amountCents     = Math.round((transaction.amount || 0) * 100);
    const gatewayFeeCents = Math.round(amountCents * 0.015);
    const netCents        = amountCents - gatewayFeeCents;
    const createdAt       = (transaction.createdAt || new Date().toISOString()).replace("T"," ").slice(0,19);
    const paidAt          = (transaction.payedAt   || new Date().toISOString()).replace("T"," ").slice(0,19);
    const product         = orderItems?.[0]?.product;

    const payload = {
      orderId:       transaction.id,
      platform:      "VoidPay",
      paymentMethod: (transaction.paymentMethod || "pix").toLowerCase().replace("credit_card","credit_card").replace("pix","pix"),
      status,
      createdAt,
      approvedDate:  status === "paid"     ? paidAt : null,
      refundedAt:    status === "refunded" ? paidAt : null,
      customer: {
        name:     client?.name  || null,
        email:    client?.email || null,
        phone:    client?.phone || null,
        document: client?.cpf   || null,
        country:  "BR",
        ip:       utmData?.ip   || "177.0.0.1",
      },
      products: [{
        id:           product?.externalId || product?.id || "5000-exercicios-expert-001",
        name:         product?.name       || "5.000 Exercicios Expert",
        planId:       null,
        planName:     null,
        quantity:     orderItems?.[0]?.quantity || 1,
        priceInCents: amountCents,
      }],
      trackingParameters: {
        src:          null,
        sck:          null,
        utm_source:   utmData?.utm_source   || null,
        utm_campaign: utmData?.utm_campaign || null,
        utm_medium:   utmData?.utm_medium   || null,
        utm_content:  utmData?.utm_content  || null,
        utm_term:     utmData?.utm_term     || null,
        fbclid:       utmData?.fbclid       || null,
      },
      commission: {
        totalPriceInCents:     amountCents,
        gatewayFeeInCents:     gatewayFeeCents,
        userCommissionInCents: netCents,
        currency:              "BRL",
      },
      isTest: false,
    };

    const resp = await fetch("https://api.utmify.com.br/api-credentials/orders", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-api-token": UTMIFY_TOKEN },
      body:    JSON.stringify(payload),
    });
    console.log(`[UTMify webhook] ${status} -> ${resp.status}: ${await resp.text()}`);
  } catch (err) {
    console.error("[UTMify webhook] Erro:", err);
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }

  const { event: eventType, client, transaction, orderItems, trackProps, checkoutUrl } = body;

  console.log(`[VoidPay Webhook] Evento: ${eventType} | TX: ${transaction?.id}`);

  // Coleta UTMs â€” prioridade: metadata > trackProps > checkoutUrl
  const meta = transaction?.metadata || {};
  const utmData = {
    utm_source:   meta.utm_source   || trackProps?.utm_source   || null,
    utm_medium:   meta.utm_medium   || trackProps?.utm_medium   || null,
    utm_campaign: meta.utm_campaign || meta.campaign_name || trackProps?.utm_campaign || null,
    utm_content:  meta.utm_content  || meta.ad_id         || trackProps?.utm_content  || null,
    utm_term:     meta.utm_term     || meta.adset_id      || trackProps?.utm_term     || null,
    fbclid:       meta.fbclid       || trackProps?.fbclid  || null,
    ip:           trackProps?.ip    || null,
  };

  // Tenta extrair do checkoutUrl como fallback
  if (checkoutUrl) {
    try {
      const u = new URL(checkoutUrl);
      if (!utmData.utm_source)   utmData.utm_source   = u.searchParams.get("utm_source");
      if (!utmData.utm_medium)   utmData.utm_medium   = u.searchParams.get("utm_medium");
      if (!utmData.utm_campaign) utmData.utm_campaign = u.searchParams.get("utm_campaign");
      if (!utmData.utm_content)  utmData.utm_content  = u.searchParams.get("utm_content");
      if (!utmData.utm_term)     utmData.utm_term     = u.searchParams.get("utm_term");
      if (!utmData.fbclid)       utmData.fbclid       = u.searchParams.get("fbclid");
    } catch {}
  }

  // Mapeia evento â†’ status UTMify
  const statusMap = {
    TRANSACTION_CREATED:      "waiting_payment",
    TRANSACTION_PAID:         "paid",
    TRANSACTION_CANCELED:     "cancelled",
    TRANSACTION_REFUNDED:     "refunded",
    TRANSACTION_CHARGED_BACK: "chargeback",
  };

  const utmifyStatus = statusMap[eventType];
  if (!utmifyStatus) {
    console.log(`[VoidPay Webhook] Evento ignorado: ${eventType}`);
    return jsonResponse(200, { ok: true });
  }

  // Dispara UTMify
  await sendUtmify(utmifyStatus, transaction, client, orderItems, utmData);

  // Atualiza Supabase se pago
  if (eventType === "TRANSACTION_PAID" && transaction?.id) {
    try {
      const supabase = getSupabase();
      await supabase
        .from("transactions")
        .update({ status: "paid", paid_at: transaction.payedAt || new Date().toISOString() })
        .eq("transaction_id", transaction.id);
    } catch (_) {}
  }

  return jsonResponse(200, { ok: true });
};
