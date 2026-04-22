"""
Servidor estático + proxy para os WebServices SOAP BlueFocus (Consulta Qtde, Exporta Cadastro).
Evita bloqueio CORS ao chamar a API a partir do navegador em localhost.
"""

from __future__ import annotations

import errno
import http.server
import json
import mimetypes
import os
import stat
import re
import socketserver
import tempfile
import urllib.error
import urllib.request
import shutil
from datetime import datetime, timezone
from urllib.parse import parse_qs, quote, unquote, urlparse

PORT = int(os.environ.get("PORT", "8080"))
BIND = os.environ.get("BIND", "0.0.0.0")
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
DB_FILE = os.path.join(DATA_DIR, "touya-db.json")
SOAP_CONFIG_DEFAULTS_FILE = os.path.join(ROOT, "db", "bluefocus-soap-config.json")
SOAP_CONFIG_KEYS = ("empresaId", "usuarioId", "pdvCodigo", "token")
MAX_DB_BYTES = 50 * 1024 * 1024
DEFAULT_DB_OBJ = {
    "updatedAt": "",
    "produtos": [],
    "bluefocus": {"config": {}, "monitor": [], "baselines": {}},
}

# POST deve ir ao servlet (mesmo padrão do ExportaCad). Sem «/servlet/» o servidor costuma responder 404.
BLUEFOCUS_CONSULTA_QTDE = (
    "https://www.app.bluefocus.com.br/BlueFocusCloud/servlet/aintegracaofcxconsultaqtde"
)
BLUEFOCUS_EXPORTA_CAD_SAT = (
    "https://www.app.bluefocus.com.br/BlueFocusCloud/servlet/aintegracaofcxexportacadsat"
)

PROXY_ROUTES = {
    "/api/bluefocus/consulta-qtde": BLUEFOCUS_CONSULTA_QTDE,
    "/api/bluefocus/exporta-cad-sat": BLUEFOCUS_EXPORTA_CAD_SAT,
}

# Troque só para confirmar no terminal que o processo carregou este arquivo (evita 404 com servidor.py antigo).
TOUYA_SERVER_BUILD = "2026-04-14-mobile-hardening"

TRANSFER_DIR = os.path.join(ROOT, "rede_transferencia")
MAX_TRANSFER_BYTES = int(os.environ.get("MAX_TRANSFER_BYTES", str(600 * 1024 * 1024)))
# Evita JSON gigante / travamento ao listar pastas com milhares de arquivos
MAX_LIST_ITEMS = int(os.environ.get("TOUYA_MAX_LIST_ITEMS", "8000"))

# Listagem: lookup por extensão (evita mimetypes.guess_type por arquivo — mais rápido em pastas grandes)
_REDE_EXT_MIME: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".json": "application/json",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
    ".xml": "application/xml",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


