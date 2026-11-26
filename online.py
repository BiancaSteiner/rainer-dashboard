"""Geschützter Flask-Einstieg für Render. Lokaler Einstieg bleibt dashboard.py."""

from collections import defaultdict, deque
from datetime import timedelta
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import threading
import time

from flask import Flask, jsonify, redirect, render_template, request, send_file, session
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import dashboard
import speicher as store

CHUNK_BYTES = 4 * 1024 * 1024


def create_app(settings=None):
    app = Flask(__name__, static_folder=None, template_folder="web")
    production = os.environ.get("RAINER_LOCAL_TEST") != "1"
    app.config.update(
        SECRET_KEY=os.environ.get("RAINER_SECRET_KEY", ""),
        DASHBOARD_USER=os.environ.get("RAINER_USERNAME", "admin"),
        DASHBOARD_PASSWORD=os.environ.get("RAINER_PASSWORD", ""),
        DATA_DIR=os.environ.get("RAINER_DATA_DIR", str(store.ROOT/"online-daten")),
        MAX_UPLOAD_BYTES=int(os.environ.get("RAINER_MAX_UPLOAD_GB", "20")) * 1024**3,
        MAX_CONTENT_LENGTH=CHUNK_BYTES + 65536,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SECURE=production,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        TRUSTED_HOSTS=[h.strip() for h in os.environ.get(
            "RAINER_ALLOWED_HOSTS", os.environ.get("RENDER_EXTERNAL_HOSTNAME", "localhost,127.0.0.1")
        ).split(",") if h.strip()],
        REQUIRE_HTTPS=production,
    )
    if settings:
        app.config.update(settings)
    if len(app.config["SECRET_KEY"]) < 32:
        raise RuntimeError("RAINER_SECRET_KEY muss mindestens 32 Zeichen enthalten.")
    password = app.config["DASHBOARD_PASSWORD"]
    if len(password) < 12:
        raise RuntimeError("RAINER_PASSWORD muss mindestens 12 Zeichen enthalten.")
    password_hash = generate_password_hash(password)
    login_tag = hmac.new(str(app.config["SECRET_KEY"]).encode(), password.encode(), hashlib.sha256).hexdigest()
    # Passwörter werden ausschließlich für die Prüfung im Prozess gehalten.
    app.config.pop("DASHBOARD_PASSWORD")
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
    data = Path(app.config["DATA_DIR"]).resolve()
    data.mkdir(parents=True, exist_ok=True)
    (data/"uploads").mkdir(exist_ok=True)
    store.CONFIG_PATH = data/"geraete.json"
    if not store.CONFIG_PATH.exists():
        shutil.copyfile(store.ROOT/"geraete.json", store.CONFIG_PATH)
    dashboard.DB_PATH = data/"messdaten.sqlite"
    dashboard.IS_DEMO = False
    store.initialize(dashboard.DB_PATH)
    lock = threading.RLock()
    failures = defaultdict(deque)
    app.extensions["rainer_lock"] = lock

    def authenticated():
        return hmac.compare_digest(str(session.get("auth", "")), login_tag)

    def csrf_token():
        if "csrf" not in session:
            session["csrf"] = secrets.token_urlsafe(32)
        return session["csrf"]

    @app.before_request
    def protect():
        if request.routing_exception:
            raise request.routing_exception
        if request.path == "/healthz":
            return None
        if app.config["REQUIRE_HTTPS"] and not request.is_secure:
            return jsonify(error="Bitte die HTTPS-Adresse verwenden."), 400
        if request.path in ("/login", "/style.css"):
            return None
        if not authenticated():
            if request.path.startswith("/api/"):
                return jsonify(error="Bitte erneut anmelden."), 401
            return redirect("/login")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            token = request.headers.get("X-LNM-Token", request.form.get("csrf", ""))
            if not hmac.compare_digest(str(token), str(session.get("csrf", ""))) or not token:
                return jsonify(error="Ungültige Anfrage. Bitte die Seite neu laden."), 403
            origin = request.headers.get("Origin")
            if origin and origin != request.host_url.rstrip("/"):
                return jsonify(error="Ungültiger Ursprung der Anfrage."), 403

    @app.after_request
    def headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; "
            "img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; "
            "base-uri 'self'; form-action 'self'"
        )
        if app.config["REQUIRE_HTTPS"]:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    @app.errorhandler(HTTPException)
    def http_error(exc):
        if request.path.startswith("/api/"):
            return jsonify(error=exc.description), exc.code
        return render_template("login.html", csrf=csrf_token(), error="Die Anfrage konnte nicht verarbeitet werden."), exc.code

    @app.errorhandler(ValueError)
    def invalid_request(exc):
        return jsonify(error=str(exc)), 400

    @app.errorhandler(OSError)
    def storage_error(exc):
        app.logger.exception("Fehler beim Zugriff auf den Datenspeicher")
        return jsonify(error="Speicherzugriff fehlgeschlagen. Bitte freien Speicher und Serverprotokoll prüfen."), 507

    @app.get("/healthz")
    def health():
        return jsonify(ok=True)

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if authenticated():
            return redirect("/")
        error, status = None, 200
        if request.method == "POST":
            token = request.form.get("csrf", "")
            if not token or not hmac.compare_digest(token, str(session.get("csrf", ""))):
                return render_template("login.html", csrf=csrf_token(), error="Bitte die Anmeldung erneut versuchen."), 403
            now = time.monotonic()
            address = request.remote_addr or "unknown"
            with lock:
                for key in list(failures):
                    while failures[key] and failures[key][0] < now-900:
                        failures[key].popleft()
                    if not failures[key]:
                        del failures[key]
                if len(failures) > 1024:
                    failures.pop(next(iter(failures)))
                blocked = len(failures.get(address, ())) >= 10
            if blocked:
                error, status = "Zu viele Anmeldeversuche. Bitte nach 15 Minuten erneut versuchen.", 429
            else:
                valid_password = check_password_hash(password_hash, request.form.get("password", ""))
                valid_user = hmac.compare_digest(request.form.get("username", "").encode(),
                                                app.config["DASHBOARD_USER"].encode())
                if valid_password and valid_user:
                    with lock:
                        failures.pop(address, None)
                    session.clear()
                    session["auth"] = login_tag
                    session.permanent = True
                    csrf_token()
                    return redirect("/")
                with lock:
                    failures[address].append(now)
                error, status = "Benutzername oder Passwort stimmt nicht.", 401
        return render_template("login.html", csrf=csrf_token(), error=error), status

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect("/login")

    @app.get("/")
    def index():
        return send_file(store.ROOT/"web"/"index.html")

    @app.get("/app.js")
    def javascript():
        return send_file(store.ROOT/"web"/"app.js")

    @app.get("/style.css")
    def stylesheet():
        return send_file(store.ROOT/"web"/"style.css")

    @app.get("/upload.js")
    def upload_javascript():
        return send_file(store.ROOT/"web"/"upload.js")

    @app.get("/api/meta")
    def meta():
        result = dashboard.metadata()
        result.update(online=True, token=csrf_token(), username=app.config["DASHBOARD_USER"],
                      chunk_bytes=CHUNK_BYTES, max_upload_bytes=app.config["MAX_UPLOAD_BYTES"])
        return jsonify(result)

    @app.get("/api/imports")
    def imports():
        return jsonify(dashboard.imports())

    def selection():
        # Wiederverwendung der validierten Abfragen des lokalen Dashboards.
        return dashboard.selection({key: request.args.getlist(key) for key in request.args})

    @app.get("/api/overview")
    def overview():
        return jsonify(dashboard.overview(*selection(), request.args.get("resolution", "auto")))

    @app.get("/api/comparison")
    def comparison():
        return jsonify(dashboard.comparisons(*selection()))

    @app.get("/api/spectrum")
    def spectrum():
        return jsonify(dashboard.spectra(*selection()))

    @app.get("/api/events")
    def events():
        return jsonify(dashboard.events(*selection(), int(request.args.get("dry", 60))))

    @app.get("/api/minute")
    def minute():
        devices, _, _ = selection()
        t = int(request.args["time"])//60*60
        with store.connect(dashboard.DB_PATH) as db:
            rows = dashboard.rows_as_dict(db.execute("SELECT * FROM samples WHERE device=? AND ts=?", (devices[0], t)))
            for row in rows:
                row.pop("spectrum")
                row["flags"] = json.loads(row["flags"])
        return jsonify(rows)

    @app.get("/api/export")
    def export():
        import csv
        from tempfile import TemporaryFile
        devices, start, end = selection()
        stream = TemporaryFile(mode="w+", encoding="utf-8-sig", newline="")
        try:
            writer = csv.writer(stream, delimiter=";")
            writer.writerow(["device", "logger_minute", *store.NUMERIC, "weather"])
            with store.connect(dashboard.DB_PATH) as db:
                placeholders = ",".join("?" for _ in devices)
                for row in db.execute(
                    f"SELECT device,ts,{','.join(store.NUMERIC)},weather FROM samples "
                    f"WHERE device IN ({placeholders}) AND ts BETWEEN ? AND ? ORDER BY ts,device",
                    [*devices, start, end]
                ):
                    writer.writerow([row[0], store.iso(row[1]), *row[2:]])
            stream.flush()
            length = stream.buffer.seek(0, 2)
            stream.buffer.seek(0)
        except Exception:
            stream.close()
            raise

        def chunks():
            try:
                yield from iter(lambda: stream.buffer.read(1024*1024), b"")
            finally:
                stream.close()
        return app.response_class(chunks(), mimetype="text/csv", headers={
            "Content-Disposition": 'attachment; filename="lnm-auswahl.csv"',
            "Content-Length": str(length),
        })

    def idle():
        with dashboard.STATE_LOCK:
            if dashboard.STATE["running"]:
                raise ValueError("Ein Import läuft bereits. Bitte dessen Abschluss abwarten.")

    @app.post("/api/import")
    def import_existing():
        with lock, dashboard.STATE_LOCK:
            if dashboard.STATE["running"]:
                return jsonify(error="Ein Import läuft bereits."), 409
            dashboard.STATE.update(running=True, message="Import startet", results=[])
        threading.Thread(target=dashboard.import_worker, daemon=True).start()
        return jsonify(ok=True)

    def upload_path(identifier):
        if not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Ungültige Upload-ID.")
        path = data/"uploads"/identifier
        if not (path/"manifest.json").exists():
            raise ValueError("Upload nicht gefunden.")
        return path

    def read_manifest(path):
        return json.loads((path/"manifest.json").read_text(encoding="utf-8"))

    def save_manifest(path, value):
        temporary = path/"manifest.tmp"
        temporary.write_text(json.dumps(value, ensure_ascii=True), encoding="utf-8")
        os.replace(temporary, path/"manifest.json")

    @app.post("/api/uploads")
    def begin_upload():
        idle()
        body = request.get_json()
        if not isinstance(body, dict):
            raise ValueError("Ungültige Uploadbeschreibung.")
        key = str(body.get("device", ""))
        if key not in {d["key"] for d in store.config()}:
            raise ValueError("Bitte ein konfiguriertes Gerät auswählen.")
        identifier = str(body.get("id", ""))
        if not re.fullmatch(r"\d{1,2}", identifier):
            raise ValueError("Logger-ID muss ein- oder zweistellig sein.")
        encoding = body.get("encoding", "utf-8-sig")
        if encoding not in ("utf-8-sig", "cp1252", "utf-16"):
            raise ValueError("Unbekannte Zeichenkodierung.")
        size = body.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= app.config["MAX_UPLOAD_BYTES"]:
            raise ValueError("Ungültige Dateigröße oder konfiguriertes Uploadlimit überschritten.")
        filename = str(body.get("name", "")).replace("\\", "/").rsplit("/", 1)[-1]
        if not filename.lower().endswith(".csv") or len(filename) > 240 or any(ord(c) < 32 for c in filename):
            raise ValueError("Bitte eine CSV-Datei mit gültigem Dateinamen auswählen.")
        if shutil.disk_usage(data).free < size*2+32*1024**2:
            raise ValueError("Zu wenig freier Speicher für Upload und Import. Bitte den Datenträger vergrößern.")
        upload_id = secrets.token_hex(16)
        path = data/"uploads"/upload_id
        path.mkdir()
        save_manifest(path, dict(device=key, id=identifier.zfill(2), encoding=encoding,
                                 size=size, name=filename, phase="upload", created=time.time()))
        return jsonify(upload=upload_id, chunk_bytes=CHUNK_BYTES)

    @app.put("/api/uploads/<identifier>/<int:index>")
    def upload_chunk(identifier, index):
        path = upload_path(identifier)
        manifest = read_manifest(path)
        count = (manifest["size"]+CHUNK_BYTES-1)//CHUNK_BYTES
        if not 0 <= index < count:
            raise ValueError("Ungültige Blocknummer.")
        expected = min(CHUNK_BYTES, manifest["size"]-index*CHUNK_BYTES)
        if request.content_length != expected:
            raise ValueError("Der Uploadblock hat eine falsche Länge. Bitte erneut übertragen.")
        payload = request.get_data(cache=False)
        if len(payload) != expected:
            raise ValueError("Uploadblock unvollständig.")
        with lock:
            if read_manifest(path)["phase"] != "upload":
                raise ValueError("Die Datei wird bereits verarbeitet.")
            part = path/f"{index}.part"
            if part.exists():
                if not hmac.compare_digest(hashlib.sha256(part.read_bytes()).digest(),
                                           hashlib.sha256(payload).digest()):
                    raise ValueError("Ein wiederholter Uploadblock hat abweichenden Inhalt.")
            else:
                temporary = path/f"{index}.tmp"
                with temporary.open("wb") as output:
                    output.write(payload)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, part)
        return jsonify(ok=True, index=index)

    def import_upload(path):
        manifest = read_manifest(path)
        result = None
        try:
            target = path/manifest["name"]
            count = (manifest["size"]+CHUNK_BYTES-1)//CHUNK_BYTES
            if not target.exists():
                temporary = path/"assembled.tmp"
                with temporary.open("wb") as output:
                    for index in range(count):
                        with (path/f"{index}.part").open("rb") as part:
                            shutil.copyfileobj(part, output, 1024*1024)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, target)
            if target.stat().st_size != manifest["size"]:
                raise ValueError("Die zusammengesetzte Datei ist unvollständig.")

            devices = store.config()
            device = next(d for d in devices if d["key"] == manifest["device"])
            imported = dict(device, id=manifest["id"], encoding=manifest["encoding"], csv=str(target))

            def progress(message):
                with dashboard.STATE_LOCK:
                    dashboard.STATE["message"] = message
            result = store.import_device(imported, dashboard.DB_PATH, progress)
            # Auswahl der letzten erfolgreich eingelesenen Datei für erneutes Einlesen.
            device.update(csv=str(target), id=manifest["id"], encoding=manifest["encoding"])
            config_tmp = store.CONFIG_PATH.with_suffix(".tmp")
            config_tmp.write_text(json.dumps(dict(devices=devices), ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(config_tmp, store.CONFIG_PATH)
            manifest["phase"] = "done"
            # Die vollständige CSV bleibt erhalten. Blockkopien können entfernt werden.
            for part in path.glob("*.part"):
                part.unlink()
        except Exception as exc:
            app.logger.exception("CSV-Import fehlgeschlagen")
            manifest["phase"] = "error"
            result = [dict(device=manifest["device"], file=manifest["name"], status="Fehler", error=str(exc))]
        finally:
            try:
                with lock:
                    manifest["result"] = result
                    save_manifest(path, manifest)
            finally:
                with dashboard.STATE_LOCK:
                    dashboard.STATE.update(running=False, message="Import abgeschlossen", results=result or [])

    @app.post("/api/uploads/<identifier>/finish")
    def finish_upload(identifier):
        path = upload_path(identifier)
        with lock, dashboard.STATE_LOCK:
            manifest = read_manifest(path)
            if manifest["phase"] == "done":
                return jsonify(ok=True, results=manifest.get("result", []))
            if manifest["phase"] == "processing" and dashboard.STATE["running"]:
                return jsonify(ok=True, running=True)
            if dashboard.STATE["running"]:
                return jsonify(error="Ein Import läuft bereits."), 409
            count = (manifest["size"]+CHUNK_BYTES-1)//CHUNK_BYTES
            # Nach Neustart oder Importfehler kann aus der vollständigen CSV erneut importiert werden.
            if not (path/manifest["name"]).exists() and any(
                not (path/f"{i}.part").exists() for i in range(count)
            ):
                raise ValueError("Es fehlen Uploadblöcke. Bitte die Datei erneut auswählen.")
            manifest["phase"] = "processing"
            save_manifest(path, manifest)
            dashboard.STATE.update(running=True, message="CSV wird zusammengesetzt und importiert", results=[])
        threading.Thread(target=import_upload, args=(path,), daemon=True).start()
        return jsonify(ok=True)

    @app.get("/api/uploads/<identifier>")
    def upload_status(identifier):
        path = upload_path(identifier)
        manifest = read_manifest(path)
        received = sorted(int(p.stem) for p in path.glob("*.part"))
        with dashboard.STATE_LOCK:
            if manifest["phase"] == "processing" and not dashboard.STATE["running"]:
                manifest["phase"] = "error"
        return jsonify(phase=manifest["phase"], result=manifest.get("result"), received=received,
                       name=manifest["name"], size=manifest["size"], device=manifest["device"])

    # Abgebrochene Imports können nach einem Neustart über dieselbe Upload-ID fortgesetzt werden.
    for path in (data/"uploads").iterdir():
        if not path.is_dir() or not (path/"manifest.json").exists():
            continue
        manifest = read_manifest(path)
        if manifest["phase"] == "processing":
            manifest["phase"] = "error"
            save_manifest(path, manifest)
    app.extensions["rainer_data"] = data
    return app
