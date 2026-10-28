"""Persistent user workspace and content-aware locations, independent of index row IDs."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4

from .db import require_editable
from .text import normalize

DEFAULT_PREFERENCES = {
    'category_order': ['Summary', 'Lecture', 'Tutorial', 'Other'],
    'shortcuts': {'search': 'Meta+k', 'back': 'Alt+ArrowLeft', 'forward': 'Alt+ArrowRight',
                  'bookmark': 'Meta+d', 'pane1': 'Alt+Digit1', 'pane2': 'Alt+Digit2'},
}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def text_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Workspace:
    def __init__(self, db):
        self.db = db

    def state(self, key, default=None):
        with self.db.connect() as conn:
            row = conn.execute('SELECT value FROM user_state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put_state(self, key, value):
        with self.db.connect() as conn:
            conn.execute('INSERT OR REPLACE INTO user_state VALUES (?,?)', (key, dump(value)))
        return value

    def preferences(self):
        return {**DEFAULT_PREFERENCES, **self.state('preferences', {})}

    def save_preferences(self, value):
        with self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_editable(conn)
            conn.execute("INSERT OR REPLACE INTO user_state VALUES ('preferences',?)", (dump(value),))
        return value

    def capture(self, position):
        """Canonicalize a new location against the requested content, never silently rebind."""
        with self.db.connect() as conn:
            doc = conn.execute('SELECT * FROM documents WHERE id=?', (position['document_id'],)).fetchone()
            if not doc:
                raise KeyError('资料不存在')
            if position.get('content_hash') and position['content_hash'] != doc['content_hash']:
                raise ValueError('资料已替换，请重新打开后记录位置。')
            def locate(page=None, key=None, unit_id=None):
                if doc['kind'] == 'pdf' and page:
                    return conn.execute('SELECT * FROM units WHERE document_id=? AND ordinal=?', (doc['id'], page - 1)).fetchone()
                if key:
                    return conn.execute("SELECT * FROM units WHERE document_id=? AND json_extract(anchor,'$.key')=?", (doc['id'], key)).fetchone()
                if unit_id:
                    return conn.execute('SELECT * FROM units WHERE document_id=? AND id=?', (doc['id'], unit_id)).fetchone()
                return None

            target = locate(position.get('page'), position.get('key'), position.get('unit_id'))
            if target is None:
                raise ValueError('请先选择可用的页、段落或表格单元。')
            anchor = json.loads(target['anchor'])
            selected_hit = locate(position.get('hit_page'), position.get('hit_key'), position.get('hit_unit_id'))
            hit = {}
            if selected_hit:
                hit_anchor = json.loads(selected_hit['anchor'])
                hit = {'hit_unit_id': selected_hit['id'], 'hit_page': hit_anchor.get('page'),
                       'hit_key': hit_anchor.get('key'), 'hit_text_hash': text_hash(selected_hit['text'])}
        return {**position, **hit, 'document_id': doc['id'], 'content_hash': doc['content_hash'],
                'page': anchor.get('page'), 'key': anchor.get('key'), 'unit_id': target['id'],
                'text_hash': text_hash(target['text']), 'excerpt': target['text'][:180],
                'label': target['label'], 'version': doc['version']}

    def resolve(self, position):
        with self.db.connect() as conn:
            doc = conn.execute('SELECT * FROM documents WHERE id=?', (position['document_id'],)).fetchone()
        if not doc:
            return {'status': 'missing', 'position': position}
        if doc['content_hash'] != position.get('content_hash'):
            return {'status': 'stale', 'position': position}
        try:
            current = self.capture(position)
        except (ValueError, KeyError):
            return {'status': 'stale', 'position': position}
        if ((position.get('text_hash') and current['text_hash'] != position['text_hash']) or
                (position.get('hit_text_hash') and current.get('hit_text_hash') != position['hit_text_hash'])):
            return {'status': 'stale', 'position': position}
        return {'status': 'resolved', 'position': current}

    def history(self):
        with self.db.connect() as conn:
            return [{'id': row['id'], 'context': json.loads(row['context']), 'updated_at': row['updated_at']}
                    for row in conn.execute('SELECT * FROM search_history ORDER BY updated_at DESC LIMIT 100')]

    def add_history(self, context):
        signature = text_hash(json.dumps(context, sort_keys=True, ensure_ascii=False))
        with self.db.connect() as conn:
            conn.execute('''INSERT INTO search_history VALUES (?,?,?,?)
                            ON CONFLICT(signature) DO UPDATE SET updated_at=excluded.updated_at''',
                         (uuid4().hex, signature, dump(context), stamp()))
            conn.execute('''DELETE FROM search_history WHERE id NOT IN
                            (SELECT id FROM search_history ORDER BY updated_at DESC LIMIT 100)''')

    def bookmarks(self, course_id=None, tag=None, q=None):
        with self.db.connect() as conn:
            rows = conn.execute('''SELECT b.*,d.name,d.course_id,c.name AS course_name FROM bookmarks b
                                   JOIN documents d ON d.id=b.document_id JOIN courses c ON c.id=d.course_id
                                   ORDER BY b.updated_at DESC''').fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item['tags'] = json.loads(item['tags'])
            item['position'] = json.loads(item['position'])
            if course_id and item['course_id'] != course_id:
                continue
            if tag and tag not in item['tags']:
                continue
            if q and q.casefold() not in (item['note'] + ' ' + item['name'] + ' ' + ' '.join(item['tags'])).casefold():
                continue
            item['status'] = self.resolve(item['position'])['status']
            result.append(item)
        return result

    def save_bookmark(self, position, note, tags, bookmark_id=None):
        captured = self.capture(position) if position else None
        when = stamp()
        with self.db.connect() as conn:
            if bookmark_id:
                row = conn.execute('SELECT * FROM bookmarks WHERE id=?', (bookmark_id,)).fetchone()
                if row is None:
                    raise KeyError('收藏不存在')
                if captured and captured['document_id'] != row['document_id']:
                    raise ValueError('请在原资料中选择新位置。')
                conn.execute('UPDATE bookmarks SET position=?,note=?,tags=?,updated_at=? WHERE id=?',
                             (dump(captured) if captured else row['position'], note, dump(tags), when, bookmark_id))
            else:
                if captured is None:
                    raise ValueError('请选择收藏位置')
                bookmark_id = uuid4().hex
                conn.execute('INSERT INTO bookmarks VALUES (?,?,?,?,?,?,?)',
                             (bookmark_id, captured['document_id'], dump(captured), note, dump(tags), when, when))
        return {'id': bookmark_id}

    def vocabulary(self, course_id=None):
        with self.db.connect() as conn:
            if course_id:
                rows = conn.execute('SELECT * FROM vocabulary WHERE course_id IS NULL OR course_id=? ORDER BY id', (course_id,))
            else:
                rows = conn.execute('SELECT * FROM vocabulary ORDER BY id')
            return [dict(row) for row in rows]

    def save_vocabulary(self, entries):
        with self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_editable(conn)
            conn.execute('DELETE FROM vocabulary')
            for entry in entries:
                normalized = list(dict.fromkeys(normalize(term.strip())[0].strip() for term in entry['terms']))
                if len(normalized) < 2 or any(not term or not any(c.isalnum() for c in term) for term in normalized):
                    raise ValueError('每个词组至少需要两个不同的有效词或短语。')
                conn.execute('INSERT INTO vocabulary VALUES (?,?,?,?)',
                             (entry.get('id') or uuid4().hex, entry.get('course_id') or None,
                              entry['kind'], dump(normalized)))
        return self.vocabulary()
