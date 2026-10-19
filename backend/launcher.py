"""Double-click launcher; starts one loopback server, reuses it, opens browser."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.local'


def healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(url + '/api/health', timeout=1) as response:
            return json.load(response).get('app') == 'course-search'
    except (OSError, ValueError, urllib.error.URLError):
        return False


def read_state() -> dict:
    try:
        return json.loads((RUNTIME / 'server.json').read_text('utf-8'))
    except (OSError, ValueError):
        return {}


def main():
    parser = argparse.ArgumentParser(description='书间 本地课程资料检索')
    parser.add_argument('--stop', action='store_true', help='停止本项目的本地服务')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    RUNTIME.mkdir(exist_ok=True)
    if args.stop:
        state = read_state()
        if state.get('pid') and state.get('url') and healthy(state['url']):
            os.kill(state['pid'], signal.SIGINT)
            print('已请求停止书间服务。')
        else:
            print('书间服务未运行。')
        return
    if not (ROOT / 'frontend' / 'dist' / 'index.html').exists():
        sys.exit('尚未完成安装，请先双击「安装.command」。')
    lock = (RUNTIME / 'server.lock').open('a+')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        for _ in range(30):
            state = read_state()
            if state.get('url') and healthy(state['url']):
                print('书间已启动：' + state['url'])
                if not args.no_browser:
                    webbrowser.open(state['url'])
                return
            time.sleep(.2)
        sys.exit('已有服务正在启动或退出，请稍后再次打开。')
    import uvicorn
    from .app import create_app
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(('127.0.0.1', 8765))
    except OSError:
        sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    state_path = RUNTIME / 'server.json'
    state_path.write_text(json.dumps({'pid': os.getpid(), 'url': url}), 'utf-8')
    print(f'\n书间 · 本地课程检索\n{url}\n请保留此窗口。按 Control+C 或双击「停止.command」退出。\n', flush=True)

    def open_when_ready():
        for _ in range(100):
            if healthy(url):
                webbrowser.open(url)
                return
            time.sleep(.1)

    if not args.no_browser:
        threading.Thread(target=open_when_ready, daemon=True).start()
    try:
        config = uvicorn.Config(create_app(), host='127.0.0.1', port=port, log_level='info', access_log=False)
        uvicorn.Server(config).run(sockets=[sock])
    finally:
        sock.close()
        state_path.unlink(missing_ok=True)
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


if __name__ == '__main__':
    main()
