from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.db import Database, SCHEMA
from backend.library import Library
from conftest import docx_bytes, import_bytes, pdf_bytes


def first_doc(client):
    return client.get('/api/documents').json()[0]


def position(doc, **changes):
    return {'document_id': doc['id'], 'content_hash': doc['content_hash'], 'page': 1, **changes}


def check(client, course=None):
    result = client.post('/api/preflight', json={'course_id': course})
    assert result.status_code == 200, result.text
    return result.json()


def enter(client, report, ack=False):
    return client.post('/api/exam/enter', json={'report_id': report['id'], 'acknowledge_warnings': ack})


def test_v1_migration_backup_and_idempotence(tmp_path):
    root = tmp_path / 'library'; root.mkdir()
    with sqlite3.connect(root / 'library.sqlite3') as conn:
        conn.executescript(SCHEMA)
        conn.execute("INSERT INTO courses VALUES ('c','Original course','date')")
    Database(root)
    backups = list((root / 'backups').glob('*.sqlite3'))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 1
        assert conn.execute('SELECT name FROM courses').fetchone()[0] == 'Original course'
    with Database(root).connect() as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 2
        assert conn.execute('SELECT count(*) FROM vocabulary').fetchone()[0] > 0
        assert conn.execute('SELECT id FROM courses').fetchone()[0] == 'c'
    assert len(list((root / 'backups').glob('*.sqlite3'))) == 1


def test_failed_migration_rolls_back(tmp_path, monkeypatch):
    import backend.db as module
    root = tmp_path / 'library'; root.mkdir()
    with sqlite3.connect(root / 'library.sqlite3') as conn:
        conn.executescript(SCHEMA)
    monkeypatch.setattr(module, 'V2_SCHEMA', module.V2_SCHEMA + '\nINVALID SQL;')
    with pytest.raises(sqlite3.Error):
        Database(root)
    with sqlite3.connect(root / 'library.sqlite3') as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 1
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='bookmarks'").fetchone()


def test_future_database_is_rejected(tmp_path):
    root = tmp_path / 'library'; root.mkdir()
    with sqlite3.connect(root / 'library.sqlite3') as conn:
        conn.execute('PRAGMA user_version=99')
    with pytest.raises(RuntimeError):
        Database(root)


