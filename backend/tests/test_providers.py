from axiom_intel.providers import Providers, retry_delay
from axiom_intel.models import WSOL

async def test_queued_event_cannot_use_a_later_usd_quote(settings):
    p=Providers(settings)
    try:
        p.price_cache[WSOL]=(100,200)
        assert p.quote(WSOL,199)==(None,None)
        assert p.quote(WSOL,201)==(100,200)
        assert p.quote(WSOL,300)==(None,None)
    finally:await p.close()


def test_retry_after_is_not_ignored():
    assert retry_delay('90',0)==90
