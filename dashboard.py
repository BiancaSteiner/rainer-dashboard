"""Lokales LNM-Dashboard. Python 3.10+, ohne zusätzliche Pakete."""

import argparse
import csv
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import secrets
import threading
from tempfile import TemporaryFile
from urllib.parse import parse_qs, urlparse
import webbrowser

import speicher as store
from protokoll import DIAMETER, SPEED

STATE = dict(running=False, message="Bereit", results=[])
STATE_LOCK = threading.Lock()
TOKEN = secrets.token_urlsafe(24)
DB_PATH = store.DATABASE
IS_DEMO = False


def metadata():
    with store.connect(DB_PATH) as db:
        devices = [dict(r) for r in db.execute("""
            SELECT d.key,d.name, min(a.ts) AS first,max(a.ts) AS last,
              (SELECT count(*) FROM samples s WHERE s.device=d.key) AS minutes
            FROM devices d LEFT JOIN attempts a ON a.device=d.key GROUP BY d.key ORDER BY d.key
        """)]
    try:
        configured = store.config()
        existing = {d["key"] for d in devices}
        if not IS_DEMO:
            for d in configured:
                if d["key"] not in existing:
                    devices.append(dict(key=d["key"], name=d["name"], first=None, last=None, minutes=0))
    except (ValueError, OSError, KeyError) as exc:
        configured = []
        config_error = str(exc)
    else:
        config_error = None
    with STATE_LOCK:
        state = dict(STATE)
    return dict(devices=devices, demo=IS_DEMO, configured=configured,
                config_error=config_error, token=TOKEN, import_state=state)


def selection(query):
    meta = metadata()
    keys = {d["key"] for d in meta["devices"]}
    selected = query.get("devices", [",".join(sorted(keys))])[0].split(",")
    if not selected or any(k not in keys for k in selected):
        raise ValueError("Bitte mindestens ein verfügbares Gerät auswählen.")
    ranges = [d for d in meta["devices"] if d["key"] in selected and d["first"] is not None]
    if not ranges:
        return selected, 0, 0
    first, last = min(d["first"] for d in ranges), max(d["last"] for d in ranges)
    start = int(query.get("start", [max(first, last-86340)])[0])
    end = int(query.get("end", [last])[0])
    if start < -2208988800 or end > 7258118400 or end < start:
        raise ValueError("Ungültiger Zeitraum.")
    return selected, start//60*60, end//60*60


def rows_as_dict(rows):
    return [dict(r) for r in rows]


def overview(selected, start, end, requested="auto"):
    expected = (end-start)//60+1 if end else 0
    step = next((n for n in (60, 300, 900, 3600, 10800, 43200, 86400)
                 if (end-start)/n <= 1400), 86400)
    if requested != "auto":
        step = int(requested)*60
        if step not in (60, 300, 900, 3600, 86400):
            raise ValueError("Ungültige zeitliche Auflösung.")
        if (end-start)/step > 5000:
            raise ValueError("Für diese Auflösung ist der Zeitraum zu lang. Bitte kürzeren Zeitraum wählen.")
    result = []
    with store.connect(DB_PATH) as db:
        for device in selected:
            summary = dict(db.execute("""
                SELECT count(*) AS telegrams,count(intensity) AS valid,
                    sum(intensity)/60.0 AS rain,max(intensity) AS peak,
                    sum(particles) AS particles,avg(quality) AS quality,
                    sum(CASE WHEN quality<80 THEN 1 ELSE 0 END) AS low80,
                    sum(CASE WHEN quality<90 THEN 1 ELSE 0 END) AS low90,
                    sum(warnings) AS warnings,
                    sum(CASE WHEN abs(control-4010)>5 THEN 1 ELSE 0 END) AS control_bad
                FROM samples WHERE device=? AND ts BETWEEN ? AND ?
            """, (device, start, end)).fetchone())
            attempts = db.execute("SELECT count(*) FROM attempts WHERE device=? AND ts BETWEEN ? AND ?",
                                  (device, start, end)).fetchone()[0]
            summary.update(expected=expected, missing=max(0, expected-summary["telegrams"]),
                           missing_logger=max(0, expected-attempts),
                           invalid=summary["telegrams"]-summary["valid"],
                           coverage=100*summary["valid"]/expected if expected else 0)
            aggregates = rows_as_dict(db.execute("""
                SELECT (ts / ?) * ? AS ts, count(*) AS n, count(intensity) AS valid,
                    max(intensity) AS intensity,avg(intensity) AS intensity_mean,
                    sum(intensity)/60.0 AS rain,sum(particles) AS particles,
                    avg(interior) AS interior,avg(laser_temp) AS laser_temp,avg(ambient) AS ambient,
                    avg(supply) AS supply,min(supply) AS supply_min,max(supply) AS supply_max,
                    avg(control) AS control,min(control) AS control_min,max(control) AS control_max,
                    avg(heater_laser) AS heater_laser,avg(heater_receiver) AS heater_receiver,
                    min(quality) AS quality,avg(quality) AS quality_mean,sum(warnings) AS warnings
                FROM samples WHERE device=? AND ts BETWEEN ? AND ? GROUP BY ts / ? ORDER BY ts
            """, (step, step, device, start, end, step)))
            total = 0
            for row in aggregates:
                total += row["rain"] or 0
                row["cumulative"] = total if row["valid"] else None
            weather = rows_as_dict(db.execute("""
                SELECT (ts / ?) * ? AS ts,weather,count(*) AS n
                FROM samples WHERE device=? AND ts BETWEEN ? AND ? GROUP BY ts / ?,weather ORDER BY ts,n DESC
            """, (step, step, device, start, end, step)))
            flags = {}
            for (json_flags,) in db.execute("SELECT flags FROM samples WHERE device=? AND ts BETWEEN ? AND ? AND warnings=1",
                                           (device, start, end)):
                for key, value in json.loads(json_flags).items():
                    if value == 1:
                        flags[key] = flags.get(key, 0)+1
            result.append(dict(device=device, summary=summary, points=aggregates, weather=weather, flags=flags))
    return dict(start=start, end=end, step=step, series=result)


