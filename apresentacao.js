/**
 * Painel / apresentação em tela cheia — lê o mesmo banco TouyaDB que a calculadora.
 */
function arredondar(valor) {
  return Number(valor.toFixed(2));
}

function calcularLinha({ nome, sku, valorVenda, comissaoPercent, cupom, custo }) {
  const skuNorm = String(sku ?? "").trim();
  const taxaSfp = arredondar((valorVenda - cupom) * 0.06);
  const taxaPlataforma = arredondar(taxaSfp + 4);
  const comissaoAfiliado = arredondar((comissaoPercent / 100) * (valorVenda - cupom));
  const retornoTikTok = arredondar(valorVenda - taxaSfp - taxaPlataforma - cupom - comissaoAfiliado);
  const retornoSanhero = arredondar(retornoTikTok - valorVenda * 0.18);
  const lucro = arredondar(retornoSanhero - custo);
  const margem = retornoSanhero > 0 ? lucro / retornoSanhero : 0;
  return {
    nome,
    sku: skuNorm,
    valorVenda,
    taxaSfp,
    taxaPlataforma,
    comissaoPercent,
    cupom,
    comissaoAfiliado,
    custo,
    retornoTikTok,
    retornoSanhero,
    lucro,
    margem,
  };
}

function produtosParaRegistros(produtos) {
  const arr = Array.isArray(produtos) ? produtos : [];
  return arr.map((item) => ({
    id: item.id,
    ...calcularLinha({
      nome: item.nome,
      sku: item.sku,
      valorVenda: item.valorVenda,
      comissaoPercent: item.comissaoPercent,
      cupom: item.cupom,
      custo: item.custo,
    }),
    ...(item.bluefocusProdutoId != null && item.bluefocusProdutoId !== ""
      ? {
          bluefocusProdutoId: Number(item.bluefocusProdutoId),
          bluefocusCodigoBarras: item.bluefocusCodigoBarras,
        }
      : {}),
    criadoEm: item.criadoEm || Date.now(),
    atualizadoEm: item.atualizadoEm || Date.now(),
  }));
}

function temVinculoBluefocus(p) {
  if (p.bluefocusProdutoId != null && p.bluefocusProdutoId !== "") return true;
  const sku = String(p.sku ?? "").trim();
  return sku !== "" && /^\d+$/.test(sku);
}

const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const percentual = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const fmtDataHora = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const elKpiProdutos = document.getElementById("dash-kpi-produtos");
const elKpiLucro = document.getElementById("dash-kpi-lucro");
const elKpiMargem = document.getElementById("dash-kpi-margem");
const elKpiBf = document.getElementById("dash-kpi-bf");
const elKpiVolume = document.getElementById("dash-kpi-volume");
const elBfMonitor = document.getElementById("dash-bf-monitor");
const elBfLinha = document.getElementById("dash-bf-linha");
const elBfBaseline = document.getElementById("dash-bf-baseline");
const elBfConexao = document.getElementById("dash-bf-conexao");
const elTopBody = document.getElementById("dash-top-body");
const elMeta = document.getElementById("dash-meta");
const elClock = document.getElementById("dash-clock");

function hojeISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function renderPainel() {
  const db = window.TouyaDB.readDb();
  const registros = produtosParaRegistros(db.produtos || []);
  const bf = window.TouyaDB.normalizeBluefocus(db.bluefocus);

  const n = registros.length;
  let lucroTotal = 0;
  let volume = 0;
  let somaRetornoPos = 0;
  let somaLucroPos = 0;
  let comBf = 0;

  registros.forEach((p) => {
    lucroTotal += p.lucro;
    volume += p.valorVenda;
    if (p.retornoSanhero > 0) {
      somaRetornoPos += p.retornoSanhero;
      somaLucroPos += p.lucro;
    }
    if (temVinculoBluefocus(p)) comBf += 1;
  });

  const margemPond = somaRetornoPos > 0 ? somaLucroPos / somaRetornoPos : 0;

  if (elKpiProdutos) elKpiProdutos.textContent = String(n);
  if (elKpiLucro) elKpiLucro.textContent = moeda.format(lucroTotal);
  if (elKpiMargem) elKpiMargem.textContent = percentual.format(margemPond);
  if (elKpiBf) elKpiBf.textContent = `${comBf} / ${n}`;
  if (elKpiVolume) elKpiVolume.textContent = moeda.format(volume);

  const mon = Array.isArray(bf.monitor) ? bf.monitor : [];
  const linhasOk = mon.filter((r) => String(r.produtoId ?? "").trim() && String(r.codigoBarras ?? "").trim()).length;
  if (elBfMonitor) elBfMonitor.textContent = String(mon.length);
  if (elBfLinha) elBfLinha.textContent = String(linhasOk);

  const bas = bf.baselines && typeof bf.baselines === "object" ? bf.baselines : {};
  const hoje = hojeISO();
  if (elBfBaseline) {
    elBfBaseline.textContent = bas[hoje] && typeof bas[hoje] === "object" ? "Registrado hoje" : "Ainda não";
  }

  const cfg = bf.config || {};
  const conectado = Boolean(
    String(cfg.empresaId || "").trim() &&
      String(cfg.usuarioId || "").trim() &&
      cfg.pdvCodigo !== undefined &&
      cfg.pdvCodigo !== null &&
      String(cfg.pdvCodigo).trim() !== "" &&
      String(cfg.token || "").trim()
  );
  if (elBfConexao) {
    elBfConexao.textContent = conectado ? "Configurada" : "Incompleta";
    elBfConexao.className = "dash-bf-status " + (conectado ? "dash-bf-ok" : "dash-bf-warn");
  }

  const top = [...registros].sort((a, b) => b.lucro - a.lucro).slice(0, 10);
  if (elTopBody) {
    elTopBody.innerHTML = "";
    if (top.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "muted-cell";
      td.textContent = "Nenhum produto na calculadora. Adicione itens na página principal.";
      tr.appendChild(td);
      elTopBody.appendChild(tr);
    } else {
      top.forEach((p, i) => {
        const tr = document.createElement("tr");
        const cls = p.lucro >= 0 ? "lucro-positivo" : "lucro-negativo";
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td>${escapeHtml(p.nome)}</td>
          <td>${moeda.format(p.valorVenda)}</td>
          <td class="${cls}">${moeda.format(p.lucro)}</td>
          <td class="${cls}">${percentual.format(p.margem)}</td>
        `;
        elTopBody.appendChild(tr);
      });
    }
  }

  const upd = db.updatedAt ? new Date(db.updatedAt).toLocaleString("pt-BR") : "—";
  if (elMeta) {
    elMeta.textContent = `Última sincronização do banco: ${upd} · Atualização automática a cada poucos segundos.`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tickClock() {
  if (elClock) elClock.textContent = fmtDataHora.format(new Date());
}

async function init() {
  await window.TouyaDB.init();
  renderPainel();
  tickClock();
  setInterval(tickClock, 1000);

  window.TouyaDB.onRemoteChange(() => renderPainel());
  setInterval(() => {
    window.TouyaDB.refresh().catch(() => {});
  }, 8000);
}

init().catch((e) => console.error("[apresentacao]", e));
