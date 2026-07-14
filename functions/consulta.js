const CPF_API_BASE = "https://www.agenciacredit.online/consulta/01/consultar-cpf.php";

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

  const cpfRaw = event.queryStringParameters?.cpf || "";
  const cpf    = cpfRaw.replace(/\D/g, "").slice(0, 11);

  if (!cpf || cpf.length < 11) {
    return jsonResponse(400, { status: 400, statusMsg: "Informe o CPF" });
  }

  const apiUrl = `${CPF_API_BASE}?cpf=${cpf}`;

  let text = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(apiUrl, {
        method:  "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept":     "application/json",
        },
        signal: controller.signal,
      });
      text = await resp.text();
      clearTimeout(timeout);
      if (resp.ok) break;
    } catch (err) {
      clearTimeout(timeout);
      if (attempt === 3) {
        return jsonResponse(502, { status: 502, statusMsg: "Falha ao consultar CPF", details: String(err) });
      }
    }
  }

  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    return jsonResponse(502, { status: 502, statusMsg: "Resposta inválida da API de CPF", details: text.slice(0, 200) });
  }

  // Verifica se retornou nome válido
  if (!data.nome || data.nome.trim() === "") {
    return jsonResponse(404, { status: 404, statusMsg: "CPF não encontrado" });
  }

  // Normaliza data de nascimento: dd/mm/yyyy -> yyyy-mm-dd
  let dataNascimento = data.nascimento || "";
  if (dataNascimento && dataNascimento.includes("/")) {
    const parts = dataNascimento.split("/");
    if (parts.length === 3) dataNascimento = `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  const dados = {
    cpf,
    nome:             data.nome             || "",
    nome_mae:         data.mae              || "",
    data_nascimento:  dataNascimento,
    sexo:             data.sexo             || "",
  };

  return jsonResponse(200, { DADOS: dados });
};
