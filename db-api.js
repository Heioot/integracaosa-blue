/**
 * Banco único em JSON no servidor (/api/db) — compartilhado na rede.
 * localStorage só é usado uma vez para migrar dados antigos (touya_local_db_json).
 */
(function (global) {
  const API_DB = "/api/db";
  const STORAGE_LEGACY_DB = "touya_local_db_json";
  const STORAGE_LEGACY_CALC = "touya_tiktok_calculos";

  function defaultBluefocus() {
    return { config: {}, monitor: [], baselines: {} };
  }

  function normalizeBluefocus(bf) {
    if (!bf || typeof bf !== "object") return defaultBluefocus();
    return {
      config: typeof bf.config === "object" && bf.config ? bf.config : {},
      monitor: Array.isArray(bf.monitor) ? bf.monitor : [],
      baselines: typeof bf.baselines === "object" && bf.baselines ? bf.baselines : {},
    };
  }

  function normalizeFull(parsed) {
    const d = parsed && typeof parsed === "object" ? parsed : {};
    return {
      updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : new Date().toISOString(),
      produtos: Array.isArray(d.produtos) ? d.produtos : [],
      bluefocus: normalizeBluefocus(d.bluefocus),
    };
  }

  let memDb = normalizeFull({});
  let persistTimer = null;
  let persistInflight = false;
  let initPromise = null;
  let pollTimer = null;
  const remoteListeners = new Set();
  const POLL_MS = 3500;
  /** Se devolver false, não aplica o JSON remoto em memDb (evita divergir da UI em edição). */
  let remoteApplyGuard = null;
  /** Ignora poll por um instante após gravar, para o servidor antigo não «apagar» a linha nova. */
  let ignoreRemotePollUntil = 0;

  function notifyRemoteListeners() {
    remoteListeners.forEach((fn) => {
      try {
        fn(memDb);
      } catch (e) {
        console.error("[TouyaDB] listener:", e);
      }
    });
  }

  async function persistNow() {
    persistInflight = true;
    try {
      const res = await fetch(API_DB, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(memDb),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.error("[TouyaDB] Falha ao salvar no servidor:", e);
    } finally {
      persistInflight = false;
    }
  }

  function schedulePersist() {
    memDb.updatedAt = new Date().toISOString();
    ignoreRemotePollUntil = Date.now() + 1200;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 280);
  }

  function readDb() {
    return memDb;
  }

  function writeDb(db) {
    if (db && typeof db === "object") {
      if (db.produtos !== undefined) memDb.produtos = db.produtos;
      if (db.bluefocus !== undefined) memDb.bluefocus = normalizeBluefocus(db.bluefocus);
    }
    schedulePersist();
  }

  function serverLooksEmpty() {
    const bf = memDb.bluefocus;
    const cfgKeys = bf.config && typeof bf.config === "object" ? Object.keys(bf.config).length : 0;
    const monLen = Array.isArray(bf.monitor) ? bf.monitor.length : 0;
    const baseLen = bf.baselines && typeof bf.baselines === "object" ? Object.keys(bf.baselines).length : 0;
    return memDb.produtos.length === 0 && cfgKeys === 0 && monLen === 0 && baseLen === 0;
  }

  function migrateLegacyLocalFullDb() {
    const raw = localStorage.getItem(STORAGE_LEGACY_DB);
    if (!raw) return;
    try {
      const parsedNorm = normalizeFull(JSON.parse(raw));
      const hasProdutos = parsedNorm.produtos.length > 0;
      const bf = parsedNorm.bluefocus;
      const hasBf =
        (bf.config && Object.keys(bf.config).length > 0) ||
        (bf.monitor && bf.monitor.length > 0) ||
        (bf.baselines && Object.keys(bf.baselines).length > 0);
      if ((hasProdutos || hasBf) && serverLooksEmpty()) {
        memDb = parsedNorm;
        localStorage.removeItem(STORAGE_LEGACY_DB);
        localStorage.removeItem(STORAGE_LEGACY_CALC);
        persistNow();
      }
    } catch {
      /* ignore */
    }
  }

  const FETCH_TIMEOUT_MS = 8000;
  const SOAP_CONFIG_DEFAULTS_URL = "/db/bluefocus-soap-config.json";

  function bluefocusConfigEmpty(cfg) {
    if (!cfg || typeof cfg !== "object") return true;
    if (String(cfg.empresaId || "").trim()) return false;
    if (String(cfg.usuarioId || "").trim()) return false;
    if (String(cfg.token || "").trim()) return false;
    const pdv = cfg.pdvCodigo;
    if (pdv !== undefined && pdv !== null && String(pdv).trim() !== "") return false;
    return true;
  }

  /** Preenche bluefocus.config a partir de db/bluefocus-soap-config.json se ainda estiver vazio (após migração legada). */
  async function mergeBluefocusSoapFromDefaultsFile() {
    if (!bluefocusConfigEmpty(memDb.bluefocus?.config)) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(SOAP_CONFIG_DEFAULTS_URL, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const defaults = await res.json();
      if (!defaults || typeof defaults !== "object") return;
      const keys = ["empresaId", "usuarioId", "pdvCodigo", "token"];
      const prev = memDb.bluefocus.config || {};
      const next = { ...prev };
      let changed = false;
      for (const k of keys) {
        if (!(k in defaults)) continue;
        const v = defaults[k];
        if (v === null || v === undefined) continue;
        if (typeof v === "string" && !v.trim()) continue;
        if (k === "pdvCodigo") {
          const n = Number(v);
          if (Number.isNaN(n)) continue;
          next[k] = n;
        } else {
          next[k] = String(v).trim();
        }
        changed = true;
      }
      if (!changed) return;
      memDb.bluefocus = normalizeBluefocus(memDb.bluefocus);
      memDb.bluefocus.config = { ...memDb.bluefocus.config, ...next };
      schedulePersist();
    } catch {
      /* rede / arquivo ausente */
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadFromServer() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(API_DB, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) {
        memDb = normalizeFull(await res.json());
        return;
      }
    } catch (e) {
      console.warn("[TouyaDB] GET /api/db falhou (use servidor.py na mesma origem):", e);
    } finally {
      clearTimeout(timer);
    }
  }

  function snapshotSync(db) {
    return JSON.stringify({ p: db.produtos, b: db.bluefocus });
  }

  /** Busca o JSON no servidor e aplica se alguém na rede salvou versão mais nova. */
  async function pollOnce() {
    if (persistTimer != null || persistInflight) return;
    if (Date.now() < ignoreRemotePollUntil) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(API_DB, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return;
      const remote = normalizeFull(await res.json());
      const mudou =
        remote.updatedAt > memDb.updatedAt ||
        (remote.updatedAt === memDb.updatedAt && snapshotSync(remote) !== snapshotSync(memDb));
      if (!mudou) return;
      if (remoteApplyGuard && remoteApplyGuard(remote) === false) return;
      memDb = remote;
      notifyRemoteListeners();
    } catch {
      /* rede / servidor indisponível */
    } finally {
      clearTimeout(timer);
    }
  }

  function startPolling() {
    if (pollTimer != null) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      pollOnce();
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pollOnce();
    });
  }

  /** Regista callback quando o servidor devolve dados mais novos (outra aba / outro PC). */
  function onRemoteChange(fn) {
    remoteListeners.add(fn);
    return () => remoteListeners.delete(fn);
  }

  function setRemoteApplyGuard(fn) {
    remoteApplyGuard = typeof fn === "function" ? fn : null;
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await loadFromServer();
      migrateLegacyLocalFullDb();
      await mergeBluefocusSoapFromDefaultsFile();
      startPolling();
    })();
    return initPromise;
  }

  async function refresh() {
    await loadFromServer();
    await mergeBluefocusSoapFromDefaultsFile();
    notifyRemoteListeners();
  }

  global.TouyaDB = {
    init,
    refresh,
    readDb,
    writeDb,
    normalizeBluefocus,
    persistNow,
    defaultBluefocus,
    onRemoteChange,
    setRemoteApplyGuard,
    pollOnce,
    bluefocusConfigEmpty,
    mergeBluefocusSoapFromDefaultsFile,
  };
})(typeof window !== "undefined" ? window : globalThis);
