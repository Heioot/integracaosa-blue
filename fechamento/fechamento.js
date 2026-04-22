/**
 * Fechamento: planilha TikTok (income) → médias sem outliers por produto (IQR / Tukey).
 */

const elFile = document.getElementById("fech-arquivo");
const elMes = document.getElementById("fech-mes");
const elAno = document.getElementById("fech-ano");
const elBusca = document.getElementById("fech-busca");
const elRecalc = document.getElementById("fech-recalcular");
const elStatus = document.getElementById("fech-status");
const elResumo = document.getElementById("fech-resumo");

/**
 * Container dos cards. Resolve na hora do uso (evita null se o script rodar antes do DOM).
 * Se a página ainda tiver só a tabela antiga (#fech-tbody), cria/substitui por #fech-cards.
 */
function fechCardsRoot() {
  let el = document.getElementById("fech-cards");
  if (el) return el;

  const legacyTbody = document.getElementById("fech-tbody");
  const wrap =
    legacyTbody?.closest(".table-wrapper") ||
    document.querySelector(".page-fechamento section.card .table-wrapper");

  el = document.createElement("div");
  el.id = "fech-cards";
  el.className = "fech-cards";
  el.setAttribute("role", "list");
  el.setAttribute("aria-label", "Produtos no período");

  if (wrap && wrap.parentNode) {
    wrap.parentNode.replaceChild(el, wrap);
    return el;
  }

  const h2 = Array.from(document.querySelectorAll(".page-fechamento h2")).find((h) =>
    (h.textContent || "").includes("Médias por produto")
  );
  const section = h2?.closest("section.card");
  if (section) {
    section.appendChild(el);
    return el;
  }

  return null;
}

const appShell = document.querySelector(".app-shell");
const toggleSidebarBtn = document.getElementById("toggle-sidebar");
const navMobileToggle = document.getElementById("nav-mobile-toggle");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
const mqMobileNav = window.matchMedia("(max-width: 980px)");

function refreshMobileSidebarAria() {
  if (!navMobileToggle || !appShell) return;
  if (!mqMobileNav.matches) {
    navMobileToggle.setAttribute("aria-expanded", "false");
    return;
  }
  const open = appShell.classList.contains("mobile-sidebar-open");
  navMobileToggle.setAttribute("aria-expanded", open ? "true" : "false");
  navMobileToggle.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
}

const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

const MESES_PT = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

function formatMesAno(y, m) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "—";
  return `${MESES_PT[m - 1]} de ${y}`;
}

/** Remove acentos para casar cabeçalhos exportados em codificações diferentes. */
function normalizeHeader(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findColumnKey(rowSample, candidates) {
  const keys = Object.keys(rowSample || {});
  const normalized = keys.map((k) => ({ raw: k, norm: normalizeHeader(k) }));
  for (const cand of candidates) {
    const want = normalizeHeader(cand);
    const hit = normalized.find((x) => x.norm === want);
    if (hit) return hit.raw;
  }
  for (const cand of candidates) {
    const want = normalizeHeader(cand);
    const hit = normalized.find((x) => x.norm.includes(want) || want.includes(x.norm));
    if (hit) return hit.raw;
  }
  return null;
}

/** @returns {{ y: number, m: number, d: number } | null} */
function parsePedidoDate(v) {
  if (v == null || v === "" || v === "/") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const epoch = new Date((v - 25569) * 86400 * 1000);
    return { y: epoch.getUTCFullYear(), m: epoch.getUTCMonth() + 1, d: epoch.getUTCDate() };
  }
  const s = String(v).trim();
  // "2026/04/14", "2026-04-14T00:00:00.000Z", etc.
  const iso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (iso) {
    return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  }
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (a > 12) return { y, m: b, d: a };
    if (b > 12) return { y, m: a, d: b };
    return { y, m: b, d: a };
  }
  const tryD = Date.parse(s);
  if (!Number.isNaN(tryD)) {
    const d = new Date(tryD);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
  return null;
}

function parseMoney(v) {
  if (v == null || v === "") return NaN;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  let s = String(v).trim().replace(/\s/g, "");
  if (s === "" || s === "-" || s === "/") return NaN;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg ? -n : n;
}

