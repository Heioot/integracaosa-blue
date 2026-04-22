function novoId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* file:// ou contexto restrito */
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

const form = document.getElementById("calc-form");
const tabelaBody = document.getElementById("resultado-body");
const btnLimpar = document.getElementById("limpar");
const btnExportarJson = document.getElementById("exportar-json");
const inputImportarJson = document.getElementById("importar-json");
const filtroNome = document.getElementById("filtro-nome");
const filtroMin = document.getElementById("filtro-min");
const filtroMax = document.getElementById("filtro-max");
const ordenacao = document.getElementById("ordenacao");
const appShell = document.querySelector(".app-shell");
const toggleSidebarBtn = document.getElementById("toggle-sidebar");
const navMobileToggle = document.getElementById("nav-mobile-toggle");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

/* Mesmo breakpoint do CSS: gaveta + hamburger (≤980px) */
const mqMobileNav = window.matchMedia("(max-width: 980px)");

/** Atualiza aria-expanded / aria-label do botão hamburger conforme o painel lateral. */
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
const sideNavLinks = document.querySelectorAll(".side-nav a");
const editModal = document.getElementById("edit-modal");
const editForm = document.getElementById("edit-form");
const cancelarModalBtn = document.getElementById("cancelar-modal");

let registros = [];
let editandoId = null;

const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const percentual = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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

function normalizeBluefocusForDb(bf) {
  return window.TouyaDB.normalizeBluefocus(bf);
}

/** @param {object|undefined} bluefocusOverride — se omitido, mantém o bluefocus já no servidor */
function salvarLocal(bluefocusOverride) {
  const db = window.TouyaDB.readDb();
  db.produtos = registros;
  if (bluefocusOverride !== undefined) {
    db.bluefocus = window.TouyaDB.normalizeBluefocus(bluefocusOverride);
  }
  window.TouyaDB.writeDb(db);
}

function montarDbCompletoParaExportar() {
  const db = window.TouyaDB.readDb();
  return {
    updatedAt: new Date().toISOString(),
    produtos: registros,
    bluefocus: normalizeBluefocusForDb(db.bluefocus),
  };
}