def spectra(selected, start, end):
    result = []
    with store.connect(DB_PATH) as db:
        for device in selected:
            matrix = [0]*440
            n = 0
            for (blob,) in db.execute("SELECT spectrum FROM samples WHERE device=? AND ts BETWEEN ? AND ?",
                                     (device, start, end)):
                n += 1
                if blob:
                    for i, count in enumerate(store.unpack(blob)):
                        matrix[i] += count
            sizes = [sum(matrix[i:i+20]) for i in range(0, 440, 20)]
            result.append(dict(device=device, minutes=n, matrix=matrix, sizes=sizes))
    return dict(series=result, diameter=DIAMETER, speed=SPEED)


def comparisons(selected, start, end):
    from itertools import combinations
    pairs = []
    with store.connect(DB_PATH) as db:
        for left, right in combinations(selected, 2):
            row = dict(db.execute("""
                SELECT count(*) AS n,sum(a.intensity)/60.0 AS rain_a,sum(b.intensity)/60.0 AS rain_b,
                    max(a.intensity) AS peak_a,max(b.intensity) AS peak_b,
                    sum(a.particles) AS particles_a,sum(b.particles) AS particles_b,
                    sum(a.intensity) AS x,sum(b.intensity) AS y,
                    sum(a.intensity*a.intensity) AS xx,sum(b.intensity*b.intensity) AS yy,
                    sum(a.intensity*b.intensity) AS xy
                FROM samples a JOIN samples b ON a.ts=b.ts AND b.device=?
                WHERE a.device=? AND a.ts BETWEEN ? AND ?
                    AND a.intensity IS NOT NULL AND b.intensity IS NOT NULL
            """, (right, left, start, end)).fetchone())
            n = row["n"]
            divisor = math.sqrt(max(0, (n*(row["xx"] or 0)-(row["x"] or 0)**2) *
                                          (n*(row["yy"] or 0)-(row["y"] or 0)**2)))
            row["correlation"] = max(-1, min(1, (n*row["xy"]-row["x"]*row["y"])/divisor)) if divisor else None
            row.update(a=left, b=right, difference=row["rain_a"]-row["rain_b"] if n else None,
                       ratio=row["rain_a"]/row["rain_b"] if n and row["rain_b"] else None)
            pairs.append(row)
    return dict(pairs=pairs)


def events(selected, start, end, dry):
    if dry not in (30, 60, 120):
        raise ValueError("Trockenpause muss 30, 60 oder 120 Minuten sein.")
    output = []
    more = False
    with store.connect(DB_PATH) as db:
        for device in selected:
            current = None
            previous = None

            def finish():
                nonlocal current, more
                if current is None:
                    return
                if len(output) < 500:
                    output.append(current)
                else:
                    more = True
                current = None

            for r in db.execute("SELECT ts,intensity,particles,quality FROM samples WHERE device=? AND ts BETWEEN ? AND ? ORDER BY ts",
                                (device, start, end)):
                t, intensity, particles, quality = r
                if current and (t-previous > 60 or intensity is None or t-current["end"] > dry*60):
                    finish()
                if intensity is not None and intensity > 0:
                    if not current:
                        current = dict(device=device, start=t, end=t, rain=0, peak=0, wet=0,
                                       particles=0, quality_min=None)
                    current["end"] = t
                    current["rain"] += intensity/60
                    current["peak"] = max(current["peak"], intensity)
                    current["wet"] += 1
                    current["particles"] += particles or 0
                    if quality is not None:
                        current["quality_min"] = min(current["quality_min"] if current["quality_min"] is not None else 100, quality)
                previous = t
            finish()
    output.sort(key=lambda r: r["start"], reverse=True)
    return dict(events=output, limited=more)


