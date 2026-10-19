import io
import json
from pathlib import Path

import pymupdf
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.parsers import parse_pdf
from conftest import docx_bytes, import_bytes, pdf_bytes


def test_batch_status_and_isolation(client, app, course):
    encrypted = pymupdf.open(stream=pdf_bytes(), filetype='pdf')
    protected = encrypted.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='secret')
    encrypted.close()
    blank = pymupdf.open(); blank.new_page(); blank_bytes = blank.tobytes(); blank.close()
    job = import_bytes(client, app, course, [
        ('good.pdf', pdf_bytes(blank=True)), ('notes.docx', docx_bytes()),
        ('scan.pdf', blank_bytes), ('encrypted.pdf', protected), ('broken.pdf', b'invalid PDF'), ('ignore.txt', b'hello'),
    ])
    assert [item['status'] for item in job['items']] == ['partial','ready','no_text','password_required','failed','unsupported']
    assert job['done'] and job['completed'] == 6
    assert client.get('/api/search', params={'q': 'deadlock'}).json()['total_documents'] == 2


def test_duplicate_and_explicit_atomic_replacement(client, app, course):
    original = pdf_bytes('oldterm deadlock')
    first = import_bytes(client, app, course, [('folder/lecture.pdf', original)])
    original_doc = first['items'][0]['document_id']
    duplicate = import_bytes(client, app, course, [('copy.pdf', original)])
    assert duplicate['items'][0]['status'] == 'duplicate'
    assert len(client.get('/api/documents').json()) == 1
    changed = import_bytes(client, app, course, [('folder/lecture.pdf', pdf_bytes('newterm deadlock'))])
    item = changed['items'][0]
    assert item['status'] == 'conflict'
    assert client.get('/api/search', params={'q': 'oldterm'}).json()['total_hits'] == 1
    endpoint = f"/api/import-jobs/{changed['id']}/items/{item['id']}/retry"
    assert client.post(endpoint, json={}).status_code == 400
    assert client.post(endpoint, json={'replace_existing': True}).status_code == 202
    app.state.library.process_next()
    assert client.get('/api/search', params={'q': 'oldterm'}).json()['total_hits'] == 0
    assert client.get('/api/search', params={'q': 'newterm'}).json()['total_hits'] == 1
    doc = client.get('/api/documents').json()[0]
    assert doc['id'] == original_doc and doc['version'] == 2
    assert client.get(f'/api/documents/{original_doc}/content?version=1').status_code == 409


def test_failed_replacement_preserves_previous_index(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes('survivingterm'))])
    failed = import_bytes(client, app, course, [('a.pdf', b'broken')])
    item = failed['items'][0]
    client.post(f"/api/import-jobs/{failed['id']}/items/{item['id']}/retry", json={'replace_existing': True})
    app.state.library.process_next()
    assert client.get('/api/search', params={'q': 'survivingterm'}).json()['total_hits'] == 1
    assert client.get('/api/documents').json()[0]['version'] == 1


def test_docx_table_anchors_and_preview(client, app, course):
    import_bytes(client, app, course, [('summary.docx', docx_bytes())])
    group = client.get('/api/search', params={'q': 'indefinite blocking', 'mode': 'phrase'}).json()['groups'][0]
    hit = group['hits'][0]
    unit = client.get(f"/api/documents/{group['document_id']}/units/{hit['unit_id']}", params={'q': 'indefinite blocking', 'mode': 'phrase'}).json()
    assert unit['anchor']['type'] == 'cell'
    assert unit['anchor']['row'] == 1 and unit['anchor']['column'] == 1
    assert unit['text'][unit['ranges'][0][0]:unit['ranges'][0][1]] == 'Indefinite blocking'
    preview = client.get(f"/api/documents/{group['document_id']}/content").json()
    assert preview['units'][0]['text'] == 'Operating Systems 操作系统'
    assert all('page' not in unit['anchor'] for unit in preview['units'])