function produtosSalvosParaRegistros(produtos) {
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

async function carregarArquivoBase() {
  try {
    const response = await fetch("./db/produtos.json");
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

function resetarFormulario() {
  if (form) form.reset();
  const cup = document.getElementById("cupom");
  if (cup) cup.value = "1.00";
  const bfId = document.getElementById("bluefocusProdutoId");
  const bfCb = document.getElementById("bluefocusCodigoBarras");
  if (bfId) bfId.value = "";
  if (bfCb) bfCb.value = "";
}

function abrirModalEdicao(item) {
  editandoId = item.id;
  document.getElementById("edit-nome").value = item.nome;
  document.getElementById("edit-sku").value = item.sku ?? "";
  document.getElementById("edit-valorVenda").value = item.valorVenda;
  document.getElementById("edit-comissaoPercent").value = item.comissaoPercent;
  document.getElementById("edit-cupom").value = item.cupom;
  document.getElementById("edit-custo").value = item.custo;
  const ePid = document.getElementById("edit-bluefocusProdutoId");
  const eCb = document.getElementById("edit-bluefocusCodigoBarras");
  if (ePid) ePid.value = item.bluefocusProdutoId != null && item.bluefocusProdutoId !== "" ? item.bluefocusProdutoId : "";
  if (eCb) eCb.value = item.bluefocusCodigoBarras ?? "";
  editModal.showModal();
}

function fecharModalEdicao() {
  editandoId = null;
  editForm.reset();
  editModal.close();
}

function filtrarEOrdenar(lista) {
  const nome = (filtroNome?.value ?? "").trim().toLowerCase();
  const minStr = (filtroMin?.value ?? "").trim();
  const maxStr = (filtroMax?.value ?? "").trim();
  const min = minStr === "" ? null : Number(minStr);
  const max = maxStr === "" ? null : Number(maxStr);

  const filtrado = lista.filter((item) => {
    const sku = String(item.sku ?? "").toLowerCase();
    const nomeBusca = `${item.nome} ${sku}`.toLowerCase();
    const nomeOk = nomeBusca.includes(nome);
    const minOk = min === null || Number.isNaN(min) ? true : item.valorVenda >= min;
    const maxOk = max === null || Number.isNaN(max) ? true : item.valorVenda <= max;
    return nomeOk && minOk && maxOk;
  });

  const tipo = ordenacao?.value ?? "recentes";
  filtrado.sort((a, b) => {
    if (tipo === "nome-asc") return a.nome.localeCompare(b.nome, "pt-BR");
    if (tipo === "nome-desc") return b.nome.localeCompare(a.nome, "pt-BR");
    if (tipo === "preco-asc") return a.valorVenda - b.valorVenda;
    if (tipo === "preco-desc") return b.valorVenda - a.valorVenda;
    if (tipo === "lucro-asc") return a.lucro - b.lucro;
    if (tipo === "lucro-desc") return b.lucro - a.lucro;
    return (b.criadoEm || 0) - (a.criadoEm || 0);
  });

  return filtrado;
}

function fmtTooltip(n) {
  return Number(n).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function tooltipsLinha(item) {
  const v = fmtTooltip(item.valorVenda);
  const c = fmtTooltip(item.cupom);
  const pct = fmtTooltip(item.comissaoPercent);
  const sfp = fmtTooltip(item.taxaSfp);
  const tp = fmtTooltip(item.taxaPlataforma);
  const ca = fmtTooltip(item.comissaoAfiliado);
  const cu = fmtTooltip(item.custo);
  const rt = fmtTooltip(item.retornoTikTok);
  const rs = fmtTooltip(item.retornoSanhero);
  const lu = fmtTooltip(item.lucro);
  const mg = percentual.format(item.margem);
  const skuTxt = String(item.sku ?? "").trim();
  return {
    nome: skuTxt ? `SKU: ${skuTxt}` : "Nenhum SKU cadastrado para este produto.",
    venda: `Valor de venda informado: R$ ${v}.`,
    sfp: `SFP = (Venda − Cupom) × 6% = (${v} − ${c}) × 0,06 = R$ ${sfp}.`,
    taxaPlataforma: `Taxa plataforma = SFP + R$ 4,00 = R$ ${sfp} + 4,00 = R$ ${tp}.`,
    comissaoPct: `Comissão (%) informada: ${pct}%.`,
    cupom: `Cupom (R$) informado: R$ ${c}.`,
    comissaoAfiliado: `Comissão afiliado = Comissão% × (Venda − Cupom) = ${pct}% × (${v} − ${c}) = R$ ${ca}.`,
    custo: `Custo informado: R$ ${cu}.`,
    retornoTikTok: `Retorno TikTok = Venda − SFP − Taxa plataforma − Cupom − Comissão afiliado = R$ ${v} − R$ ${sfp} − R$ ${tp} − R$ ${c} − R$ ${ca} = R$ ${rt}.`,
    retornoSanhero: `Retorno SANHERO = Retorno TikTok − (Venda × 18%) = R$ ${rt} − (${v} × 0,18) = R$ ${rs}.`,
    lucro: `Lucro = Retorno SANHERO − Custo = R$ ${rs} − R$ ${cu} = R$ ${lu}.`,
    margem:
      item.retornoSanhero > 0
        ? `Margem % = Lucro ÷ Retorno SANHERO = R$ ${lu} ÷ R$ ${rs} = ${mg}.`
        : "Margem %: Retorno SANHERO é zero ou negativo; divisão não se aplica.",
  };
}

function criarCelula(valor, classe = "", title = "") {
  const td = document.createElement("td");
  td.textContent = valor;
  if (classe) td.className = classe;
  if (title) {
    td.title = title;
    td.classList.add("cell-com-tooltip");
  }
  return td;
}

function renderizarTabela() {
  if (!tabelaBody) return;
  tabelaBody.innerHTML = "";

  const itens = filtrarEOrdenar(registros);
  itens.forEach((item) => {
    const tr = document.createElement("tr");
    const classeLucro = item.lucro >= 0 ? "lucro-positivo" : "lucro-negativo";
    const tip = tooltipsLinha(item);

    tr.appendChild(criarCelula(item.nome, "", tip.nome));
    tr.appendChild(criarCelula(moeda.format(item.valorVenda), "", tip.venda));
    tr.appendChild(criarCelula(moeda.format(item.taxaSfp), "", tip.sfp));
    tr.appendChild(criarCelula(moeda.format(item.taxaPlataforma), "", tip.taxaPlataforma));
    tr.appendChild(criarCelula(percentual.format(item.comissaoPercent / 100), "", tip.comissaoPct));
    tr.appendChild(criarCelula(moeda.format(item.cupom), "", tip.cupom));
    tr.appendChild(criarCelula(moeda.format(item.comissaoAfiliado), "", tip.comissaoAfiliado));
    tr.appendChild(criarCelula(moeda.format(item.custo), "", tip.custo));
    tr.appendChild(criarCelula(moeda.format(item.retornoTikTok), "", tip.retornoTikTok));
    tr.appendChild(criarCelula(moeda.format(item.retornoSanhero), "", tip.retornoSanhero));
    tr.appendChild(criarCelula(moeda.format(item.lucro), classeLucro, tip.lucro));
    tr.appendChild(criarCelula(percentual.format(item.margem), classeLucro, tip.margem));

    const acoesTd = document.createElement("td");
    const acoes = document.createElement("div");
    acoes.className = "row-actions";

    const editarBtn = document.createElement("button");
    editarBtn.className = "btn-muted";
    editarBtn.textContent = "Editar";
    editarBtn.addEventListener("click", () => {
      abrirModalEdicao(item);
    });

    const excluirBtn = document.createElement("button");
    excluirBtn.className = "danger";
    excluirBtn.textContent = "Excluir";
    excluirBtn.addEventListener("click", () => {
      registros = registros.filter((r) => r.id !== item.id);
      salvarLocal();
      renderizarTabela();
      if (editandoId === item.id) fecharModalEdicao();
    });

    acoes.appendChild(editarBtn);
    acoes.appendChild(excluirBtn);
    acoesTd.appendChild(acoes);
    tr.appendChild(acoesTd);
    tabelaBody.appendChild(tr);
  });
}

if (form) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    /* Não usar await TouyaDB.init() aqui: se GET /api/db travar, o submit nunca continuaria. */
    void window.TouyaDB.init();

    const elNome = document.getElementById("nome");
    const elSku = document.getElementById("sku");
    const elVenda = document.getElementById("valorVenda");
    const elComissao = document.getElementById("comissaoPercent");
    const elCupom = document.getElementById("cupom");
    const elCusto = document.getElementById("custo");
    if (!elNome || !elVenda || !elComissao || !elCupom || !elCusto) return;

    const base = {
      nome: elNome.value.trim(),
      sku: (elSku?.value ?? "").trim(),
      valorVenda: Number(elVenda.value),
      comissaoPercent: Number(elComissao.value),
      cupom: Number(elCupom.value),
      custo: Number(elCusto.value),
    };
    if (!base.nome) {
      alert("Informe o nome do produto.");
      elNome.focus();
      return;
    }
    if (!Number.isFinite(base.valorVenda) || base.valorVenda < 0) {
      alert("Informe um valor de venda válido (R$).");
      elVenda.focus();
      return;
    }
    if (!Number.isFinite(base.comissaoPercent) || base.comissaoPercent < 0) {
      alert("Informe a comissão (%) corretamente.");
      elComissao.focus();
      return;
    }
    if (!Number.isFinite(base.cupom) || base.cupom < 0) {
      alert("Informe o cupom (R$) corretamente.");
      elCupom.focus();
      return;
    }
    const custoVal = Number.isFinite(base.custo) ? base.custo : 0;
    base.custo = custoVal < 0 ? 0 : custoVal;

    const bfIdRaw = document.getElementById("bluefocusProdutoId")?.value?.trim();
    const bfCbRaw = document.getElementById("bluefocusCodigoBarras")?.value?.trim() ?? "";
    const bluefocusExtras =
      bfIdRaw !== undefined && bfIdRaw !== ""
        ? {
            bluefocusProdutoId: Number(bfIdRaw),
            bluefocusCodigoBarras: bfCbRaw === "" ? undefined : bfCbRaw,
          }
        : {};

    const calculado = calcularLinha(base);
    registros.unshift({
      id: novoId(),
      ...calculado,
      ...bluefocusExtras,
      criadoEm: Date.now(),
      atualizadoEm: Date.now(),
    });

    /* Filtros ativos escondem linhas que não batem com a busca — parece que «não adicionou». */
    if (filtroNome) filtroNome.value = "";
    if (filtroMin) filtroMin.value = "";
    if (filtroMax) filtroMax.value = "";

    try {
      salvarLocal();
    } catch (e) {
      console.error("[calculadora] salvarLocal:", e);
      alert(
        "Não foi possível gravar no servidor. Abra o site por http://localhost:8080 (servidor.py) e recarregue a página."
      );
    }
    renderizarTabela();
    resetarFormulario();
  });
}

if (cancelarModalBtn) {
  cancelarModalBtn.addEventListener("click", fecharModalEdicao);
}

if (editForm) {
  editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editandoId) return;
    const base = {
      nome: document.getElementById("edit-nome").value.trim(),
      sku: document.getElementById("edit-sku").value.trim(),
      valorVenda: Number(document.getElementById("edit-valorVenda").value),
      comissaoPercent: Number(document.getElementById("edit-comissaoPercent").value),
      cupom: Number(document.getElementById("edit-cupom").value),
      custo: Number(document.getElementById("edit-custo").value),
    };
    if (!base.nome) return;
    const bfIdRaw = document.getElementById("edit-bluefocusProdutoId")?.value?.trim();
    const bfCbRaw = document.getElementById("edit-bluefocusCodigoBarras")?.value?.trim() ?? "";
    const calculado = calcularLinha(base);
    registros = registros.map((item) => {
      if (item.id !== editandoId) return item;
      const next = { ...item, ...calculado, atualizadoEm: Date.now() };
      if (bfIdRaw !== undefined && bfIdRaw !== "") {
        next.bluefocusProdutoId = Number(bfIdRaw);
        next.bluefocusCodigoBarras = bfCbRaw === "" ? undefined : bfCbRaw;
      } else {
        delete next.bluefocusProdutoId;
        delete next.bluefocusCodigoBarras;
      }
      return next;
    });
    salvarLocal();
    renderizarTabela();
    fecharModalEdicao();
  });
}

