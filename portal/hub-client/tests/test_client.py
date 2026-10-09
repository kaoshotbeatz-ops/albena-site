import base64, hashlib, json, os, stat, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import albena_portal_client as apc


class Fake(BaseHTTPRequestHandler):
    calls = []
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        Fake.calls.append((self.command, self.path, dict(self.headers), body))
        if self.path.endswith("/pair/complete"): self._send(200, {"hubId": "123e4567"})
        else: self._send(200, {"ok": True, "updateChannel": "beta", "remoteAccess": False})
    def do_GET(self):
        Fake.calls.append((self.command, self.path, dict(self.headers), b""))
        if "edition=nvidia" in self.path: self._send(404, {"error": "no release"})
        else: self._send(200, {"version": "1.2.0", "manifestUrl": "https://x/m.json", "sha256": "a" * 64})


class T(unittest.TestCase):
    def setUp(self):
        self.srv = HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.tmp = tempfile.mkdtemp()
        Fake.calls.clear()
    def tearDown(self): self.srv.shutdown()
    def client(self, **kw):
        c = apc.PortalClient(self.tmp, version="1.0.0", **kw)
        c.base = f"http://127.0.0.1:{self.srv.server_port}"  # test-only: bypass the https-only constructor check
        return c

    def test_rejects_http_base(self):
        with self.assertRaises(ValueError): apc.PortalClient(self.tmp, base_url="http://account.albena.ai")

    def test_key_is_0600_and_stable(self):
        c = self.client(); k1 = c.public_key_b64()
        self.assertEqual(stat.S_IMODE(os.stat(c.key_path).st_mode), 0o600)
        self.assertEqual(k1, self.client().public_key_b64())
        os.chmod(c.key_path, 0o644)
        with self.assertRaises(PermissionError): c.public_key_b64()

    def test_pair_then_signed_heartbeat_verifies(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        c = self.client()
        self.assertEqual(c.pair("abcd-2345"), "123e4567")
        pb = json.loads(Fake.calls[0][3]); self.assertEqual(pb["edition"], "mac"); self.assertNotIn("token", pb)
        with self.assertRaises(apc.PortalError): self.client(edition="mac").__class__(self.tmp + "/none").heartbeat()
        out = c.heartbeat([("voice", "ok"), ("llm", "degraded")])
        self.assertEqual(out["updateChannel"], "beta"); self.assertEqual(c.update_channel, "beta")
        m, path, h, body = Fake.calls[1]
        msg = f"POST\n{path}\n{h['X-Hub-Timestamp']}\n{hashlib.sha256(body).hexdigest()}".encode()
        Ed25519PublicKey.from_public_bytes(base64.b64decode(c.public_key_b64())).verify(base64.b64decode(h["X-Hub-Signature"]), msg)
        self.assertEqual(h["X-Hub-Id"], "123e4567")
        self.assertFalse(json.loads(body)["health"]["ok"])

    def test_pair_with_serial_or_license_key_sends_exactly_one_credential(self):
        c = self.client()
        c.pair(serial="ALB-0001"); self.assertEqual(json.loads(Fake.calls[-1][3])["serial"], "ALB-0001")
        c.pair(license_key="ALB-AAAAA-AAAAA-AAAAA-AAAAA"); pb = json.loads(Fake.calls[-1][3])
        self.assertEqual(pb["licenseKey"], "ALB-AAAAA-AAAAA-AAAAA-AAAAA"); self.assertNotIn("code", pb); self.assertNotIn("serial", pb)
        for kw in ({}, {"code": "ABCD2345", "serial": "ALB-0001"}):
            with self.assertRaises(ValueError): c.pair(**kw)

    def test_heartbeat_rejects_free_form_service_names(self):
        c = self.client(); c.pair("ABCD2345")
        with self.assertRaises(ValueError): c.heartbeat([("alice's phone", "ok")])
        with self.assertRaises(ValueError): c.heartbeat([("voice", "bored")])

    def test_check_update(self):
        c = self.client()
        self.assertEqual(c.check_update()["version"], "1.2.0")
        c.version = "1.2.0"; self.assertIsNone(c.check_update())
        self.assertIsNone(self.client(edition="nvidia").check_update())

    def test_vercmp(self):
        self.assertEqual(apc.vercmp("1.10.0", "1.9.9"), 1); self.assertEqual(apc.vercmp("1.0", "1.0.0"), 0)


if __name__ == "__main__": unittest.main()
