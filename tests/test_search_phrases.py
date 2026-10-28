"""Multiword equivalence groups must compose with the other query terms."""
import pytest

from conftest import import_bytes, pdf_bytes


@pytest.mark.parametrize('mode,expected', [
    ('all', {'expanded.pdf', 'original.pdf'}),
    ('any', {'expanded.pdf', 'original.pdf', 'phrase-only.pdf', 'single-word.pdf'}),
])
def test_registered_phrase_in_longer_query_and_reader_agree(client, app, course, mode, expected):
    assert client.put('/api/vocabulary', json=[
        {'kind': 'synonym', 'terms': ['mutual exclusion', 'mutex']},
    ]).status_code == 200
    import_bytes(client, app, course, [
        ('expanded.pdf', pdf_bytes('Mutex resource.')),
        ('original.pdf', pdf_bytes('Mutual exclusion resource.')),
        ('phrase-only.pdf', pdf_bytes('Mutex.')),
        ('single-word.pdf', pdf_bytes('Mutual example.')),
    ])
    params = {'q': 'mutual exclusion resource', 'mode': mode, 'expand': True}
    response = client.get('/api/search', params=params)
    assert response.status_code == 200, response.text
    result = response.json()
    assert {group['name'] for group in result['groups']} == expected
    assert {'term': 'mutex', 'source': 'synonym'} in result['expansions']
    original = next(group for group in result['groups'] if group['name'] == 'original.pdf')
    assert original['hit_count'] == 3  # No extra hit for the original multiword phrase.
    expanded = next(group for group in result['groups'] if group['name'] == 'expanded.pdf')
    hit = expanded['hits'][0]
    assert {'term': 'mutex', 'source': 'synonym', 'range': [0, 5]} in hit['matches']
    located = client.get(f"/api/documents/{expanded['document_id']}/units/{hit['unit_id']}", params=params).json()
    assert located['ranges'] == hit['ranges']
    assert located['matches'] == hit['matches']
    exact = client.get('/api/search', params={**params, 'expand': False}).json()
    assert 'phrase-only.pdf' not in {group['name'] for group in exact['groups']}
    if mode == 'all':
        assert 'expanded.pdf' not in {group['name'] for group in exact['groups']}
    phrase = client.get('/api/search', params={**params, 'mode': 'phrase'}).json()
    assert {group['name'] for group in phrase['groups']} == {'original.pdf'}


def test_adjacent_and_overlapping_phrases_use_complete_nonoverlapping_covers(client, app, course):
    assert client.put('/api/vocabulary', json=[
        {'kind': 'synonym', 'terms': ['alpha beta', 'first']},
        {'kind': 'synonym', 'terms': ['beta gamma', 'middle']},
        {'kind': 'synonym', 'terms': ['gamma delta', 'last']},
    ]).status_code == 200
    texts = {
        'adjacent.pdf': 'first last',
        'overlap.pdf': 'alpha middle delta',
        'prefix.pdf': 'first gamma delta',
        'suffix.pdf': 'alpha beta last',
        'original.pdf': 'alpha beta gamma delta',
        'incomplete-left.pdf': 'first middle',
        'incomplete-right.pdf': 'middle last',
    }
    import_bytes(client, app, course, [(name, pdf_bytes(text)) for name, text in texts.items()])
    result = client.get('/api/search', params={'q': 'alpha beta gamma delta', 'expand': True}).json()
    assert {group['name'] for group in result['groups']} == {
        'adjacent.pdf', 'overlap.pdf', 'prefix.pdf', 'suffix.pdf', 'original.pdf',
    }


def test_phrase_expansion_in_all_courses_respects_course_dictionary(client, app, course):
    other = client.post('/api/courses', json={'name': 'Other course'}).json()['id']
    assert client.put('/api/vocabulary', json=[
        {'kind': 'synonym', 'terms': ['mutual exclusion', 'mutex'], 'course_id': course},
    ]).status_code == 200
    for course_id in [course, other]:
        import_bytes(client, app, course_id, [('a.pdf', pdf_bytes('Mutex resource.'))])
    params = {'q': 'mutual exclusion resource', 'expand': True}
    result = client.get('/api/search', params=params).json()
    assert len(result['groups']) == 1
    assert result['groups'][0]['course_id'] == course
    assert client.get('/api/search', params={**params, 'course_id': other}).json()['total_documents'] == 0
