#!/usr/local/lib/hermes-agent/venv/bin/python
"""Relay new Seerr fork updater events from pve1 to Telegram.

Hermes runs this as a script-only cron job; whatever it prints is delivered.
Quiet runs print nothing. Copy lives in the fork at fork/hermes/.
"""
import json
from pathlib import Path
import subprocess

CURSOR = Path('/root/.hermes/cron/seerr-fork-update-cursor.json')
CMD = ['/root/.hermes/scripts/pve.sh', 'ssh',
       'tail -n 60 /var/log/seerr-fork-update-events.jsonl 2>/dev/null || true']
ICONS = {'updated': '✅', 'deployed': '✅', 'conflict': '⚠️', 'push_failed': '⚠️',
         'build_failed': '🚨', 'deploy_failed': '🚨', 'error': '🚨'}


def load():
    try:
        return json.loads(CURSOR.read_text())
    except Exception:
        return {'seen': [], 'remote_failures': 0, 'remote_alerted': False}


def save(state):
    CURSOR.parent.mkdir(parents=True, exist_ok=True)
    tmp = CURSOR.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, sort_keys=True) + '\n')
    tmp.replace(CURSOR)


state = load()
try:
    p = subprocess.run(CMD, text=True, capture_output=True, timeout=35)
    if p.returncode != 0:
        raise RuntimeError(f'pve1 query exited {p.returncode}')
    records = []
    for line in p.stdout.splitlines():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if isinstance(r, dict) and r.get('id'):
            records.append(r)
    seen = set(state.get('seen', []))
    fresh = [r for r in records if r['id'] not in seen]
    state['seen'] = [r['id'] for r in records][-100:]
    if state.get('remote_alerted'):
        fresh.insert(0, {'kind': 'deployed', 'message': 'Seerr updater monitor can reach pve1 again.'})
    state.update(remote_failures=0, remote_alerted=False)
    save(state)
    if fresh:
        print('\n'.join(f"{ICONS.get(r.get('kind'), 'ℹ️')} {r.get('message')}" for r in fresh))
except Exception as exc:
    state['remote_failures'] = int(state.get('remote_failures', 0)) + 1
    if state['remote_failures'] >= 4 and not state.get('remote_alerted'):
        print(f'⚠️ Seerr updater monitor cannot read pve1: {type(exc).__name__}: {exc}')
        state['remote_alerted'] = True
    save(state)