def test_bookmark_survives_rebuild_but_requires_rebind_after_replacement(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    doc = first_doc(client)
    saved = client.post('/api/bookmarks', json={'position': position(doc), 'note': 'review this', 'tags': [' OS ', 'OS', 'exam']})
    assert saved.status_code == 201, saved.text
    bookmark_id = saved.json()['id']
    old = client.get('/api/bookmarks').json()[0]
    assert old['tags'] == ['OS', 'exam'] and old['position']['text_hash']
    client.post(f"/api/documents/{doc['id']}/rebuild")
    app.state.library.process_next()
    resolved = client.post('/api/positions/resolve', json=old['position']).json()
    assert resolved['status'] == 'resolved'
    assert resolved['position']['unit_id'] != old['position']['unit_id']
    assert resolved['position']['version'] == 2
    assert client.get('/api/bookmarks', params={'course_id': course, 'tag': 'OS', 'q': 'review'}).json()[0]['id'] == bookmark_id
    assert client.get('/api/bookmarks', params={'tag': 'wrong'}).json() == []
    job = import_bytes(client, app, course, [('a.pdf', pdf_bytes('new content'))])
    item = job['items'][0]
    client.post(f"/api/import-jobs/{job['id']}/items/{item['id']}/retry", json={'replace_existing': True})
    app.state.library.process_next()
    stale = client.get('/api/bookmarks').json()[0]
    assert stale['status'] == 'stale' and stale['note'] == 'review this'
    assert client.post('/api/positions/resolve', json=old['position']).json()['status'] == 'stale'
    assert client.post('/api/bookmarks', json={'position': position(doc)}).status_code == 400
    doc = first_doc(client)
    assert client.patch(f'/api/bookmarks/{bookmark_id}', json={'position': position(doc), 'note': 'rebound', 'tags': ['new']}).status_code == 200
    assert client.get('/api/bookmarks').json()[0]['status'] == 'resolved'
    assert client.delete(f'/api/bookmarks/{bookmark_id}').status_code == 200
    assert client.get('/api/bookmarks').json() == []


def test_docx_structural_position_and_fingerprint(client, app, course):
    import_bytes(client, app, course, [('a.docx', docx_bytes())])
    doc = first_doc(client)
    units = client.get(f"/api/documents/{doc['id']}/content").json()['units']
    table_cell = next(unit for unit in units if unit['anchor']['type'] == 'cell')
    captured = client.post('/api/positions/capture', json=position(doc, page=None, key=table_cell['anchor']['key'])).json()
    assert captured['key'] == table_cell['anchor']['key']
    assert captured['unit_id'] == table_cell['unit_id']
    captured['text_hash'] = 'wrong'
    assert client.post('/api/positions/resolve', json=captured).json()['status'] == 'stale'


def test_history_dedup_and_workspace_persist_across_restart(tmp_path):
    root = tmp_path / 'library'
    app = create_app(library_path=root, start_worker=False)
    with TestClient(app, headers={'X-Local-Request': '1'}) as client:
        for query in ['alpha', 'beta', 'alpha']:
            assert client.post('/api/history', json={'query': query, 'mode': 'all', 'expand': True}).status_code == 200
        assert [row['context']['query'] for row in client.get('/api/history').json()] == ['alpha', 'beta']
        assert client.put('/api/workspace', json={'panes': [{'back': [1]}, {}], 'active': 1}).status_code == 200
    with TestClient(create_app(library_path=root, start_worker=False), headers={'X-Local-Request': '1'}) as client:
        assert client.get('/api/workspace').json()['active'] == 1
        assert len(client.get('/api/history').json()) == 2
        client.delete('/api/history')
        assert client.get('/api/history').json() == []


def test_history_has_bounded_retention(client):
    for i in range(105):
        client.post('/api/history', json={'query': str(i)})
    history = client.get('/api/history').json()
    assert len(history) == 100 and history[0]['context']['query'] == '104'


def test_expansion_is_opt_in_and_reader_ranges_agree(client, app, course):
    import_bytes(client, app, course, [('exact.pdf', pdf_bytes('Deadlock.')), ('forms.pdf', pdf_bytes('Deadlocks.')), ('synonym.pdf', pdf_bytes('Indefinite blocking.'))])
    assert client.get('/api/search', params={'q': 'deadlock'}).json()['total_hits'] == 1
    expanded = client.get('/api/search', params={'q': 'deadlock', 'expand': True}).json()
    assert expanded['total_hits'] == 2
    assert expanded['groups'][0]['name'] == 'exact.pdf'
    hit = expanded['groups'][1]['hits'][0]
    assert hit['matches'][0]['source'] == 'form'
    doc_id = expanded['groups'][1]['document_id']
    located = client.get(f"/api/documents/{doc_id}/units/{hit['unit_id']}", params={'q': 'deadlock', 'expand': True}).json()
    assert located['ranges'] == hit['ranges'] and located['matches'] == hit['matches']
    synonym = client.get('/api/search', params={'q': 'starvation', 'expand': True}).json()
    assert synonym['total_hits'] == 1 and synonym['groups'][0]['hits'][0]['matches'][0]['term'] == 'indefinite blocking'


@pytest.mark.parametrize('q,mode,total', [('starvation missing', 'all', 0), ('starvation missing', 'any', 1), ('indefinite blocking', 'phrase', 1), ('deadlock', 'phrase', 0)])
def test_expanded_boolean_and_phrase_rules(client, app, course, q, mode, total):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes('Starvation and deadlocks.'))])
    result = client.get('/api/search', params={'q': q, 'mode': mode, 'expand': True}).json()
    assert result['total_hits'] == total


