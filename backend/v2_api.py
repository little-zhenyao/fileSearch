"""V2 endpoints, shared by the desktop launcher and isolated integration tests."""
from __future__ import annotations

import json
import sqlite3
from typing import Literal

from fastapi import HTTPException, Query
from pydantic import BaseModel, Field, model_validator

from .db import require_editable
from .exam import Exam
from .workspace import DEFAULT_PREFERENCES


class SearchContext(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    mode: Literal['all', 'any', 'phrase'] = 'all'
    course: str = ''
    category: str = ''
    document: str = ''
    expand: bool = False
    sort: Literal['relevance', 'category'] = 'relevance'


class Position(BaseModel):
    document_id: str
    content_hash: str = ''
    page: int | None = Field(None, ge=1)
    key: str | None = None
    unit_id: str | None = None
    text_hash: str | None = None
    hit_unit_id: str | None = None
    hit_page: int | None = Field(None, ge=1)
    hit_key: str | None = None
    hit_text_hash: str | None = None
    lexicon_version: str | None = None
    excerpt: str = Field('', max_length=180)
    label: str = ''
    version: int | None = None
    offset: float = Field(0, ge=0, le=1)
    horizontal: float = Field(0, ge=0, le=1)
    zoom: float = Field(1, ge=.5, le=3)
    rotation: Literal[0, 90, 180, 270] = 0
    match: int = Field(0, ge=0)
    find: str = Field('', max_length=500)


class BookmarkBody(BaseModel):
    position: Position | None = None
    note: str = Field('', max_length=10000)
    tags: list[str] = Field(default_factory=list, max_length=30)

    @model_validator(mode='after')
    def normalize_tags(self):
        self.tags = list(dict.fromkeys(tag.strip() for tag in self.tags if tag.strip()))
        if any(len(tag) > 100 for tag in self.tags):
            raise ValueError('标签不能超过 100 个字符')
        return self


class VocabularyEntry(BaseModel):
    id: str | None = None
    course_id: str | None = None
    kind: Literal['form', 'synonym']
    terms: list[str] = Field(min_length=2, max_length=12)

    @model_validator(mode='after')
    def term_lengths(self):
        if any(len(term) > 100 for term in self.terms):
            raise ValueError('每个词或短语不能超过 100 个字符')
        return self


class Preferences(BaseModel):
    category_order: list[str] = Field(default_factory=lambda: DEFAULT_PREFERENCES['category_order'][:])
    shortcuts: dict[str, str] = Field(default_factory=lambda: DEFAULT_PREFERENCES['shortcuts'].copy())

    @model_validator(mode='after')
    def valid_preferences(self):
        if sorted(self.category_order) != sorted(DEFAULT_PREFERENCES['category_order']):
            raise ValueError('类别顺序必须恰好包含四个类别')
        if set(self.shortcuts) != set(DEFAULT_PREFERENCES['shortcuts']):
            raise ValueError('快捷键动作不完整')
        if len(set(self.shortcuts.values())) != len(self.shortcuts):
            raise ValueError('快捷键不能重复')
        for value in self.shortcuts.values():
            parts = value.split('+')
            if (len(parts) < 2 or len(parts) > 5 or not parts[-1] or len(parts[-1]) > 20 or
                    any(mod not in ('Meta', 'Control', 'Alt', 'Shift') for mod in parts[:-1])):
                raise ValueError('快捷键需要有效的修饰键和按键')
        return self


class PreflightBody(BaseModel):
    course_id: str | None = None


class EnterExam(BaseModel):
    report_id: str
    acknowledge_warnings: bool = False


def install_v2(app, library):
    def workspace():
        return library().workspace

    @app.get('/api/workspace')
    def get_workspace():
        return workspace().state('workspace', {})

    @app.put('/api/workspace')
    def save_workspace(body: dict):
        if len(json.dumps(body)) > 500_000:
            raise ValueError('阅读历史过大，请清理后重试。')
        # Add content fingerprints to locations without persisting any search result payload.
        for pane in body.get('panes', []) if isinstance(body.get('panes'), list) else []:
            if not isinstance(pane, dict):
                continue
            visits = [pane.get('current'), pane.get('saved'), *pane.get('back', []), *pane.get('forward', [])]
            for visit in visits:
                if not isinstance(visit, dict) or not isinstance(visit.get('position'), dict):
                    continue
                position = visit['position']
                if not position.get('text_hash'):
                    try:
                        visit['position'] = workspace().capture(Position.model_validate(position).model_dump())
                    except (ValueError, KeyError):
                        pass  # Preserve obsolete locations so restore can explicitly mark them stale.
                visit.pop('hit', None)
        return workspace().put_state('workspace', body)

    @app.get('/api/history')
    def history():
        return workspace().history()

    @app.post('/api/history')
    def add_history(body: SearchContext):
        workspace().add_history(body.model_dump())
        return {'ok': True}

    @app.delete('/api/history')
    def clear_history():
        with library().db.connect() as conn:
            conn.execute('DELETE FROM search_history')
        return {'ok': True}

    @app.post('/api/positions/resolve')
    def resolve_position(body: Position):
        return workspace().resolve(body.model_dump())

    @app.post('/api/positions/capture')
    def capture_position(body: Position):
        return workspace().capture(body.model_dump())

    @app.get('/api/bookmarks')
    def bookmarks(course_id: str | None = None, tag: str | None = None, q: str | None = Query(None, max_length=500)):
        return workspace().bookmarks(course_id, tag, q)

    @app.post('/api/bookmarks', status_code=201)
    def create_bookmark(body: BookmarkBody):
        return workspace().save_bookmark(body.position.model_dump() if body.position else None, body.note, body.tags)

    @app.patch('/api/bookmarks/{bookmark_id}')
    def update_bookmark(bookmark_id: str, body: BookmarkBody):
        return workspace().save_bookmark(body.position.model_dump() if body.position else None, body.note, body.tags, bookmark_id)

    @app.delete('/api/bookmarks/{bookmark_id}')
    def delete_bookmark(bookmark_id: str):
        with library().db.connect() as conn:
            conn.execute('DELETE FROM bookmarks WHERE id=?', (bookmark_id,))
        return {'ok': True}

    @app.get('/api/preferences')
    def preferences():
        return workspace().preferences()

    @app.put('/api/preferences')
    def save_preferences(body: Preferences):
        return workspace().save_preferences(body.model_dump())

    @app.get('/api/vocabulary')
    def vocabulary():
        return [{**row, 'terms': json.loads(row['terms'])} for row in workspace().vocabulary()]

    @app.put('/api/vocabulary')
    def save_vocabulary(body: list[VocabularyEntry]):
        if len(body) > 100:
            raise ValueError('最多保存 100 个词组')
        try:
            entries = workspace().save_vocabulary([item.model_dump() for item in body])
        except sqlite3.IntegrityError as exc:
            raise ValueError('词表 ID 重复或课程不存在') from exc
        return [{**row, 'terms': json.loads(row['terms'])} for row in entries]

    @app.get('/api/search/expansions')
    def expansion_preview(q: str = Query(min_length=1, max_length=500), mode: Literal['all','any','phrase'] = 'all', course_id: str | None = None):
        return {'expansions': library().query(q, mode, course_id, True).expansions}

    @app.get('/api/preflight')
    def latest_preflight(course_id: str | None = None):
        return Exam(library()).latest(course_id)

    @app.post('/api/preflight')
    def preflight(body: PreflightBody):
        return Exam(library()).check(body.course_id)

    @app.get('/api/exam')
    def exam_status():
        return Exam(library()).status()

    @app.post('/api/exam/enter')
    def enter_exam(body: EnterExam):
        try:
            return Exam(library()).enter(body.report_id, body.acknowledge_warnings)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post('/api/exam/exit')
    def exit_exam():
        return Exam(library()).exit()

    @app.post('/api/import-jobs/{job_id}/items/{item_id}/dismiss')
    def dismiss_import_issue(job_id: str, item_id: str):
        with library().db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_editable(conn)
            row = conn.execute('SELECT status FROM job_items WHERE id=? AND job_id=?', (item_id, job_id)).fetchone()
            if not row:
                raise KeyError('导入记录不存在')
            if row['status'] not in ('failed', 'password_required', 'conflict', 'unsupported'):
                raise ValueError('此项不是可忽略的导入问题')
            conn.execute('UPDATE job_items SET dismissed=1 WHERE id=?', (item_id,))
        return {'ok': True}
