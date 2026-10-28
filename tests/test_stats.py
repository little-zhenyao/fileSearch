from pathlib import Path

from backend.app import storage_bytes
from conftest import import_bytes, pdf_bytes


def test_storage_ignores_directories_and_disappearing_sqlite_files(tmp_path, monkeypatch):
    (tmp_path / 'copies').mkdir()
    (tmp_path / 'copies' / 'lecture.pdf').write_bytes(b'lecture')
    temporary = tmp_path / 'library.sqlite3-shm'
    temporary.write_bytes(b'temporary shared memory')
    original_stat = Path.stat

    def stat_after_sqlite_cleanup(path, *args, **kwargs):
        if path == temporary:
            raise FileNotFoundError(path)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'stat', stat_after_sqlite_cleanup)
    assert storage_bytes(tmp_path) == len(b'lecture')


def test_stats_remain_available_when_file_disappears(client, app, course, monkeypatch):
    import_bytes(client, app, course, [('lecture.pdf', pdf_bytes())])
    temporary = app.state.library.db.root / 'vanished-shm'
    temporary.write_bytes(b'temporary')
    original_stat = Path.stat
    temporary_reads = 0

    def stat_after_cleanup(path, *args, **kwargs):
        nonlocal temporary_reads
        if path == temporary:
            temporary_reads += 1
            # It existed during an is_file() check, but SQLite removed it
            # before the subsequent stat(). The old implementation crashed here.
            if temporary_reads > 1:
                raise FileNotFoundError(path)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'stat', stat_after_cleanup)
    for _ in range(5):
        temporary_reads = 0
        response = client.get('/api/stats')
        assert response.status_code == 200
        stats = response.json()
        assert stats['documents'] == 1
        assert stats['searchable_units'] == 1
        assert stats['storage_bytes'] > 0
