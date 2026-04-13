function defaultBluefocus() {
  return window.TouyaDB.defaultBluefocus();
}

function normalizeBluefocus(bf) {
  return window.TouyaDB.normalizeBluefocus(bf);
}

function readDb() {
  return window.TouyaDB.readDb();
}

function writeDb(db) {
  window.TouyaDB.writeDb(db);
}

/** Migra chaves antigas (touya_bf_*) para dentro de `bluefocus` no JSON do servidor. */
function migrarLegacyBluefocus() {
  const db = readDb();
  let changed = false;
  const lc = localStorage.getItem("touya_bf_config");
  if (lc) {
    try {
      const c = JSON.parse(lc);
      if (c && typeof c === "object") {
        db.bluefocus.config = { ...db.bluefocus.config, ...c };
        changed = true;
      }
    } catch {
      /* ignore */
    }
    localStorage.removeItem("touya_bf_config");
  }
  const lm = localStorage.getItem("touya_bf_monitor");
  if (lm) {
    try {
      const m = JSON.parse(lm);
      if (Array.isArray(m) && m.length) {
        db.bluefocus.monitor = m;
        changed = true;
      }
    } catch {
      /* ignore */
    }
    localStorage.removeItem("touya_bf_monitor");
  }
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("touya_bf_baseline_")) keysToRemove.push(k);
  }
  keysToRemove.forEach((k) => {
    const date = k.slice("touya_bf_baseline_".length);
    try {
      const map = JSON.parse(localStorage.getItem(k));
      if (map && typeof map === "object" && !db.bluefocus.baselines[date]) {
        db.bluefocus.baselines[date] = map;
        changed = true;
      }
    } catch {
      /* ignore */
    }
    localStorage.removeItem(k);
  });
  if (changed) writeDb(db);
}

function hojeISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function carregarConfig() {
  return readDb().bluefocus.config || {};
}

function salvarConfig(cfg) {
  const db = readDb();
  db.bluefocus.config = cfg;
  writeDb(db);
}

function carregarMonitor() {
  return readDb().bluefocus.monitor || [];
}

function salvarMonitor(rows) {
  const db = readDb();
  db.bluefocus.monitor = rows;
  writeDb(db);
}

function carregarBaseline() {
  const day = hojeISO();
  const b = readDb().bluefocus.baselines?.[day];
  return b && typeof b === "object" ? b : {};
}

function salvarBaseline(map) {
  const db = readDb();
  if (!db.bluefocus.baselines) db.bluefocus.baselines = {};
  db.bluefocus.baselines[hojeISO()] = map;
  writeDb(db);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Primeiro filho elemento com nome local (XML com namespaces). */
function primeiroFilhoLocalName(el, localName) {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === localName) return c;
  }
  return null;
}

/** Mesmo com prefixo SOAP (`ns:QtdeProduto`), o `localName` bate; `getElementsByTagName` não. */
function primeiroFilhoLocalNameCI(el, ...localNames) {
  const set = new Set(localNames.map((n) => n.toLowerCase()));
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (set.has(c.localName.toLowerCase())) return c;
  }
  return null;
}

/** Primeiro descendente com um dos nomes locais (ignora maiúsculas). */
function primeiroDescendenteLocalNameCI(el, ...localNames) {
  const set = new Set(localNames.map((n) => n.toLowerCase()));
  const walk = (node) => {
    if (node.nodeType !== 1) return null;
    if (set.has(node.localName.toLowerCase())) return node;
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(el);
}

function normTextoXml(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
}

/** Bloco de saída da consulta (PDF Pré-Venda / Genexus: Sdtwebservicesaida). */
function encontrarSdtwebservicesaida(doc) {
  let found = null;
  const walk = (node) => {
    if (node.nodeType !== 1) return;
    const ln = node.localName.toLowerCase();
    if (ln === "sdtwebservicesaida") {
      found = node;
      return;
    }
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
      walk(c);
      if (found) return;
    }
  };
  walk(doc.documentElement);
  return found;
}

/**
 * PDF pág. 9: `<Sdtwebservicesaida><Produto><ProdutoItem>…</ProdutoItem></Produto>`.
 * Não varrer a árvore inteira — outro `ProdutoItem`/`QtdeProduto` interno devolve -1200 etc.
 */
function listarProdutoItemsResposta(doc) {
  const saida = encontrarSdtwebservicesaida(doc);
  const out = [];
  if (saida) {
    for (let c = saida.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName.toLowerCase() !== "produto") continue;
      for (let pi = c.firstElementChild; pi; pi = pi.nextElementSibling) {
        if (pi.localName.toLowerCase() === "produtoitem") out.push(pi);
      }
    }
  }
  if (out.length > 0) return out;

  const raiz = saida || doc.documentElement;
  const walk = (node) => {
    if (node.nodeType !== 1) return;
    if (node.localName.toLowerCase() === "produtoitem") out.push(node);
    for (let ch = node.firstElementChild; ch; ch = ch.nextElementSibling) walk(ch);
  };
  walk(raiz);
  if (out.length === 0 && saida) {
    return listarTodosProdutoItemsDoc(doc);
  }
  return out;
}

/** Se o bloco de saída tiver outro nome no WSDL, ainda achamos os itens no documento. */
function listarTodosProdutoItemsDoc(doc) {
  const out = [];
  const walk = (node) => {
    if (node.nodeType !== 1) return;
    if (node.localName.toLowerCase() === "produtoitem") out.push(node);
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) walk(c);
  };
  walk(doc.documentElement);
  return out;
}

function textoProdutoIdItem(el) {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName && c.localName.toLowerCase() === "produtoid") {
      return normTextoXml(c.textContent);
    }
  }
  const n = primeiroDescendenteLocalNameCI(el, "ProdutoId", "produtoid");
  return n ? normTextoXml(n.textContent) : "";
}

/** Só estes nomes em fallback — nunca «Saldo»/«Qtde» genérico (pegam nós errados e viram -1200 etc.). */
const NOMES_QTDE_FALLBACK = ["Quantidade", "QtdeEstoque", "QuantidadeEstoque"];

/**
 * PDF: `<QtdeProduto>` é filho direto de `ProdutoItem`. Nunca usar o 1º `QtdeProduto` da subárvore
 * (ordem documento) — pode ser nó interno com valor errado (-1200).
 */
function textoQtdeProdutoItem(el) {
  const a = el.getAttribute("QtdeProduto");
  if (a != null && String(a).trim() !== "") return normTextoXml(a);

  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName && c.localName.toLowerCase() === "qtdeproduto") {
      const t = normTextoXml(c.textContent);
      if (t !== "") return t;
    }
  }

  for (let f = 0; f < NOMES_QTDE_FALLBACK.length; f++) {
    const lower = NOMES_QTDE_FALLBACK[f].toLowerCase();
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName && c.localName.toLowerCase() === lower) {
        const t = normTextoXml(c.textContent);
        if (t !== "") return t;
      }
    }
  }
  return "";
}

