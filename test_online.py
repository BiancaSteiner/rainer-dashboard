"""Online-Prüfungen mit synthetischen Daten und Flask-Testclient."""

import io
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

import dashboard
import online
import speicher as store
from pruefung import frame
from datetime import datetime


class OnlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(dir=store.ROOT)
        self.original_db = dashboard.DB_PATH
        self.original_config = store.CONFIG_PATH
        self.password = "Synthetisches-Testpasswort-2026"
        self.settings = dict(TESTING=True, SECRET_KEY="test-key-"+32*"x",
                             DASHBOARD_PASSWORD=self.password, DATA_DIR=self.temp.name,
                             TRUSTED_HOSTS=["rainer.test"], REQUIRE_HTTPS=True)
        dashboard.STATE.update(running=False, message="Bereit", results=[])
        self.app = online.create_app(self.settings)
        self.client = self.app.test_client()
        self.csrf = None

    def tearDown(self):
        # Hintergrundimport muss vor dem Entfernen seiner Testdateien fertig sein.
        limit = time.monotonic()+10
        while dashboard.STATE["running"] and time.monotonic()<limit:
            time.sleep(.01)
        dashboard.DB_PATH = self.original_db
        store.CONFIG_PATH = self.original_config
        self.temp.cleanup()

    def get(self, url, **kwargs):
        return self.client.get(url, base_url="https://rainer.test", **kwargs)

    def post(self, url, **kwargs):
        return self.client.post(url, base_url="https://rainer.test", **kwargs)

    def login(self):
        page = self.get("/login")
        token = re.search(r'name="csrf" value="([^"]+)"', page.text)[1]
        result = self.post("/login", data={"username":"admin", "password":self.password, "csrf":token})
        self.assertEqual(result.status_code, 302)
        self.csrf = self.get("/api/meta").json["token"]

    def write(self, url, **kwargs):
        return self.post(url, headers={"X-LNM-Token":self.csrf}, **kwargs)

    def begin(self, payload, **options):
        self.login()
        request = dict(device="wald1", id="01", encoding="utf-8-sig", size=len(payload), name="kunst.csv")
        request.update(options)
        response = self.write("/api/uploads", json=request)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json["upload"]

    def put(self, identifier, index, payload):
        return self.client.put(f"/api/uploads/{identifier}/{index}", data=payload,
                               content_type="application/octet-stream", headers={"X-LNM-Token":self.csrf},
                               base_url="https://rainer.test")

    def await_import(self, identifier):
        limit = time.monotonic()+10
        while time.monotonic()<limit:
            status = self.get("/api/uploads/"+identifier).json
            if status["phase"] in ("done", "error"):
                return status
            time.sleep(.01)
        self.fail("Import nicht abgeschlossen")

    def test_private_routes_require_login_and_health_is_public(self):
        self.assertEqual(self.get("/").status_code, 302)
        for path in ("/api/meta","/api/imports","/api/export","/api/spectrum","/api/minute"):
            self.assertEqual(self.get(path).status_code, 401)
        self.assertEqual(self.post("/api/import").status_code, 401)
        self.assertEqual(self.get("/healthz").json, {"ok":True})
        self.assertEqual(self.get("/messdaten.sqlite").status_code, 404)

    def test_login_csrf_cookies_and_logout(self):
        self.assertEqual(self.post("/login",data={"username":"admin","password":self.password}).status_code,403)
        self.login()
        with self.get("/") as page:
            self.assertEqual(page.status_code,200)
        self.assertEqual(self.post("/logout").status_code,403)
        self.assertEqual(self.write("/logout").status_code,302)
        self.assertEqual(self.get("/api/meta").status_code,401)
        response=self.get("/login")
        cookie=response.headers["Set-Cookie"]
        self.assertIn("Secure",cookie)
        self.assertIn("HttpOnly",cookie)
        self.assertIn("SameSite=Lax",cookie)

    def test_invalid_host_and_insecure_request(self):
        self.assertEqual(self.client.get("/api/meta",base_url="https://untrusted.example").status_code,400)
        self.assertEqual(self.client.get("/login",base_url="http://rainer.test").status_code,400)

    def test_login_is_rate_limited(self):
        page=self.get("/login")
        token=re.search(r'name="csrf" value="([^"]+)"',page.text)[1]
        for _ in range(10):
            response=self.post("/login",data={"username":"admin","password":"wrong","csrf":token})
            self.assertEqual(response.status_code,401)
        self.assertEqual(self.post("/login",data={"username":"admin","password":self.password,"csrf":token}).status_code,429)

    def test_chunk_retries_import_export_and_restart(self):
        payload=frame(datetime(2026,7,23,3,55),6).encode()
        identifier=self.begin(payload)
        self.assertEqual(self.put(identifier,0,payload).status_code,200)
        self.assertEqual(self.put(identifier,0,payload).status_code,200)
        changed=payload[:-1]+b"x"
        self.assertEqual(self.put(identifier,0,changed).status_code,400)
        self.assertEqual(self.get("/api/uploads/"+identifier).json["received"],[0])
        self.assertEqual(self.write("/api/uploads/"+identifier+"/finish").status_code,200)
        self.assertEqual(self.await_import(identifier)["phase"],"done")
        t=store.epoch("23.07.2026 03:55")
        summary=self.get(f"/api/overview?devices=wald1&start={t}&end={t}").json["series"][0]["summary"]
        self.assertAlmostEqual(summary["rain"],.1)
        response=self.get(f"/api/export?devices=wald1&start={t}&end={t}")
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.data.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(self.get("/api/imports").json[0]["accepted"],1)
        saved_cookie=self.client.get_cookie("session",domain="rainer.test")
        self.app=online.create_app(self.settings)
        self.client=self.app.test_client()
        self.client.set_cookie("session",saved_cookie.value,domain="rainer.test")
        self.assertEqual(self.get("/api/overview?devices=wald1").json["series"][0]["summary"]["telegrams"],1)
        self.assertEqual(self.write("/api/uploads/"+identifier+"/finish").json["results"][0]["accepted"],1)

    def test_upload_rejects_missing_chunks_and_path_escape(self):
        payload=frame(datetime(2026,7,23,3,55)).encode()
        identifier=self.begin(payload)
        self.assertEqual(self.write("/api/uploads/"+identifier+"/finish").status_code,400)
        self.assertEqual(self.put(identifier,0,payload[:-1]).status_code,400)
        self.assertEqual(self.get("/api/uploads/not-a-valid-id").status_code,400)
        bad=self.write("/api/uploads",json={"device":"../../escape","id":"01","name":"x.csv","size":30})
        self.assertEqual(bad.status_code,400)
        self.assertEqual(self.post("/api/import",headers={"X-LNM-Token":self.csrf,"Origin":"https://other.example"}).status_code,403)

    def test_upload_spanning_multiple_chunks(self):
        payload=(frame(datetime(2026,7,23,3,55)).encode()*4)
        with patch.object(online,"CHUNK_BYTES",800):
            identifier=self.begin(payload)
            n=(len(payload)+799)//800
            for index in range(n):
                self.assertEqual(self.put(identifier,index,payload[index*800:(index+1)*800]).status_code,200)
            self.assertEqual(self.write("/api/uploads/"+identifier+"/finish").status_code,200)
            self.assertEqual(self.await_import(identifier)["phase"],"done")
        with store.connect(dashboard.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM samples").fetchone()[0],1)
            self.assertEqual(db.execute("SELECT duplicates FROM imports").fetchone()[0],3)

    def test_interrupted_import_can_retry_after_restart(self):
        payload=frame(datetime(2026,7,23,3,55)).encode()
        identifier=self.begin(payload)
        self.put(identifier,0,payload)
        directory=Path(self.temp.name)/"uploads"/identifier
        manifest=json.loads((directory/"manifest.json").read_text())
        manifest["phase"]="processing"
        (directory/"manifest.json").write_text(json.dumps(manifest))
        self.app=online.create_app(self.settings)
        self.client=self.app.test_client()
        self.login()
        self.assertEqual(self.get("/api/uploads/"+identifier).json["phase"],"error")
        self.assertEqual(self.write("/api/uploads/"+identifier+"/finish").status_code,200)
        self.assertEqual(self.await_import(identifier)["phase"],"done")

    def test_startup_requires_secrets(self):
        with self.assertRaises(RuntimeError):
            online.create_app(dict(self.settings,SECRET_KEY="short"))
        with self.assertRaises(RuntimeError):
            online.create_app(dict(self.settings,DASHBOARD_PASSWORD="short"))


if __name__=="__main__":
    unittest.main(verbosity=2)
