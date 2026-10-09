#!/usr/bin/env python3
"""Hub-side client for account.albena.ai (pairing, signed heartbeat, update check).

Dependency: `cryptography` (Ed25519). If it is missing, PyNaCl is used instead. Everything else is stdlib.

Auth model: no bearer token. The hub keeps an Ed25519 private key (mode 0600) and signs every call:
    X-Hub-Id, X-Hub-Timestamp (unix s, +-5 min), X-Hub-Signature = b64(sign("METHOD\\nPATH?QUERY\\nTS\\nsha256hex(body)"))
Only operational metadata is ever sent (see heartbeat()). TLS is strict: https only, system CA store,
hostname checked, no redirects followed, no env-proxy surprises for plaintext.

This client only *finds* updates. Trust in the artifact comes from the signed manifest verified by
hub/update/update.sh against hubconf/release-signers (see hub/update/KEYS.md), not from this API.
"""
import base64
import hashlib
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

try:  # preferred
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    def _generate():
        k = Ed25519PrivateKey.generate()
        return k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())

    def _pub(seed):
        return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)

    def _sign(seed, msg):
        return Ed25519PrivateKey.from_private_bytes(seed).sign(msg)
except ImportError:  # fallback
    from nacl.signing import SigningKey

    def _generate():
        return bytes(SigningKey.generate())

    def _pub(seed):
        return bytes(SigningKey(seed).verify_key)

    def _sign(seed, msg):
        return SigningKey(seed).sign(msg).signature

DEFAULT_BASE = "https://account.albena.ai"
SERVICE_STATUS = {"ok", "degraded", "down", "unknown"}
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,48}$")


class PortalError(Exception):
    def __init__(self, status, message):
        super().__init__(f"{status}: {message}")
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def vercmp(a, b):
    def key(v):
        return tuple(int(x) for x in re.split(r"[-+]", v)[0].split("."))
    ka, kb = key(a), key(b)
    n = max(len(ka), len(kb))
    ka, kb = ka + (0,) * (n - len(ka)), kb + (0,) * (n - len(kb))
    return (ka > kb) - (ka < kb)


class PortalClient:
    def __init__(self, state_dir, base_url=DEFAULT_BASE, edition="mac", profile="home", version="0.0.0",
                 update_channel="stable", ssl_context=None, clock=time.time):
        if not base_url.startswith("https://"):
            raise ValueError("base_url must be https://")
        self.dir, self.base, self.edition, self.profile = state_dir, base_url.rstrip("/"), edition, profile
        self.version, self.update_channel, self.clock = version, update_channel, clock
        self.ctx = ssl_context or ssl.create_default_context()  # CERT_REQUIRED + check_hostname
        self._opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=self.ctx))
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self.key_path = os.path.join(self.dir, "hub_ed25519.key")
        self.id_path = os.path.join(self.dir, "hub_id")

    # --- key + identity ---
    def _seed(self):
        if os.path.exists(self.key_path):
            if os.stat(self.key_path).st_mode & 0o077:
                raise PermissionError(f"{self.key_path} must be mode 0600")
            with open(self.key_path, "rb") as f:
                return base64.b64decode(f.read())
        seed = _generate()
        fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(base64.b64encode(seed))
        return seed

    def public_key_b64(self):
        return base64.b64encode(_pub(self._seed())).decode()

    @property
    def hub_id(self):
        try:
            with open(self.id_path) as f:
                return f.read().strip() or None
        except FileNotFoundError:
            return None

    # --- transport ---
    def _request(self, method, path, body=None, signed=True):
        raw = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", "User-Agent": f"albena-hub/{self.version}"}
        if signed:
            hid = self.hub_id
            if not hid:
                raise PortalError(0, "hub is not paired")
            ts = str(int(self.clock()))
            msg = f"{method}\n{path}\n{ts}\n{hashlib.sha256(raw).hexdigest()}".encode()
            headers.update({"X-Hub-Id": hid, "X-Hub-Timestamp": ts,
                            "X-Hub-Signature": base64.b64encode(_sign(self._seed(), msg)).decode()})
        req = urllib.request.Request(self.base + path, data=raw if method != "GET" else None, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=15) as r:
                return json.loads(r.read(1 << 20) or b"{}")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read(4096)).get("error", "")
            except Exception:
                msg = ""
            raise PortalError(e.code, msg) from None

    # --- API ---
    def pair(self, code):
        """Bind this hub to the account that generated `code`. Stores only the hub id."""
        out = self._request("POST", "/api/hubs/pair/complete", signed=False, body={
            "code": code, "hubPublicKey": self.public_key_b64(), "edition": self.edition,
            "profile": self.profile, "version": self.version})
        with open(self.id_path, "w") as f:
            f.write(out["hubId"])
        os.chmod(self.id_path, 0o600)
        return out["hubId"]

    def heartbeat(self, services=()):
        """services: iterable of (name, status). Operational metadata only; the server rejects anything else."""
        svc = []
        for name, status in services:
            if not _NAME.match(name) or status not in SERVICE_STATUS:
                raise ValueError(f"bad service entry {name!r}")
            svc.append([name, status])
        body = {"version": self.version, "profile": self.profile, "updateChannel": self.update_channel,
                "health": {"ok": all(s[1] == "ok" for s in svc), "services": svc}}
        out = self._request("POST", "/api/hubs/heartbeat", body=body)
        # server-side settings are authoritative (owner changes them in the portal)
        self.update_channel = out.get("updateChannel", self.update_channel)
        return out

    def check_update(self):
        """Return the release pointer if newer than self.version, else None. Verify via update.sh, not here."""
        q = urllib.parse.urlencode({"edition": self.edition, "channel": self.update_channel})
        try:
            rel = self._request("GET", "/api/releases/latest?" + q, signed=False)
        except PortalError as e:
            if e.status == 404:
                return None
            raise
        return rel if vercmp(rel["version"], self.version) > 0 else None
