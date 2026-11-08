"""Runtime configuration, read from environment variables only (no secrets in code)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    v = _env(name)
    return int(v) if v is not None else default


def _env_bool(name: str, default: bool) -> bool:
    v = _env(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Config:
    database_url: str = field(default_factory=lambda: _env(
        "DATABASE_URL", "postgresql://icecap:icecap@localhost:5432/icecap"))
    user_agent: str = field(default_factory=lambda: _env(
        "ICECAP_USER_AGENT",
        "IceCapDevelopmentIntelligence/0.1 (public-records monitor; contact via repository owner)"))
    backfill_days: int = field(default_factory=lambda: _env_int("ICECAP_BACKFILL_DAYS", 365))
    worker_id: str = field(default_factory=lambda: _env("ICECAP_WORKER_ID", f"worker-{os.getpid()}"))
    max_concurrent_sources: int = field(default_factory=lambda: _env_int("ICECAP_MAX_CONCURRENT_SOURCES", 3))
    scheduler_tick_s: int = field(default_factory=lambda: _env_int("ICECAP_SCHEDULER_TICK_S", 15))
    http_timeout_s: int = field(default_factory=lambda: _env_int("ICECAP_HTTP_TIMEOUT_S", 90))

    # Notifications (all optional — mocked delivery when absent)
    telegram_bot_token: str | None = field(default_factory=lambda: _env("TELEGRAM_BOT_TOKEN"))
    telegram_chat_id: str | None = field(default_factory=lambda: _env("TELEGRAM_CHAT_ID"))
    smtp_host: str | None = field(default_factory=lambda: _env("SMTP_HOST"))
    smtp_port: int = field(default_factory=lambda: _env_int("SMTP_PORT", 587))
    smtp_user: str | None = field(default_factory=lambda: _env("SMTP_USER"))
    smtp_password: str | None = field(default_factory=lambda: _env("SMTP_PASSWORD"))
    smtp_starttls: bool = field(default_factory=lambda: _env_bool("SMTP_STARTTLS", True))
    email_from: str | None = field(default_factory=lambda: _env("ALERT_EMAIL_FROM"))
    email_to: str | None = field(default_factory=lambda: _env("ALERT_EMAIL_TO"))
    notify_channels: tuple[str, ...] = field(default_factory=lambda: tuple(
        c.strip() for c in (_env("NOTIFY_CHANNELS", "telegram,email") or "").split(",") if c.strip()))
    dashboard_url: str = field(default_factory=lambda: _env("DASHBOARD_URL", "http://localhost:3000"))

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)

    @property
    def email_configured(self) -> bool:
        return bool(self.smtp_host and self.email_from and self.email_to)


def get_config() -> Config:
    return Config()