function textoMsgErroProdItem(el) {
  const n =
    primeiroFilhoLocalNameCI(el, "MsgErroProd") || primeiroDescendenteLocalNameCI(el, "MsgErroProd");
  return n ? normTextoXml(n.textContent) : "";
}

/** PDF Pré-Venda: cada `ProdutoItem` da resposta traz `ProdutoCodigoBarras` junto com `QtdeProduto`. */
function textoProdutoCodigoBarrasItem(el) {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName && c.localName.toLowerCase() === "produtocodigobarras") {
      return normTextoXml(c.textContent);
    }
  }
  const n = primeiroDescendenteLocalNameCI(el, "ProdutoCodigoBarras");
  return n ? normTextoXml(n.textContent) : "";
}

function chaveMonitorProduto(produtoId, codigoBarras) {
  return `${String(produtoId ?? "").trim()}|${String(codigoBarras ?? "").trim()}`;
}

/** Mesmo código com ou sem pontos/zeros à esquerda (ex.: 27.00.00.00.82 vs 2700000082). */
function chaveMonitorProdutoDigitos(produtoId, codigoBarras) {
  const d = String(codigoBarras ?? "").replace(/\D/g, "");
  return `${String(produtoId ?? "").trim()}|${d}`;
}

/**
 * O PDF não garante a mesma ordem dos `ProdutoItem` na resposta que no pedido.
 * Cruza por ProdutoId + ProdutoCodigoBarras (como no exemplo do manual).
 */
function mergeLeituraConsulta(itensRequisicao, linhasResposta) {
  const map = new Map();
  const mapDigitos = new Map();
  for (let i = 0; i < linhasResposta.length; i++) {
    const r = linhasResposta[i];
    const pid = String(r.produtoId ?? "").trim();
    const cbResp = String(r.produtoCodigoBarras ?? "").trim();
    const keys = [chaveMonitorProduto(pid, cbResp)];
    if (cbResp === "") keys.push(chaveMonitorProduto(pid, pid));
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (key && !map.has(key)) map.set(key, r);
    }
    const dig = cbResp.replace(/\D/g, "");
    if (dig) {
      const kd = chaveMonitorProdutoDigitos(pid, cbResp);
      if (!mapDigitos.has(kd)) mapDigitos.set(kd, r);
    }
  }

  const ultimaLeitura = [];
  const ultimoItensConsulta = [];
  for (let i = 0; i < itensRequisicao.length; i++) {
    const req = itensRequisicao[i];
    const pid = String(req.produtoId).trim();
    const cbReq = String(req.codigoBarras).trim();
    const tryKeys = [chaveMonitorProduto(pid, cbReq), chaveMonitorProduto(pid, pid)];
    let hit = null;
    for (let t = 0; t < tryKeys.length; t++) {
      if (map.has(tryKeys[t])) {
        hit = map.get(tryKeys[t]);
        break;
      }
    }
    if (!hit) {
      const kd = chaveMonitorProdutoDigitos(pid, cbReq);
      if (mapDigitos.has(kd)) hit = mapDigitos.get(kd);
    }
    if (!hit) {
      const mesmoPid = linhasResposta.filter((r) => String(r.produtoId).trim() === pid);
      if (mesmoPid.length === 1) hit = mesmoPid[0];
    }
    if (hit) {
      ultimaLeitura.push({
        produtoId: pid,
        qtde: hit.qtde,
        msgProd: hit.msgProd || "",
      });
      ultimoItensConsulta.push(req);
    }
  }
  return { ultimaLeitura, ultimoItensConsulta };
}

/** WSDL: soapAction="Valimaction/AINTEGRACAOFCXEXPORTACADSAT.Execute" (valor com aspas no header SOAP 1.1). */
const SOAP_ACTION_EXPORTA_CAD_SAT = '"Valimaction/AINTEGRACAOFCXEXPORTACADSAT.Execute"';

/** Consulta Quantidade — mesmo padrão Valim/Genexus que o servlet costuma exigir. */
const SOAP_ACTION_CONSULTA_QTDE = '"Valimaction/AINTEGRACAOFCXCONSULTAQTDE.Execute"';

/**
 * IntegracaoFcxExportaCadSAT.Execute — entrada alinhada ao PDF / SdtWebServiceEntradaExpCadastro.
 */
