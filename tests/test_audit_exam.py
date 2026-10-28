"""Regression coverage for exam preparation and import attempt ordering."""

from conftest import import_bytes, pdf_bytes


def test_retry_of_older_import_failure_is_the_latest_actionable_attempt(client, app, course):
    failed = import_bytes(client, app, course, [('a.pdf', b'broken PDF')])
    failed_item = failed['items'][0]
    assert failed_item['status'] == 'failed'

    import_bytes(client, app, course, [('a.pdf', pdf_bytes('Usable replacement.'))])
    report = client.post('/api/preflight', json={'course_id': course}).json()
    assert not report['blockers']  # A later successful import resolved the original failure.

    endpoint = f"/api/import-jobs/{failed['id']}/items/{failed_item['id']}/retry"
    assert client.post(endpoint, json={'replace_existing': True}).status_code == 202
    assert client.get('/api/preflight', params={'course_id': course}).json()['stale']
    assert app.state.library.process_next()
    assert client.get('/api/import-jobs/' + failed['id']).json()['items'][0]['status'] == 'failed'
    assert client.get('/api/preflight', params={'course_id': course}).json()['stale']
    assert client.post('/api/exam/enter', json={'report_id': report['id']}).status_code == 409

    report = client.post('/api/preflight', json={'course_id': course}).json()
    assert any(issue.get('item_id') == failed_item['id'] for issue in report['blockers'])
    assert client.post('/api/exam/enter', json={'report_id': report['id']}).status_code == 409

    assert client.post(endpoint.removesuffix('/retry') + '/dismiss').status_code == 200
    assert not client.post('/api/preflight', json={'course_id': course}).json()['blockers']


def test_exam_freeze_also_blocks_retry_and_import_issue_dismissal(client, app, course):
    job = import_bytes(client, app, course, [('good.pdf', pdf_bytes()), ('broken.pdf', b'broken')])
    failed = next(item for item in job['items'] if item['status'] == 'failed')
    endpoint = f"/api/import-jobs/{job['id']}/items/{failed['id']}"
    assert client.post(endpoint + '/dismiss').status_code == 200
    report = client.post('/api/preflight', json={'course_id': course}).json()
    assert not report['blockers']
    assert client.post('/api/exam/enter', json={'report_id': report['id']}).status_code == 200
    assert client.post(endpoint + '/retry', json={}).status_code == 409
    assert client.post(endpoint + '/dismiss').status_code == 409


def test_preflight_does_not_hide_failure_with_success_from_another_course(client, app, course):
    first = import_bytes(client, app, course, [('good.pdf', pdf_bytes()), ('broken.pdf', b'broken')])
    failed = next(item for item in first['items'] if item['status'] == 'failed')
    other = client.post('/api/courses', json={'name': 'Another course'}).json()['id']
    import_bytes(client, app, other, [('broken.pdf', pdf_bytes('Successful but a different course.'))])
    report = client.post('/api/preflight', json={'course_id': course}).json()
    assert any(issue.get('item_id') == failed['id'] for issue in report['blockers'])
    other_report = client.post('/api/preflight', json={'course_id': other}).json()
    assert not other_report['blockers']
