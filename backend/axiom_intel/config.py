from pathlib import Path
from typing import Literal
from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore", env_prefix="INTEL_")
    mode: Literal["live", "offline"] = "live"
    database_url: SecretStr = SecretStr("sqlite+aiosqlite:///./data/intelligence.db")
    redis_url: SecretStr | None = None
    api_token: SecretStr | None = None
    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    solana_rpc_http: SecretStr = SecretStr("https://api.mainnet-beta.solana.com")
    solana_rpc_ws: SecretStr = SecretStr("wss://api.mainnet-beta.solana.com")
    rpc_rps: float = Field(4, gt=0, le=1000)
    rpc_concurrency: int = Field(4, ge=1, le=64)
    rpc_usd_per_1000: float = Field(0, ge=0)
    provider_fixed_monthly_usd: float = Field(0, ge=0)
    watch_pumpswap: bool = True
    enrichment_interval_s: float = Field(20, ge=10)
    security_ttl_s: float = Field(120, ge=10)
    max_candidates: int = Field(150, ge=1, le=2000)
    queue_size: int = Field(1000, ge=10)
    max_hot_events: int = Field(200000, ge=1000)
    max_token_events: int = Field(10000, ge=100)
    max_price_age_s: float = Field(45, ge=1)
    max_trade_age_s: float = Field(15, ge=1)
    max_security_age_s: float = Field(180, ge=10)
    min_warmup_s: float = Field(60, ge=60)
    signal_score_threshold: float = Field(62, ge=0, le=100)
    min_liquidity_usd: float = Field(25000, ge=0)
    min_buyers_30s: int = Field(8, ge=2)
    max_single_wallet_share: float = Field(0.4, gt=0, le=1)
    max_largest_owner_share: float = Field(0.2, gt=0, le=1)
    paper_initial_cash_usd: float = Field(10000, gt=0)
    risk_per_trade_pct: float = Field(0.5, gt=0, le=2)
    max_position_pct: float = Field(5, gt=0, le=20)
    max_exposure_pct: float = Field(20, gt=0, le=100)
    risk_timezone: str = "Europe/Berlin"
    max_daily_loss_pct: float = Field(3, gt=0, le=20)
    max_drawdown_pct: float = Field(10, gt=0, le=50)
    max_positions: int = Field(4, ge=1, le=100)
    stop_pct: float = Field(12, gt=0, le=50)
    max_slippage_bps: float = Field(300, gt=0, le=1000)
    max_price_impact_pct: float = Field(2, gt=0, le=10)
    modeled_slippage_bps: float = Field(100, ge=0, le=1000)
    modeled_fee_bps: float = Field(100, ge=0, le=500)
    modeled_priority_fee_usd: float = Field(0.1, ge=0)
    paper_max_hold_s: int = Field(1800, ge=10)
    weights_path: str = "../config/weights.json"
    robinhood_enabled: bool = False
    robinhood_rpc_http: SecretStr = SecretStr("https://rpc.mainnet.chain.robinhood.com")
    robinhood_rpc_ws: SecretStr | None = None
    robinhood_chain_id: int = 4663
    robinhood_start_block: int | None = None
    robinhood_contracts: str = ""
    x_bearer_token: SecretStr | None = None
    x_query: str = ""
    x_poll_s: float = Field(60, ge=30)
    x_max_posts_per_day: int = Field(100, ge=10, le=10000)
    reddit_client_id: SecretStr | None = None\n    reddit_client_secret: SecretStr | None = None\n    reddit_subreddits: str = ""\n    reddit_user_agent: str = "AxiomIntelligence/0.1 (authorized social analytics)"\n    reddit_poll_s: float = Field(120, ge=60)\n    telegram_bot_token: SecretStr | None = None
    telegram_read_channels: str = ""
    telegram_alert_chat_id: str = ""
    telegram_alerts_enabled: bool = False

    @model_validator(mode="after")
    def constraints(self):
        from zoneinfo import ZoneInfo
        ZoneInfo(self.risk_timezone)
        if self.modeled_slippage_bps > self.max_slippage_bps:
            raise ValueError("Modeled slippage exceeds the configured limit")
        if self.robinhood_enabled and not self.robinhood_rpc_ws:
            raise ValueError("Robinhood needs an authorized JSON-RPC WebSocket endpoint")
        return self

    @property
    def origins(self) -> list[str]:
        return [x.strip() for x in self.allowed_origins.split(",") if x.strip()]

    def prepare_data_dir(self):
        url = self.database_url.get_secret_value()
        if url.startswith("sqlite") and ":memory:" not in url:
            Path(url.split("///", 1)[1]).parent.mkdir(parents=True, exist_ok=True)