if (btnLimpar) {
  btnLimpar.addEventListener("click", () => {
    registros = [];
    salvarLocal();
    renderizarTabela();
    resetarFormulario();
  });
}

[filtroNome, filtroMin, filtroMax].forEach((el) => {
  if (el) el.addEventListener("input", renderizarTabela);
});
if (ordenacao) ordenacao.addEventListener("change", renderizarTabela);

if (btnExportarJson) btnExportarJson.addEventListener("click", () => {
  const payload = montarDbCompletoParaExportar();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "touya-db.json";
  link.click();
  URL.revokeObjectURL(url);
});

if (inputImportarJson) inputImportarJson.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    let produtosRaw;
    let bluefocusImport;
    if (Array.isArray(json)) {
      produtosRaw = json;
    } else if (json && Array.isArray(json.produtos)) {
      produtosRaw = json.produtos;
      if (json.bluefocus && typeof json.bluefocus === "object") {
        bluefocusImport = json.bluefocus;
      }
    } else {
      throw new Error("Formato invalido");
    }
    registros = produtosRaw.map((item) => ({
      id: item.id || novoId(),
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
    salvarLocal(bluefocusImport);
    renderizarTabela();
    resetarFormulario();
  } catch (error) {
    alert("JSON invalido. Envie um array de produtos ou o objeto completo (produtos + bluefocus).");
  } finally {
    inputImportarJson.value = "";
  }
});

