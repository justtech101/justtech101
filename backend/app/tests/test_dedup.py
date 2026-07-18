from app.services.dedup import compute_content_hash


def test_content_hash_stable_for_same_input():
    h1 = compute_content_hash(type_="job", organization="Acme Corp", title="Senior Engineer", source="rss:test")
    h2 = compute_content_hash(type_="job", organization="Acme Corp", title="Senior Engineer", source="rss:test")
    assert h1 == h2


def test_content_hash_ignores_case_and_punctuation():
    h1 = compute_content_hash(type_="job", organization="Acme Corp!", title="Senior Engineer, Backend", source="rss:test")
    h2 = compute_content_hash(type_="job", organization="acme corp", title="senior engineer backend", source="rss:test")
    assert h1 == h2


def test_content_hash_differs_by_source():
    h1 = compute_content_hash(type_="job", organization="Acme Corp", title="Senior Engineer", source="rss:site_a")
    h2 = compute_content_hash(type_="job", organization="Acme Corp", title="Senior Engineer", source="rss:site_b")
    assert h1 != h2


def test_content_hash_differs_by_type():
    h1 = compute_content_hash(type_="job", organization="Acme Corp", title="Senior Engineer", source="rss:test")
    h2 = compute_content_hash(type_="grant", organization="Acme Corp", title="Senior Engineer", source="rss:test")
    assert h1 != h2
