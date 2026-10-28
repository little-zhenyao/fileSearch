import pytest

from conftest import import_bytes, pdf_bytes


@pytest.mark.parametrize('same_size', [False, True])
def test_reimport_repairs_corrupt_shared_copy_without_losing_index(client, app, course, same_size):
    original = pdf_bytes('Repairable source text.')
    imported = import_bytes(client, app, course, [('lecture.pdf', original)])
    document_id = imported['items'][0]['document_id']
    with app.state.library.db.connect() as conn:
        blob = conn.execute('SELECT blob FROM documents WHERE id=?', (document_id,)).fetchone()[0]
    copy = app.state.library.db.root / 'files' / blob
    copy.write_bytes(b'x' * len(original) if same_size else b'broken')
    report = client.post('/api/preflight', json={'course_id': course}).json()
    assert report['blockers']

    retried = import_bytes(client, app, course, [('lecture.pdf', original)])
    assert retried['items'][0]['status'] == 'duplicate'
    assert copy.read_bytes() == original
    assert retried['items'][0]['document_id'] == document_id
    assert len(client.get('/api/documents').json()) == 1
    assert client.get('/api/search', params={'q': 'Repairable'}).json()['total_documents'] == 1
    report = client.post('/api/preflight', json={'course_id': course}).json()
    assert not report['blockers']