function normalizarRegistros(base, manterIdOriginal = false) {
  return base.map((item) => ({
    id: manterIdOriginal && item.id ? item.id : novoId(),
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
    atualizadoEm: Date.now(),
  }));
}

async function carregarIniciais() {
  await window.TouyaDB.init();
  const salvos = window.TouyaDB.readDb().produtos;
  if (salvos.length > 0) {
    registros = produtosSalvosParaRegistros(salvos);
    salvarLocal();
    renderizarTabela();
  } else {
    const iniciaisArquivo = await carregarArquivoBase();
    const iniciais = iniciaisArquivo.length > 0
      ? iniciaisArquivo
      : [
          { nome: "MiniMop", sku: "", valorVenda: 14.9, comissaoPercent: 9, cupom: 1, custo: 0 },
          { nome: "Bivolt", sku: "", valorVenda: 329.9, comissaoPercent: 8, cupom: 1, custo: 0 },
        ];

    registros = normalizarRegistros(iniciais, true);
    salvarLocal();
    renderizarTabela();
  }

  window.TouyaDB.setRemoteApplyGuard(() => {
    const a = document.activeElement;
    if (!a?.closest) return true;
    if (editModal?.open && editModal.contains(a)) return false;
    if (
      a.closest("main.container") &&
      (a.tagName === "INPUT" || a.tagName === "SELECT" || a.tagName === "TEXTAREA")
    ) {
      return false;
    }
    return true;
  });
  window.TouyaDB.onRemoteChange((db) => {
    registros = produtosSalvosParaRegistros(db.produtos);
    renderizarTabela();
  });
  document.querySelector("main.container")?.addEventListener("focusout", () => {
    requestAnimationFrame(() => window.TouyaDB.pollOnce());
  });
}

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

sideNavLinks.forEach((link) => {
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

carregarIniciais().catch((err) => console.error("[calculadora]", err));