def test_nonrecursive_and_course_specific_vocabulary(client, app, course):
    other = client.post('/api/courses', json={'name': 'Other'}).json()['id']
    for course_id, name in [(course, 'a.pdf'), (other, 'b.pdf')]:
        import_bytes(client, app, course_id, [(name, pdf_bytes('beta gamma'))])
    entries = [{'kind': 'synonym', 'terms': ['alpha', 'beta'], 'course_id': course},
               {'kind': 'synonym', 'terms': ['beta', 'gamma'], 'course_id': None}]
    assert client.put('/api/vocabulary', json=entries).status_code == 200
    result = client.get('/api/search', params={'q': 'alpha', 'expand': True}).json()
    assert result['total_documents'] == 1 and result['groups'][0]['course_id'] == course
    assert result['total_hits'] == 1
    assert [item['term'] for item in result['expansions']] == ['beta']
    hit = result['groups'][0]['hits'][0]
    assert client.get(f"/api/documents/{result['groups'][0]['document_id']}/units/{hit['unit_id']}", params={'q': 'alpha', 'expand': True}).json()['ranges'] == hit['ranges']


def test_expansion_pagination_and_category_sort(client, app, course):
    import_bytes(client, app, course, [(f'{i}.pdf', pdf_bytes('Deadlocks.')) for i in range(3)])
    docs = client.get('/api/documents').json()
    client.patch(f"/api/documents/{docs[2]['id']}", json={'category': 'Summary'})
    params = {'q': 'deadlock', 'expand': True, 'sort': 'category', 'limit': 1}
    first = client.get('/api/search', params=params).json()
    assert first['groups'][0]['document_id'] == docs[2]['id']
    second = client.get('/api/search', params={**params, 'offset': first['next_offset']}).json()
    assert second['groups'][0]['document_id'] != first['groups'][0]['document_id']
    assert second['total_documents'] == 3


def test_preferences_and_vocabulary_validation_is_atomic(client):
    previous = client.get('/api/preferences').json()
    invalid = {**previous, 'category_order': ['Summary'] * 4}
    assert client.put('/api/preferences', json=invalid).status_code == 422
    assert client.get('/api/preferences').json() == previous
    vocabulary = client.get('/api/vocabulary').json()
    assert client.put('/api/vocabulary', json=[{'kind': 'synonym', 'terms': ['A', 'a']}]).status_code == 400
    assert client.get('/api/vocabulary').json() == vocabulary


