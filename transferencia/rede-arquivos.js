(function () {
  /** Sempre origem absoluta (evita /api relativo errado); file:// → localhost:8080. */
  function baseApiTouya() {
    const proto = window.location.protocol;
    if (proto === "file:") {
      return "http://localhost:8080";
    }
    return window.location.origin || "";
  }

  const BASE = baseApiTouya();
  const API = `${BASE}/api/rede-arquivos`;
  const UPLOAD = `${BASE}/api/rede-arquivos/upload`;
  const DOWNLOAD = `${BASE}/api/rede-arquivos/download`;
  const MKDIR = `${BASE}/api/rede-arquivos/mkdir`;
  /** GET sem query string — útil se algo remover ?mkdir= da URL. */
  const MKDIR_PATH = `${BASE}/api/rede-mkdir`;

  function mkdirPathUrl(rel) {
    const parts = String(rel || "")
      .split("/")
      .filter(Boolean)
      .map((s) => encodeURIComponent(s));
    return parts.length ? `${MKDIR_PATH}/${parts.join("/")}` : MKDIR_PATH;
  }

  const elDrop = document.getElementById("rede-dropzone");
  const elInput = document.getElementById("rede-file-input");
  const elCards = document.getElementById("rede-cards");
  const elStatus = document.getElementById("rede-status");
  const elErr = document.getElementById("rede-erro");
  const elBc = document.getElementById("rede-bc");
  const elBtnUp = document.getElementById("rede-btn-up");
  const elBtnMkdir = document.getElementById("rede-btn-mkdir");
  const elHint = document.getElementById("rede-dropzone-hint");

  /** Caminho relativo da pasta atual ("" = raiz). */
  let currentPath = "";

  /** Cancela GET de listagem anterior para não empilhar requisições lentas. */
  let listFetchAbort = null;

  function setErr(msg) {
    if (elErr) elErr.textContent = msg || "";
  }

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg || "";
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("pt-BR");
    } catch {
      return iso;
    }
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /** Evita mostrar página HTML de erro do Python no texto vermelho. */
  function formatErrorBody(text) {
    const t = String(text || "").trim();
    if (!t) return "Erro desconhecido.";
    const lower = t.slice(0, 200).toLowerCase();
    if (t.startsWith("<!DOCTYPE") || lower.startsWith("<html")) {
      const code = t.match(/Error code:\s*(\d+)/i);
      const msg = t.match(/<p>Message:\s*([^<]+)/i);
      const bits = [];
      if (code) bits.push(`código ${code[1]}`);
      if (msg) bits.push(msg[1].trim());
      return (
        bits.join(" — ") ||
        "Rota não encontrada no servidor. Salve e reinicie o servidor.py (build rede-mkdir-post ou mais novo)."
      );
    }
    return t.slice(0, 500);
  }

  async function readErrResponse(res) {
    try {
      return formatErrorBody(await res.text());
    } catch {
      return `HTTP ${res.status}`;
    }
  }

  function listUrl() {
    const bust = `_=${Date.now()}`;
    if (currentPath) {
      return `${API}?p=${encodeURIComponent(currentPath)}&${bust}`;
    }
    return `${API}?${bust}`;
  }

  function uploadUrl() {
    return currentPath ? `${UPLOAD}?p=${encodeURIComponent(currentPath)}` : UPLOAD;
  }

  function fileDownloadUrl(name) {
    let u = `${DOWNLOAD}?f=${encodeURIComponent(name)}`;
    if (currentPath) u += `&p=${encodeURIComponent(currentPath)}`;
    return u;
  }

  function filePreviewUrl(name) {
    return `${fileDownloadUrl(name)}&inline=1`;
  }

  function deleteUrl(name) {
    let u = `${API}?f=${encodeURIComponent(name)}`;
    if (currentPath) u += `&p=${encodeURIComponent(currentPath)}`;
    return u;
  }

  function updateDropHint() {
    if (!elHint) return;
    elHint.textContent = currentPath
      ? `Pasta atual: ${currentPath}. Arraste arquivos ou clique para enviar para esta pasta.`
      : "Arraste e solte aqui ou clique. Os arquivos vão para a raiz (rede_transferencia).";
  }

  function renderBreadcrumb() {
    if (!elBc) return;
    const frag = document.createDocumentFragment();
    const parts = [{ label: "Início", path: "" }];
    if (currentPath) {
      let acc = "";
      currentPath.split("/").forEach((seg) => {
        acc = acc ? `${acc}/${seg}` : seg;
        parts.push({ label: seg, path: acc });
      });
    }
    parts.forEach((part, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "rede-bc-sep";
        sep.textContent = "/";
        sep.setAttribute("aria-hidden", "true");
        frag.appendChild(sep);
      }
      if (i === parts.length - 1) {
        const strong = document.createElement("strong");
        strong.className = "rede-bc-current";
        strong.textContent = part.label;
        frag.appendChild(strong);
      } else {
        const a = document.createElement("a");
        a.href = "#";
        a.className = "rede-bc-link";
        a.textContent = part.label;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          currentPath = part.path;
          updateDropHint();
          refreshList();
        });
        frag.appendChild(a);
      }
    });
    elBc.innerHTML = "";
    elBc.appendChild(frag);
    if (elBtnUp) elBtnUp.disabled = !currentPath;
  }

  function itemsFromPayload(data) {
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.files)) {
      return data.files.map((f) => ({
        name: f.name,
        type: "file",
        size: f.size,
        modified: f.modified,
        mime: f.mime || "application/octet-stream",
      }));
    }
    return [];
  }

  function sortItems(items) {
    const arr = (items || []).slice();
    arr.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });
    });
    return arr;
  }

  /** Em telas estreitas / iPhone: não carrega vídeo até o toque — evita várias requisições pesadas ao abrir a página. */
  function useLazyVideoThumb() {
    try {
      return window.matchMedia("(max-width: 980px)").matches;
    } catch {
      return true;
    }
  }

  function thumbForFile(it) {
    const mime = String(it.mime || "");
    if (mime.startsWith("image/")) {
      const url = filePreviewUrl(it.name);
      return `<div class="rede-card-thumb rede-card-thumb--media"><img src="${escapeAttr(url)}" alt="" loading="lazy" decoding="async" /></div>`;
    }
    if (mime.startsWith("video/")) {
      const url = filePreviewUrl(it.name);
      if (useLazyVideoThumb()) {
        return `<div class="rede-card-thumb rede-card-thumb--media rede-card-thumb--video-placeholder" data-video-url="${escapeAttr(url)}" role="button" tabindex="0" aria-label="Carregar pré-visualização do vídeo"><span class="rede-video-ph" aria-hidden="true">▶</span><span class="rede-video-ph-hint">Toque para vídeo</span></div>`;
      }
      return `<div class="rede-card-thumb rede-card-thumb--media"><video src="${escapeAttr(url)}" muted playsinline preload="metadata"></video></div>`;
    }
    if (mime.startsWith("audio/")) {
      const url = filePreviewUrl(it.name);
      return `<div class="rede-card-thumb rede-card-thumb--audio"><audio controls preload="none" src="${escapeAttr(url)}"></audio></div>`;
    }
    if (mime === "application/pdf" || /\.pdf$/i.test(it.name)) {
      return `<div class="rede-card-thumb rede-card-thumb--icon" aria-hidden="true">PDF</div>`;
    }
    const ext = (it.name.split(".").pop() || "").slice(0, 6).toUpperCase();
    return `<div class="rede-card-thumb rede-card-thumb--icon" aria-hidden="true">${escapeHtml(ext || "FILE")}</div>`;
  }

  function activateVideoPlaceholder(ph) {
    if (!ph || ph.dataset.loaded === "1") return;
    const url = ph.getAttribute("data-video-url");
    if (!url) return;
    ph.dataset.loaded = "1";
    ph.innerHTML = "";
    const v = document.createElement("video");
    v.controls = true;
    v.playsInline = true;
    v.muted = true;
    v.preload = "metadata";
    v.src = url;
    ph.appendChild(v);
    ph.classList.remove("rede-card-thumb--video-placeholder");
    ph.classList.add("rede-card-thumb--media");
    ph.removeAttribute("role");
    ph.removeAttribute("tabindex");
  }

  function showListLoading() {
    if (!elCards) return;
    elCards.setAttribute("aria-busy", "true");
    elCards.innerHTML = "";
    const p = document.createElement("p");
    p.className = "rede-empty rede-list-loading";
    p.textContent = "Carregando pasta…";
    elCards.appendChild(p);
  }

  function renderCards(data) {
    if (!elCards) return;
    elCards.removeAttribute("aria-busy");
    const items = sortItems(itemsFromPayload(data));
    elCards.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "rede-empty";
      empty.textContent = "Pasta vazia. Envie arquivos ou crie uma subpasta.";
      elCards.appendChild(empty);
      return;
    }

    items.forEach((it) => {
      const art = document.createElement("article");
      art.className =
        it.type === "folder" ? "rede-card rede-card--folder" : "rede-card rede-card--file";
      art.setAttribute("role", "listitem");

      if (it.type === "folder") {
        art.innerHTML = `
          <div class="rede-card-thumb rede-card-thumb--folder" aria-hidden="true">📁</div>
          <div class="rede-card-body">
            <div class="rede-card-title" title="${escapeAttr(it.name)}">${escapeHtml(it.name)}</div>
            <div class="rede-card-meta">${fmtDate(it.modified)}</div>
            <div class="rede-card-actions">
              <button type="button" class="link-btn rede-btn-remove">Remover pasta</button>
            </div>
          </div>`;
        art.addEventListener("click", (e) => {
          if (e.target.closest(".rede-card-actions")) return;
          currentPath = currentPath ? `${currentPath}/${it.name}` : it.name;
          updateDropHint();
          refreshList();
        });
        art.querySelector(".rede-btn-remove").addEventListener("click", (e) => {
          e.stopPropagation();
          remover(it.name, "folder");
        });
      } else {
        art.innerHTML = `
          ${thumbForFile(it)}
          <div class="rede-card-body">
            <div class="rede-card-title" title="${escapeAttr(it.name)}">${escapeHtml(it.name)}</div>
            <div class="rede-card-meta">${fmtBytes(Number(it.size) || 0)} · ${fmtDate(it.modified)}</div>
            <div class="rede-card-actions">
              <a class="link-btn" href="${escapeAttr(fileDownloadUrl(it.name))}" download>Baixar</a>
              <button type="button" class="link-btn rede-btn-remove">Remover</button>
            </div>
          </div>`;
        art.querySelector(".rede-btn-remove").addEventListener("click", (e) => {
          e.stopPropagation();
          remover(it.name, "file");
        });
      }
      elCards.appendChild(art);
    });
  }

  if (elCards) {
    elCards.addEventListener("click", (e) => {
      const ph = e.target.closest(".rede-card-thumb--video-placeholder");
      if (ph) activateVideoPlaceholder(ph);
    });
    elCards.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const ph = e.target.closest(".rede-card-thumb--video-placeholder");
      if (ph) {
        e.preventDefault();
        activateVideoPlaceholder(ph);
      }
    });
  }

  async function refreshList(opts) {
    const silent = opts && opts.silent;
    if (!silent) setErr("");
    if (!silent) {
      renderBreadcrumb();
      updateDropHint();
      showListLoading();
    }
    if (listFetchAbort) listFetchAbort.abort();
    listFetchAbort = new AbortController();
    const { signal } = listFetchAbort;
    let res;
    try {
      res = await fetch(listUrl(), {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      if (!silent) {
        setErr(e?.message || String(e));
        if (elCards) {
          elCards.removeAttribute("aria-busy");
          elCards.innerHTML = "";
        }
      }
      return;
    }
    if (!res.ok) {
      if (!silent) {
        const hint =
          res.status === 404
            ? " Confirme servidor.py na 8080 e pasta existente."
            : "";
        setErr(`Não foi possível listar (HTTP ${res.status}).${hint}`);
        if (elCards) {
          elCards.removeAttribute("aria-busy");
          elCards.innerHTML = "";
        }
      }
      return;
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      if (!silent) {
        setErr(e?.message || "Resposta inválida ao listar.");
        if (elCards) {
          elCards.removeAttribute("aria-busy");
          elCards.innerHTML = "";
        }
      }
      return;
    }
    if (!silent && data && data.truncated) {
      setStatus(
        `Lista limitada aos primeiros ${Number(data.maxItems) || "?"} itens (pasta muito grande).`
      );
    }
    renderCards(data);
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length === 0) return;
    setErr("");
    setStatus(`Enviando ${files.length} arquivo(s)…`);
    const url = uploadUrl();
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const fd = new FormData();
      fd.append("file", files[i], files[i].name);
      try {
        const res = await fetch(url, { method: "POST", body: fd });
        if (!res.ok) {
          setErr(await readErrResponse(res));
          setStatus("");
          return;
        }
        ok++;
      } catch (e) {
        setErr(e?.message || String(e));
        setStatus("");
        return;
      }
    }
    setStatus(`${ok} arquivo(s) enviado(s).`);
    await refreshList();
  }

  async function remover(name, kind) {
    const label = kind === "folder" ? "pasta" : "arquivo";
    if (!name || !window.confirm(`Remover ${label} "${name}"?`)) return;
    setErr("");
    try {
      const res = await fetch(deleteUrl(name), { method: "DELETE" });
      if (!res.ok) {
        setErr(await readErrResponse(res));
        return;
      }
      setStatus("Removido.");
      await refreshList();
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  async function parseMkdirResponse(res) {
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, err: formatErrorBody(text) };
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const t = text.trim();
    if (t.startsWith("<") || t.toLowerCase().includes("<!doctype")) {
      return {
        ok: false,
        err:
          "A resposta veio em HTML (não é o servidor Touya). Abra http://localhost:8080/transferencia/ usando abrir-calculadora.bat na pasta do projeto.",
      };
    }
    if (!ct.includes("application/json")) {
      return {
        ok: false,
        err: "Resposta sem JSON. Confirme servidor.py (build mkdir-json) na porta 8080.",
      };
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return { ok: false, err: "JSON inválido na resposta." };
    }
    if (!j || typeof j !== "object") {
      return { ok: false, err: "Resposta vazia ou inválida." };
    }
    if (Array.isArray(j.saved)) {
      return {
        ok: false,
        err: "Resposta foi de envio de arquivo (upload), não de criar pasta.",
      };
    }
    /* mkdir: ok + path; upload também tem ok:true mas não tem path de pasta rede. */
    if (
      j.touyaRole === "mkdir" ||
      (j.ok === true &&
        typeof j.path === "string" &&
        !Array.isArray(j.items))
    ) {
      return { ok: true, path: j.path, absPath: j.absPath || "" };
    }
    if (Array.isArray(j.files)) {
      return {
        ok: false,
        err:
          "Resposta não é do servidor Touya (formato «files»). Use só http://localhost:8080/transferencia/ com abrir-calculadora.bat na pasta do projeto.",
      };
    }
    if (j.touyaRole === "list" || Array.isArray(j.items)) {
      return {
        ok: false,
        err:
          "O servidor devolveu a listagem da pasta em vez de criar a subpasta. " +
          "Salve o servidor.py atual, reinicie abrir-calculadora.bat e atualize a página (Ctrl+F5). " +
          "Se persistir, outro programa pode estar na porta 8080 ou bloqueando POST /api.",
      };
    }
    if (j.ok === false) {
      return { ok: false, err: j.message || j.error || "Servidor recusou criar a pasta." };
    }
    if (j.ok == null && j.path != null && j.absPath != null) {
      return { ok: true, path: j.path, absPath: j.absPath || "" };
    }
    return {
      ok: false,
      err: `Resposta inesperada do servidor (sem ok:true). Trecho: ${JSON.stringify(j).slice(0, 180)}`,
    };
  }

  async function criarPasta() {
    const nome = window.prompt("Nome da nova pasta (sem / ou \\):");
    if (nome == null) return;
    const n = String(nome).trim();
    if (!n || /[/\\]/.test(n)) {
      setErr("Nome inválido.");
      return;
    }
    const rel = currentPath ? `${currentPath}/${n}` : n;
    setErr("");
    try {
      const bust = `_=${Date.now()}`;
      const attempts = [
        () =>
          fetch(MKDIR, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ path: rel }),
          }),
        () =>
          fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ op: "mkdir", path: rel }),
          }),
        () =>
          fetch(mkdirPathUrl(rel), {
            method: "GET",
            cache: "no-store",
            headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          }),
        () =>
          fetch(`${API}?mkdir=${encodeURIComponent(rel)}&${bust}`, {
            method: "GET",
            cache: "no-store",
            headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          }),
      ];
      let lastErr = "";
      for (let i = 0; i < attempts.length; i++) {
        const res = await attempts[i]();
        const r = await parseMkdirResponse(res);
        if (r.ok) {
          setStatus(
            r.absPath ? `Pasta criada no disco: ${r.absPath}` : "Pasta criada."
          );
          await refreshList();
          return;
        }
        lastErr = r.err || lastErr;
      }
      setErr(lastErr || "Não foi possível criar a pasta.");
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  if (elBtnUp) {
    elBtnUp.addEventListener("click", () => {
      if (!currentPath) return;
      const parts = currentPath.split("/");
      parts.pop();
      currentPath = parts.join("/");
      refreshList();
    });
  }

  if (elBtnMkdir) {
    elBtnMkdir.addEventListener("click", () => criarPasta());
  }

  if (elDrop) {
    ["dragenter", "dragover"].forEach((ev) => {
      elDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elDrop.classList.add("rede-dropzone--active");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      elDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        elDrop.classList.remove("rede-dropzone--active");
      });
    });
    elDrop.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) uploadFiles(dt.files);
    });
    elDrop.addEventListener("click", () => elInput && elInput.click());
  }

  if (elInput) {
    elInput.addEventListener("change", () => {
      if (elInput.files && elInput.files.length) uploadFiles(elInput.files);
      elInput.value = "";
    });
  }

  updateDropHint();
  refreshList();

  /** Junta focus + visibility e reduz corridas com navegação (debounce). */
  let silentRefreshTimer = null;
  function scheduleSilentRefresh() {
    if (silentRefreshTimer !== null) window.clearTimeout(silentRefreshTimer);
    silentRefreshTimer = window.setTimeout(() => {
      silentRefreshTimer = null;
      if (document.hidden) return;
      refreshList({ silent: true });
    }, 450);
  }

  let pollTimer = null;
  function startAutoRefresh() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => {
      scheduleSilentRefresh();
    }, 45000);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleSilentRefresh();
  });
  window.addEventListener("focus", () => scheduleSilentRefresh());
  startAutoRefresh();

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
})();