function montarEnvelopeExportaCadSat({
  empresaId,
  usuarioId,
  pdvCodigo,
  tipoAtualizacao,
  tipo = 4,
  pessoaId = 0,
  cargaPDVNumero = 0,
  cargaPDVSequencia = 0,
  produtoId = 0,
  dataHoraInicio = "30/12/1899",
}) {
  return `<?xml version="1.0"?>
<SOAP-ENV:Envelope
xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<SOAP-ENV:Body>
<IntegracaoFcxExportaCadSAT.Execute xmlns="Valim">
<Sdtwebserviceentradaexpcadastro>
<EmpresaId>${escapeXml(empresaId)}</EmpresaId>
<UsuarioId>${escapeXml(usuarioId)}</UsuarioId>
<PDVCodigo>${Number(pdvCodigo)}</PDVCodigo>
<TipoAtualizacao>${escapeXml(tipoAtualizacao)}</TipoAtualizacao>
<Tipo>${Number(tipo)}</Tipo>
<PessoaId>${Number(pessoaId)}</PessoaId>
<CargaPDVNumero>${Number(cargaPDVNumero)}</CargaPDVNumero>
<CargaPDVSequencia>${Number(cargaPDVSequencia)}</CargaPDVSequencia>
<ProdutoId>${Number(produtoId)}</ProdutoId>
<DataHoraInicio>${escapeXml(dataHoraInicio)}</DataHoraInicio>
</Sdtwebserviceentradaexpcadastro>
</IntegracaoFcxExportaCadSAT.Execute>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

/**
 * Resposta: IntegracaoFcxExportaCadSAT.ExecuteResponse / Sdtwebservicesaidaexpcadastrosat.
 */
function parseExportaCadResponse(xmlText) {
  const trimmed = xmlText.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.toLowerCase().startsWith("<html")) {
    throw new Error(
      "Resposta foi HTML, não XML. Abra o site por http://localhost:8080 com servidor.py rodando (não abra o HTML pelo disco)."
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Resposta XML inválida da API.");
  }

  const fault =
    doc.getElementsByTagName("Fault")[0] ||
    doc.getElementsByTagNameNS("http://schemas.xmlsoap.org/soap/envelope/", "Fault")[0];
  if (fault) {
    const reason =
      fault.getElementsByTagName("faultstring")[0]?.textContent?.trim() ||
      String(fault.textContent || "")
        .trim()
        .slice(0, 400);
    throw new Error(reason || "SOAP Fault (erro no servidor BlueFocus ou no proxy).");
  }

  const saida =
    doc.getElementsByTagName("Sdtwebservicesaidaexpcadastrosat")[0] ||
    doc.getElementsByTagName("SdtWebServiceSaidaExpCadastroSAT")[0];

  let msgErro = "";
  let snFim = "S";
  if (saida) {
    msgErro = primeiroFilhoLocalName(saida, "MsgErro")?.textContent?.trim() || "";
    const sn = primeiroFilhoLocalName(saida, "SNFim")?.textContent?.trim() || "S";
    snFim = sn.toUpperCase();
  } else {
    msgErro = doc.getElementsByTagName("MsgErro")[0]?.textContent?.trim() || "";
    snFim = (doc.getElementsByTagName("SNFim")[0]?.textContent?.trim() || "S").toUpperCase();
  }
  if (msgErro) {
    throw new Error(msgErro);
  }

  const allItems = doc.getElementsByTagName("ProdutoItem");
  const produtos = [];
  for (let i = 0; i < allItems.length; i++) {
    const el = allItems[i];
    const pidNode = primeiroFilhoLocalName(el, "ProdutoId");
    if (!pidNode) continue;
    const pid = pidNode.textContent?.trim();
    if (!pid) continue;
    const nome =
      primeiroFilhoLocalName(el, "ProdutoDescricao")?.textContent?.trim() ||
      primeiroFilhoLocalName(el, "ProdutoDescricaoResumida")?.textContent?.trim() ||
      `Produto ${pid}`;
    let codigoBarras = "";
    const cbItems = el.getElementsByTagName("CodigoBarrasItem");
    if (cbItems.length > 0) {
      const cb = cbItems[0].getElementsByTagName("CodigoBarras")[0];
      codigoBarras = cb?.textContent?.trim() || "";
    }
    if (!codigoBarras) codigoBarras = String(pid);
    produtos.push({ produtoId: String(pid), nome, codigoBarras });
  }

  return { snFim, produtos };
}

async function chamarExportaCadSat(xmlBody, token) {
  const res = await fetch("/api/bluefocus/exporta-cad-sat", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "X-Bluefocus-Token": token,
      SOAPAction: SOAP_ACTION_EXPORTA_CAD_SAT,
    },
    body: xmlBody,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text.slice(0, 500) || `Erro HTTP ${res.status}`);
  }
  return text;
}

/**
 * Corpo idêntico ao PDF «Integração Bluefocus WebServices Pré-Venda» (Consulta quantidade):
 * Sdtwebserviceentrada → Produto → ProdutoItem com só ProdutoId + ProdutoCodigoBarras (texto, sem espaços extras).
 */
function montarEnvelopeConsultaQtde({ empresaId, usuarioId, pdvCodigo, itens }) {
  const produtosXml = itens
    .map((p) => {
      const pid = String(p.produtoId ?? "").trim();
      const cb = String(p.codigoBarras ?? "").trim();
      return `<ProdutoItem>
<ProdutoId>${escapeXml(pid)}</ProdutoId>
<ProdutoCodigoBarras>${escapeXml(cb)}</ProdutoCodigoBarras>
</ProdutoItem>`;
    })
    .join("\n");

  const emp = String(empresaId ?? "").trim();
  const usr = String(usuarioId ?? "").trim();
  const pdv = Number.isFinite(Number(pdvCodigo)) ? String(Math.trunc(Number(pdvCodigo))) : String(pdvCodigo ?? "").trim();

  return `<?xml version="1.0"?>
<SOAP-ENV:Envelope 
xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" 
xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<SOAP-ENV:Body>
<IntegracaoFcxConsultaQtde.Execute xmlns="Valim">
<Sdtwebserviceentrada>
<EmpresaId>${escapeXml(emp)}</EmpresaId>
<UsuarioId>${escapeXml(usr)}</UsuarioId>
<PDVCodigo>${escapeXml(pdv)}</PDVCodigo>
<Produto>
${produtosXml}
</Produto>
</Sdtwebserviceentrada>
</IntegracaoFcxConsultaQtde.Execute>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function parseConsultaQtdeResponse(xmlText) {
  const trimmed = xmlText.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.toLowerCase().startsWith("<html")) {
    throw new Error(
      "Resposta foi HTML, não XML. Use http://localhost:8080 com servidor.py (não abra o HTML pelo disco)."
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) {
    throw new Error("Resposta XML inválida da API.");
  }

  const fault =
    doc.getElementsByTagName("Fault")[0] ||
    doc.getElementsByTagNameNS("http://schemas.xmlsoap.org/soap/envelope/", "Fault")[0];
  if (fault) {
    const reason =
      fault.getElementsByTagName("faultstring")[0]?.textContent?.trim() ||
      String(fault.textContent || "")
        .trim()
        .slice(0, 400);
    throw new Error(reason || "SOAP Fault na Consulta Quantidade.");
  }

  const saida = encontrarSdtwebservicesaida(doc);
  let msgErro = "";
  if (saida) {
    const nMsg = primeiroFilhoLocalNameCI(saida, "MsgErro");
    msgErro = nMsg ? normTextoXml(nMsg.textContent) : "";
  }
  if (!msgErro) {
    const nGlobal = primeiroDescendenteLocalNameCI(doc.documentElement, "MsgErro");
    msgErro = nGlobal ? normTextoXml(nGlobal.textContent) : "";
  }
  if (msgErro) {
    throw new Error(msgErro);
  }

  const items = listarProdutoItemsResposta(doc);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    const produtoId = textoProdutoIdItem(el);
    const produtoCodigoBarras = textoProdutoCodigoBarrasItem(el);
    const qtdeStr = textoQtdeProdutoItem(el);
    const msgProd = textoMsgErroProdItem(el);
    const qtde = parseQtdeProdutoSoap(qtdeStr);
    out.push({
      produtoId: produtoId ? String(produtoId) : "",
      produtoCodigoBarras,
      qtde: Number.isFinite(qtde) ? qtde : 0,
      msgProd: msgProd || "",
    });
  }
  return out;
}

/**
 * PDF: `328.0000` / `0.0000`; produção pode usar pt-BR `3.395,0000` ou milhar `1.200` (= 1200).
 * Sinal negativo só no início (ex.: `-1.200` = -1200 em notação BR, não -1,2).
 */
function parseQtdeProdutoSoap(raw) {
  let s = String(raw ?? "")
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/[\u2212\u2013]/g, "-")
    .replace(/\uFF0C/g, ",")
    .replace(/\u066C/g, ",");
  if (!s) return NaN;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1).trim();

  if (s.includes(",")) {
    const semMilhar = s.replace(/\./g, "");
    const n = Number(semMilhar.replace(",", "."));
    if (!Number.isFinite(n)) return NaN;
    return neg ? -Math.abs(n) : n;
  }

  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    const n = Number(s.replace(/\./g, ""));
    return neg ? -Math.abs(n) : n;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg ? -Math.abs(n) : n;
}