def _mime_from_name_list(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    return _REDE_EXT_MIME.get(ext, "application/octet-stream")


def _ensure_data_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


def _ensure_transfer_dir() -> None:
    os.makedirs(TRANSFER_DIR, exist_ok=True)


def _safe_transfer_filename(name: str) -> str:
    name = os.path.basename((name or "").replace("\x00", ""))
    name = name.replace("\r", "").replace("\n", "")
    for c in '<>:"/\\|?*':
        name = name.replace(c, "_")
    name = name.strip()
    if not name or name in (".", ".."):
        return "arquivo"
    return name[:240]


def _path_under_transfer_dir(logical_name: str) -> str | None:
    """Arquivo só na raiz (compatibilidade)."""
    _ensure_transfer_dir()
    safe = _safe_transfer_filename(logical_name)
    root = os.path.abspath(TRANSFER_DIR)
    full = os.path.abspath(os.path.join(TRANSFER_DIR, safe))
    if not full.startswith(root + os.sep):
        return None
    return full


def _normalize_rel_path(p: str | None) -> str | None:
    """Caminho relativo com /; '' = raiz; None = inválido (.. fora da raiz etc.)."""
    if p is None:
        return ""
    s = str(p).strip().replace("\\", "/")
    if not s:
        return ""
    parts: list[str] = []
    for seg in s.split("/"):
        seg = seg.strip()
        if not seg or seg == ".":
            continue
        if seg == "..":
            if not parts:
                return None
            parts.pop()
            continue
        if seg.startswith("."):
            return None
        if len(seg) > 200:
            return None
        for c in '<>:"|?*':
            if c in seg:
                return None
        parts.append(seg)
    if len(parts) > 40:
        return None
    return "/".join(parts)


def _abs_in_transfer(rel: str) -> str | None:
    _ensure_transfer_dir()
    root = os.path.abspath(TRANSFER_DIR)
    rel_n = _normalize_rel_path(rel) if rel != "" else ""
    if rel_n is None:
        return None
    if rel_n == "":
        return root
    full = os.path.abspath(os.path.join(TRANSFER_DIR, *rel_n.split("/")))
    if not full.startswith(root + os.sep):
        return None
    return full


def _safe_item_name(name: str) -> str | None:
    name = os.path.basename((name or "").replace("\x00", "")).strip()
    if not name or name in (".", "..") or name.startswith("."):
        return None
    for c in '<>:"/\\|?*':
        if c in name:
            return None
    return name[:240]


def _abs_item(parent_rel: str, name: str) -> str | None:
    """Arquivo ou pasta em parent_rel (normalizado)."""
    pr = _normalize_rel_path(parent_rel) if parent_rel else ""
    if pr is None:
        return None
    sn = _safe_item_name(name)
    if not sn:
        return None
    rel = f"{pr}/{sn}" if pr else sn
    return _abs_in_transfer(rel)


def _unique_save_path_in_dir(dir_abs: str, safe_name: str) -> str:
    base, ext = os.path.splitext(safe_name)
    candidate = os.path.join(dir_abs, safe_name)
    n = 0
    while os.path.exists(candidate):
        n += 1
        candidate = os.path.join(dir_abs, f"{base}_{n}{ext}")
    return candidate


def _unique_save_path(safe_name: str) -> str:
    _ensure_transfer_dir()
    return _unique_save_path_in_dir(TRANSFER_DIR, safe_name)


def _list_transfer_dir(rel: str) -> dict | None:
    base = _abs_in_transfer(rel)
    if base is None or not os.path.isdir(base):
        return None
    items: list[dict] = []
    truncated = False
    try:
        with os.scandir(base) as scan:
            entries = sorted(scan, key=lambda e: e.name)
    except OSError:
        return None
    for entry in entries:
        if len(items) >= MAX_LIST_ITEMS:
            truncated = True
            break
        name = entry.name
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        try:
            m = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
        except (ValueError, OSError):
            m = ""
        if stat.S_ISDIR(st.st_mode):
            items.append({"name": name, "type": "folder", "modified": m})
        else:
            items.append(
                {
                    "name": name,
                    "type": "file",
                    "size": st.st_size,
                    "modified": m,
                    "mime": _mime_from_name_list(name),
                }
            )
    rel_n = _normalize_rel_path(rel) if rel else ""
    if rel_n is None:
        return None
    out: dict = {"path": rel_n, "items": items, "touyaRole": "list"}
    if truncated:
        out["truncated"] = True
        out["maxItems"] = MAX_LIST_ITEMS
    return out


def _mkdir_ok_dict(rel_n: str | None, ap: str | None) -> dict:
    """Resposta JSON única para qualquer mkdir bem-sucedido (POST ou GET)."""
    return {
        "ok": True,
        "path": rel_n or "",
        "absPath": ap or "",
        "touyaRole": "mkdir",
    }


def _mkdir_from_json(obj: dict) -> tuple[bool, str, str | None, str | None]:
    """Cria pasta (path/rel). Retorna (ok, erro, abs_path, path_rel)."""
    sub = str(obj.get("path") or obj.get("rel") or "").strip()
    rel_n = _normalize_rel_path(sub)
    if rel_n is None or not rel_n:
        return False, "path inválido ou vazio", None, None
    dest = _abs_in_transfer(rel_n)
    if dest is None:
        return False, "Caminho inválido", None, None
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as e:
        return False, str(e), None, None
    if not os.path.isdir(dest):
        return False, "Pasta não foi criada no disco", None, None
    ap = os.path.abspath(dest)
    print(f"[rede-arquivos] mkdir OK rel={rel_n!r} -> {ap}", flush=True)
    return True, "", ap, rel_n


def _multipart_file_parts(body: bytes, content_type: str) -> list[tuple[str, bytes]]:
    m = re.search(r"boundary=([^;\s]+)", content_type, re.I)
    if not m:
        return []
    boundary = m.group(1).strip('"')
    sep = b"\r\n--" + boundary.encode("ascii")
    parts = body.split(sep)
    out: list[tuple[str, bytes]] = []
    for part in parts:
        part = part.lstrip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        head, rest = part.split(b"\r\n\r\n", 1)
        head_s = head.decode("utf-8", errors="replace")
        if rest.endswith(b"\r\n"):
            rest = rest[:-2]
        fn_m = re.search(r'filename="((?:[^"\\]|\\.)*)"', head_s, re.I)
        if fn_m:
            fname = fn_m.group(1).replace('\\"', '"')
        else:
            fn_s = re.search(r"filename\*=UTF-8''([^;\r\n]+)", head_s, re.I)
            if not fn_s:
                continue
            fname = unquote(fn_s.group(1).strip())
        fname = fname.strip()
        if not fname:
            continue
        out.append((fname, rest))
    return out


def _norm_http_path(path: str) -> str:
    """Query string fora; unquote; remove barra final (exceto raiz) — evita 404 em /api/foo/."""
    p = path.split("?", 1)[0]
    p = unquote(p)
    if len(p) > 1 and p.endswith("/"):
        p = p.rstrip("/")
    return p if p else "/"


def _bluefocus_config_empty(cfg: object) -> bool:
    if not isinstance(cfg, dict):
        return True
    if str(cfg.get("empresaId") or "").strip():
        return False
    if str(cfg.get("usuarioId") or "").strip():
        return False
    if str(cfg.get("token") or "").strip():
        return False
    pdv = cfg.get("pdvCodigo")
    if pdv is not None and str(pdv).strip() != "":
        return False
    return True


def _merge_soap_defaults_into_db(data: dict) -> dict:
    """Preenche bluefocus.config a partir de db/bluefocus-soap-config.json se o banco estiver vazio."""
    if not isinstance(data, dict):
        return data
    bf = data.get("bluefocus")
    if not isinstance(bf, dict):
        bf = {}
    cfg = bf.get("config")
    if not _bluefocus_config_empty(cfg):
        return data
    if not os.path.isfile(SOAP_CONFIG_DEFAULTS_FILE):
        return data
    try:
        with open(SOAP_CONFIG_DEFAULTS_FILE, "r", encoding="utf-8") as f:
            defaults = json.load(f)
    except (OSError, json.JSONDecodeError):
        return data
    if not isinstance(defaults, dict):
        return data
    new_cfg = dict(cfg) if isinstance(cfg, dict) else {}
    for k in SOAP_CONFIG_KEYS:
        if k not in defaults:
            continue
        v = defaults[k]
        if v is None or (isinstance(v, str) and not v.strip()):
            continue
        if k == "pdvCodigo":
            try:
                new_cfg[k] = int(v) if str(v).strip() != "" else v
            except (TypeError, ValueError):
                new_cfg[k] = v
        else:
            new_cfg[k] = str(v).strip() if isinstance(v, str) else v
    bf = dict(bf)
    bf["config"] = new_cfg
    out = dict(data)
    out["bluefocus"] = bf
    return out


def _read_db_file() -> dict:
    _ensure_data_dir()
    if not os.path.isfile(DB_FILE):
        data = dict(DEFAULT_DB_OBJ)
    else:
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = dict(DEFAULT_DB_OBJ)
        except (json.JSONDecodeError, OSError):
            data = dict(DEFAULT_DB_OBJ)
    cfg_before = (data.get("bluefocus") or {}).get("config")
    was_empty = _bluefocus_config_empty(cfg_before)
    data = _merge_soap_defaults_into_db(data)
    if was_empty and not _bluefocus_config_empty((data.get("bluefocus") or {}).get("config")):
        try:
            _atomic_write_db(data)
        except (OSError, ValueError):
            pass
    return data


def _dumps_json_bytes(obj: object) -> bytes:
    """Serializa JSON com fallback para tipos não padrão (evita 500 em edge cases)."""
    return json.dumps(obj, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")


def _atomic_write_db(obj: dict) -> None:
    _ensure_data_dir()
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_DB_BYTES:
        raise ValueError("JSON excede tamanho máximo")
    dname = os.path.dirname(DB_FILE) or "."
    fd, tmp_path = tempfile.mkstemp(suffix=".tmp", prefix="touya-db-", dir=dname)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.replace(tmp_path, DB_FILE)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


class TouyaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format, *args):
        """Todas as requisições HTTP aparecem no terminal; robusto a %% na linha e Unicode no console."""
        try:
            line = format % args
        except (TypeError, ValueError):
            line = repr((format, args))
        try:
            print(f"{self.address_string()} - {line}", flush=True)
        except UnicodeEncodeError:
            safe = f"{self.address_string()} - {line}".encode("ascii", "replace").decode("ascii")
            print(safe, flush=True)

    def _parse_content_length(self, default: int = 0) -> int | None:
        """Content-Length numérico e >= 0; None se cabeçalho inválido (evita ValueError no int())."""
        raw = self.headers.get("Content-Length")
        if raw is None or (isinstance(raw, str) and not str(raw).strip()):
            return default
        try:
            n = int(str(raw).strip())
        except (TypeError, ValueError):
            return None
        if n < 0:
            return None
        return n

    def _safe_wfile_write(self, data: bytes) -> bool:
        """Cliente (ex.: Safari iOS) pode fechar o socket antes do fim — não derruba o processo."""
        try:
            self.wfile.write(data)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return False
        except OSError as e:
            if e.errno in (errno.EPIPE, errno.ECONNRESET, errno.ECONNABORTED):
                return False
            # WinError 10053 / 10054 — conexão anulada pelo host
            if getattr(e, "winerror", None) in (10053, 10054):
                return False
            raise

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Bluefocus-Token, autentica, SOAPAction",
        )
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _json_no_cache(self) -> None:
        """Evita que o navegador mostre lista antiga após criar pasta / enviar arquivo."""
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        # Path com barra final preservada — _norm_http_path remove "/" e quebraria redirects de pastas.
        path_http = unquote(parsed.path or "/")
        path_only = _norm_http_path(self.path)

        if path_http == "/transferencia":
            self.send_response(302)
            self.send_header("Location", "/transferencia/")
            self.end_headers()
            return

        if path_only == "/api/touya-ping":
            payload = _dumps_json_bytes(
                {
                    "ok": True,
                    "build": TOUYA_SERVER_BUILD,
                    "rede_arquivos": True,
                    "mkdir_post": True,
                    "mkdir_path_get": True,
                }
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._json_no_cache()
            self.end_headers()
            self._safe_wfile_write(payload)
            return

        if path_only == "/api/rede-arquivos/download":
            raw_p = (qs.get("p") or [""])[0]
            parent_rel = _normalize_rel_path(unquote(raw_p)) if raw_p.strip() else ""
            if parent_rel is None:
                self.send_error(400, "Invalid p")
                return
            raw = (qs.get("f") or qs.get("name") or [None])[0]
            if not raw:
                self.send_error(400, "Missing f")
                return
            logical = unquote(raw)
            path = _abs_item(parent_rel, logical)
            if not path or not os.path.isfile(path):
                self.send_error(404, "Not Found")
                return
            try:
                size = os.path.getsize(path)
            except OSError:
                self.send_error(500, "Cannot read file")
                return
            base_name = os.path.basename(path)
            mime = _mime_from_name_list(base_name)
            if mime == "application/octet-stream":
                mime = mimetypes.guess_type(path)[0] or mime
            inline_q = (qs.get("inline") or ["0"])[0].strip().lower() in ("1", "true", "yes")
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(size))
            ascii_fallback = base_name.encode("ascii", "replace").decode("ascii").replace('"', "_")
            disp_kind = "inline" if inline_q else "attachment"
            disp = (
                f'{disp_kind}; filename="{ascii_fallback}"; '
                f"filename*=UTF-8''{quote(base_name, safe='')}"
            )
            self.send_header("Content-Disposition", disp)
            self.end_headers()
            try:
                with open(path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
            except OSError:
                # Cliente fechou a conexão (comum no Safari ao sair da página) ou erro de leitura
                pass
            return

        if path_only.startswith("/api/rede-mkdir/"):
            rel_raw = path_only[len("/api/rede-mkdir/") :].strip()
            if not rel_raw:
                self.send_error(400, "Caminho vazio")
                return
            parts_decoded: list[str] = []
            for seg in rel_raw.split("/"):
                if not seg:
                    continue
                parts_decoded.append(unquote(seg))
            rel_joined = "/".join(parts_decoded)
            ok, err, ap, rel_n = _mkdir_from_json({"path": rel_joined})
            if not ok:
                self.send_error(400, (err or "Erro")[:800])
                return
            payload = _dumps_json_bytes(_mkdir_ok_dict(rel_n, ap))
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._json_no_cache()
            self.end_headers()
            self._safe_wfile_write(payload)
            print(f"[rede-arquivos] GET path mkdir rel={rel_n!r}", flush=True)
            return

        if path_only == "/api/rede-arquivos":
            mkdir_vals = qs.get("mkdir")
            if mkdir_vals and str(mkdir_vals[0]).strip():
                raw_mk = unquote(str(mkdir_vals[0]).strip())
                ok, err, ap, rel_n = _mkdir_from_json({"path": raw_mk})
                if not ok:
                    self.send_error(400, (err or "Erro")[:800])
                    return
                payload = _dumps_json_bytes(_mkdir_ok_dict(rel_n, ap))
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self._json_no_cache()
                self.end_headers()
                self._safe_wfile_write(payload)
                print(f"[rede-arquivos] GET mkdir rel={rel_n!r}", flush=True)
                return
            raw_p = (qs.get("p") or [""])[0]
            rel = _normalize_rel_path(unquote(raw_p)) if raw_p.strip() else ""
            if rel is None:
                self.send_error(400, "Caminho inválido")
                return
            try:
                data = _list_transfer_dir(rel)
            except OSError as e:
                self.send_error(500, str(e))
                return
            except Exception as e:
                print(f"[rede-arquivos] GET list exceção: {e!r}", flush=True)
                self.send_error(500, "Erro ao listar pasta")
                return
            if data is None:
                self.send_error(404, "Pasta não encontrada")
                return
            try:
                payload = _dumps_json_bytes(data)
            except (TypeError, ValueError) as e:
                print(f"[rede-arquivos] JSON lista: {e!r}", flush=True)
                self.send_error(500, "Erro ao montar resposta")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._json_no_cache()
            self.end_headers()
            self._safe_wfile_write(payload)
            if os.environ.get("TOUYA_DEBUG_REDE"):
                n = len(data.get("items") or [])
                print(f"[rede-arquivos] GET list p={rel!r} — {n} item(ns)", flush=True)
            return

        if path_only == "/api/db":
            try:
                body = _read_db_file()
            except OSError as e:
                self.send_error(500, str(e))
                return
            payload = _dumps_json_bytes(body)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._json_no_cache()
            self.end_headers()
            self._safe_wfile_write(payload)
            return
        if path_http == "/movimentacao":
            self.send_response(302)
            self.send_header("Location", "/movimentacao/")
            self.end_headers()
            return
        if path_http == "/fechamento":
            self.send_response(302)
            self.send_header("Location", "/fechamento/")
            self.end_headers()
            return
        if path_only in ("/apresentacao", "/apresentacao/"):
            self.send_response(302)
            self.send_header("Location", "/apresentacao.html")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        path = _norm_http_path(self.path)
        if path == "/api/rede-arquivos/mkdir":
            length = self._parse_content_length(0)
            if length is None or length <= 0 or length > 65536:
                self.send_error(400, "Corpo inválido")
                return
            body = self.rfile.read(length)
            try:
                obj = json.loads(body.decode("utf-8") if body else "{}")
            except json.JSONDecodeError:
                self.send_error(400, "JSON inválido")
                return
            if not isinstance(obj, dict):
                self.send_error(400, "JSON deve ser objeto")
                return
            ok, err, ap, rel_n = _mkdir_from_json(obj)
            if not ok:
                self.send_error(400, (err or "Erro")[:800])
                return
            payload = _dumps_json_bytes(_mkdir_ok_dict(rel_n, ap))
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._json_no_cache()
            self.end_headers()
            self._safe_wfile_write(payload)
            return

        if path == "/api/rede-arquivos/upload":
            parsed = urlparse(self.path)
            qs = parse_qs(parsed.query)
            raw_p = (qs.get("p") or [""])[0]
            parent_rel = _normalize_rel_path(unquote(raw_p)) if raw_p.strip() else ""
            if parent_rel is None:
                self.send_error(400, "Caminho p inválido")
                return
            dest_dir = _abs_in_transfer(parent_rel)
            if dest_dir is None:
                self.send_error(400, "Caminho inválido")
                return
            length = self._parse_content_length(0)
            if length is None or length <= 0 or length > MAX_TRANSFER_BYTES:
                self.send_error(413, "Arquivo muito grande ou corpo vazio")
                return
            ct = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ct.lower():
                self.send_error(400, "Use multipart/form-data")
                return
            body = self.rfile.read(length)
            parts = _multipart_file_parts(body, ct)
            if not parts:
                self.send_error(400, "Nenhum arquivo no envio")
                return
            try:
                os.makedirs(dest_dir, exist_ok=True)
            except OSError as e:
                self.send_error(500, str(e))
                return
            saved: list[str] = []
            for orig_name, data in parts:
                safe = _safe_transfer_filename(orig_name)
                dest = _unique_save_path_in_dir(dest_dir, safe)
                try:
                    with open(dest, "wb") as f:
                        f.write(data)
                except OSError as e:
                    self.send_error(500, str(e))
                    return
                saved.append(os.path.basename(dest))
                print(
                    f"[rede-arquivos] upload salvo: {dest} ({len(data)} bytes)",
                    flush=True,
                )
            payload = _dumps_json_bytes({"ok": True, "saved": saved})
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self._safe_wfile_write(payload)
            return

        if path == "/api/rede-arquivos":
            ct = self.headers.get("Content-Type", "")
            if "application/json" not in ct.lower():
                self.send_error(415, "Use Content-Type: application/json")
                return
            length = self._parse_content_length(0)
            if length is None or length <= 0 or length > 65536:
                self.send_error(400, "Corpo inválido")
                return
            body = self.rfile.read(length)
            try:
                obj = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError:
                self.send_error(400, "JSON inválido")
                return
            if not isinstance(obj, dict):
                self.send_error(400, "JSON inválido")
                return
            if obj.get("op") != "mkdir":
                self.send_error(400, "Informe op: mkdir")
                return
            ok, err, ap, rel_n = _mkdir_from_json(obj)
            if not ok:
                self.send_error(400, (err or "Erro")[:800])
                return
            payload = _dumps_json_bytes(_mkdir_ok_dict(rel_n, ap))
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._json_no_cache()
            self.end_headers()
            self._safe_wfile_write(payload)
            return

        if path == "/api/db":
            length = self._parse_content_length(0)
            if length is None:
                self.send_error(400, "Content-Length inválido")
                return
            if length > MAX_DB_BYTES:
                self.send_error(413, "Payload Too Large")
                return
            body = self.rfile.read(length) if length else b""
            try:
                obj = json.loads(body.decode("utf-8") if body else "{}")
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            if not isinstance(obj, dict):
                self.send_error(400, "JSON must be an object")
                return
            try:
                _atomic_write_db(obj)
            except ValueError as e:
                self.send_error(413, str(e))
                return
            except OSError as e:
                self.send_error(500, str(e))
                return
            self.send_response(204)
            self.end_headers()
            return
        target_url = PROXY_ROUTES.get(path)
        if not target_url:
            print(
                f"[Touya] POST 404 — path={path!r} raw={self.path!r} | "
                f"build {TOUYA_SERVER_BUILD} (se não aparecer «rede-arquivos» no build, reinicie com servidor.py atual)",
                flush=True,
            )
            self.send_error(404, "Not Found")
            return

        length = self._parse_content_length(0)
        if length is None:
            self.send_error(400, "Content-Length inválido")
            return
        body = self.rfile.read(length) if length else b""

        token = (
            self.headers.get("X-Bluefocus-Token")
            or self.headers.get("autentica")
            or ""
        )
        soap_action = self.headers.get("SOAPAction", "").strip()

        print(
            f"[BlueFocus proxy] POST {path} -> {target_url} | "
            f"corpo {len(body)} bytes | token={bool(token)} | SOAPAction={'sim' if soap_action else 'não'}",
            flush=True,
        )

        req = urllib.request.Request(target_url, data=body, method="POST")
        req.add_header("Content-Type", "text/xml; charset=utf-8")
        if token:
            req.add_header("autentica", token)
        if soap_action:
            req.add_header("SOAPAction", soap_action)

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
        except urllib.error.HTTPError as e:
            err_body = e.read() if e.fp else b""
            print(f"[BlueFocus proxy] ERRO HTTP {e.code} em {path} ({len(err_body)} bytes corpo erro)", flush=True)
            self.send_response(e.code)
            self.send_header("Content-Type", "text/xml; charset=utf-8")
            self.end_headers()
            self._safe_wfile_write(err_body)
            return
        except OSError as e:
            print(f"[BlueFocus proxy] ERRO rede {path}: {e!s}", flush=True)
            msg = str(e).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self._safe_wfile_write(msg)
            return

        print(f"[BlueFocus proxy] OK {path} — resposta {len(data)} bytes", flush=True)
        if path == "/api/bluefocus/consulta-qtde" and len(data) > 0:
            preview = data[:900].decode("utf-8", errors="replace").replace("\r", " ").replace("\n", " ")
            print(f"[BlueFocus proxy] prévia XML: {preview[:800]}…", flush=True)
        self.send_response(200)
        # text/xml costuma exibir melhor no DevTools (Resposta) que application/xml
        self.send_header("Content-Type", "text/xml; charset=utf-8")
        self.end_headers()
        self._safe_wfile_write(data)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        path_only = _norm_http_path(self.path)
        if path_only != "/api/rede-arquivos":
            self.send_error(404, "Not Found")
            return
        raw_p = (qs.get("p") or [""])[0]
        parent_rel = _normalize_rel_path(unquote(raw_p)) if raw_p.strip() else ""
        if parent_rel is None:
            self.send_error(400, "Invalid p")
            return
        raw = (qs.get("f") or qs.get("name") or [None])[0]
        if not raw:
            self.send_error(400, "Parâmetro f ausente")
            return
        logical = unquote(raw)
        path_item = _abs_item(parent_rel, logical)
        if not path_item or (not os.path.isfile(path_item) and not os.path.isdir(path_item)):
            self.send_error(404, "Not Found")
            return
        try:
            if os.path.isdir(path_item):
                shutil.rmtree(path_item)
            else:
                os.unlink(path_item)
        except OSError as e:
            self.send_error(500, str(e))
            return
        print(f"[rede-arquivos] removido: {path_item}", flush=True)
        self.send_response(204)
        self.end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    _ensure_transfer_dir()
    with ReusableTCPServer((BIND, PORT), TouyaHandler) as httpd:
        print(f"Servindo em http://{BIND}:{PORT}/ (pasta: {ROOT})")
        print(
            f"Build Touya: {TOUYA_SERVER_BUILD} — rede: GET lista, GET ?mkdir=, POST mkdir, upload, DELETE",
            flush=True,
        )
        print(f"Arquivos na rede: pasta {TRANSFER_DIR}", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
