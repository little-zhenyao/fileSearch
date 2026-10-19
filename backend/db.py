from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS courses (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
 name TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'Other', content_hash TEXT NOT NULL,
 blob TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
 unit_count INTEGER NOT NULL, searchable_count INTEGER NOT NULL,
 size INTEGER NOT NULL, warning TEXT, created_at TEXT NOT NULL,
 UNIQUE(course_id,relative_path), UNIQUE(course_id,content_hash)
);
CREATE TABLE IF NOT EXISTS units (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL,
 normalized TEXT NOT NULL, mapping TEXT NOT NULL, anchor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS units_document ON units(document_id,ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS units_fts USING fts5(normalized, tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS units_tri USING fts5(normalized, tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS units_insert AFTER INSERT ON units BEGIN
 INSERT INTO units_fts(rowid,normalized) VALUES (new.rowid,new.normalized);
 INSERT INTO units_tri(rowid,normalized) VALUES (new.rowid,new.normalized);
END;
CREATE TRIGGER IF NOT EXISTS units_delete AFTER DELETE ON units BEGIN
 DELETE FROM units_fts WHERE rowid=old.rowid;
 DELETE FROM units_tri WHERE rowid=old.rowid;
END;
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id)
);
CREATE TABLE IF NOT EXISTS job_items (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
 relative_path TEXT NOT NULL, kind TEXT NOT NULL, content_hash TEXT NOT NULL,
 blob TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 error TEXT, warning TEXT, document_id TEXT, replace_existing INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_item_status ON job_items(status,created_at);
PRAGMA user_version=1;
"""


class Database:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        (root / 'files').mkdir(exist_ok=True)
        self.path = root / 'library.sqlite3'
        with self.connect() as conn:
            version = conn.execute('PRAGMA user_version').fetchone()[0]
            if version > 1:
                raise RuntimeError('资料库版本较新，请使用对应版本的应用，勿覆盖数据库。')
            conn.execute('PRAGMA journal_mode=WAL')
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