function quantileSorted(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

/**
 * Média dos valores dentro dos limites de Tukey (IQR). Com menos de 4 pontos, usa média simples.
 * @param {number[]} values
 */
function meanWithoutOutliers(values) {
  const nums = values.filter((x) => Number.isFinite(x));
  if (nums.length === 0) return null;
  if (nums.length < 4) {
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  const kept = sorted.filter((x) => x >= low && x <= high);
  if (kept.length === 0) {
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

let lastRows = [];
let lastKeys = /** @type {{ data: string, nome: string, liq: string, vendas: string } | null} */ (null);
/** Resumo das datas da última planilha (para mensagens e período sugerido). */
let lastFileDateSummary = /** @type {{ min: object, max: object, modoY: number, modoM: number, comData: number } | null} */ (null);

function cmpData(a, b) {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

/**
 * Lê todas as datas da coluna e escolhe o mês/ano com mais linhas; guarda min/max para o texto de ajuda.
 */
function resumirDatasPlanilha(rows, keys) {
  /** @type {Map<string, number>} */
  const porMes = new Map();
  let min = null;
  let max = null;
  let comData = 0;
  for (const row of rows) {
    const dt = parsePedidoDate(row[keys.data]);
    if (!dt) continue;
    comData += 1;
    const k = `${dt.y}-${dt.m}`;
    porMes.set(k, (porMes.get(k) || 0) + 1);
    if (!min || cmpData(dt, min) < 0) min = { ...dt };
    if (!max || cmpData(dt, max) > 0) max = { ...dt };
  }
  if (comData === 0 || !min || !max) return null;
  let bestN = -1;
  let modoY = min.y;
  let modoM = min.m;
  for (const [k, n] of porMes) {
    if (n > bestN) {
      bestN = n;
      const [yy, mm] = k.split("-").map(Number);
      modoY = yy;
      modoM = mm;
    }
  }
  return { min, max, modoY, modoM, comData };
}

/**
 * Export TikTok costuma gravar !ref pequeno (ex.: A1:AM4) mesmo com milhares de linhas.
 * SheetJS só inclui em sheet_to_json as linhas dentro de !ref — recalculamos a área pelas células reais.
 */
function expandWorksheetRange(ws, XLSX) {
  if (!ws || typeof ws !== "object") return;
  let maxR = 0;
  let maxC = 0;
  let minR = Infinity;
  let minC = Infinity;
  for (const k of Object.keys(ws)) {
    if (k[0] === "!") continue;
    let addr;
    try {
      addr = XLSX.utils.decode_cell(k);
    } catch {
      continue;
    }
    if (addr.r < minR) minR = addr.r;
    if (addr.c < minC) minC = addr.c;
    if (addr.r > maxR) maxR = addr.r;
    if (addr.c > maxC) maxC = addr.c;
  }
  if (!Number.isFinite(minR) || maxR < minR) return;
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: minR, c: minC },
    e: { r: maxR, c: maxC },
  });
}

/**
 * Usa a aba «Detalhes do pedido» quando existir; senão tenta a primeira aba com cabeçalhos de income.
 */
function pickIncomeSheetRows(wb, XLSX) {
  const names = wb.SheetNames || [];
  const preferred = names.find((n) => /detalhes\s+do\s+pedido/i.test(n));
  const order = preferred ? [preferred, ...names.filter((n) => n !== preferred)] : names;

  for (const name of order) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    expandWorksheetRange(ws, XLSX);
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
    if (rows.length && detectKeys(rows)) {
      return { rows, sheetName: name };
    }
  }

  const name = names[0];
  const ws = wb.Sheets[name];
  expandWorksheetRange(ws, XLSX);
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  return { rows, sheetName: name };
}

function buildWorkbookRows(arrayBuffer) {
  const XLSX = window.XLSX;
  if (!XLSX || typeof XLSX.read !== "function") {
    throw new Error("Biblioteca XLSX não carregou. Verifique a conexão ou recarregue a página.");
  }
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  return pickIncomeSheetRows(wb, XLSX);
}

function detectKeys(rows) {
  if (!rows.length) return null;
  const data = findColumnKey(rows[0], ["Data de criação do pedido", "Data de criacao do pedido"]);
  const nome = findColumnKey(rows[0], ["Nome do produto"]);
  const liq = findColumnKey(rows[0], ["Valor total a ser liquidado"]);
  const vendas = findColumnKey(rows[0], ["Vendas líquidas dos produtos", "Vendas liquidas dos produtos"]);
  if (!data || !nome || !liq || !vendas) return null;
  return { data, nome, liq, vendas };
}

function computeTable(rows, keys, mesRef, anoRef, busca) {
  const mes = Number(mesRef);
  const ano = Number(anoRef);
  const q = (busca || "").trim().toLowerCase();

  /** @type {Map<string, { liq: number[], vendas: number[] }>} */
  const byProduct = new Map();
  let skippedDate = 0;
  let skippedMonth = 0;
  let used = 0;

  for (const row of rows) {
    const nome = String(row[keys.nome] ?? "").trim();
    if (!nome) continue;

    const dt = parsePedidoDate(row[keys.data]);
    if (!dt) {
      skippedDate += 1;
      continue;
    }
    if (dt.m !== mes || dt.y !== ano) {
      skippedMonth += 1;
      continue;
    }

    const vLiq = parseMoney(row[keys.liq]);
    const vVen = parseMoney(row[keys.vendas]);
    if (!Number.isFinite(vLiq) || !Number.isFinite(vVen)) continue;

    if (q && !nome.toLowerCase().includes(q)) continue;

    used += 1;
    if (!byProduct.has(nome)) {
      byProduct.set(nome, { liq: [], vendas: [] });
    }
    const g = byProduct.get(nome);
    g.liq.push(vLiq);
    g.vendas.push(vVen);
  }

  const list = [...byProduct.entries()].map(([nome, g]) => ({
    nome,
    n: g.liq.length,
    mediaLiq: meanWithoutOutliers(g.liq),
    mediaVen: meanWithoutOutliers(g.vendas),
  }));
  list.sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    return a.nome.localeCompare(b.nome, "pt-BR");
  });

  return { list, skippedDate, skippedMonth, used, produtos: byProduct.size };
}