def test_exam_freeze_is_enforced_by_api_and_survives_restart(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    doc = first_doc(client)
    report = check(client, course)
    assert report['blockers'] == [] and report['warnings'] == []
    assert enter(client, report).status_code == 200
    assert client.post('/api/courses', json={'name': 'Blocked'}).status_code == 409
    assert client.patch(f"/api/documents/{doc['id']}", json={'category': 'Summary'}).status_code == 409
    assert client.post(f"/api/documents/{doc['id']}/rebuild").status_code == 409
    assert client.put('/api/vocabulary', json=[]).status_code == 409
    assert client.put('/api/preferences', json=client.get('/api/preferences').json()).status_code == 409
    assert client.post('/api/import-jobs', data={'course_id': course, 'paths': '["b.pdf"]'}, files=[('files', ('b.pdf', pdf_bytes()))]).status_code == 409
    assert client.get('/api/search', params={'q': 'deadlock'}).json()['total_hits'] == 2
    assert client.post('/api/history', json={'query': 'deadlock'}).status_code == 200
    assert client.post('/api/bookmarks', json={'position': position(doc), 'note': 'still writable'}).status_code == 201
    assert client.put('/api/workspace', json={'active': 0}).status_code == 200
    with TestClient(create_app(library_path=app.state.library.db.root, start_worker=False), headers={'X-Local-Request': '1'}) as restarted:
        assert restarted.get('/api/exam').json()['active'] is True
        assert restarted.post(f"/api/documents/{doc['id']}/rebuild").status_code == 409
        assert restarted.post('/api/exam/exit').json()['active'] is False
    assert client.patch(f"/api/documents/{doc['id']}", json={'category': 'Summary'}).status_code == 200


def test_exam_warns_for_scanned_pages_and_requires_ack(client, app, course):
    import_bytes(client, app, course, [('partial.pdf', pdf_bytes(blank=True))])
    report = check(client)
    assert not report['blockers'] and report['warnings']
    assert enter(client, report).status_code == 409
    assert enter(client, report, True).status_code == 200


@pytest.mark.parametrize('damage', ['missing', 'hash', 'index', 'fts', 'anchor'])
def test_preflight_detects_copied_file_and_index_damage(client, app, course, damage):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    with app.state.library.db.connect() as conn:
        doc = conn.execute('SELECT * FROM documents').fetchone()
        if damage == 'missing':
            (app.state.library.db.root / 'files' / doc['blob']).unlink()
        elif damage == 'hash':
            (app.state.library.db.root / 'files' / doc['blob']).write_bytes(pdf_bytes('changed outside app'))
        elif damage == 'index':
            conn.execute("UPDATE units SET text='bad'")
        elif damage == 'fts':
            conn.execute('DELETE FROM units_fts')
        else:
            conn.execute("UPDATE units SET anchor='{}'")
    report = check(client)
    assert report['blockers'] and enter(client, report, True).status_code == 409


def test_stale_preflight_and_pending_jobs_cannot_enter(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    report = check(client)
    doc = first_doc(client)
    client.patch(f"/api/documents/{doc['id']}", json={'category': 'Summary'})
    assert enter(client, report).status_code == 409
    report = check(client)
    client.post(f"/api/documents/{doc['id']}/rebuild")
    assert enter(client, report).status_code == 409
    assert any('任务' in issue['name'] for issue in check(client)['blockers'])
    app.state.library.process_next()
    assert client.get('/api/preflight').json()['stale']


def test_import_issue_exclusion_and_successful_retry_clear_blocker(client, app, course):
    import_bytes(client, app, course, [('good.pdf', pdf_bytes()), ('broken.pdf', b'broken')])
    report = check(client)
    issue = next(item for item in report['blockers'] if item.get('item_id'))
    route = f"/api/import-jobs/{issue['job_id']}/items/{issue['item_id']}"
    assert client.post(route + '/dismiss').status_code == 200
    assert not check(client)['blockers']
    client.post(route + '/retry', json={})
    app.state.library.process_next()
    # Explicit retry should make the failure actionable again.
    assert check(client)['blockers']


def test_enter_and_new_job_are_serialized(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    doc = first_doc(client); report = check(client)
    def freeze():
        return enter(client, report).status_code
    def rebuild():
        return client.post(f"/api/documents/{doc['id']}/rebuild").status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(freeze); b = pool.submit(rebuild)
        frozen, queued = a.result(), b.result()
    assert (frozen, queued) in ((200, 409), (409, 202))


def test_viewport_and_active_hit_are_distinct_and_rebuildable(client, app, course):
    import_bytes(client, app, course, [('a.docx', docx_bytes())])
    doc = first_doc(client)
    units = client.get(f"/api/documents/{doc['id']}/content").json()['units']
    paragraph = next(unit for unit in units if unit['anchor']['key'] == 'p2')
    cell = next(unit for unit in units if 'Indefinite' in unit['text'])
    raw = position(doc, page=None, key=paragraph['anchor']['key'], hit_key=cell['anchor']['key'], hit_unit_id=cell['unit_id'])
    state = {'panes': [{'current': {'id': 'visit', 'documentId': doc['id'], 'position': raw, 'hit': {'snippet': 'do not persist search payload'}}}, {}]}
    saved = client.put('/api/workspace', json=state).json()['panes'][0]['current']
    assert 'hit' not in saved
    assert saved['position']['text_hash'] and saved['position']['hit_text_hash']
    assert saved['position']['key'] == 'p2'
    assert saved['position']['hit_key'] == cell['anchor']['key']
    client.post(f"/api/documents/{doc['id']}/rebuild")
    app.state.library.process_next()
    resolved = client.post('/api/positions/resolve', json=saved['position']).json()
    assert resolved['status'] == 'resolved'
    assert resolved['position']['unit_id'] != paragraph['unit_id']
    assert resolved['position']['hit_unit_id'] != cell['unit_id']
    assert resolved['position']['key'] == 'p2'


def test_preflight_marks_preference_changes_stale(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    report = check(client)
    prefs = client.get('/api/preferences').json()
    prefs['category_order'].reverse()
    client.put('/api/preferences', json=prefs)
    assert client.get('/api/preflight').json()['stale']
    assert enter(client, report).status_code == 409


def test_changed_vocabulary_cannot_silently_change_old_hit_highlights(client, app, course):
    import_bytes(client, app, course, [('a.pdf', pdf_bytes('Deadlocks.'))])
    result = client.get('/api/search', params={'q': 'deadlock', 'expand': True}).json()
    group = result['groups'][0]; hit = group['hits'][0]
    params = {'q': 'deadlock', 'expand': True, 'lexicon_version': hit['lexicon_version']}
    route = f"/api/documents/{group['document_id']}/units/{hit['unit_id']}"
    assert client.get(route, params=params).json()['ranges'] == hit['ranges']
    client.put('/api/vocabulary', json=[])
    assert client.get(route, params=params).status_code == 409
    assert not client.get('/api/search', params={'q': 'deadlock', 'expand': True}).json()['groups']


def test_exam_entering_during_upload_leaves_no_library_side_effects(client, app, course):
    import asyncio
    from backend.db import FrozenLibrary
    from backend.exam import Exam
    import_bytes(client, app, course, [('a.pdf', pdf_bytes())])
    report = check(client)
    lib = app.state.library
    previous_blobs = {path.name for path in (lib.db.root / 'files').iterdir()}
    previous_jobs = client.get('/api/import-jobs').json()

    class SlowUpload:
        finished = False
        async def read(self, _size):
            if self.finished:
                return b''
            self.finished = True
            Exam(lib).enter(report['id'], False)
            return pdf_bytes('upload overlapping exam entry')
        async def close(self):
            pass

    with pytest.raises(FrozenLibrary):
        asyncio.run(lib.import_files(course, [SlowUpload()], ['new.pdf']))
    assert {path.name for path in (lib.db.root / 'files').iterdir()} == previous_blobs
    assert client.get('/api/import-jobs').json() == previous_jobs


def test_existing_v1_files_units_and_fts_survive_upgrade(tmp_path):
    import hashlib
    from backend.parsers import parse_pdf
    from backend.text import compact_mapping, normalize
    root = tmp_path / 'v1-library'; (root / 'files').mkdir(parents=True)
    data = pdf_bytes('Deadlock from the original V1 library.')
    digest = hashlib.sha256(data).hexdigest(); blob = digest + '.pdf'
    source = root / 'files' / blob; source.write_bytes(data)
    unit = parse_pdf(source)[0][0]
    normalized, mapping = normalize(unit['text'])
    with sqlite3.connect(root / 'library.sqlite3') as conn:
        conn.executescript(SCHEMA)
        conn.execute("INSERT INTO courses VALUES ('original','V1 Course','2026-10-19')")
        conn.execute('''INSERT INTO documents
                        (id,course_id,name,relative_path,kind,content_hash,blob,status,
                         unit_count,searchable_count,size,created_at)
                        VALUES ('old-document','original','a.pdf','a.pdf','pdf',?,?,'ready',1,1,?,'2026-10-19')''',
                     (digest, blob, len(data)))
        conn.execute('INSERT INTO units VALUES (?,?,?,?,?,?,?,?)',
                     ('old-unit', 'old-document', 0, unit['label'], unit['text'], normalized,
                      json.dumps(compact_mapping(mapping)), json.dumps(unit['anchor'])))
    with TestClient(create_app(library_path=root, start_worker=False), headers={'X-Local-Request': '1'}) as upgraded:
        result = upgraded.get('/api/search', params={'q': 'deadlock'}).json()
        assert result['groups'][0]['document_id'] == 'old-document'
        assert result['groups'][0]['hits'][0]['unit_id'] == 'old-unit'
        assert upgraded.get('/api/documents/old-document/content').content == data
        assert upgraded.get('/api/documents/old-document/units/old-unit', params={'q': 'deadlock'}).json()['rectangles'][0]
        assert upgraded.post('/api/bookmarks', json={'position': {'document_id': 'old-document', 'content_hash': digest, 'page': 1}}).status_code == 201
