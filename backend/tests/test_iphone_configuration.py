import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location('iphone_https', Path(__file__).parents[2] / 'scripts' / 'iphone_https.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_https_configuration_preserves_credentials_and_existing_origins(tmp_path):
    env = tmp_path / '.env'
    env.write_text('INTEL_API_TOKEN=private-test-token\nPOSTGRES_PASSWORD=private-test-password\nINTEL_ALLOWED_ORIGINS=http://localhost:3000\n')
    assert module.configure(env, 'intel.example.com') == 'https://intel.example.com'
    content = env.read_text()
    assert 'INTEL_API_TOKEN=private-test-token\n' in content
    assert 'POSTGRES_PASSWORD=private-test-password\n' in content
    assert 'http://localhost:3000,https://intel.example.com' in content
    module.configure(env, 'intel.example.com')
    assert env.read_text().count('https://intel.example.com') == 1
    assert env.stat().st_mode & 0o777 == 0o600


def test_placeholder_token_cannot_enable_public_gateway(tmp_path):
    env = tmp_path / '.env'
    env.write_text('INTEL_API_TOKEN=replace-with-random-api-token\n')
    with pytest.raises(ValueError): module.configure(env, 'intel.example.com')
    assert 'INTEL_PUBLIC_DOMAIN' not in env.read_text()


@pytest.mark.parametrize('value', ['localhost', '127.0.0.1', 'https://example.com', 'domain.com:8080', 'example.com/path', '*.example.com', 'foo.local', 'x.com\nreverse_proxy bad'])
def test_domain_cannot_inject_configuration(value):
    with pytest.raises(ValueError): module.domain_name(value)
