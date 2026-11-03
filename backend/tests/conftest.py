import time
import pytest
from axiom_intel.config import Settings
from axiom_intel.models import Trade, Market, Security, WSOL, TOKEN_PROGRAM
from axiom_intel.storage import Store

TOKEN = "11111111111111111111111111111112"
NOW = 1800000000.0

@pytest.fixture
def settings():
    return Settings(mode="offline", database_url="sqlite+aiosqlite:///:memory:")

@pytest.fixture
async def store():
    s = Store("sqlite+aiosqlite:///:memory:")
    await s.start()
    yield s
    await s.close()


def trade(i=0, side="buy", wallet=None, at=None, usd=100, price=1):
    return Trade(id=f"test:{i}", token=TOKEN, venue="pump", signature=f"test-sig-{i}", event_index=i,
                 slot=i, timestamp=at if at is not None else NOW - 1, received_at=at if at is not None else NOW - 1,
                 wallet=wallet or f"wallet-{i}", side=side, token_amount_raw=int(usd / price * 10**6),
                 quote_amount_raw=int(usd / 100 * 10**9), quote_mint=WSOL, quote_decimals=9,
                 quote_usd=100, quote_price_at=NOW - 2, decimals=6)


def market(now=NOW, liquidity=100000):
    return Market(token=TOKEN, symbol="TEST", name="Test Fixture (not live)", pair="pool", dex="pump", price_usd=1,
                  liquidity_usd=liquidity, market_cap=100000, fdv=100000, volume_5m=50000, received_at=now)


def security(now=NOW):
    return Security(token=TOKEN, checked_at=now, decimals=6, supply_raw=10**15, mint_authority=None,
                    freeze_authority=None, token_program=TOKEN_PROGRAM, largest_observed_owner_share=.03,
                    sampled_accounts=20)


def eligible_snap(now=NOW):
    return {"token": TOKEN, "symbol": "TEST", "status": "ENTRY_CANDIDATE", "price_usd": 1,
            "blockers": [], "trade_age_s": 0, "metadata_age_s": 0,
            "market": {"liquidity_usd": 100000}, "windows": {"15": {"net_flow_usd": 1000}},
            "security": {"blockers": []}, "evaluated_at": now}
