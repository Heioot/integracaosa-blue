"""
Servidor estático + proxy para os WebServices SOAP BlueFocus (Consulta Qtde, Exporta Cadastro).
Evita bloqueio CORS ao chamar a API a partir do navegador em localhost.
"""

from __future__ import annotations

import http.server
import json
import os
import socketserver
import tempfile
import urllib.error
import urllib.request

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


def _ensure_data_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


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
        """Todas as requisições HTTP aparecem no terminal do Cursor."""
        message = "%s - %s" % (self.address_string(), format % args)
        print(message, flush=True)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Bluefocus-Token, autentica, SOAPAction",
        )
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path_only = self.path.split("?", 1)[0]
        if path_only == "/api/db":
            try:
                body = _read_db_file()
            except OSError as e:
                self.send_error(500, str(e))
                return
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path_only == "/movimentacao":
            self.send_response(302)
            self.send_header("Location", "/movimentacao/")
            self.end_headers()
            return
        if path_only in ("/apresentacao", "/apresentacao/"):
            self.send_response(302)
            self.send_header("Location", "/apresentacao.html")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/db":
            length = int(self.headers.get("Content-Length", 0))
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
            self.send_error(404, "Not Found")
            return

        length = int(self.headers.get("Content-Length", 0))
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
            self.wfile.write(err_body)
            return
        except OSError as e:
            print(f"[BlueFocus proxy] ERRO rede {path}: {e!s}", flush=True)
            msg = str(e).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(msg)
            return

        print(f"[BlueFocus proxy] OK {path} — resposta {len(data)} bytes", flush=True)
        if path == "/api/bluefocus/consulta-qtde" and len(data) > 0:
            preview = data[:900].decode("utf-8", errors="replace").replace("\r", " ").replace("\n", " ")
            print(f"[BlueFocus proxy] prévia XML: {preview[:800]}…", flush=True)
        self.send_response(200)
        # text/xml costuma exibir melhor no DevTools (Resposta) que application/xml
        self.send_header("Content-Type", "text/xml; charset=utf-8")
        self.end_headers()
        self.wfile.write(data)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    with ReusableTCPServer((BIND, PORT), TouyaHandler) as httpd:
        print(f"Servindo em http://{BIND}:{PORT}/ (pasta: {ROOT})")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