def test_pdf_native_coordinates_for_crop_and_rotation(tmp_path):
    for rotation in (0, 90, 180, 270):
        pdf = pymupdf.open(); page = pdf.new_page(width=600, height=800)
        page.insert_text((100, 150), 'deadlock', fontsize=14)
        original_bbox = page.search_for('deadlock')[0]
        page.set_cropbox(pymupdf.Rect(40, 60, 560, 740)); page.set_rotation(rotation)
        path = tmp_path / f'crop-{rotation}.pdf'; pdf.save(path); pdf.close()
        units, _ = parse_pdf(path)
        rects = [rect for rect in units[0]['anchor']['boxes'] if rect]
        # PDF user space has its origin at the bottom left of the media box.
        assert abs(min(rect[0] for rect in rects) - original_bbox.x0) < .01
        assert abs(min(rect[1] for rect in rects) - (800 - original_bbox.y1)) < .01
        assert abs(max(rect[3] for rect in rects) - (800 - original_bbox.y0)) < .01


def test_pdf_endpoint_has_per_occurrence_rectangles(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    group = client.get('/api/search', params={'q': 'deadlock'}).json()['groups'][0]
    hit = group['hits'][0]
    unit = client.get(f"/api/documents/{group['document_id']}/units/{hit['unit_id']}", params={'q': 'deadlock'}).json()
    assert len(unit['ranges']) == 2
    assert len(unit['rectangles']) == 2
    assert all(len(rects) >= 1 for rects in unit['rectangles'])
    content = client.get(f"/api/documents/{group['document_id']}/content")
    assert content.headers['content-type'] == 'application/pdf'
    assert content.content.startswith(b'%PDF')


def test_rebuild_removes_old_unit_ids(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    group = client.get('/api/search', params={'q': 'deadlock'}).json()['groups'][0]
    old = group['hits'][0]['unit_id']
    response = client.post(f"/api/documents/{group['document_id']}/rebuild")
    assert response.status_code == 202
    app.state.library.process_next()
    assert client.get(f"/api/documents/{group['document_id']}/units/{old}").status_code == 404
    assert client.get('/api/search', params={'q': 'deadlock'}).json()['total_hits'] == 2


def test_restart_recovers_processing_items(tmp_path):
    config = tmp_path / 'config.json'; root = tmp_path / 'library'
    app = create_app(config_path=config, library_path=root, start_worker=False)
    with TestClient(app, headers={'X-Local-Request': '1'}) as client:
        course = client.post('/api/courses', json={'name': 'Restart'}).json()['id']
        response = client.post('/api/import-jobs', data={'course_id': course, 'paths': '["a.pdf"]'}, files={'files': ('a.pdf', pdf_bytes())})
        job_id = response.json()['job_id']
        with app.state.library.db.connect() as conn:
            conn.execute("UPDATE job_items SET status='processing'")
    app2 = create_app(config_path=config, library_path=root)
    with TestClient(app2) as client:
        import time
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if client.get('/api/import-jobs/' + job_id).json()['done']:
                break
            time.sleep(.02)
        assert client.get('/api/search', params={'q': 'deadlock'}).json()['total_hits'] == 2


def test_setup_and_local_request_protection(tmp_path):
    config = tmp_path / 'config.json'
    with TestClient(create_app(config_path=config, start_worker=False)) as client:
        assert not client.get('/api/settings').json()['configured']
        assert client.get('/api/courses').status_code == 409
        assert client.post('/api/settings', json={'library_path': str(tmp_path/'lib')}).status_code == 403
        headers = {'X-Local-Request': '1'}
        assert client.post('/api/settings', json={'library_path': str(tmp_path/'lib')}, headers={**headers, 'Origin':'https://malicious.example'}).status_code == 403
        assert client.post('/api/settings', json={'library_path': str(tmp_path/'lib')}, headers=headers).status_code == 200
        assert config.exists()
        assert client.post('/api/settings', json={'library_path': str(tmp_path/'other')}, headers=headers).status_code == 409
    with TestClient(create_app(config_path=config, start_worker=False)) as client:
        assert client.get('/api/settings').json()['configured']


def test_invalid_paths_never_escape_library(client, course):
    for path in ('../escape.pdf', '/tmp/escape.pdf', 'folder/../../escape.pdf', 'C:\\escape.pdf'):
        response = client.post('/api/import-jobs', data={'course_id': course, 'paths': json.dumps([path])}, files={'files': ('a.pdf', pdf_bytes())})
        assert response.status_code == 400
    assert client.get('/api/documents/not-found/content').status_code == 404
    assert client.get('/api/health', headers={'host': 'external.example'}).status_code == 400
