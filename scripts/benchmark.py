"""Reproducible synthetic performance check, never imports into a user's library."""
from __future__ import annotations

import argparse
import json
import math
import platform
import statistics
import sys
import time
from pathlib import Path

import pymupdf
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import create_app
from backend.library import now, uid


def benchmark(root: Path, files: int, pages: int, runs: int):
    app = create_app(library_path=root, start_worker=False)
    with TestClient(app, headers={'X-Local-Request': '1'}) as client:
        courses = client.get('/api/courses').json()
        course = courses[0]['id'] if courses else client.post('/api/courses', json={'name': 'Synthetic Benchmark'}).json()['id']
        count = len(client.get('/api/documents').json())
        if count == 0:
            start = time.perf_counter()
            for number in range(files):
                document = pymupdf.open()
                for page_number in range(pages):
                    page = document.new_page()
                    lines = [f'Course {number:03d}, page {page_number + 1}: operating systems',
                             'Deadlock requires mutual exclusion and circular wait.',
                             f'Unique identifier: lecture{number:03d}page{page_number + 1:03d}.']
                    lines.extend(['Processes use resource allocation, scheduling, semaphores and memory.'] * 26)
                    page.insert_text((45, 60), '\n'.join(lines), fontsize=10, lineheight=1.4)
                data = document.tobytes(); document.close()
                response = client.post('/api/import-jobs', data={'course_id':course,'paths':json.dumps([f'lecture{number:03d}.pdf'])}, files={'files':(f'lecture{number:03d}.pdf',data)})
                assert response.status_code == 202, response.text
                while app.state.library.process_next():
                    pass
                if (number + 1) % 10 == 0:
                    print(f'Indexed {number + 1}/{files} files ({(number + 1) * pages} pages)', flush=True)
            index_seconds = time.perf_counter() - start
        else:
            index_seconds = None
        results = []
        for query, mode in [('deadlock','all'),('mutual exclusion','phrase'),('deadlock circular','all'),
                            ('deadlock nonexistent','any'),('lecture042page017','all'),('不存在','all')]:
            durations = []
            hits = 0
            for _ in range(runs):
                start = time.perf_counter()
                response = client.get('/api/search', params={'q':query,'mode':mode})
                durations.append((time.perf_counter() - start) * 1000)
                assert response.status_code == 200, response.text
                hits = response.json()['total_hits']
            results.append({'query':query, 'mode':mode, 'hits':hits,
                            'median_ms':round(statistics.median(durations),2),
                            'p95_ms':round(sorted(durations)[math.ceil(len(durations)*.95)-1],2)})
        stats = client.get('/api/stats').json()
        report = {'kind':'synthetic, warm-cache API benchmark (not real course acceptance)',
                  'platform':platform.platform(),'python':platform.python_version(),
                  'files':stats['documents'],'pages':stats['units'],'runs_per_query':runs,
                  'index_seconds':index_seconds,'search':results,
                  'english_p95_under_1_second':all(row['p95_ms'] <= 1000 for row in results[:-1])}
        path = root.parent / 'benchmark-report.json'
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('.local/benchmark/library'))
    parser.add_argument('--files', type=int, default=100)
    parser.add_argument('--pages', type=int, default=30)
    parser.add_argument('--runs', type=int, default=20)
    args = parser.parse_args()
    benchmark(args.root, args.files, args.pages, args.runs)
