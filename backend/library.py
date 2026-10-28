from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import tempfile
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .db import Database, require_editable
from .parsers import PasswordRequired, parse, rectangles
from .text import compact_mapping, normalize, snippet
from .search import SearchPlan
from .workspace import Workspace, text_hash

CATEGORIES = ('Lecture', 'Tutorial', 'Summary', 'Other')
TERMINAL = {'ready', 'partial', 'no_text', 'password_required', 'failed', 'duplicate', 'conflict', 'unsupported'}
log = logging.getLogger(__name__)


def uid() -> str:
    return uuid.uuid4().hex


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def safe_relative_path(value: str) -> str:
    value = value.replace('\\', '/')
    path = PurePosixPath(value)
    if (not value or len(value) > 2048 or path.is_absolute() or
            '..' in path.parts or '\x00' in value or ':' in value):
        raise ValueError('文件相对路径无效')
    return str(path)


class Library:
    def __init__(self, root: Path):
        self.db = Database(root)
        self.workspace = Workspace(self.db)
        self.wakeup = threading.Event()
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self):
        with self.db.connect() as conn:
            conn.execute("UPDATE job_items SET status='queued',error=NULL WHERE status='processing'")
        self.thread = threading.Thread(target=self._run, name='library-indexer', daemon=True)
        self.thread.start()

    def stop(self):
        self.stopping.set()
        self.wakeup.set()
        if self.thread:
            self.thread.join(timeout=10)

    def _run(self):
        while not self.stopping.is_set():
            try:
                if self.process_next():
                    continue
            except Exception:
                log.exception('索引队列异常')
            self.wakeup.wait(1)
            self.wakeup.clear()

    def process_next(self) -> bool:
        with self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if self.workspace.state('exam', {}).get('active'):
                return False
            row = conn.execute("""SELECT i.*,j.course_id FROM job_items i JOIN jobs j ON j.id=i.job_id
                                   WHERE i.status='queued' ORDER BY i.created_at,i.rowid LIMIT 1""").fetchone()
            if row is None:
                return False
            item = dict(row)
            conn.execute("UPDATE job_items SET status='processing',error=NULL WHERE id=?", (item['id'],))
        try:
            self._index(item)
        except PasswordRequired as exc:
            self._finish(item['id'], 'password_required', str(exc))
        except Exception as exc:
            log.exception('文件处理失败: %s', item['relative_path'])
            self._finish(item['id'], 'failed', f'无法处理文件：{str(exc)[:400]}')
        return True

    def _finish(self, item_id: str, status: str, error: str | None = None, document_id: str | None = None):
        with self.db.connect() as conn:
            conn.execute('UPDATE job_items SET status=?,error=?,document_id=? WHERE id=?',
                         (status, error, document_id, item_id))

    def _index(self, item: dict):
        with self.db.connect() as conn:
            duplicate = conn.execute('SELECT id FROM documents WHERE course_id=? AND content_hash=?',
                                     (item['course_id'], item['content_hash'])).fetchone()
            existing = conn.execute('SELECT * FROM documents WHERE course_id=? AND relative_path=?',
                                    (item['course_id'], item['relative_path'])).fetchone()
        if duplicate and not (existing and duplicate['id'] == existing['id'] and item['replace_existing']):
            self._finish(item['id'], 'duplicate', '相同内容已存在，已保留原资料。', duplicate['id'])
            return
        if existing and not item['replace_existing']:
            self._finish(item['id'], 'conflict', '同路径资料内容已变化，请明确选择替换；旧索引仍可使用。', existing['id'])
            return
        # Parse completely before opening the replacement transaction.
        units, warning = parse(self.db.root / 'files' / item['blob'], item['kind'])
        searchable = sum(bool(unit['text'].strip()) for unit in units)
        status = 'no_text' if not searchable else 'partial' if searchable < len(units) and item['kind'] == 'pdf' else 'ready'
        document_id = existing['id'] if existing else uid()
        version = existing['version'] + 1 if existing else 1
        with self.db.connect() as conn:
            if existing:
                conn.execute('DELETE FROM units WHERE document_id=?', (document_id,))
                conn.execute('''UPDATE documents SET content_hash=?,blob=?,version=?,status=?,unit_count=?,
                             searchable_count=?,size=?,warning=?,created_at=? WHERE id=?''',
                             (item['content_hash'], item['blob'], version, status, len(units), searchable,
                              item['size'], warning, now(), document_id))
            else:
                conn.execute('''INSERT INTO documents
                             (id,course_id,name,relative_path,kind,content_hash,blob,status,unit_count,
                              searchable_count,size,warning,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                             (document_id, item['course_id'], PurePosixPath(item['relative_path']).name,
                              item['relative_path'], item['kind'], item['content_hash'], item['blob'], status,
                              len(units), searchable, item['size'], warning, now()))
            for ordinal, unit in enumerate(units):
                text, mapping = normalize(unit['text'])
                conn.execute('''INSERT INTO units (id,document_id,ordinal,label,text,normalized,mapping,anchor)
                             VALUES (?,?,?,?,?,?,?,?)''',
                             (uid(), document_id, ordinal, unit['label'], unit['text'], text,
                              json_dump(compact_mapping(mapping)), json_dump(unit['anchor'])))
            conn.execute('UPDATE job_items SET status=?,document_id=?,warning=?,error=NULL WHERE id=?',
                         (status, document_id, warning, item['id']))

    async def import_files(self, course_id: str, uploads: list, paths: list[str]) -> str:
        if len(uploads) != len(paths) or not uploads:
            raise ValueError('文件和路径数量不一致或未选择文件')
        normalized_paths = [safe_relative_path(path) for path in paths]
        with self.db.connect() as conn:
            require_editable(conn)
            if not conn.execute('SELECT 1 FROM courses WHERE id=?', (course_id,)).fetchone():
                raise ValueError('课程不存在')
        items = []
        # Uploads can be slow. Stage outside the library so an exam can enter while
        # uploading, then reject the import without adding blobs or queue records.
        with tempfile.TemporaryDirectory(prefix='filesearch-import-') as staging:
            for upload, path in zip(uploads, normalized_paths):
                kind = PurePosixPath(path).suffix.lower().lstrip('.')
                item_id = uid()
                if kind not in ('pdf', 'docx'):
                    items.append((item_id, path, kind, '', '', 0, 'unsupported', '仅支持 PDF 和 DOCX'))
                    await upload.close()
                    continue
                temporary = Path(staging) / item_id
                digest = hashlib.sha256()
                size = 0
                try:
                    with temporary.open('wb') as stream:
                        while chunk := await upload.read(1024 * 1024):
                            digest.update(chunk)
                            stream.write(chunk)
                            size += len(chunk)
                    content_hash = digest.hexdigest()
                    blob = f'{content_hash}.{kind}'
                    items.append((item_id, path, kind, content_hash, blob, size, 'queued', None))
                finally:
                    await upload.close()
            job_id = uid()
            with self.db.connect() as conn:
                conn.execute('BEGIN IMMEDIATE')
                require_editable(conn)
                for item in items:
                    item_id, _, _, _, blob, *_ = item
                    if not blob:
                        continue
                    destination = self.db.root / 'files' / blob
                    try:
                        with destination.open('rb') as existing_copy:
                            intact = hashlib.file_digest(existing_copy, 'sha256').hexdigest() == item[3]
                    except FileNotFoundError:
                        intact = False
                    # A duplicate upload must also repair a missing/corrupt shared
                    # copy. The filename alone does not prove the bytes are intact.
                    if not intact:
                        temporary = self.db.root / 'files' / f'.{item_id}.upload'
                        try:
                            shutil.copyfile(Path(staging) / item_id, temporary)
                            os.replace(temporary, destination)
                        finally:
                            temporary.unlink(missing_ok=True)
                conn.execute('INSERT INTO jobs VALUES (?,?,?)', (job_id, now(), course_id))
                for item in items:
                    conn.execute('''INSERT INTO job_items
                                 (id,job_id,relative_path,kind,content_hash,blob,size,status,error,created_at)
                                 VALUES (?,?,?,?,?,?,?,?,?,?)''', (item[0], job_id, *item[1:], now()))
        self.wakeup.set()
        return job_id

    def jobs(self, job_id: str | None = None) -> list[dict]:
        with self.db.connect() as conn:
            jobs = conn.execute('''SELECT j.*,c.name AS course_name FROM jobs j
                                JOIN courses c ON c.id=j.course_id ''' +
                                ('WHERE j.id=? ' if job_id else '') + 'ORDER BY j.created_at DESC LIMIT 30',
                                (job_id,) if job_id else ()).fetchall()
            result = []
            for job in jobs:
                items = [dict(row) for row in conn.execute('''SELECT id,relative_path,status,error,warning,
                         document_id,replace_existing FROM job_items WHERE job_id=? ORDER BY rowid''', (job['id'],))]
                result.append({**dict(job), 'items': items,
                               'done': all(item['status'] in TERMINAL for item in items),
                               'completed': sum(item['status'] in TERMINAL for item in items), 'total': len(items)})
            return result

    def retry(self, job_id: str, item_id: str, replace: bool):
        with self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_editable(conn)
            item = conn.execute('SELECT * FROM job_items WHERE id=? AND job_id=?', (item_id, job_id)).fetchone()
            if not item:
                raise KeyError('导入记录不存在')
            if item['status'] not in ('failed', 'password_required', 'conflict'):
                raise ValueError('此文件无需重试')
            if item['status'] == 'conflict' and not replace:
                raise ValueError('请明确确认替换同路径资料')
            conn.execute("UPDATE job_items SET status='queued',error=NULL,dismissed=0,replace_existing=?,created_at=? WHERE id=?",
                         (int(replace), now(), item_id))
        self.wakeup.set()

    def rebuild(self, document_id: str) -> str:
        with self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_editable(conn)
            doc = conn.execute('SELECT * FROM documents WHERE id=?', (document_id,)).fetchone()
            if not doc:
                raise KeyError('资料不存在')
            job_id = uid()
            conn.execute('INSERT INTO jobs VALUES (?,?,?)', (job_id, now(), doc['course_id']))
            conn.execute('''INSERT INTO job_items
                         (id,job_id,relative_path,kind,content_hash,blob,size,replace_existing,created_at)
                         VALUES (?,?,?,?,?,?,?,1,?)''',
                         (uid(), job_id, doc['relative_path'], doc['kind'], doc['content_hash'], doc['blob'], doc['size'], now()))
        self.wakeup.set()
        return job_id

    def search(self, q: str, mode: str = 'all', course_id: str | None = None,
               category: str | None = None, document_id: str | None = None,
               offset: int = 0, limit: int = 20, unit_offset: int = 0, expand: bool = False,
               sort: str = 'relevance') -> dict:
        vocabulary = self.workspace.vocabulary() if expand else []
        query = self.query(q, mode, course_id, expand, vocabulary)
        lexicon_version = text_hash(json_dump(vocabulary)) if expand else None
        clauses, parameters = [], []
        for column, value in [('d.course_id', course_id), ('d.category', category), ('d.id', document_id)]:
            if value:
                clauses.append(f'{column}=?')
                parameters.append(value)
        candidate_sql, candidate_parameters = query.candidates()
        clauses.append(candidate_sql)
        parameters.extend(candidate_parameters)
        sql = '''SELECT u.id AS unit_id,u.ordinal,u.label,u.text,u.normalized,u.mapping,
                 d.id AS document_id,d.name,d.kind,d.version,d.category,d.course_id,c.name AS course_name
                 FROM units u JOIN documents d ON d.id=u.document_id JOIN courses c ON c.id=d.course_id'''
        if clauses:
            sql += ' WHERE ' + ' AND '.join(clauses)
        groups: dict[str, dict] = {}
        row_plans = {}
        with self.db.connect() as conn:
            for row in conn.execute(sql, parameters):
                actual_query = query
                if expand and not course_id:
                    if row['course_id'] not in row_plans:
                        row_plans[row['course_id']] = self.query(q, mode, row['course_id'], True, vocabulary)
                    actual_query = row_plans[row['course_id']]
                ranges, details = actual_query.matches(row['normalized'], json.loads(row['mapping']))
                if not ranges:
                    continue
                doc_id = row['document_id']
                group = groups.setdefault(doc_id, {
                    'document_id': doc_id, 'name': row['name'], 'kind': row['kind'],
                    'version': row['version'], 'category': row['category'], 'course_id': row['course_id'],
                    'course_name': row['course_name'], 'hit_count': 0, 'hits': [], 'score': 0, 'exact': False,
                })
                score = len(ranges) / (1 + len(row['text']) / 800)
                group['score'] = max(group['score'], score)
                group['exact'] |= bool(query.original.matches(row['normalized'], json.loads(row['mapping'])))
                group['hit_count'] += len(ranges)
                group['hits'].append({'unit_id': row['unit_id'], 'ordinal': row['ordinal'],
                                      'page': row['ordinal'] + 1 if row['kind'] == 'pdf' else None,
                                      'label': row['label'], 'ranges': ranges,
                                      'lexicon_version': lexicon_version, 'match_count': len(ranges), 'matches': details, 'snippet': snippet(row['text'], ranges),
                                      'version': row['version']})
        category_order = self.workspace.preferences()['category_order']
        ordered = sorted(groups.values(), key=lambda group: (
            not group['exact'], category_order.index(group['category']) if sort == 'category' else 0,
            -group['score'], group['name'], group['document_id']))
        total_hits = sum(group['hit_count'] for group in ordered)
        selected = ordered[offset:offset + limit]
        for group in selected:
            group['hits'].sort(key=lambda hit: hit['ordinal'])
            group['unit_total'] = len(group['hits'])
            group['hits'] = group['hits'][unit_offset:unit_offset + 20]
            group['next_unit_offset'] = unit_offset + len(group['hits']) if unit_offset + len(group['hits']) < group['unit_total'] else None
            del group['score']
        return {'groups': selected, 'total_documents': len(ordered), 'total_hits': total_hits,
                'next_offset': offset + limit if offset + limit < len(ordered) else None,
                'expansions': query.expansions}

    def query(self, q, mode='all', course_id=None, expand=False, vocabulary=None):
        vocabulary = (self.workspace.vocabulary() if vocabulary is None else vocabulary) if expand else []
        if course_id:
            vocabulary = [row for row in vocabulary if row['course_id'] is None or row['course_id'] == course_id]
        return SearchPlan.create(q, mode, vocabulary)

    def unit(self, document_id: str, unit_id: str, q: str | None = None, mode: str = 'all',
             expand: bool = False, course_id: str | None = None, vocabulary=None) -> dict:
        with self.db.connect() as conn:
            row = conn.execute('''SELECT u.*,d.version,d.course_id FROM units u JOIN documents d ON d.id=u.document_id
                                WHERE u.document_id=? AND u.id=?''', (document_id, unit_id)).fetchone()
        if row is None:
            raise KeyError('位置已失效，请重新搜索（资料可能已重建）。')
        anchor = json.loads(row['anchor'])
        ranges, details = self.query(q, mode, course_id or row['course_id'], expand, vocabulary).matches(row['normalized'], json.loads(row['mapping'])) if q else ([], [])
        result = {'unit_id': row['id'], 'document_id': document_id, 'version': row['version'],
                  'label': row['label'], 'text': row['text'], 'ranges': ranges, 'matches': details,
                  'anchor': {key: value for key, value in anchor.items() if key not in ('boxes', 'lines')}}
        if anchor['type'] == 'page':
            result['rectangles'] = rectangles(anchor, ranges)
        return result
