"""Zero-dependency Web Push (RFC 8291 + RFC 8292), ntfy.sh, and Webhook notifier."""

import base64
import hashlib
import hmac
import json
import os
import struct
import time
from typing import Any
from urllib.parse import urlparse

from aiohttp import ClientSession, ClientTimeout
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from config import VAPID_PATH


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(data: str) -> bytes:
    pad = "=" * ((4 - len(data) % 4) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    if not salt:
        salt = b"\x00" * 32
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    out = b""
    prev = b""
    counter = 1
    while len(out) < length:
        prev = hmac.new(prk, prev + info + bytes([counter]), hashlib.sha256).digest()
        out += prev
        counter += 1
    return out[:length]


class VapidManager:
    """Loads or generates persistent ECDSA P-256 VAPID keys."""

    def __init__(self, path=VAPID_PATH, subject: str = "https://gtpp.omidhemmati.com"):
        self.path = path
        self.subject = subject
        self.private_key: ec.EllipticCurvePrivateKey
        self.public_b64url: str
        self._load_or_create()

    def _load_or_create(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.private_key = serialization.load_pem_private_key(
                data["private_pem"].encode("utf-8"), password=None
            )
            self.public_b64url = data["public_b64url"]
            loaded_subject = data.get("subject", self.subject)
            if loaded_subject.endswith("@localhost"):
                loaded_subject = self.subject
                data["subject"] = loaded_subject
                self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            self.subject = loaded_subject
            return

        self.private_key = ec.generate_private_key(ec.SECP256R1())
        pub_bytes = self.private_key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        self.public_b64url = b64url_encode(pub_bytes)
        priv_pem = self.private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("utf-8")
        self.path.write_text(
            json.dumps(
                {
                    "private_pem": priv_pem,
                    "public_b64url": self.public_b64url,
                    "subject": self.subject,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def build_auth_header(self, endpoint: str, ttl_sec: int = 12 * 3600) -> str:
        parsed = urlparse(endpoint)
        aud = f"{parsed.scheme}://{parsed.netloc}"
        header = b64url_encode(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
        claims = b64url_encode(
            json.dumps(
                {
                    "aud": aud,
                    "exp": int(time.time()) + ttl_sec,
                    "sub": self.subject,
                },
                separators=(",", ":"),
            ).encode()
        )
        signing_input = f"{header}.{claims}".encode("ascii")
        der_sig = self.private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der_sig)
        raw_sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        jwt_token = f"{header}.{claims}.{b64url_encode(raw_sig)}"
        return f"vapid t={jwt_token}, k={self.public_b64url}"


def encrypt_webpush_payload(p256dh_b64: str, auth_b64: str, payload_bytes: bytes) -> bytes:
    """Encrypt Web Push payload using RFC 8291 (aes128gcm content encoding)."""
    ua_pub_bytes = b64url_decode(p256dh_b64)
    auth_secret = b64url_decode(auth_b64)
    if len(ua_pub_bytes) != 65 or ua_pub_bytes[0] != 0x04:
        raise ValueError("Invalid client p256dh public key")
    if len(auth_secret) != 16:
        raise ValueError("Invalid client auth secret")

    ua_pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub_bytes)
    as_priv = ec.generate_private_key(ec.SECP256R1())
    as_pub_bytes = as_priv.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )

    ecdh_secret = as_priv.exchange(ec.ECDH(), ua_pub)
    salt = os.urandom(16)

    # RFC 8291 Section 3.3 key derivation
    prk_key = _hkdf_extract(auth_secret, ecdh_secret)
    key_info = b"WebPush: info\x00" + ua_pub_bytes + as_pub_bytes
    ikm = _hkdf_expand(prk_key, key_info, 32)

    prk = _hkdf_extract(salt, ikm)
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)

    # Single record with 0x02 delimiter
    plaintext = payload_bytes + b"\x02"
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext, None)

    header = salt + struct.pack("!I", 4096) + bytes([len(as_pub_bytes)]) + as_pub_bytes
    return header + ciphertext


async def send_web_push(
    session: ClientSession,
    vapid: VapidManager,
    sub: dict[str, Any],
    payload: dict[str, Any],
) -> tuple[str, str]:
    """Send an encrypted Web Push message. Returns ('ok'|'gone'|'error', detail)."""
    endpoint = sub["endpoint"]
    try:
        body = encrypt_webpush_payload(
            sub["p256dh"],
            sub["auth"],
            json.dumps(payload).encode("utf-8"),
        )
        headers = {
            "Authorization": vapid.build_auth_header(endpoint),
            "TTL": "300",
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "Urgency": "high",
        }
        async with session.post(endpoint, data=body, headers=headers, timeout=ClientTimeout(total=10)) as resp:
            if 200 <= resp.status < 300:
                return "ok", f"HTTP {resp.status}"
            if resp.status in (404, 410):
                return "gone", f"HTTP {resp.status}"
            err_text = (await resp.text())[:200]
            return "error", f"HTTP {resp.status}: {err_text}"
    except Exception as exc:
        return "error", str(exc)


async def send_ntfy(
    session: ClientSession,
    server: str,
    topic: str,
    title: str,
    body: str,
    priority: str = "default",
    tags: str = "train",
) -> tuple[str, str]:
    """Send notification to an ntfy.sh (or self-hosted ntfy) topic."""
    clean_topic = (topic or "").strip().lstrip("/")
    if not clean_topic:
        return "skipped", "No topic configured"
    base = (server or "https://ntfy.sh").strip().rstrip("/")
    url = f"{base}/{clean_topic}"
    headers = {
        "Title": title,
        "Priority": priority,
        "Tags": tags,
    }
    try:
        async with session.post(
            url,
            data=body.encode("utf-8"),
            headers=headers,
            timeout=ClientTimeout(total=8),
        ) as resp:
            if 200 <= resp.status < 300:
                return "ok", f"HTTP {resp.status}"
            return "error", f"HTTP {resp.status}"
    except Exception as exc:
        return "error", str(exc)


async def send_webhook(
    session: ClientSession,
    url: str,
    payload: dict[str, Any],
) -> tuple[str, str]:
    """Send JSON POST to a user-configured generic webhook (Discord/Home Assistant/etc.)."""
    target = (url or "").strip()
    if not target:
        return "skipped", "No webhook URL"
    try:
        async with session.post(
            target,
            json=payload,
            timeout=ClientTimeout(total=8),
        ) as resp:
            if 200 <= resp.status < 300:
                return "ok", f"HTTP {resp.status}"
            return "error", f"HTTP {resp.status}"
    except Exception as exc:
        return "error", str(exc)


async def dispatch_notification(
    session: ClientSession,
    db,
    vapid: VapidManager,
    user_id: str,
    title: str,
    body: str,
    data_dict: dict[str, Any],
    priority: str = "default",
    tags: str = "train",
) -> dict[str, Any]:
    """Dispatch notification across all configured channels for a user and return per-channel status."""
    settings = db.get_settings(user_id)
    channels = settings.get("channels", {})
    results: dict[str, Any] = {}

    if channels.get("web_push_enabled", True):
        subs = db.list_push_subscriptions(user_id)
        if not subs:
            results["web_push"] = {"status": "no_subscribers"}
        else:
            wp_ok = 0
            wp_err = []
            payload = {
                "title": title,
                "body": body,
                "tag": data_dict.get("tag", "gotracker"),
                "url": "/",
                "data": data_dict,
            }
            for sub in subs:
                status, detail = await send_web_push(session, vapid, sub, payload)
                if status == "ok":
                    wp_ok += 1
                    db.mark_push_result(sub["endpoint"], True)
                elif status == "gone":
                    db.delete_push_subscription(sub["endpoint"], user_id=user_id)
                    wp_err.append(f"removed expired ({detail})")
                else:
                    db.mark_push_result(sub["endpoint"], False)
                    wp_err.append(detail)
            results["web_push"] = {
                "status": "ok" if wp_ok > 0 else "error",
                "delivered": wp_ok,
                "total": len(subs),
                "errors": wp_err,
            }

    ntfy_topic = (channels.get("ntfy_topic") or "").strip()
    if ntfy_topic:
        status, detail = await send_ntfy(
            session,
            channels.get("ntfy_server", "https://ntfy.sh"),
            ntfy_topic,
            title,
            body,
            priority=priority,
            tags=tags,
        )
        results["ntfy"] = {"status": status, "detail": detail}

    webhook_url = (channels.get("webhook_url") or "").strip()
    if webhook_url:
        status, detail = await send_webhook(
            session,
            webhook_url,
            {
                "title": title,
                "body": body,
                "content": f"**{title}**\n{body}",
                "data": data_dict,
            },
        )
        results["webhook"] = {"status": status, "detail": detail}

    return results
