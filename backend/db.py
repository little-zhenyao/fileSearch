from __future__ import annotations

import json
import sqlite3
import uuid
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

V2_SCHEMA = """
CREATE TABLE user_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE search_history (
 id TEXT PRIMARY KEY, signature TEXT NOT NULL UNIQUE, context TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE bookmarks (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
 position TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE vocabulary (
 id TEXT PRIMARY KEY, course_id TEXT REFERENCES courses(id),
 kind TEXT NOT NULL CHECK(kind IN ('form','synonym')), terms TEXT NOT NULL
);
CREATE TABLE preflights (id TEXT PRIMARY KEY, report TEXT NOT NULL, created_at TEXT NOT NULL);
ALTER TABLE job_items ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=2;
"""


class FrozenLibrary(ValueError):
    pass


def require_editable(conn):
    """Call inside BEGIN IMMEDIATE, in the same transaction as the mutation."""
    row = conn.execute("SELECT value FROM user_state WHERE key='exam'").fetchone()
    if row and json.loads(row[0]).get('active'):
        raise FrozenLibrary('考试模式已冻结资料修改，请先退出考试模式。')


class Database:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        (root / 'files').mkdir(exist_ok=True)
        self.path = root / 'library.sqlite3'
        with self.connect() as conn:
            version = conn.execute('PRAGMA user_version').fetchone()[0]
            if version > 2:
                raise RuntimeError('资料库版本较新，请使用对应版本的应用，勿覆盖数据库。')
            conn.execute('PRAGMA journal_mode=WAL')
            if version == 1:
                backups = root / 'backups'
                backups.mkdir(exist_ok=True)
                backup = backups / f'library-v1-{uuid.uuid4().hex}.sqlite3'
                with sqlite3.connect(backup) as destination:
                    conn.backup(destination)
            if version < 2:
                # executescript otherwise commits implicitly; keep all DDL/version writes atomic.
                conn.executescript('BEGIN IMMEDIATE;\n' + (SCHEMA if version == 0 else '') + V2_SCHEMA)
                from .search import DEFAULT_GROUPS
                conn.executemany('INSERT INTO vocabulary VALUES (?,NULL,?,?)',
                                 [(f'builtin-{index}', kind, json.dumps(terms))
                                  for index, (kind, terms) in enumerate(DEFAULT_GROUPS)])

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