function render() {
  const root = fechCardsRoot();
  if (!root) return;
  if (!lastKeys || !lastRows.length) {
    root.innerHTML = "";
    elResumo.textContent = "";
    elStatus.textContent = "Carregue um arquivo .xlsx (export income TikTok).";
    elStatus.classList.remove("config-feedback-warn");
    return;
  }

  const mes = elMes.value;
  const ano = elAno.value;
  const busca = elBusca.value;

  const { list, skippedDate, skippedMonth, used, produtos } = computeTable(
    lastRows,
    lastKeys,
    mes,
    ano,
    busca
  );

  root.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fech-empty";
    empty.textContent = "Nenhum produto para exibir com os filtros atuais.";
    root.appendChild(empty);
  } else {
    for (const row of list) {
      const art = document.createElement("article");
      art.className = "fech-card";
      art.setAttribute("role", "listitem");

      const head = document.createElement("div");
      head.className = "fech-card-head";

      const badge = document.createElement("span");
      badge.className = "fech-card-qty";
      badge.setAttribute("aria-label", "Pedidos no mês após filtro");
      badge.textContent = String(row.n);

      const title = document.createElement("h3");
      title.className = "fech-card-title";
      title.textContent = row.nome;
      title.title = row.nome;

      head.appendChild(badge);
      head.appendChild(title);

      const stats = document.createElement("dl");
      stats.className = "fech-card-stats";

      const rowLiq = document.createElement("div");
      rowLiq.className = "fech-stat";
      const dtL = document.createElement("dt");
      dtL.textContent = "Média s/ outliers — valor a liquidar";
      const ddL = document.createElement("dd");
      ddL.textContent = row.mediaLiq != null ? moeda.format(row.mediaLiq) : "—";
      rowLiq.appendChild(dtL);
      rowLiq.appendChild(ddL);

      const rowVen = document.createElement("div");
      rowVen.className = "fech-stat";
      const dtV = document.createElement("dt");
      dtV.textContent = "Média s/ outliers — vendas líquidas";
      const ddV = document.createElement("dd");
      ddV.textContent = row.mediaVen != null ? moeda.format(row.mediaVen) : "—";
      rowVen.appendChild(dtV);
      rowVen.appendChild(ddV);

      stats.appendChild(rowLiq);
      stats.appendChild(rowVen);

      art.appendChild(head);
      art.appendChild(stats);
      root.appendChild(art);
    }
  }

  const periodoSel = `${formatMesAno(Number(ano), Number(mes))} (${String(mes).padStart(2, "0")}/${ano})`;
  let faixaDatas = "";
  if (lastFileDateSummary) {
    const { min, max } = lastFileDateSummary;
    faixaDatas = ` Datas na planilha (criação do pedido): de ${min.d.toString().padStart(2, "0")}/${String(min.m).padStart(2, "0")}/${min.y} a ${max.d.toString().padStart(2, "0")}/${String(max.m).padStart(2, "0")}/${max.y}.`;
  }

  elResumo.textContent = `Planilha: ${lastRows.length} linha(s). Período selecionado: ${periodoSel}.${faixaDatas} Neste período: ${used} linha(s) em ${produtos} produto(s). Linhas sem data válida: ${skippedDate}. Fora do período escolhido: ${skippedMonth}. Médias sem outliers: IQR (Tukey); com menos de 4 pedidos por produto, média simples.`;

  if (list.length) {
    elStatus.textContent = `Exibindo ${list.length} produto(s).`;
    elStatus.classList.remove("config-feedback-warn");
  } else if (used === 0 && skippedMonth > 0 && lastFileDateSummary) {
    const sug = formatMesAno(lastFileDateSummary.modoY, lastFileDateSummary.modoM);
    elStatus.textContent = `Nenhum pedido em ${periodoSel}.${faixaDatas} Ajuste o mês/ano (sugestão: ${sug}, onde há mais linhas) ou use outra exportação.`;
    elStatus.classList.add("config-feedback-warn");
  } else {
    elStatus.textContent = "Nenhuma linha para esse mês e filtros.";
    elStatus.classList.toggle("config-feedback-warn", true);
  }
}

