"""Regressionsprüfung mit künstlichen Loggertelegrammen, ohne private Messdateien."""

import csv
import io
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from types import SimpleNamespace

import dashboard
import speicher as store


def frame(t, intensity=6, bad=False, sep=";"):
    fields = ["0"]*520
    fields[:5] = ["\x0201", "4128", "1.20", "01.01.21", "20:33:41"]
    fields[11] = "RA" if intensity else "NP"
    fields[12:15] = [f"{intensity:.3f}", f"{intensity:.3f}", "0.000"]
    fields[18] = "100"
    fields[36:45] = ["12", "22", "0661", "4010", "1500", "130", "120", "125", "99999"]
    fields[49] = "4"
    fields[79+2*20+5] = "4"
    if bad:
        fields[79] = "\udcff"
    fields[-1] = "AA"
    # Tabellenauszug mit umformatiertem Rahmen: Prüfsumme nicht mehr prüfbar.
    return sep.join([t.strftime("%d.%m.%Y %H:%M:%S"), "01", *fields])+"\n"


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(dir=store.ROOT)
        self.root = Path(self.temp.name)
        self.db = self.root/"test.sqlite"
        store.initialize(self.db)
        self.old_db = dashboard.DB_PATH
        dashboard.DB_PATH = self.db
        self.t = datetime(2026, 7, 23, 3, 55)
        self.device = dict(key="wald1", name="Wald 1", id="01", csv=str(self.root/"a.csv"), separator="auto")

    def tearDown(self):
        dashboard.DB_PATH = self.old_db
        self.temp.cleanup()

    def import_text(self, text, device=None):
        (self.root/"a.csv").write_bytes(text.encode("utf-8", errors="surrogateescape"))
        return store.import_device(device or self.device, self.db, lambda _: None)[0]

    def test_import_retries_bytes_gaps_and_matrix(self):
        text = frame(self.t) + frame(self.t) + frame(self.t, 12)
        text += frame(self.t+timedelta(minutes=1), bad=True)
        text += frame(self.t+timedelta(minutes=3), 3)
        text += "23.07.2026 03:58;02;Fehler: Nur Echo empfangen, keine Sensordaten.\n"
        imported = self.import_text(text)
        self.assertEqual((imported["accepted"], imported["duplicates"], imported["conflicts"], imported["errors"]), (2,1,1,1))
        self.assertEqual(imported["bad_bytes"], 1)
        repeated = store.import_device(self.device, self.db, lambda _: None)[0]
        self.assertEqual(repeated["status"], "Bereits importiert")
        start = store.epoch(self.t)
        result = dashboard.overview(["wald1"], start, start+180, "1")["series"][0]
        self.assertAlmostEqual(result["summary"]["rain"], .15)
        self.assertEqual(result["summary"]["valid"], 2)
        self.assertEqual(result["summary"]["missing"], 2)
        self.assertEqual(result["summary"]["missing_logger"], 1)
        spectrum = dashboard.spectra(["wald1"], start, start+180)["series"][0]
        self.assertEqual(spectrum["matrix"][2*20+5], 8)
        self.assertEqual(spectrum["sizes"][2], 8)
        events = dashboard.events(["wald1"], start, start+180, 60)["events"]
        self.assertEqual(len(events), 2)

    def test_tab_export_and_minute_alignment(self):
        t = self.t+timedelta(seconds=8)
        result = self.import_text(frame(t, sep="\t")+"\x03\t\t\t\n")
        self.assertEqual(result["accepted"], 1)
        with store.connect(self.db) as db:
            row = db.execute("SELECT * FROM samples").fetchone()
            self.assertEqual(row["ts"], store.epoch(self.t))
            self.assertEqual(row["supply"], 13)
            self.assertEqual(row["ambient"], None)

    def test_overlap_only_comparison(self):
        self.import_text(frame(self.t, 6)+frame(self.t+timedelta(minutes=1), 60))
        other = dict(self.device, key="lichtung", name="Lichtung")
        self.import_text(frame(self.t, 3), other)
        start = store.epoch(self.t)
        pair = dashboard.comparisons(["wald1","lichtung"], start, start+60)["pairs"][0]
        self.assertEqual(pair["n"], 1)
        self.assertAlmostEqual(pair["rain_a"], .1)
        self.assertAlmostEqual(pair["rain_b"], .05)
        self.assertEqual(pair["correlation"], None)

    def test_transaction_rolls_back_on_broken_csv(self):
        with self.assertRaises(csv.Error):
            self.import_text(frame(self.t)+'"nicht abgeschlossen\n')
        with store.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM samples").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM imports").fetchone()[0], 0)

    def test_error_only_device_keeps_coverage_and_null_totals(self):
        result = self.import_text("23.07.2026 03:55;01;Fehler: Nur Echo empfangen, keine Sensordaten.\n")
        self.assertEqual(result["errors"], 1)
        t = store.epoch(self.t)
        row = dashboard.overview(["wald1"], t, t)["series"][0]
        self.assertEqual(row["summary"]["expected"], 1)
        self.assertEqual(row["summary"]["missing"], 1)
        self.assertIsNone(row["summary"]["rain"])
        self.assertEqual(row["points"], [])

    def test_csv_download_streams_original_minutes(self):
        self.import_text(frame(self.t, 6)+frame(self.t+timedelta(minutes=1), 3))

        class Request(dashboard.Handler):
            def __init__(self):
                self.wfile = io.BytesIO()
                self.server = SimpleNamespace(server_port=8765)
                self.headers = {"Host": "127.0.0.1:8765"}
                self.response_headers = {}

            def send_response(self, status):
                self.status = status

            def send_header(self, key, value):
                self.response_headers[key] = value

            def end_headers(self):
                pass

        request = Request()
        t = store.epoch(self.t)
        request.path = f"/api/export?devices=wald1&start={t}&end={t+60}"
        request.do_GET()
        self.assertEqual(request.status, 200)
        payload = request.wfile.getvalue()
        self.assertTrue(payload.startswith(b"\xef\xbb\xbf"))
        rows = list(csv.reader(io.StringIO(payload.decode("utf-8-sig")), delimiter=";"))
        self.assertEqual(len(rows), 3)
        self.assertEqual(float(rows[1][2]), 6)
        self.assertEqual(float(rows[2][2]), 3)
        self.assertEqual(int(request.response_headers["Content-Length"]), len(payload))

    def test_large_ranges_aggregate_without_losing_peak(self):
        text = "".join(frame(self.t+timedelta(minutes=i), 30 if i==1000 else 6) for i in range(5000))
        self.import_text(text)
        result = dashboard.overview(["wald1"],store.epoch(self.t),store.epoch(self.t)+4999*60)
        self.assertLess(len(result["series"][0]["points"]), 1402)
        self.assertEqual(max(p["intensity"] for p in result["series"][0]["points"]), 30)
        self.assertAlmostEqual(result["series"][0]["summary"]["rain"], (4999*6+30)/60)
        self.assertEqual(result["series"][0]["points"][-1]["cumulative"],
                         sum(p["rain"] for p in result["series"][0]["points"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