async function chamarConsultaQtde(xmlBody, token) {
  const res = await fetch("/api/bluefocus/consulta-qtde", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "X-Bluefocus-Token": token,
      SOAPAction: SOAP_ACTION_CONSULTA_QTDE,
    },
    body: xmlBody,
  });

  const text = await res.text();
  if (!res.ok) {
    const isHtml = /^\s*</.test(text) && /<html/i.test(text);
    if (res.status === 404 || (isHtml && text.includes("404"))) {
      throw new Error(
        "HTTP 404 no servidor BlueFocus (URL da Consulta Quantidade). O proxy foi ajustado para usar /servlet/aintegracaofcxconsultaqtde — recarregue a página e tente de novo. Se persistir, confira o WSDL no painel BlueFocus."
      );
    }
    throw new Error(
      isHtml ? `Erro HTTP ${res.status} (resposta HTML do servidor).` : text.slice(0, 500) || `Erro HTTP ${res.status}`
    );
  }
  return text;
}

function fmtNum(n) {
  return Number(n).toLocaleString("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

const elEmpresa = document.getElementById("bf-empresa");
const elUsuario = document.getElementById("bf-usuario");
const elPdv = document.getElementById("bf-pdv");
const elToken = document.getElementById("bf-token");
const elSalvarConfig = document.getElementById("bf-salvar-config");
const elTestarConexao = document.getElementById("bf-testar-conexao");
const elExportarSoapJson = document.getElementById("bf-exportar-soap-json");
const elImportarSoapJson = document.getElementById("bf-importar-soap-json");
const elImportarSoapFile = document.getElementById("bf-importar-soap-file");
const elProdutosBody = document.getElementById("bf-produtos-body");
const elAddLinha = document.getElementById("bf-add-linha");
const elImportarCalc = document.getElementById("bf-importar-calculadora");
const elAtualizar = document.getElementById("bf-atualizar");
const elBaseline = document.getElementById("bf-baseline");
const elBaselineMsg = document.getElementById("bf-baseline-msg");
const elErro = document.getElementById("bf-erro");
const elRankingBody = document.getElementById("bf-ranking-body");
const elTipoCadastro = document.getElementById("bf-tipo-cadastro");
const elImportarCadastro = document.getElementById("bf-importar-cadastro");
const elCadastroStatus = document.getElementById("bf-cadastro-status");
const elConfigSalvaMsg = document.getElementById("bf-config-salva-msg");
const elLeituraOk = document.getElementById("bf-leitura-ok");
const elCardProdutosMonitorados = document.getElementById("bf-card-produtos-monitorados");
const elToggleMonitor = document.getElementById("bf-toggle-monitor");
const LS_MONITOR_COLLAPSED = "touya_bf_ui_monitor_collapsed";
let configSalvaMsgTimer = null;

const appShell = document.querySelector(".app-shell");
const toggleSidebarBtn = document.getElementById("toggle-sidebar");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

let ultimaLeitura = [];
/** Paralelo a `ultimaLeitura`: mesma ordem dos `ProdutoItem` enviados na última consulta. */
let ultimoItensConsulta = [];
let monitorRows = [];

/**
 * ProdutoId BlueFocus na calculadora: campo «ID BlueFocus» ou, se vazio, SKU numérico
 * (muitos usuários guardam o mesmo código do PDV só no SKU).
 */
function produtoIdBluefocusCalculadora(p) {
  if (!p || typeof p !== "object") return null;
  const bf = p.bluefocusProdutoId;
  if (bf !== undefined && bf !== null && bf !== "") {
    return String(bf).trim();
  }
  const sku = String(p.sku ?? "").trim();
  if (sku !== "" && /^\d+$/.test(sku)) {
    return sku;
  }
  return null;
}

/** Chave `produtoId|codigoBarras` — alinhada a «Importar da calculadora». */
function chaveCalculadoraBluefocus(p) {
  const pid = produtoIdBluefocusCalculadora(p);
  if (pid === null) return null;
  const codigoBarras =
    p.bluefocusCodigoBarras !== undefined && p.bluefocusCodigoBarras !== null && p.bluefocusCodigoBarras !== ""
      ? String(p.bluefocusCodigoBarras).trim()
      : String(pid);
  return `${pid}|${codigoBarras}`;
}

function chavesCalculadoraBluefocus() {
  const set = new Set();
  (readDb().produtos || []).forEach((p) => {
    const k = chaveCalculadoraBluefocus(p);
    if (k) set.add(k);
  });
  return set;
}

/** Nome na calculadora para o par ProdutoId + código de barras (ou null). */
function nomeCalculadoraPorChave(produtoId, codigoBarras) {
  const pidStr = String(produtoId ?? "").trim();
  const cbStr = String(codigoBarras ?? "").trim() || pidStr;
  for (const p of readDb().produtos || []) {
    const k = chaveCalculadoraBluefocus(p);
    if (k === `${pidStr}|${cbStr}`) {
      return (p.nome || "").trim() || `Produto ${pidStr}`;
    }
  }
  return null;
}

function setErro(msg) {
  elErro.textContent = msg || "";
  if (msg && elLeituraOk) {
    elLeituraOk.textContent = "";
  }
  if (msg && elErro) {
    elErro.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

const LS_LAST_AUTO16H = "touya_bf_last_auto16h";
const HORA_LEITURA_AUTO = 16;
const MINUTO_LEITURA_AUTO = 0;

let leituraEmAndamento = false;
let timerAuto16h = null;

function marcarAuto16hExecutado() {
  try {
    localStorage.setItem(LS_LAST_AUTO16H, hojeISO());
  } catch {
    /* ignore */
  }
}

function jaExecutouAuto16hHoje() {
  try {
    return localStorage.getItem(LS_LAST_AUTO16H) === hojeISO();
  } catch {
    return false;
  }
}

/** Erro na leitura: alerta vermelho (manual) ou mensagem discreta na área da leitura (automático 16h). */
function reportarErroLeitura(msg, opcoes = {}) {
  const automatico = opcoes.origem === "auto16h";
  if (automatico) {
    elErro.textContent = "";
    if (elLeituraOk) {
      elLeituraOk.classList.add("config-feedback-warn");
      elLeituraOk.textContent = `Atualização automática (16h): ${msg}`;
    }
  } else {
    setErro(msg);
  }
}

function msAteProximaExecucao16h() {
  const now = new Date();
  const alvo = new Date(now);
  alvo.setHours(HORA_LEITURA_AUTO, MINUTO_LEITURA_AUTO, 0, 0);
  if (now.getTime() >= alvo.getTime()) {
    alvo.setDate(alvo.getDate() + 1);
  }
  return alvo.getTime() - now.getTime();
}

function iniciarAgendamentoLeitura16h() {
  if (timerAuto16h) {
    clearTimeout(timerAuto16h);
    timerAuto16h = null;
  }
  const ms = msAteProximaExecucao16h();
  timerAuto16h = setTimeout(() => {
    timerAuto16h = null;
    executarLeitura({ origem: "auto16h" }).catch(() => {});
    iniciarAgendamentoLeitura16h();
  }, ms);
}

/** Se já passou das 16h hoje e a aba não estava aberta no horário, roda uma vez ao abrir a página. */
function tentarLeituraAuto16hAdmissivel() {
  const now = new Date();
  const minutos = now.getHours() * 60 + now.getMinutes();
  const limite = HORA_LEITURA_AUTO * 60 + MINUTO_LEITURA_AUTO;
  if (minutos < limite) return;
  if (jaExecutouAuto16hHoje()) return;
  executarLeitura({ origem: "auto16h" }).catch(() => {});
}

function atualizarMsgBaseline() {
  const b = carregarBaseline();
  const n = Object.keys(b).length;
  if (n === 0) {
    elBaselineMsg.textContent =
      "Ainda não há estoque inicial do dia. Use «Definir estoque inicial do dia» após uma leitura bem-sucedida para comparar com leituras seguintes.";
  } else {
    elBaselineMsg.textContent = `Estoque inicial de hoje registrado para ${n} produto(s). A coluna «Quantidade alterada» usa |atual − inicial|.`;
  }
}

function renderEditor() {
  const mapQtde = new Map();
  const mapQtdeDig = new Map();
  for (let i = 0; i < ultimaLeitura.length; i++) {
    const item = ultimaLeitura[i];
    const req = ultimoItensConsulta[i];
    if (!req || item == null) continue;
    const pid = String(req.produtoId).trim();
    const cb = String(req.codigoBarras).trim();
    mapQtde.set(chaveMonitorProduto(pid, cb), item.qtde);
    if (cb.replace(/\D/g, "")) {
      mapQtdeDig.set(chaveMonitorProdutoDigitos(pid, cb), item.qtde);
    }
  }

  elProdutosBody.innerHTML = "";
  monitorRows.forEach((row, idx) => {
    const pid = String(row.produtoId ?? "").trim();
    const cb = String(row.codigoBarras ?? "").trim();
    let q = null;
    if (pid && cb) {
      if (mapQtde.has(chaveMonitorProduto(pid, cb))) q = mapQtde.get(chaveMonitorProduto(pid, cb));
      else if (mapQtdeDig.has(chaveMonitorProdutoDigitos(pid, cb))) q = mapQtdeDig.get(chaveMonitorProdutoDigitos(pid, cb));
    }
    const qtdeLabel =
      q != null && Number.isFinite(Number(q)) ? fmtNum(q) : "—";
    const qtdeTitle =
      q != null
        ? "QtdeProduto da última leitura (mesmo cruzamento da tabela «Leitura do dia»)"
        : "Ainda sem leitura para esta linha ou linha não incluída na última consulta (calculadora + filtro).";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" data-f="nome" data-i="${idx}" value="${escapeAttr(row.nome)}" /></td>
      <td><input type="number" data-f="produtoId" data-i="${idx}" min="0" step="1" value="${escapeAttr(row.produtoId)}" /></td>
      <td><input type="text" data-f="codigoBarras" data-i="${idx}" value="${escapeAttr(row.codigoBarras)}" /></td>
      <td class="bf-qtde-monitor muted-cell" title="${escapeAttr(qtdeTitle)}">${escapeAttr(qtdeLabel)}</td>
      <td><button type="button" class="danger btn-tiny" data-remove="${idx}">Remover</button></td>
    `;
    elProdutosBody.appendChild(tr);
  });

  elProdutosBody.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("change", onEditorChange);
  });
  elProdutosBody.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-remove"));
      monitorRows.splice(i, 1);
      salvarMonitor(monitorRows);
      renderEditor();
    });
  });
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function onEditorChange(event) {
  const inp = event.target;
  const f = inp.getAttribute("data-f");
  const i = Number(inp.getAttribute("data-i"));
  if (!f || Number.isNaN(i) || !monitorRows[i]) return;
  monitorRows[i][f] = inp.value;
  salvarMonitor(monitorRows);
}

function renderRanking() {
  elRankingBody.innerHTML = "";
  const baseline = carregarBaseline();
  const nomePorId = {};
  monitorRows.forEach((r) => {
    nomePorId[String(r.produtoId)] = (r.nome || "").trim() || `Produto ${r.produtoId}`;
  });

  const linhas = ultimaLeitura.map((item, idx) => {
    const id = String(item.produtoId);
    const req = ultimoItensConsulta[idx];
    const nomeCalc = req ? nomeCalculadoraPorChave(req.produtoId, req.codigoBarras) : null;
    const nome = nomeCalc || nomePorId[id] || `Produto ${id}`;
    const atual = item.qtde;
    const ini = baseline[id];
    let alterada = null;
    if (ini !== undefined && ini !== null && Number.isFinite(Number(ini))) {
      alterada = Math.abs(Number(atual) - Number(ini));
    }
    return { nome, alterada, atual, inicial: ini, id, msg: item.msgProd };
  });

  if (ultimaLeitura.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted-cell";
    td.textContent =
      "Nenhuma leitura ainda. Preencha a conexão e a lista monitorada (abaixo), com produtos alinhados à calculadora, depois clique em «Atualizar leitura».";
    tr.appendChild(td);
    elRankingBody.appendChild(tr);
    return;
  }

  const comAlteracao = linhas.filter((x) => x.alterada != null);
  comAlteracao.sort((a, b) => {
    if (b.alterada !== a.alterada) return b.alterada - a.alterada;
    return a.nome.localeCompare(b.nome, "pt-BR");
  });
  const top = comAlteracao.slice(0, 10);

  if (top.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted-cell";
    td.textContent =
      "Defina o estoque inicial do dia para ver o ranking por maior alteração. Abaixo segue a leitura atual (até 10 itens), com estoque no PDV em cada linha.";
    tr.appendChild(td);
    elRankingBody.appendChild(tr);
    const ordenadosNome = [...linhas].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")).slice(0, 10);
    ordenadosNome.forEach((row) => {
      elRankingBody.appendChild(criarLinhaRanking(row, true));
    });
    return;
  }

  top.forEach((row) => {
    elRankingBody.appendChild(criarLinhaRanking(row, false));
  });
}

function criarLinhaRanking(row, semBaseline) {
  const tr = document.createElement("tr");
  const tdNome = document.createElement("td");
  tdNome.textContent = row.nome;
  if (row.msg) tdNome.title = row.msg;

  const tdEstoque = document.createElement("td");
  tdEstoque.textContent = fmtNum(row.atual);
  tdEstoque.className = "bf-col-estoque";
  tdEstoque.title = "Quantidade em estoque no PDV (última leitura)";

  const tdIni = document.createElement("td");
  if (row.inicial !== undefined && row.inicial !== null && Number.isFinite(Number(row.inicial))) {
    tdIni.textContent = fmtNum(row.inicial);
  } else {
    tdIni.textContent = "—";
    tdIni.className = "muted-cell";
    tdIni.title = "Use «Definir estoque inicial do dia» após uma leitura";
  }

  const tdAlt = document.createElement("td");
  if (semBaseline || row.alterada == null) {
    tdAlt.textContent = "—";
    tdAlt.className = "muted-cell";
  } else {
    tdAlt.textContent = fmtNum(row.alterada);
    tdAlt.className = "lucro-positivo";
  }

  tr.appendChild(tdNome);
  tr.appendChild(tdEstoque);
  tr.appendChild(tdIni);
  tr.appendChild(tdAlt);
  return tr;
}

function aplicarEstadoMonitorColapsado() {
  if (!elCardProdutosMonitorados || !elToggleMonitor) return;
  const collapsed = localStorage.getItem(LS_MONITOR_COLLAPSED) === "1";
  elCardProdutosMonitorados.classList.toggle("bf-monitor-collapsed", collapsed);
  elToggleMonitor.setAttribute("aria-expanded", collapsed ? "false" : "true");
  elToggleMonitor.textContent = collapsed ? "Expandir lista" : "Recolher lista";
}

async function executarLeitura(opcoes = {}) {
  const origem = opcoes.origem || "manual";
  const automatico = origem === "auto16h";

  if (leituraEmAndamento) return;
  leituraEmAndamento = true;

  if (!automatico) {
    if (elLeituraOk) elLeituraOk.textContent = "";
    setErro("");
  }

  const labelBtn = elAtualizar ? elAtualizar.textContent : "";
  if (elAtualizar && !automatico) {
    elAtualizar.disabled = true;
    elAtualizar.textContent = "Consultando…";
  }

  try {
    const cfg = lerConfigDosCampos();
    const empresaId = (cfg.empresaId || "").trim();
    const usuarioId = (cfg.usuarioId || "").trim();
    const pdvCodigo = cfg.pdvCodigo;
    const token = (cfg.token || "").trim();

    const permitidos = chavesCalculadoraBluefocus();
    const rawItens = monitorRows
      .map((r) => ({
        produtoId: String(r.produtoId || "").trim(),
        codigoBarras: String(r.codigoBarras || "").trim(),
      }))
      .filter((r) => r.produtoId && r.codigoBarras);

    const itens = rawItens.filter((r) => permitidos.has(`${r.produtoId}|${r.codigoBarras}`));

    if (!empresaId || !usuarioId || pdvCodigo === undefined || pdvCodigo === null || pdvCodigo === "") {
      reportarErroLeitura("Preencha EmpresaId, UsuarioId e PDVCodigo na seção «Conexão» abaixo.", opcoes);
      return;
    }
    if (!token) {
      reportarErroLeitura("Informe o token (autentica) nos campos de conexão.", opcoes);
      return;
    }
    if (permitidos.size === 0) {
      reportarErroLeitura(
        "Nenhum produto na calculadora TikTok com «ID BlueFocus» preenchido nem SKU só com números (mesmo ID do PDV). A leitura usa um desses — edite o produto na calculadora ou preencha o campo ID BlueFocus.",
        opcoes
      );
      return;
    }
    if (rawItens.length === 0) {
      reportarErroLeitura(
        "Faltam produtos na tabela «Produtos monitorados» (logo abaixo): preencha ProdutoId e Código de barras em ao menos uma linha, ou use «Importar da calculadora» / «Buscar produtos no BlueFocus».",
        opcoes
      );
      if (!automatico && elCardProdutosMonitorados) {
        elCardProdutosMonitorados.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    if (itens.length === 0) {
      reportarErroLeitura(
        "Nenhum produto na lista monitorada corresponde à calculadora (mesmo ProdutoId e código de barras). Na seção «Produtos monitorados» abaixo, use «Importar da calculadora» ou alinhe os IDs e códigos.",
        opcoes
      );
      if (!automatico && elCardProdutosMonitorados) {
        elCardProdutosMonitorados.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const xml = montarEnvelopeConsultaQtde({
      empresaId,
      usuarioId,
      pdvCodigo: Number(pdvCodigo),
      itens,
    });

    salvarConfig(cfg);

    const xmlResp = await chamarConsultaQtde(xml, token);
    const parsed = parseConsultaQtdeResponse(xmlResp);
    const merged = mergeLeituraConsulta(itens, parsed);
    ultimaLeitura = merged.ultimaLeitura;
    ultimoItensConsulta = merged.ultimoItensConsulta;

    if (automatico && ultimaLeitura.length > 0) {
      marcarAuto16hExecutado();
    }

    if (elLeituraOk) {
      if (ultimaLeitura.length === 0) {
        elLeituraOk.classList.add("config-feedback-warn");
        if (parsed.length > 0) {
          elLeituraOk.textContent = automatico
            ? "Atualização automática (16h): a API devolveu linhas, mas nenhuma casou com ProdutoId + código de barras (veja PDF: ProdutoCodigoBarras). Confira a lista monitorada."
            : "A API devolveu produtos no XML, mas nenhum casou com ProdutoId + código de barras enviados. Confira a lista monitorada (devem ser iguais aos do PDF: ProdutoCodigoBarras).";
        } else {
          elLeituraOk.textContent = automatico
            ? "Atualização automática (16h): a API respondeu sem linhas de produto no XML."
            : "A API respondeu sem linhas de produto no XML. Verifique token/PDV ou se o SOAPAction está correto no servidor BlueFocus.";
        }
      } else {
        elLeituraOk.classList.remove("config-feedback-warn");
        elLeituraOk.textContent = automatico
          ? `Atualização automática (16h): ${ultimaLeitura.length} produto(s) — estoque atualizado na tabela.`
          : `Leitura OK: ${ultimaLeitura.length} produto(s). Veja a tabela abaixo.`;
      }
    }
    renderRanking();
    renderEditor();
    if (!automatico && elLeituraOk && ultimaLeitura.length > 0) {
      elLeituraOk.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (e) {
    const msg = formatarErroRede(e) || e?.message || String(e);
    reportarErroLeitura(msg, opcoes);
  } finally {
    leituraEmAndamento = false;
    if (elAtualizar && !automatico) {
      elAtualizar.disabled = false;
      elAtualizar.textContent = labelBtn || "Atualizar leitura";
    }
  }
}

function limparLinhasVaziasMonitor() {
  monitorRows = monitorRows.filter(
    (r) => String(r.produtoId || "").trim() && String(r.codigoBarras || "").trim()
  );
  if (monitorRows.length === 0) {
    monitorRows = [{ nome: "", produtoId: "", codigoBarras: "" }];
  }
}

async function importarCadastroBluefocus() {
  setErro("");
  if (elCadastroStatus) elCadastroStatus.textContent = "";
  const cfg = lerConfigDosCampos();
  const empresaId = (cfg.empresaId || "").trim();
  const usuarioId = (cfg.usuarioId || "").trim();
  const pdvCodigo = cfg.pdvCodigo;
  const token = (cfg.token || "").trim();
  const tipoAtualizacao = (elTipoCadastro?.value || "C").trim().toUpperCase().slice(0, 1);

  if (!empresaId || !usuarioId || pdvCodigo === undefined || pdvCodigo === null || pdvCodigo === "") {
    setErro("Preencha EmpresaId, UsuarioId e PDVCodigo nos campos acima.");
    return;
  }
  if (!token) {
    setErro("Informe o token (autentica) nos campos acima.");
    return;
  }

  salvarConfig(cfg);

  const seen = new Set(
    monitorRows
      .filter((r) => String(r.produtoId || "").trim() && String(r.codigoBarras || "").trim())
      .map((r) => `${String(r.produtoId).trim()}|${String(r.codigoBarras).trim()}`)
  );

  let ultimoProdutoId = 0;
  let chamadas = 0;
  let novos = 0;
  const maxChamadas = 400;

  if (elImportarCadastro) elImportarCadastro.disabled = true;

  try {
    while (chamadas < maxChamadas) {
      const xml = montarEnvelopeExportaCadSat({
        empresaId,
        usuarioId,
        pdvCodigo: Number(pdvCodigo),
        tipoAtualizacao: tipoAtualizacao === "A" ? "A" : "C",
        produtoId: ultimoProdutoId,
      });
      const text = await chamarExportaCadSat(xml, token);
      const { snFim, produtos } = parseExportaCadResponse(text);
      chamadas += 1;
      if (produtos.length === 0) {
        break;
      }
      for (const p of produtos) {
        const key = `${p.produtoId}|${p.codigoBarras}`;
        if (!seen.has(key)) {
          seen.add(key);
          monitorRows.push({
            nome: p.nome,
            produtoId: p.produtoId,
            codigoBarras: p.codigoBarras,
          });
          novos += 1;
        }
        ultimoProdutoId = Number(p.produtoId);
      }
      if (snFim === "S") {
        break;
      }
    }

    limparLinhasVaziasMonitor();
    salvarMonitor(monitorRows);
    renderEditor();
    if (elCadastroStatus) {
      elCadastroStatus.textContent = `Concluído: ${novos} produto(s) novo(s) na lista, em ${chamadas} chamada(s) SOAP (último ProdutoId usado na paginação: ${ultimoProdutoId || "—"}).`;
    }
  } finally {
    if (elImportarCadastro) elImportarCadastro.disabled = false;
  }
}

function importarDaCalculadora() {
  try {
    const produtos = readDb().produtos;
    const seen = new Set(monitorRows.map((r) => `${r.produtoId}|${r.codigoBarras}`));
    let n = 0;
    produtos.forEach((p) => {
      const pid = produtoIdBluefocusCalculadora(p);
      if (pid === null) return;
      const codigoBarras =
        p.bluefocusCodigoBarras !== undefined && p.bluefocusCodigoBarras !== null && p.bluefocusCodigoBarras !== ""
          ? String(p.bluefocusCodigoBarras)
          : String(pid);
      const key = `${pid}|${codigoBarras}`;
      if (seen.has(key)) return;
      seen.add(key);
      monitorRows.push({
        nome: String(p.nome || "").trim() || `Produto ${pid}`,
        produtoId: String(pid),
        codigoBarras: codigoBarras,
      });
      n += 1;
    });
    salvarMonitor(monitorRows);
    renderEditor();
    if (n === 0) {
      setErro("Nenhum produto na calculadora com «ID BlueFocus» ou SKU numérico (ID do PDV).");
    } else {
      setErro("");
    }
  } catch {
    setErro("Não foi possível ler os dados da calculadora.");
  }
}

function lerConfigDosCampos() {
  return {
    empresaId: elEmpresa.value.trim(),
    usuarioId: elUsuario.value.trim(),
    pdvCodigo: elPdv.value === "" ? "" : Number(elPdv.value),
    token: elToken.value.trim(),
  };
}

function normalizarConfigSoapImport(obj) {
  if (!obj || typeof obj !== "object") return null;
  const pdvRaw = obj.pdvCodigo;
  let pdvCodigo = "";
  if (pdvRaw !== undefined && pdvRaw !== null && String(pdvRaw).trim() !== "") {
    const n = Number(pdvRaw);
    pdvCodigo = Number.isNaN(n) ? "" : n;
  }
  return {
    empresaId: String(obj.empresaId ?? "").trim(),
    usuarioId: String(obj.usuarioId ?? "").trim(),
    pdvCodigo,
    token: String(obj.token ?? "").trim(),
  };
}

function exportarJsonConexaoSoap() {
  const cfg = lerConfigDosCampos();
  const blob = new Blob([JSON.stringify(cfg, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "bluefocus-soap-config.json";
  a.click();
  URL.revokeObjectURL(a.href);
  if (elConfigSalvaMsg) {
    elConfigSalvaMsg.classList.remove("config-feedback-warn");
    elConfigSalvaMsg.textContent = "Arquivo JSON da conexão baixado (mesmo formato que db/bluefocus-soap-config.json).";
    if (configSalvaMsgTimer) clearTimeout(configSalvaMsgTimer);
    configSalvaMsgTimer = setTimeout(() => {
      if (elConfigSalvaMsg) elConfigSalvaMsg.textContent = "";
    }, 8000);
  }
}

function formatarErroRede(err) {
  const m = err?.message || String(err);
  if (m === "Failed to fetch" || m.includes("NetworkError") || m.includes("Load failed")) {
    return "Não conseguiu falar com o servidor local. Rode python servidor.py e abra http://localhost:8080/movimentacao/ (não use arquivo direto do disco).";
  }
  return m;
}

async function testarConexaoSoap() {
  setErro("");
  if (elConfigSalvaMsg) {
    elConfigSalvaMsg.classList.remove("config-feedback-warn");
    elConfigSalvaMsg.textContent = "Testando…";
  }
  const cfg = lerConfigDosCampos();
  salvarConfig(cfg);

  if (!cfg.empresaId || !cfg.usuarioId || cfg.pdvCodigo === "" || cfg.pdvCodigo === null || cfg.pdvCodigo === undefined) {
    if (elConfigSalvaMsg) {
      elConfigSalvaMsg.classList.add("config-feedback-warn");
      elConfigSalvaMsg.textContent = "Preencha EmpresaId, UsuarioId e PDVCodigo.";
    }
    return;
  }
  if (!cfg.token) {
    if (elConfigSalvaMsg) {
      elConfigSalvaMsg.classList.add("config-feedback-warn");
      elConfigSalvaMsg.textContent = "Preencha o token (autentica).";
    }
    return;
  }

  if (elTestarConexao) elTestarConexao.disabled = true;
  try {
    const xml = montarEnvelopeExportaCadSat({
      empresaId: cfg.empresaId,
      usuarioId: cfg.usuarioId,
      pdvCodigo: Number(cfg.pdvCodigo),
      tipoAtualizacao: "C",
      produtoId: 0,
    });
    const text = await chamarExportaCadSat(xml, cfg.token);
    const { snFim, produtos } = parseExportaCadResponse(text);
    if (elConfigSalvaMsg) {
      elConfigSalvaMsg.classList.remove("config-feedback-warn");
      elConfigSalvaMsg.textContent = `Conexão OK. Primeiro lote: ${produtos.length} produto(s), SNFim=${snFim}. Veja também o terminal do servidor.`;
    }
  } catch (e) {
    const msg = formatarErroRede(e);
    if (elConfigSalvaMsg) {
      elConfigSalvaMsg.classList.add("config-feedback-warn");
      elConfigSalvaMsg.textContent = `Falha: ${msg}`;
    }
    setErro(msg);
  } finally {
    if (elTestarConexao) elTestarConexao.disabled = false;
  }
}

elSalvarConfig.addEventListener("click", () => {
  salvarConfig(lerConfigDosCampos());
  setErro("");
  if (elConfigSalvaMsg) {
    if (configSalvaMsgTimer) clearTimeout(configSalvaMsgTimer);
    const tokenOk = elToken.value.trim().length > 0;
    const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    elConfigSalvaMsg.classList.remove("config-feedback-warn");
    if (!tokenOk) {
      elConfigSalvaMsg.classList.add("config-feedback-warn");
      elConfigSalvaMsg.textContent =
        `Salvo às ${hora} no servidor. Atenção: token (autentica) vazio — preencha para as chamadas SOAP funcionarem.`;
    } else {
      elConfigSalvaMsg.textContent = `Salvo às ${hora} no servidor (data/touya-db.json).`;
    }
    configSalvaMsgTimer = setTimeout(() => {
      if (elConfigSalvaMsg) elConfigSalvaMsg.textContent = "";
    }, 12000);
  }
});

if (elTestarConexao) {
  elTestarConexao.addEventListener("click", () => {
    testarConexaoSoap();
  });
}

if (elExportarSoapJson) {
  elExportarSoapJson.addEventListener("click", () => exportarJsonConexaoSoap());
}

if (elImportarSoapJson && elImportarSoapFile) {
  elImportarSoapJson.addEventListener("click", () => elImportarSoapFile.click());
  elImportarSoapFile.addEventListener("change", () => {
    const f = elImportarSoapFile.files?.[0];
    elImportarSoapFile.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const cfg = normalizarConfigSoapImport(JSON.parse(String(reader.result || "")));
        if (!cfg) throw new Error("JSON inválido");
        salvarConfig(cfg);
        aplicarUiComDadosDoServidor();
        setErro("");
        if (elConfigSalvaMsg) {
          elConfigSalvaMsg.classList.remove("config-feedback-warn");
          elConfigSalvaMsg.textContent = "Conexão importada do JSON e salva no servidor.";
        }
      } catch {
        if (elConfigSalvaMsg) {
          elConfigSalvaMsg.classList.add("config-feedback-warn");
          elConfigSalvaMsg.textContent = "Não foi possível ler o JSON (esperado: empresaId, usuarioId, pdvCodigo, token).";
        }
      }
    };
    reader.readAsText(f, "UTF-8");
  });
}

if (elToggleMonitor) {
  elToggleMonitor.addEventListener("click", () => {
    const cur = localStorage.getItem(LS_MONITOR_COLLAPSED) === "1";
    localStorage.setItem(LS_MONITOR_COLLAPSED, cur ? "0" : "1");
    aplicarEstadoMonitorColapsado();
  });
}

elAddLinha.addEventListener("click", () => {
  monitorRows.push({ nome: "", produtoId: "", codigoBarras: "" });
  salvarMonitor(monitorRows);
  renderEditor();
});

elImportarCalc.addEventListener("click", importarDaCalculadora);

if (elImportarCadastro) {
  elImportarCadastro.addEventListener("click", () => {
    importarCadastroBluefocus().catch((e) => {
      setErro(e.message || String(e));
      if (elCadastroStatus) elCadastroStatus.textContent = "";
    });
  });
}

elAtualizar.addEventListener("click", () => {
  executarLeitura().catch((e) => {
    setErro(e.message || String(e));
  });
});

elBaseline.addEventListener("click", () => {
  setErro("");
  if (elLeituraOk) elLeituraOk.textContent = "";
  if (ultimaLeitura.length === 0) {
    setErro("Faça uma leitura bem-sucedida antes de definir o estoque inicial.");
    return;
  }
  const map = {};
  ultimaLeitura.forEach((item) => {
    map[String(item.produtoId)] = item.qtde;
  });
  salvarBaseline(map);
  atualizarMsgBaseline();
  renderRanking();
  const n = Object.keys(map).length;
  if (elLeituraOk) {
    elLeituraOk.classList.remove("config-feedback-warn");
    elLeituraOk.textContent = `Estoque inicial do dia registrado para ${n} produto(s). Compare com «Atualizar leitura» para ver alterações.`;
    elLeituraOk.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

function syncMovimentacaoAdiadoPorFoco() {
  const a = document.activeElement;
  if (!a?.closest) return false;
  const t = a.tagName;
  if (t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") return false;
  return Boolean(a.closest("main.container"));
}

function aplicarUiComDadosDoServidor() {
  const cfg = carregarConfig();
  elEmpresa.value = cfg.empresaId || "";
  elUsuario.value = cfg.usuarioId || "";
  elPdv.value = cfg.pdvCodigo !== undefined && cfg.pdvCodigo !== null ? String(cfg.pdvCodigo) : "";
  elToken.value = cfg.token || "";
  monitorRows = carregarMonitor();
  if (monitorRows.length === 0) {
    monitorRows = [{ nome: "", produtoId: "", codigoBarras: "" }];
  }
  renderEditor();
  atualizarMsgBaseline();
  renderRanking();
}

async function initCampos() {
  await window.TouyaDB.init();
  migrarLegacyBluefocus();
  aplicarUiComDadosDoServidor();
  window.TouyaDB.setRemoteApplyGuard(() => !syncMovimentacaoAdiadoPorFoco());
  window.TouyaDB.onRemoteChange(() => {
    aplicarUiComDadosDoServidor();
  });
  document.querySelector("main.container")?.addEventListener("focusout", () => {
    requestAnimationFrame(() => window.TouyaDB.pollOnce());
  });
  aplicarEstadoMonitorColapsado();
  tentarLeituraAuto16hAdmissivel();
  iniciarAgendamentoLeitura16h();
}

if (toggleSidebarBtn && appShell) {
  toggleSidebarBtn.addEventListener("click", () => {
    const isMobile = window.matchMedia("(max-width: 980px)").matches;
    if (isMobile) {
      appShell.classList.toggle("mobile-sidebar-open");
    } else {
      appShell.classList.toggle("sidebar-collapsed");
    }
  });
}

if (sidebarBackdrop && appShell) {
  sidebarBackdrop.addEventListener("click", () => {
    appShell.classList.remove("mobile-sidebar-open");
  });
}

document.querySelectorAll(".side-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 980px)").matches) {
      appShell.classList.remove("mobile-sidebar-open");
    }
  });
});

document.querySelectorAll("#nav-dropdown-calculadora .nav-dropdown-menu a").forEach((link) => {
  if (link.textContent.trim() === "Shopee") {
    link.addEventListener("click", (event) => event.preventDefault());
  }
});

initCampos().catch((err) => console.error("[movimentacao]", err));