async function onFile(ev) {
  const f = ev.target?.files?.[0];
  if (!f) return;
  elStatus.textContent = "Lendo…";
  try {
    const buf = await f.arrayBuffer();
    const { rows, sheetName } = buildWorkbookRows(buf);
    lastRows = rows;
    lastKeys = detectKeys(rows);
    if (!lastKeys) {
      lastRows = [];
      lastFileDateSummary = null;
      elStatus.textContent =
        "Não encontrei as colunas esperadas (Data de criação do Pedido, Nome do produto, Valor total a ser liquidado, Vendas líquidas dos produtos). Confira se é a exportação «income» da TikTok.";
      elStatus.classList.add("config-feedback-warn");
      const cr = fechCardsRoot();
      if (cr) cr.innerHTML = "";
      elResumo.textContent = "";
      return;
    }
    lastFileDateSummary = resumirDatasPlanilha(rows, lastKeys);
    if (lastFileDateSummary && elMes && elAno) {
      elMes.value = String(lastFileDateSummary.modoM);
      elAno.value = String(lastFileDateSummary.modoY);
    }
    elStatus.classList.remove("config-feedback-warn");
    elStatus.textContent = `Arquivo: ${f.name} · aba «${sheetName}». Período ajustado para ${lastFileDateSummary ? formatMesAno(lastFileDateSummary.modoY, lastFileDateSummary.modoM) : "—"} (mês com mais pedidos na planilha).`;
    render();
  } catch (e) {
    lastRows = [];
    lastKeys = null;
    lastFileDateSummary = null;
    elStatus.textContent = e?.message || String(e);
    elStatus.classList.add("config-feedback-warn");
    const cr = fechCardsRoot();
    if (cr) cr.innerHTML = "";
    elResumo.textContent = "";
  }
}

if (elFile) elFile.addEventListener("change", (e) => onFile(e));
if (elMes) elMes.addEventListener("change", render);
if (elAno) elAno.addEventListener("change", render);
if (elBusca) elBusca.addEventListener("input", () => requestAnimationFrame(render));
if (elRecalc) elRecalc.addEventListener("click", render);

if (toggleSidebarBtn && appShell) {
  toggleSidebarBtn.addEventListener("click", () => {
    if (mqMobileNav.matches) {
      appShell.classList.toggle("mobile-sidebar-open");
      refreshMobileSidebarAria();
    } else {
      appShell.classList.toggle("sidebar-collapsed");
    }
  });
}

if (navMobileToggle && appShell) {
  navMobileToggle.addEventListener("click", () => {
    appShell.classList.toggle("mobile-sidebar-open");
    refreshMobileSidebarAria();
  });
}

if (sidebarBackdrop && appShell) {
  sidebarBackdrop.addEventListener("click", () => {
    appShell.classList.remove("mobile-sidebar-open");
    refreshMobileSidebarAria();
  });
}

document.querySelectorAll(".side-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    if (mqMobileNav.matches) {
      appShell.classList.remove("mobile-sidebar-open");
      refreshMobileSidebarAria();
    }
  });
});

window.addEventListener("resize", () => {
  if (!mqMobileNav.matches && appShell) {
    appShell.classList.remove("mobile-sidebar-open");
    refreshMobileSidebarAria();
  }
});

document.querySelectorAll("#nav-dropdown-calculadora .nav-dropdown-menu a").forEach((link) => {
  if (link.textContent.trim() === "Shopee") {
    link.addEventListener("click", (event) => event.preventDefault());
  }
});
