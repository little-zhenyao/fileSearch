import json

import pytest

from backend.text import Query, compact_mapping, normalize
from conftest import docx_bytes, import_bytes, pdf_bytes


@pytest.mark.parametrize('query,mode,expected', [
    ('DEADLOCK', 'all', 2), ('deadlocks', 'all', 1), ('dead', 'all', 0),
    ('mutual exclusion', 'phrase', 1), ('mutual Deadlock', 'all', 3),
    ('mutual missing', 'all', 0), ('deadlock missing', 'any', 2),
    ('exclusion Deadlock', 'phrase', 0), ('deadlock" OR *', 'all', 0),
])
def test_english_search(client, app, course, query, mode, expected):
    import_bytes(client, app, course, [('lecture.pdf', pdf_bytes())])
    result = client.get('/api/search', params={'q': query, 'mode': mode})
    assert result.status_code == 200, result.text
    assert result.json()['total_hits'] == expected


@pytest.mark.parametrize('query,mode,expected', [
    ('死', 'all', 1), ('死锁', 'all', 1), ('资源等待', 'all', 2),
    ('死锁 deadlock', 'all', 2), ('死锁 Starvation', 'all', 0),
    ('死锁 Starvation', 'any', 2), ('死锁与资源', 'phrase', 1),
    ('不存在', 'all', 0), ('中文', 'all', 1),
])
def test_chinese_and_mixed_search(client, app, course, query, mode, expected):
    import_bytes(client, app, course, [('summary.docx', docx_bytes())])
    result = client.get('/api/search', params={'q': query, 'mode': mode})
    assert result.status_code == 200, result.text
    assert result.json()['total_hits'] == expected


def test_normalization_and_offsets():
    source = '😀 A ﬃ cafe\u0301 dead-\nlock\tmutual  exclusion soft\u00adhyphen'
    text, mapping = normalize(source)
    assert text == '😀 a ffi café deadlock mutual exclusion softhyphen'
    for query, expected in [('ffi', 'ﬃ'), ('café', 'cafe\u0301'), ('deadlock', 'dead-\nlock'),
                            ('mutual exclusion', 'mutual  exclusion'), ('softhyphen', 'soft\u00adhyphen')]:
        ranges = Query.parse(query, 'phrase').matches(text, mapping)
        assert len(ranges) == 1
        assert source[ranges[0][0]:ranges[0][1]] == expected
        assert Query.parse(query, 'phrase').matches(text, compact_mapping(mapping)) == ranges


def test_per_document_unit_pagination(client, app, course):
    from docx import Document
    import io
    document = Document()
    for index in range(45):
        document.add_paragraph(f'Deadlock example {index}')
    stream = io.BytesIO(); document.save(stream)
    import_bytes(client, app, course, [('long.docx', stream.getvalue())])
    params = {'q': 'deadlock'}
    result = client.get('/api/search', params=params).json()
    group = result['groups'][0]
    assert group['unit_total'] == 45 and group['next_unit_offset'] == 20
    seen = [hit['unit_id'] for hit in group['hits']]
    for offset, expected_next in [(20, 40), (40, None)]:
        part = client.get('/api/search', params={**params, 'document_id':group['document_id'], 'unit_offset':offset}).json()['groups'][0]
        seen.extend(hit['unit_id'] for hit in part['hits'])
        assert part['next_unit_offset'] == expected_next
    assert len(seen) == len(set(seen)) == 45


def test_scope_category_and_no_cross_unit_phrase(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes('mutual'))])
    second = client.post('/api/courses', json={'name': 'CS Other'}).json()['id']
    import_bytes(client, app, second, [('b.docx', docx_bytes('exclusion'))])
    assert client.get('/api/search', params={'q': 'mutual exclusion', 'mode': 'phrase'}).json()['total_hits'] == 0
    result = client.get('/api/search', params={'q': 'mutual', 'course_id': course}).json()
    doc_id = result['groups'][0]['document_id']
    assert client.patch('/api/documents/' + doc_id, json={'category': 'Lecture'}).status_code == 200
    assert client.get('/api/search', params={'q': 'mutual', 'category': 'Summary'}).json()['total_hits'] == 0
    assert client.get('/api/search', params={'q': 'mutual', 'category': 'Lecture'}).json()['total_hits'] == 1


def test_document_pagination_and_unit_pagination(client, app, course):
    import_bytes(client, app, course, [(f'{i}.pdf', pdf_bytes(f'Deadlock definition number {i}')) for i in range(4)])
    first = client.get('/api/search', params={'q': 'deadlock', 'limit': 2}).json()
    second = client.get('/api/search', params={'q': 'deadlock', 'limit': 2, 'offset': first['next_offset']}).json()
    assert first['total_documents'] == 4
    assert not set(g['document_id'] for g in first['groups']) & set(g['document_id'] for g in second['groups'])
    assert second['next_offset'] is None


def test_short_query_any_cannot_be_restricted_to_fts_candidates(client, app, course):
    import_bytes(client, app, course, [('a.docx', docx_bytes('死锁。')), ('b.pdf', pdf_bytes('deadlock'))])
    result = client.get('/api/search', params={'q': '死锁 deadlock', 'mode': 'any'}).json()
    assert result['total_documents'] == 2


def test_empty_and_invalid_query(client):
    assert client.get('/api/search', params={'q': '***'}).status_code == 400
    assert client.get('/api/search', params={'q': 'deadlock', 'mode': 'sql'}).status_code == 422
    assert client.get('/api/search', params={'q': 'a', 'offset': -1}).status_code == 422
