import pytest
from axiom_intel.enrichment import inspect_mint
from axiom_intel.models import TOKEN_PROGRAM, TOKEN_2022
from conftest import TOKEN

class FakeRPC:
    def __init__(self,extensions=None,authority=None):
        self.extensions=extensions or []
        self.authority=authority
    async def rpc(self,method,params):
        if method=='getAccountInfo':
            return {'value':{'owner':TOKEN_2022 if self.extensions else TOKEN_PROGRAM,'data':{'parsed':{'type':'mint','info':{'decimals':6,'supply':'1000000000','mintAuthority':self.authority,'freezeAuthority':None,'extensions':[{'extension':x} for x in self.extensions]}}}}}
        if method=='getTokenLargestAccounts':
            return {'value':[{'address':'vault-account','amount':'800000000'},{'address':'user-account','amount':'100000000'}]}
        if method=='getMultipleAccounts':
            return {'value':[{'data':{'parsed':{'info':{'owner':'known-pool'}}}},{'data':{'parsed':{'info':{'owner':'wallet'}}}}]}

async def test_verified_vault_owner_excluded_not_wallet():
    sec=await inspect_mint(FakeRPC(),TOKEN,{'known-pool'})
    assert sec.largest_observed_owner_share==.1
    assert not sec.blockers

async def test_active_mint_authority_blocked():
    sec=await inspect_mint(FakeRPC(authority='mint-authority'),TOKEN,{'known-pool'})
    assert 'Aktive Mint Authority' in sec.blockers

async def test_transfer_hook_default_deny():
    sec=await inspect_mint(FakeRPC(extensions=['transferHook']),TOKEN,{'known-pool'})
    assert sec.blockers

async def test_metadata_extension_permitted_not_guaranteed_safe():
    sec=await inspect_mint(FakeRPC(extensions=['metadataPointer','tokenMetadata']),TOKEN,{'known-pool'})
    assert not sec.blockers and sec.warnings

async def test_distribution_outage_preserves_mint_evidence_but_blocks():
    from axiom_intel.providers import ProviderError
    class PartialRPC(FakeRPC):
        async def rpc(self,method,params):
            if method=='getTokenLargestAccounts':raise ProviderError('rpc unavailable')
            return await super().rpc(method,params)
    sec=await inspect_mint(PartialRPC(),TOKEN,set())
    assert sec.decimals==6 and sec.largest_observed_owner_share is None
    assert any('Distribution' in b for b in sec.blockers)
