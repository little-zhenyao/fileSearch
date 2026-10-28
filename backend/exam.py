"""Preflight copied materials and atomically freeze library mutations."""
from __future__ import annotations

import hashlib
import json
from uuid import uuid4

from .parsers import parse
from .text import compact_mapping, normalize
from .workspace import dump, stamp


class Exam:
    def __init__(self, library):
        self.library = library
        self.db = library.db

    def status(self):
        return self.library.workspace.state('exam', {'active': False})

    def snapshot(self, conn, course_id):
        docs = conn.execute('SELECT * FROM documents' + (' WHERE course_id=?' if course_id else '') + ' ORDER BY id',
                            (course_id,) if course_id else ()).fetchall()
        issues = conn.execute('''SELECT i.*,j.course_id FROM job_items i JOIN jobs j ON j.id=i.job_id
                                WHERE i.rowid=(SELECT x.rowid FROM job_items x JOIN jobs y ON y.id=x.job_id
                                  WHERE y.course_id=j.course_id AND x.relative_path=i.relative_path
                                  ORDER BY x.created_at DESC,x.rowid DESC LIMIT 1)
                                ORDER BY i.rowid''').fetchall()
        pending = conn.execute("SELECT count(*) FROM job_items WHERE status IN ('queued','processing')").fetchone()[0]
        return {'documents': [dict(doc) for doc in docs], 'jobs': [dict(item) for item in issues],
                'pending': pending, 'vocabulary': self.library.workspace.vocabulary(),
                'preferences': self.library.workspace.preferences()}

    def inspect(self, conn, course_id):
        if course_id and not conn.execute('SELECT 1 FROM courses WHERE id=?', (course_id,)).fetchone():
            raise ValueError('课程不存在')
        snapshot = self.snapshot(conn, course_id)
        docs, issues, pending = snapshot['documents'], snapshot['jobs'], snapshot['pending']
        blockers, warnings, records = [], [], []
        if not docs:
            blockers.append({'name': '资料库', 'message': '所选范围没有资料。'})
        if pending:
            blockers.append({'name': '索引任务', 'message': f'{pending} 项任务尚未完成，请等待或处理后重新自检。'})
        # Only the latest attempt at a path is actionable. Old failures remain an audit trail.
        for item in issues:
            if item['dismissed'] or (course_id and item['course_id'] != course_id):
                continue
            if item['status'] in ('failed', 'password_required', 'conflict'):
                blockers.append({'name': item['relative_path'], 'message': item['error'] or '导入问题尚未解决',
                                 'job_id': item['job_id'], 'item_id': item['id']})
            elif item['status'] == 'unsupported':
                warnings.append({'name': item['relative_path'], 'message': '不支持的格式未进入检索。'})
        for doc in docs:
            issues_before = len(blockers)
            path = self.db.root / 'files' / doc['blob']
            try:
                with path.open('rb') as stream:
                    digest_state = hashlib.sha256()
                    while chunk := stream.read(1024 * 1024):
                        digest_state.update(chunk)
                    digest = digest_state.hexdigest()
                if digest != doc['content_hash']:
                    raise ValueError('本地副本哈希不一致，请重新导入。')
                parsed, _ = parse(path, doc['kind'])
                indexed = conn.execute('SELECT rowid AS fts_id,* FROM units WHERE document_id=? ORDER BY ordinal', (doc['id'],)).fetchall()
                searchable = sum(bool(unit['text'].strip()) for unit in parsed)
                if len(parsed) != doc['unit_count'] or len(indexed) != len(parsed) or searchable != doc['searchable_count']:
                    raise ValueError('文本单元数量与索引记录不一致，请重建。')
                for ordinal, (unit, row) in enumerate(zip(parsed, indexed)):
                    normalized, mapping = normalize(unit['text'])
                    if (row['ordinal'] != ordinal or row['text'] != unit['text'] or
                            row['normalized'] != normalized or json.loads(row['mapping']) != compact_mapping(mapping) or
                            json.loads(row['anchor']) != unit['anchor']):
                        raise ValueError('索引内容或定位锚点不一致，请重建。')
                    for table in ('units_fts', 'units_tri'):
                        stored = conn.execute(f'SELECT normalized FROM {table} WHERE rowid=?', (row['fts_id'],)).fetchone()
                        if not stored or stored[0] != normalized:
                            raise ValueError('全文索引不一致，请重建。')
                if searchable < len(parsed) or searchable == 0:
                    warnings.append({'name': doc['name'], 'message': f'{searchable}/{len(parsed)} 个单元可搜索；扫描文字未做 OCR。'})
            except Exception as exc:
                blockers.append({'name': doc['name'], 'message': str(exc) or '文件无法打开'})
                digest = 'unavailable'
            records.append({'id': doc['id'], 'name': doc['name'], 'version': doc['version'],
                            'content_hash': doc['content_hash'], 'actual_hash': digest,
                            'searchable_count': doc['searchable_count'], 'unit_count': doc['unit_count'],
                            'indexed_at': doc['created_at'], 'ok': len(blockers) == issues_before})
        return {'course_id': course_id, 'documents': records, 'blockers': blockers, 'warnings': warnings,
                'fingerprint': hashlib.sha256(dump(snapshot).encode()).hexdigest()}

    def check(self, course_id=None):
        with self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            report = {**self.inspect(conn, course_id), 'id': uuid4().hex, 'created_at': stamp()}
            conn.execute('INSERT INTO preflights VALUES (?,?,?)', (report['id'], dump(report), report['created_at']))
            conn.execute('DELETE FROM preflights WHERE id NOT IN (SELECT id FROM preflights ORDER BY created_at DESC LIMIT 10)')
        return report

    def latest(self, course_id=None):
        with self.db.connect() as conn:
            reports = conn.execute('SELECT report FROM preflights ORDER BY created_at DESC').fetchall()
            for row in reports:
                report = json.loads(row[0])
                if report['course_id'] == course_id:
                    # Cheap staleness check; entering always repeats the complete inspection.
                    snapshot = self.snapshot(conn, course_id)
                    report['stale'] = hashlib.sha256(dump(snapshot).encode()).hexdigest() != report['fingerprint']
                    return report
        return None

    def enter(self, report_id, acknowledge):
        with self.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT report FROM preflights WHERE id=?', (report_id,)).fetchone()
            if not row:
                raise ValueError('请先执行自检。')
            report = json.loads(row[0])
            current = self.inspect(conn, report['course_id'])
            if current['blockers']:
                raise ValueError('自检存在阻断问题，请处理后重新检查。')
            if current['fingerprint'] != report['fingerprint']:
                raise ValueError('资料或设置已变化，请重新自检。')
            if current['warnings'] and not acknowledge:
                raise ValueError('请先确认不可搜索页面等警告。')
            state = {'active': True, 'report_id': report_id, 'course_id': report['course_id'], 'entered_at': stamp()}
            conn.execute("INSERT OR REPLACE INTO user_state VALUES ('exam',?)", (dump(state),))
        return state

    def exit(self):
        return self.library.workspace.put_state('exam', {'active': False})