def imports():
    with store.connect(DB_PATH) as db:
        rows = rows_as_dict(db.execute("SELECT * FROM imports ORDER BY id DESC LIMIT 100"))
        for row in rows:
            row.pop("sha256")
            row["examples"] = json.loads(row["examples"])
        return rows


def import_worker():
    results = []

    def progress(message):
        with STATE_LOCK:
            STATE["message"] = message
    try:
        devices = store.config()
        for device in devices:
            try:
                results.extend(store.import_device(device, DB_PATH, progress))
            except (ValueError, OSError, KeyError, csv.Error) as exc:
                results.append(dict(device=device["key"], status="Fehler", error=str(exc)))
        progress("Import abgeschlossen")
    except Exception as exc:
        progress(f"Import abgebrochen: {exc}")
    finally:
        with STATE_LOCK:
            STATE.update(running=False, results=results)


class Handler(BaseHTTPRequestHandler):
    server_version = "LNM-Local/1.0"

    def log_message(self, *args):
        pass

    def send(self, data, content_type="application/json; charset=utf-8", status=200, filename=None):
        if isinstance(data, (dict, list)):
            data = json.dumps(data, ensure_ascii=True, allow_nan=False).encode()
        elif isinstance(data, str):
            data = data.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def valid_host(self):
        return self.headers.get("Host", "") in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

    def do_POST(self):
        if not self.valid_host() or self.headers.get("X-LNM-Token") != TOKEN:
            return self.send(dict(error="Ungültige lokale Anfrage"), status=403)
        if self.path != "/api/import":
            return self.send(dict(error="Unbekannte Aktion"), status=404)
        if IS_DEMO:
            return self.send(dict(error="Bitte für eigene Daten start.cmd verwenden."), status=400)
        with STATE_LOCK:
            if STATE["running"]:
                return self.send(dict(error="Ein Import läuft bereits."), status=409)
            STATE.update(running=True, message="Import startet", results=[])
        threading.Thread(target=import_worker, daemon=True).start()
        self.send(dict(ok=True))

    def do_GET(self):
        if not self.valid_host():
            return self.send(dict(error="Ungültiger Host"), status=403)
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            static = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/upload.js": ("upload.js", "text/javascript; charset=utf-8"),
                      "/style.css": ("style.css", "text/css; charset=utf-8")}
            if path in static:
                filename, mime = static[path]
                return self.send((store.ROOT/"web"/filename).read_bytes(), mime)
            if path == "/api/meta":
                return self.send(metadata())
            if path == "/api/imports":
                return self.send(imports())
            selected, start, end = selection(query)
            if path == "/api/overview":
                return self.send(overview(selected, start, end, query.get("resolution", ["auto"])[0]))
            if path == "/api/spectrum":
                return self.send(spectra(selected, start, end))
            if path == "/api/comparison":
                return self.send(comparisons(selected, start, end))
            if path == "/api/events":
                return self.send(events(selected, start, end, int(query.get("dry", [60])[0])))
            if path == "/api/minute":
                t = int(query["time"][0])//60*60
                with store.connect(DB_PATH) as db:
                    result = rows_as_dict(db.execute("SELECT * FROM samples WHERE device=? AND ts=?",
                                                    (selected[0], t)))
                    for row in result:
                        row.pop("spectrum")
                        row["flags"] = json.loads(row["flags"])
                    return self.send(result)
            if path == "/api/export":
                with TemporaryFile(mode="w+", encoding="utf-8-sig", newline="") as text:
                    writer = csv.writer(text, delimiter=";")
                    writer.writerow(["device", "logger_minute", *store.NUMERIC, "weather"])
                    with store.connect(DB_PATH) as db:
                        placeholders = ",".join("?" for _ in selected)
                        for row in db.execute(f"SELECT device,ts,{','.join(store.NUMERIC)},weather FROM samples "
                                              f"WHERE device IN ({placeholders}) AND ts BETWEEN ? AND ? ORDER BY ts,device",
                                              [*selected, start, end]):
                            writer.writerow([row[0], store.iso(row[1]), *row[2:]])
                    text.flush()
                    raw = text.buffer
                    length = raw.seek(0, 2)
                    raw.seek(0)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Content-Disposition", 'attachment; filename="lnm-auswahl.csv"')
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    for chunk in iter(lambda: raw.read(1024*1024), b""):
                        self.wfile.write(chunk)
                return
            return self.send(dict(error="Nicht gefunden"), status=404)
        except (ValueError, KeyError, OSError) as exc:
            self.send(dict(error=str(exc)), status=400)
        except Exception as exc:
            self.send(dict(error=f"Anfrage fehlgeschlagen: {exc}"), status=500)


def main():
    global DB_PATH, IS_DEMO
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    IS_DEMO = args.demo
    if IS_DEMO:
        DB_PATH = store.ROOT/"demo.sqlite"
        store.demo(DB_PATH)
    else:
        store.initialize(DB_PATH)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"LNM Dashboard · {'DEMO' if IS_DEMO else 'Eigene Daten'} · {url}", flush=True)
    print("Zum Beenden dieses Fenster schließen oder Strg+C drücken.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
