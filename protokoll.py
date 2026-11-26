from array import array
from datetime import datetime, timedelta
import math
import re

MINUTE = timedelta(minutes=1)
DIAMETER = [.125, .25, .375, .5, .75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3,
            3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8]
SPEED = [0, .2, .4, .6, .8, 1, 1.4, 1.8, 2.2, 2.6, 3, 3.4, 4.2, 5,
         5.8, 6.6, 7.4, 8.2, 9, 10, 20]
MID = [(a + b) / 2 for a, b in zip(DIAMETER, DIAMETER[1:])] + [8]
WEATHER = {"NP": "Trocken", "DZ": "Niesel", "RADZ": "Regen und Niesel",
           "RA": "Regen", "RASN": "Schneeregen", "SN": "Schnee",
           "SG": "Schneegriesel", "GS": "Graupel/Eiskörner", "GR": "Hagel",
           "UP": "Unbestimmt", "?????": "Sensorfehler"}
FLAGS = ("laser_off static_signal laser_temp_analog laser_temp_digital "
         "laser_current_analog laser_current_digital sensor_supply heater_laser "
         "heater_receiver temperature_sensor heater_supply heater_housing "
         "heater_heads heater_carriers laser_control").split()
FIELDS = {
    "intensity_mmh": (14, 999.999), "liquid_mmh": (15, 999.999),
    "solid_mmh": (16, 999.999), "device_counter_mm": (17, 9999.99),
    "quality_pct": (20, 999), "interior_c": (38, 999), "laser_driver_c": (39, 99),
    "control_mv": (41, 9999), "supply_v": (43, 999, .1),
    "heater_laser_ma": (44, 999), "heater_receiver_ma": (45, 999),
    "ambient_c": (46, 999.9), "particle_count": (51, 99999),
}
MINUTE_FIELDS = ["device", "minute", "logger_timestamp", "sensor_timestamp",
                 "serial", "metar", "synop_4677", "synop_4680", "weather",
                 *FIELDS, "usable_intensity_mmh", "rain_mm", "spectrum_count",
                 "any_status_flag", *FLAGS, "source", "row"]


def device_id(value):
    return str(value).strip().zfill(2)


def timestamp(value):
    if isinstance(value, datetime):
        return value
    value = str(value).strip()
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        for fmt in ("%d.%m.%Y %H:%M:%S", "%d.%m.%y %H:%M:%S",
                    "%d.%m.%Y %H:%M", "%d.%m.%y %H:%M"):
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                pass
        raise ValueError(f"Zeitstempel nicht lesbar: {value!r}") from None


def minute(value):
    if value.tzinfo is not None:
        raise ValueError("Zeitzonen vor dem Import auf eine einheitliche Loggerzeit vereinheitlichen")
    return value.replace(second=0, microsecond=0)


def number(value, sentinel):
    if value is None or str(value).strip() == "":
        return None
    n = float(str(value).replace(",", "."))
    if not math.isfinite(n):
        raise ValueError("Nicht endlicher Messwert")
    if abs(n) == sentinel or str(value).strip() in ("999999", "99999") and sentinel == 999.9:
        return None
    return n


def parse(fields, observed_device, logger_time, raw, excel):
    if len(fields) not in (520, 524):
        if len(fields) == 1 and "Keine Antwort" in str(fields[0]):
            raise ValueError("Keine Antwort")
        if len(fields) == 1 and re.fullmatch(r"!\d{2}TR00001", str(fields[0])):
            raise ValueError("Kein Telegramm verfügbar")
        raise ValueError(f"Feldanzahl {len(fields)} (erwartet 520 oder 524)")
    native_id = device_id(str(fields[0]).removeprefix("_x0002_").lstrip("\x02"))
    if native_id != observed_device or not re.fullmatch(r"\d{2}", native_id):
        raise ValueError("Telegramm-ID stimmt nicht zur Quellen-ID")
    check = str(fields[-1]).strip().upper()
    if excel and check.isdigit():
        check = check.zfill(2)
    if not re.fullmatch("[0-9A-F]{2}", check):
        raise ValueError("Ungültiges Prüfsummenfeld")
    checksum_status = "nicht_pruefbar"
    if not excel and raw.count("\x02") == 1 and raw.endswith(("\x03", "\x03\r\n", "\x03\n")):
        frame = raw[raw.index("\x02"):raw.index("\x03") + 1]
        suffix = re.search(r";([0-9A-Fa-f]{2});\r\n\x03$", frame)
        if suffix:
            payload = frame[:suffix.start(1)] + frame[suffix.end(1):]
            if (-sum(payload.encode("ascii"))) % 256 != int(check, 16):
                raise ValueError("Prüfsumme stimmt nicht")
            checksum_status = "ok"
    sensor_time = None
    try:
        date = fields[3]
        clock = fields[4]
        if isinstance(date, datetime):
            sensor_time = timestamp(f"{date.date()} {clock}")
        else:
            sensor_time = timestamp(f"{date} {clock}")
    except ValueError:
        if logger_time is None:
            raise
    measure_time = logger_time or sensor_time
    t = minute(measure_time)
    metar = str(fields[11]).strip()
    weather = WEATHER.get(metar.lstrip("+-"), f"METAR {metar}" if metar else "Unbekannt")
    values = {}
    # The protocol numbers STX as field 1; it shares the first cell with the device ID.
    for key, (index, sentinel, *scale) in FIELDS.items():
        values[key] = number(fields[index - 2], sentinel)
        if key in ("intensity_mmh", "liquid_mmh", "solid_mmh") and str(fields[index - 2]) == "999999":
            values[key] = None
        if scale and values[key] is not None:
            values[key] = round(values[key] * scale[0], 4)
    if values["ambient_c"] is None and len(fields) == 524:
        values["ambient_c"] = number(fields[519], 999.9)
    if values["quality_pct"] is not None and not 0 <= values["quality_pct"] <= 100:
        raise ValueError("Qualität außerhalb 0–100")
    if any(values[k] is not None and values[k] < 0 for k in ("intensity_mmh", "particle_count")):
        raise ValueError("Negativer Niederschlags- oder Partikelwert")
    flag_values = [int(v) for v in fields[20:35]]
    if any(v not in (0, 1, 9) for v in flag_values):
        raise ValueError("Ungültiges Statusflag")
    matrix = array("H", (int(v) for v in fields[79:519]))
    if max(matrix) > 9999:
        raise ValueError("Spektralklasse außerhalb 0–9999")
    intensity = values["intensity_mmh"] if weather not in ("Sensorfehler", "Unbestimmt") else None
    record = dict(minute=t, logger_timestamp=logger_time, sensor_timestamp=sensor_time,
                  serial=fields[1], metar=metar, synop_4677=fields[9],
                  synop_4680=fields[10], weather=weather, **values,
                  usable_intensity_mmh=intensity, rain_mm=None if intensity is None else intensity/60,
                  spectrum_count=sum(matrix), any_status_flag=int(1 in flag_values),
                  **dict(zip(FLAGS, [v if v != 9 else None for v in flag_values])))
    return record, matrix, checksum_status


