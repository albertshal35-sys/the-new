"""Delivery channels. When credentials are absent, a MockChannel records the message locally and the
notification is marked `mocked` — it is never reported as delivered."""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from pathlib import Path

from ..config import Config
from ..http import PoliteClient

log = logging.getLogger(__name__)
MOCK_LOG = Path(__file__).resolve().parents[2] / "var" / "mock_notifications.log"


@dataclass
class SendResult:
    ok: bool
    mocked: bool = False
    provider_message_id: str | None = None


class MockChannel:
    def __init__(self, name: str, reason: str):
        self.name = name
        self.reason = reason

    async def send(self, subject: str, body: str) -> SendResult:
        MOCK_LOG.parent.mkdir(parents=True, exist_ok=True)
        with MOCK_LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"===== MOCK {self.name.upper()} (not delivered: {self.reason}) =====\n{subject}\n{body}\n\n")
        log.info("mock %s notification recorded: %s", self.name, subject)
        return SendResult(ok=True, mocked=True, provider_message_id=f"mock-{self.name}")


class TelegramChannel:
    name = "telegram"

    def __init__(self, token: str, chat_id: str, client: PoliteClient):
        self.token = token
        self.chat_id = chat_id
        self.client = client

    async def send(self, subject: str, body: str) -> SendResult:
        text = body if len(body) <= 4000 else body[:3990] + "\n…"
        r = await self.client.request("POST", f"https://api.telegram.org/bot{self.token}/sendMessage",
                                      json_body={"chat_id": self.chat_id, "text": text,
                                                 "disable_web_page_preview": True})
        if not r.data.get("ok"):
            raise RuntimeError(f"Telegram API error: {r.data.get('description')}")
        return SendResult(ok=True, provider_message_id=str(r.data["result"]["message_id"]))


class EmailChannel:
    name = "email"

    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _send_sync(self, subject: str, body: str) -> str:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = self.cfg.email_from
        msg["To"] = self.cfg.email_to
        msg.set_content(body)
        with smtplib.SMTP(self.cfg.smtp_host, self.cfg.smtp_port, timeout=30) as s:
            if self.cfg.smtp_starttls:
                s.starttls(context=ssl.create_default_context())
            if self.cfg.smtp_user:
                s.login(self.cfg.smtp_user, self.cfg.smtp_password or "")
            s.send_message(msg)
        return msg.get("Message-ID") or "smtp-accepted"

    async def send(self, subject: str, body: str) -> SendResult:
        mid = await asyncio.to_thread(self._send_sync, subject, body)
        return SendResult(ok=True, provider_message_id=mid)


def build_channels(cfg: Config, client: PoliteClient) -> dict:
    ch = {}
    ch["telegram"] = TelegramChannel(cfg.telegram_bot_token, cfg.telegram_chat_id, client) \
        if cfg.telegram_configured else MockChannel("telegram", "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set")
    ch["email"] = EmailChannel(cfg) if cfg.email_configured else \
        MockChannel("email", "SMTP_HOST/ALERT_EMAIL_FROM/ALERT_EMAIL_TO not set")
    return ch
