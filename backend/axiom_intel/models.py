from typing import Literal, Any
from pydantic import BaseModel, Field, ConfigDict, field_validator
import base58

WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
WINDOWS = (5, 15, 30, 60, 300, 900, 3600, 86400)


def solana_address(value: str) -> str:
    try:
        if len(base58.b58decode(value)) != 32:
            raise ValueError()
    except Exception:
        raise ValueError("Expected a 32-byte base58 Solana address") from None
    return value


class Trade(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: str
    chain: Literal["solana"] = "solana"
    token: str
    venue: Literal["pump", "pumpswap"]
    signature: str
    event_index: int
    slot: int
    timestamp: float = Field(gt=0)
    received_at: float = Field(gt=0)
    wallet: str
    side: Literal["buy", "sell"]
    token_amount_raw: int = Field(gt=0)
    quote_amount_raw: int = Field(gt=0)
    quote_mint: str
    quote_decimals: int = Field(ge=0, le=18)
    quote_usd: float | None = Field(None, gt=0)
    quote_price_at: float | None = None
    decimals: int | None = Field(None, ge=0, le=18)
    schema_warning: str | None = None
    source: str = "solana-confirmed-rpc"

    @property
    def usd(self) -> float | None:
        return self.quote_amount_raw / 10**self.quote_decimals * self.quote_usd if self.quote_usd else None

    @property
    def price_usd(self) -> float | None:
        return self.usd / (self.token_amount_raw / 10**self.decimals) if self.usd and self.decimals is not None else None


class Market(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    token: str
    symbol: str
    name: str
    pair: str
    dex: str
    price_usd: float = Field(gt=0)
    liquidity_usd: float = Field(ge=0)
    market_cap: float | None = Field(None, ge=0)
    fdv: float | None = Field(None, ge=0)
    volume_5m: float | None = Field(None, ge=0)
    received_at: float
    source_timestamp: float | None = None
    pair_created_at: float | None = None
    source: str = "dexscreener"


class Security(BaseModel):
    token: str
    checked_at: float
    received_at: float | None = None
    decimals: int = Field(ge=0, le=18)
    supply_raw: int = Field(gt=0)
    mint_authority: str | None
    freeze_authority: str | None
    token_program: str
    extensions: list[str] = []
    largest_observed_owner_share: float | None = None
    sampled_accounts: int = 0
    excluded_vault_owners: list[str] = []
    blockers: list[str] = []
    warnings: list[str] = []
    source: str = "solana-rpc-mint-and-largest-accounts"


class SocialPost(BaseModel):
    id: str
    platform: Literal["x", "telegram", "import"]
    author: str
    text: str = Field(max_length=20000)
    timestamp: float
    received_at: float
    url: str = ""
    contracts: list[str] = []
    likes: int = Field(0, ge=0)
    reposts: int = Field(0, ge=0)


class PaperRequest(BaseModel):
    token: str
    idempotency_key: str = Field(min_length=8, max_length=120, pattern=r"^[a-zA-Z0-9_-]+$")
    notional_usd: float = Field(gt=0, le=100000, allow_inf_nan=False)
    _token = field_validator("token")(solana_address)


class CloseRequest(BaseModel):
    fraction: float = Field(1, gt=0, le=1, allow_inf_nan=False)
    idempotency_key: str = Field(min_length=8, max_length=120, pattern=r"^[a-zA-Z0-9_-]+$")


class WatchRequest(BaseModel):
    token: str
    _token = field_validator("token")(solana_address)
