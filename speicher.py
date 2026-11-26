"""Lokaler, transaktionaler CSV-Import und SQLite-Messdatenspeicher."""

import csv
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import struct
import zlib

from protokoll import parse, timestamp

ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "messdaten.sqlite"
CONFIG_PATH = ROOT / "geraete.json"
NUMERIC = ["intensity", "particles", "quality", "interior", "laser_temp", "supply",
           "control", "heater_laser", "heater_receiver", "ambient", "warnings"]
RECORD_KEYS = ["usable_intensity_mmh", "particle_count", "quality_pct", "interior_c",
               "laser_driver_c", "supply_v", "control_mv", "heater_laser_ma",
               "heater_receiver_ma", "ambient_c", "any_status_flag"]
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS devices(key TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS samples(
    device TEXT NOT NULL, ts INTEGER NOT NULL,
    intensity REAL, particles REAL, quality REAL, interior REAL, laser_temp REAL,
    supply REAL, control REAL, heater_laser REAL, heater_receiver REAL, ambient REAL,
    warnings INTEGER, weather TEXT, spectrum BLOB, flags TEXT,
    logger_time TEXT, sensor_time TEXT, serial TEXT, checksum TEXT,
    source TEXT, line INTEGER, PRIMARY KEY(device, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attempts(
    device TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(device,ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS imports(
    id INTEGER PRIMARY KEY, device TEXT, filename TEXT, sha256 TEXT,
    rows INTEGER, accepted INTEGER, errors INTEGER, duplicates INTEGER, conflicts INTEGER,
    bad_bytes INTEGER, checksum_unchecked INTEGER, examples TEXT, imported_at TEXT,
    UNIQUE(device,sha256)
);
CREATE INDEX IF NOT EXISTS samples_time ON samples(ts,device);
"""


@contextmanager
def connect(path=DATABASE):
    db = sqlite3.connect(path, timeout=60)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=60000")
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize(path=DATABASE):
    with connect(path) as db:
        db.executescript(SCHEMA)


def config():
    devices = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))["devices"]
    keys = [d["key"] for d in devices]
    if len(set(keys)) != len(keys) or any(not re.fullmatch(r"[a-zA-Z0-9_-]+", k) for k in keys):
        raise ValueError("Geräte-Schlüssel müssen eindeutig sein und Buchstaben, Ziffern, _ oder - enthalten.")
    for d in devices:
        if not re.fullmatch(r"\d{1,2}", str(d["id"])):
            raise ValueError(f"Ungültige Logger-ID bei {d['key']}")
    return devices


def epoch(value):
    dt = timestamp(value)
    if dt.tzinfo is not None:
        raise ValueError("Bitte alle Zeitangaben vorab auf eine einheitliche Loggerzeit vereinheitlichen.")
    return int(dt.replace(second=0, microsecond=0, tzinfo=timezone.utc).timestamp())


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M")


def pack(matrix):
    return zlib.compress(struct.pack("<440H", *matrix), level=1)


def unpack(blob):
    return struct.unpack("<440H", zlib.decompress(blob))


def separator(stream, configured):
    if configured != "auto":
        value = "\t" if configured == r"\t" else configured
        if len(value) != 1:
            raise ValueError("separator muss auto oder genau ein Trennzeichen sein.")
        return value
    lines = [stream.readline() for _ in range(80)]
    stream.seek(0)

    def score(sep):
        return sum(len(r) > 1 and re.fullmatch(r"\d{1,2}", r[1].strip()) is not None
                   for r in csv.reader(lines, delimiter=sep))

    best = max((";", "\t", ","), key=score)
    if score(best) == 0:
        raise ValueError("Keine Logger-ID in Spalte 2 erkannt. Erwartet werden Loggerzeit, ID und Telegrammfelder.")
    return best


def telegram_rows(path, device):
    csv.field_size_limit(10_000_000)
    with path.open(encoding=device.get("encoding", "utf-8-sig"),
                   errors="surrogateescape", newline="") as stream:
        sep = separator(stream, device.get("separator", "auto"))
        pending = None
        lines = []

        def tracked():
            for line in stream:
                lines.append(line)
                yield line

        reader = csv.reader(tracked(), delimiter=sep, strict=True)
        for fields in reader:
            raw = "".join(lines)
            lines.clear()
            first = fields[0].strip() if fields else ""
            if first in ("\x03", "_x0003_", r"\u0003") and not any(v.strip() for v in fields[1:]):
                if pending:
                    no, payload, text = pending
                    pending = None
                    yield no, payload, text + raw
                continue
            if pending:
                yield pending
            pending = (reader.line_num, fields, raw)
        if pending:
            yield pending


def import_device(device, db_path, progress):
    import glob
    pattern = device["csv"]
    absolute = str(ROOT / pattern) if not Path(pattern).is_absolute() else pattern
    paths = [Path(p) for p in sorted(glob.glob(absolute, recursive=True)) if Path(p).is_file()]
    if not paths:
        return [dict(device=device["key"], file=pattern, status="Datei fehlt")]
    results = []
    for path in paths:
        original_stat = path.stat()
        progress(f"{device['name']} · Prüfe {path.name}")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
                digest.update(block)
        fingerprint = digest.hexdigest()
        with connect(db_path) as db:
            db.execute("INSERT INTO devices VALUES(?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name",
                       (device["key"], device["name"]))
            if db.execute("SELECT 1 FROM imports WHERE device=? AND sha256=?",
                          (device["key"], fingerprint)).fetchone():
                results.append(dict(device=device["key"], file=path.name, status="Bereits importiert"))
                continue
            result = dict(rows=0, accepted=0, errors=0, duplicates=0, conflicts=0,
                          bad_bytes=0, checksum_unchecked=0)
            examples = []
            for line, cells, raw in telegram_rows(path, device):
                if len(cells) < 2 or not re.fullmatch(r"\d{1,2}", cells[1].strip()):
                    continue
                if int(cells[1]) != int(device["id"]):
                    continue
                result["rows"] += 1
                try:
                    result["bad_bytes"] += sum(0xdc80 <= ord(char) <= 0xdcff for char in raw)
                    t = epoch(cells[0].strip())
                    db.execute("INSERT OR IGNORE INTO attempts VALUES(?,?)", (device["key"], t))
                    logtime = timestamp(cells[0].strip())
                    fields = list(cells[2:])
                    while fields and fields[-1].strip() in ("", "\x03", "_x0003_", r"\u0003"):
                        fields.pop()
                    if fields:
                        fields[0] = fields[0].replace(r"\u0002", "\x02").replace("_x0002_", "\x02")
                    record, matrix, checksum = parse(fields, str(device["id"]).zfill(2), logtime, raw, False)
                    values = [record[k] for k in RECORD_KEYS]
                    blob = pack(matrix)
                    flags = json.dumps({k: record[k] for k in
                                        ("laser_off", "static_signal", "laser_temp_analog",
                                         "laser_temp_digital", "laser_current_analog",
                                         "laser_current_digital", "sensor_supply", "heater_laser",
                                         "heater_receiver", "temperature_sensor", "heater_supply",
                                         "heater_housing", "heater_heads", "heater_carriers", "laser_control")})
                    stored = values + [record["weather"], blob, flags, str(logtime),
                                       str(record["sensor_timestamp"] or ""), str(record["serial"]),
                                       checksum, path.name, line]
                    previous = db.execute("SELECT * FROM samples WHERE device=? AND ts=?",
                                          (device["key"], t)).fetchone()
                    if previous:
                        identical = all(previous[k] == v for k, v in zip(NUMERIC, values))
                        identical &= previous["weather"] == record["weather"] and previous["spectrum"] == blob
                        result["duplicates" if identical else "conflicts"] += 1
                    else:
                        db.execute("INSERT INTO samples VALUES(" + ",".join(["?"] * 22) + ")",
                                   [device["key"], t] + stored)
                        result["accepted"] += 1
                        result["checksum_unchecked"] += checksum != "ok"
                except (ValueError, TypeError, OverflowError, IndexError, UnicodeError) as exc:
                    result["errors"] += 1
                    if len(examples) < 12:
                        examples.append(dict(line=line, error=str(exc)))
                if result["rows"] % 10000 == 0:
                    progress(f"{device['name']} · {result['rows']:,} Zeilen · {result['accepted']:,} übernommen")
            if result["rows"] == 0:
                raise ValueError(f"{path.name}: Keine Zeile mit Logger-ID {device['id']} gefunden.")
            final_stat = path.stat()
            if (original_stat.st_size, original_stat.st_mtime_ns) != (final_stat.st_size, final_stat.st_mtime_ns):
                raise ValueError(f"{path.name}: Datei wurde während des Imports verändert. Bitte erneut importieren.")
            db.execute("""INSERT INTO imports(device,filename,sha256,rows,accepted,errors,duplicates,
                          conflicts,bad_bytes,checksum_unchecked,examples,imported_at)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                       [device["key"], path.name, fingerprint, *result.values(),
                        json.dumps(examples, ensure_ascii=True), datetime.now().isoformat(timespec="seconds")])
            results.append(dict(device=device["key"], file=path.name, status="Importiert", **result))
    return results


def demo(path):
    """Separate Demonstrationsdatenbank mit identischen Zeitfenstern für drei Geräte."""
    from random import Random
    initialize(path)
    with connect(path) as db:
        if db.execute("SELECT count(*) FROM samples").fetchone()[0]:
            return
        random = Random(42)
        first = epoch("2026-07-20 00:00")
        for d, name, factor in (("wald1", "Wald 1", .72), ("wald2", "Wald 2", .80),
                                ("lichtung", "Lichtung", 1.0)):
            db.execute("INSERT INTO devices VALUES(?,?)", (d, name))
            for m in range(7 * 1440):
                ts = first + m * 60
                if d == "wald2" and 3700 < m < 3770:
                    continue
                db.execute("INSERT INTO attempts VALUES(?,?)", (d, ts))
                if d == "wald1" and 6200 < m < 6230:
                    continue
                intensity = 0
                for centre, spread, peak in ((1050, 85, 9), (3340, 130, 18), (6650, 105, 28), (9050, 170, 6)):
                    if abs(m-centre) < spread * 2:
                        intensity += peak * math.exp(-((m-centre)/spread)**2) * factor * random.uniform(.7, 1.3)
                if intensity < .04:
                    intensity = 0
                interior = 12 + 5 * math.sin(m/1440*2*math.pi-1.6) + random.random()*.4
                particles = int(intensity * random.uniform(110, 210))
                matrix = [0] * 440
                if particles:
                    for i in range(22):
                        size = max(0, int(particles * math.exp(-i/2.2) / 2.8))
                        matrix[i*20+min(19, 4+i)] = size
                quality = 65 if 6690 < m < 6710 else random.randint(93, 100)
                warnings = int(d == "wald2" and 6600 < m < 6660)
                values = [intensity, particles, quality, interior, interior+10, 12.8,
                          4010+warnings*9, 170-interior*4, 161-interior*3.8, interior-.5, warnings]
                stored = [d, ts, *values, "Regen" if intensity else "Trocken", pack(matrix),
                          json.dumps({"sensor_supply": warnings}), iso(ts), iso(ts), "DEMO",
                          "demo", "Künstliche Demonstrationsdaten", m+1]
                db.execute("INSERT INTO samples VALUES(" + ",".join(["?"]*22) + ")", stored)
