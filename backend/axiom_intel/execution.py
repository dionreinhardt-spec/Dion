"""Execution boundary: a future authorized adapter must satisfy this contract."""
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, Literal


@dataclass(frozen=True)
class ExecutionQuote:
    chain: str
    token: str
    side: Literal["buy", "sell"]
    input_amount: Decimal
    minimum_output: Decimal
    expires_at: float
    provider: str
    quote_id: str


class ExecutionAdapter(Protocol):
    async def quote(self, chain: str, token: str, side: str, amount: Decimal) -> ExecutionQuote: ...
    async def execute(self, quote: ExecutionQuote, authorization_id: str, idempotency_key: str) -> str: ...


class LiveExecutionDisabled:
    """Deliberately has no signer, transaction builder or sendTransaction path."""
    async def quote(self, *args, **kwargs):
        raise PermissionError("Live execution is not available in version 0.1")

    async def execute(self, *args, **kwargs):
        raise PermissionError("Separate implementation, wallet limits and explicit authorization required")
