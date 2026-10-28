from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import stat
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .library import CATEGORIES, Library, now, uid
from .db import FrozenLibrary, require_editable
from .v2_api import install_v2
from .workspace import text_hash, dump

PROJECT = Path(__file__).resolve().parents[1]


def storage_bytes(root: Path) -> int:
    total = 0
    for path in root.rglob('*'):
        try:
            info = path.stat()
        except (FileNotFoundError, NotADirectoryError):
            # SQLite removes WAL/SHM files when the last connection closes.
            continue
        if stat.S_ISREG(info.st_mode):
            total += info.st_size
    return total


class Configure(BaseModel):
    library_path: str = Field(min_length=1, max_length=4096)


class CourseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class CategoryUpdate(BaseModel):
    category: Literal['Lecture', 'Tutorial', 'Summary', 'Other']


class Retry(BaseModel):
    replace_existing: bool = False


def create_app(config_path: Path | None = None, library_path: Path | None = None,
               start_worker: bool = True, dist_path: Path | None = None) -> FastAPI:
    config = config_path or Path(os.environ.get('FILESEARCH_CONFIG', PROJECT / '.local' / 'settings.json'))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        root = library_path
        if root is None and config.exists():
            settings = json.loads(config.read_text('utf-8'))
            root = Path(settings['library_path'])
        app.state.library = Library(root) if root else None
        if app.state.library and start_worker:
            app.state.library.start()
        yield
        if app.state.library:
            await asyncio.to_thread(app.state.library.stop)

    app = FastAPI(title='书间 · 本地课程检索', version='2.0.0', lifespan=lifespan,
                  docs_url=None, redoc_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])

    @app.middleware('http')
    async def local_requests(request: Request, call_next):
        if request.url.path.startswith('/api/') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
            # A custom header prevents cross-origin HTML forms from changing the library.
            if request.headers.get('x-local-request') != '1':
                return JSONResponse({'detail': '仅接受本地应用操作'}, status_code=403)
            origin = request.headers.get('origin')
            if origin:
                parsed = urlparse(origin)
                allowed = {str(request.base_url).rstrip('/')}
                if os.environ.get('FILESEARCH_DEV') == '1':
                    allowed.update({'http://127.0.0.1:5173', 'http://localhost:5173'})
                if parsed.scheme != 'http' or origin not in allowed:
                    return JSONResponse({'detail': '请求来源不受信任'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self'; worker-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            "font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"
        )
        return response

    @app.exception_handler(FrozenLibrary)
    async def frozen_library(_request, exc):
        return JSONResponse({'detail': str(exc)}, status_code=409)

    @app.exception_handler(ValueError)
    async def invalid_value(_request, exc):
        return JSONResponse({'detail': str(exc)}, status_code=400)

    @app.exception_handler(KeyError)
    async def missing_value(_request, exc):
        return JSONResponse({'detail': str(exc.args[0])}, status_code=404)

    def library() -> Library:
        value = app.state.library
        if value is None:
            raise HTTPException(409, '请先选择资料库目录')
        return value

    def document(document_id: str) -> dict:
        with library().db.connect() as conn:
            row = conn.execute('SELECT * FROM documents WHERE id=?', (document_id,)).fetchone()
        if row is None:
            raise KeyError('资料不存在')
        return dict(row)

    @app.get('/api/health')
    def health():
        return {'app': 'course-search', 'version': '2.0.0', 'configured': app.state.library is not None}

    @app.get('/api/settings')
    def settings():
        lib = app.state.library
        return {'configured': lib is not None,
                'library_path': str(lib.db.root) if lib else '',
                'suggested_path': str(Path.home() / 'Documents' / '书间资料库'),
                'categories': CATEGORIES}

    @app.post('/api/settings')
    async def configure(body: Configure):
        if app.state.library:
            raise HTTPException(409, '资料库已经配置；迁移请按使用说明操作。')
        root = Path(body.library_path).expanduser().resolve()
        try:
            lib = Library(root)
            config.parent.mkdir(parents=True, exist_ok=True)
            temporary = config.with_suffix('.tmp')
            temporary.write_text(json.dumps({'library_path': str(root)}, ensure_ascii=False), 'utf-8')
            temporary.replace(config)
        except (OSError, sqlite3.Error) as exc:
            raise HTTPException(400, f'无法使用此目录：{exc}') from exc
        app.state.library = lib
        if start_worker:
            lib.start()
        return {'library_path': str(root)}

    @app.post('/api/settings/pick-directory')
    async def pick_directory():
        if sys.platform != 'darwin':
            raise HTTPException(400, '请在输入框中填写目录路径')
        try:
            result = await asyncio.to_thread(subprocess.run,
                ['osascript', '-e', 'POSIX path of (choose folder with prompt "选择书间资料库目录")'],
                capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(400, '目录选择超时，请手动填写路径') from exc
        if result.returncode:
            return {'path': None}
        return {'path': result.stdout.strip()}

    @app.get('/api/stats')
    def stats():
        lib = library()
        with lib.db.connect() as conn:
            counts = dict(conn.execute('''SELECT count(*) AS documents,
                         coalesce(sum(unit_count),0) AS units,
                         coalesce(sum(searchable_count),0) AS searchable_units FROM documents''').fetchone())
            counts['pending'] = conn.execute("SELECT count(*) FROM job_items WHERE status IN ('queued','processing')").fetchone()[0]
        counts['storage_bytes'] = storage_bytes(lib.db.root)
        counts['library_path'] = str(lib.db.root)
        return counts

    @app.get('/api/courses')
    def courses():
        with library().db.connect() as conn:
            return [dict(row) for row in conn.execute('''SELECT c.*,count(d.id) AS document_count FROM courses c
                  LEFT JOIN documents d ON d.course_id=c.id GROUP BY c.id ORDER BY c.created_at,c.id''')]

    @app.post('/api/courses', status_code=201)
    def create_course(body: CourseCreate):
        name = body.name.strip()
        if not name:
            raise ValueError('请输入课程名称')
        course = {'id': uid(), 'name': name, 'created_at': now()}
        try:
            with library().db.connect() as conn:
                conn.execute('BEGIN IMMEDIATE')
                require_editable(conn)
                conn.execute('INSERT INTO courses VALUES (:id,:name,:created_at)', course)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, '课程名称已存在') from exc
        return {**course, 'document_count': 0}

    @app.get('/api/documents')
    def documents(course_id: str | None = None, category: str | None = None):
        filters, values = [], []
        for col, value in [('course_id', course_id), ('category', category)]:
            if value:
                filters.append(f'd.{col}=?')
                values.append(value)
        with library().db.connect() as conn:
            sql = '''SELECT d.id,d.course_id,d.name,d.relative_path,d.kind,d.category,d.version,d.status,
                     d.content_hash,d.unit_count,d.searchable_count,d.size,d.warning,d.created_at,c.name AS course_name
                     FROM documents d JOIN courses c ON c.id=d.course_id'''
            if filters:
                sql += ' WHERE ' + ' AND '.join(filters)
            return [dict(row) for row in conn.execute(sql + ' ORDER BY d.name,d.id', values)]

    @app.patch('/api/documents/{document_id}')
    def update_document(document_id: str, body: CategoryUpdate):
        document(document_id)
        with library().db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            require_editable(conn)
            conn.execute('UPDATE documents SET category=? WHERE id=?', (body.category, document_id))
        return {'ok': True}

    @app.post('/api/documents/{document_id}/rebuild', status_code=202)
    def rebuild_document(document_id: str):
        return {'job_id': library().rebuild(document_id)}

    @app.post('/api/import-jobs', status_code=202)
    async def import_documents(course_id: str = Form(...), paths: str = Form(...), files: list[UploadFile] = File(...)):
        try:
            path_list = json.loads(paths)
        except json.JSONDecodeError as exc:
            raise ValueError('路径列表不是有效 JSON') from exc
        if not isinstance(path_list, list) or not all(isinstance(path, str) for path in path_list):
            raise ValueError('路径列表必须是字符串数组')
        job_id = await library().import_files(course_id, files, path_list)
        return {'job_id': job_id}

    @app.get('/api/import-jobs')
    def jobs():
        return library().jobs()

    @app.get('/api/import-jobs/{job_id}')
    def job(job_id: str):
        result = library().jobs(job_id)
        if not result:
            raise KeyError('导入任务不存在')
        return result[0]

    @app.post('/api/import-jobs/{job_id}/items/{item_id}/retry', status_code=202)
    def retry_job(job_id: str, item_id: str, body: Retry):
        library().retry(job_id, item_id, body.replace_existing)
        return {'ok': True}

    @app.get('/api/search')
    def search(q: str = Query(min_length=1, max_length=500), mode: Literal['all','any','phrase'] = 'all',
               course_id: str | None = None, category: str | None = None,
               document_id: str | None = None, offset: int = Query(0, ge=0),
               limit: int = Query(20, ge=1, le=100), unit_offset: int = Query(0, ge=0), expand: bool = False,
               sort: Literal['relevance', 'category'] = 'relevance'):
        return library().search(q, mode, course_id, category, document_id, offset, limit, unit_offset, expand, sort)

    @app.get('/api/documents/{document_id}/content')
    def content(document_id: str, version: int | None = None):
        doc = document(document_id)
        if version is not None and doc['version'] != version:
            raise HTTPException(409, '资料已更新，请重新搜索或打开资料。')
        if doc['kind'] == 'pdf':
            path = library().db.root / 'files' / doc['blob']
            if not path.is_file():
                raise HTTPException(404, '本地副本缺失，请重新导入资料。')
            return FileResponse(path, media_type='application/pdf', headers={'Cache-Control': 'no-cache'})
        with library().db.connect() as conn:
            units = []
            for row in conn.execute('SELECT id,label,text,anchor FROM units WHERE document_id=? ORDER BY ordinal', (document_id,)):
                units.append({'unit_id': row['id'], 'label': row['label'], 'text': row['text'], 'anchor': json.loads(row['anchor'])})
        return {'document_id': document_id, 'version': doc['version'], 'units': units, 'warning': doc['warning']}

    @app.get('/api/documents/{document_id}/units/{unit_id}')
    def unit(document_id: str, unit_id: str, q: str | None = Query(None, max_length=500),
             mode: Literal['all','any','phrase'] = 'all', version: int | None = None,
             expand: bool = False, course_id: str | None = None, lexicon_version: str | None = None):
        vocabulary = library().workspace.vocabulary() if expand else []
        if expand and lexicon_version and lexicon_version != text_hash(dump(vocabulary)):
            raise HTTPException(409, '词表已更新，请重新搜索以获取一致的命中和高亮。')
        result = library().unit(document_id, unit_id, q, mode, expand, course_id, vocabulary)
        if version is not None and result['version'] != version:
            raise HTTPException(409, '资料已更新，请重新搜索。')
        return result

    install_v2(app, library)

    dist = dist_path or PROJECT / 'frontend' / 'dist'
    if dist.is_dir():
        app.mount('/', StaticFiles(directory=dist, html=True), name='frontend')
    else:
        @app.get('/')
        def no_frontend():
            return JSONResponse({'detail': '前端尚未构建，请先运行安装.command'}, status_code=503)
    return app


app = create_app()
