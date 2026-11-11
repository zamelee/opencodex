from ha_gateway.urlnorm import default_scheme, normalize_base_url, provider_from_base_url


def test_strips_protocol_path():
    url, note = normalize_base_url("http://127.0.0.1:10100/v1/responses", "openai-responses")
    assert url == "http://127.0.0.1:10100"
    assert note


def test_keeps_root_url():
    url, note = normalize_base_url("http://127.0.0.1:10100", "openai-responses")
    assert url == "http://127.0.0.1:10100"
    assert note == ""


def test_adds_scheme():
    url, note = normalize_base_url("127.0.0.1:10100", "openai-responses")
    assert url == "http://127.0.0.1:10100"
    assert note


def test_strips_trailing_slash():
    url, _ = normalize_base_url("http://127.0.0.1:10100/", "openai-responses")
    assert url == "http://127.0.0.1:10100"


def test_anthropic_path():
    url, _ = normalize_base_url("http://h:8080/v1/messages", "anthropic")
    assert url == "http://h:8080"


def test_chat_path():
    url, _ = normalize_base_url("http://h:8080/v1/chat/completions", "openai-chat")
    assert url == "http://h:8080"


def test_provider_from_base_url():
    assert provider_from_base_url("http://10.126.126.2:10100") == "10.126.126.2:10100"
    assert provider_from_base_url("http://example.com") == "example.com"
    assert provider_from_base_url("") == ""


def test_provider_from_base_url_without_scheme():
    assert provider_from_base_url("127.0.0.1:10100") == "127.0.0.1:10100"


def test_provider_default_fills_from_normalized_url():
    """Provider 留空 -> 取归一化后 Base URL 的域名+端口。"""
    url, _ = normalize_base_url("http://10.126.126.2:10100/v1/responses", "openai-responses")
    assert provider_from_base_url(url) == "10.126.126.2:10100"


def test_https_is_supported():
    """https 地址原样保留，不被改写。"""
    url, note = normalize_base_url("https://api.example.com", "openai-responses")
    assert url == "https://api.example.com"
    assert note == ""


def test_default_scheme_rules():
    assert default_scheme("127.0.0.1:10100") == "http"
    assert default_scheme("localhost:10100") == "http"
    assert default_scheme("10.126.126.2:10100") == "http"
    assert default_scheme("api.example.com") == "https"


def test_public_domain_without_scheme_becomes_https():
    url, note = normalize_base_url("api.example.com", "openai-responses")
    assert url == "https://api.example.com"
    assert "https" in note


def test_bare_ip_without_scheme_stays_http():
    url, _ = normalize_base_url("10.126.126.2:10100", "openai-responses")
    assert url == "http://10.126.126.2:10100"
