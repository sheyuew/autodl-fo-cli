"""Exercise real terminal Ctrl+C handling; SSH/browser boundaries stay local."""
import fcntl
import base64
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLIENT = Path(os.environ.get('FO_TEST_CLIENT', ROOT))


class Terminal:
    def __init__(self, args, env):
        self.master, slave = pty.openpty()

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            [shutil.which('node'), str(CLIENT / 'cli.mjs'), *args],
            stdin=slave, stdout=slave, stderr=slave, cwd=CLIENT, env=env,
            preexec_fn=controlling_terminal,
        )
        os.close(slave)
        self.output = b''

    def expect(self, text, timeout=10):
        until = time.monotonic() + timeout
        needle = text.encode()
        while needle not in self.output:
            remaining = until - time.monotonic()
            if remaining <= 0:
                raise AssertionError('Terminal did not show: ' + text + '\n' + self.transcript())
            ready, _, _ = select.select([self.master], [], [], remaining)
            if ready:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    data = b''
                if not data:
                    raise AssertionError('Terminal exited before: ' + text + '\n' + self.transcript())
                self.output += data

    def send(self, text):
        os.write(self.master, text.encode())

    def transcript(self):
        return self.output.decode(errors='replace')

    def drain(self):
        while select.select([self.master], [], [], 0)[0]:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            self.output += data

    def close(self):
        os.close(self.master)
        if self.process.poll() is None:
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)


class TerminalControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fo-terminal-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        bin_dir = self.home / 'bin'
        bin_dir.mkdir()
        self.audit = self.home / 'rpc.jsonl'
        fake_ssh = '''#!/usr/bin/env python3
import json, socket, sys
from pathlib import Path
if '-L' in sys.argv:
    address=sys.argv[sys.argv.index('-L')+1]
    listener=socket.socket()
    listener.bind(('127.0.0.1',int(address.split(':')[1])))
    listener.listen()
    while True:
        connection,_=listener.accept()
        connection.close()
q=json.loads(sys.stdin.read())
with Path(AUDIT).open('a') as f:f.write(json.dumps(q)+'\\n')
if sys.argv[-1]=='fo-enroll':
    import base64
    key='ssh-ed25519 '+base64.b64encode(bytes.fromhex('0000000b')+b'ssh-ed25519'+bytes.fromhex('00000020')+bytes([7])*32).decode()
    result={'kind':'fo-cli-invite','version':1,'host':'fo-u-fixture@example.test','port':22,'serverHostKey':key}
elif q['op']=='notifications':result={'events':[],'cursor':0}
elif q['op']=='login':result={'port':6081,'password':'LOCAL-TEST','tenant':'fixture'}
elif q['op']=='login-password':result={'state':'authenticated','account':'fixture:alice@fixture'}
elif q['op']=='viewer':result={'port':6081,'password':'LOCAL-TEST','tenant':'fixture'}
elif q['op']=='status':result={'account':'fixture:alice@fixture','tasks':[]}
elif q['op']=='activate':result={'tenant':'fixture','account':'fixture:test','fo':True}
else:raise RuntimeError('Unexpected operation: '+q['op'])
print(json.dumps({'ok':True,'result':result}))
'''.replace('AUDIT', repr(str(self.audit)))
        (bin_dir / 'ssh').write_text(fake_ssh)
        (bin_dir / 'ssh').chmod(0o755)
        for name in ('open', 'xdg-open'):
            file = bin_dir / name
            file.write_text('#!/bin/sh\nexit 0\n')
            file.chmod(0o755)
        config = self.home / 'config.json'
        config.write_text(json.dumps({
            'host': 'fo-u-fixture@example.test', 'port': 22,
            'identityFile': str(self.home / 'unused-test-key'), 'protocol': 'multi-v1',
        }))
        self.env = {**os.environ, 'FO_CONFIG': str(config), 'FO_CLI_HOME': str(self.home),
                    'PATH': str(bin_dir) + os.pathsep + os.environ['PATH']}

    def session(self, args):
        terminal = Terminal(args, self.env)
        self.addCleanup(terminal.close)
        return terminal

    def stopped(self, terminal):
        terminal.send('\x03')
        until = time.monotonic() + 4
        while terminal.process.poll() is None and time.monotonic() < until:
            if select.select([terminal.master], [], [], 0.05)[0]:
                terminal.drain()
        code = terminal.process.poll()
        if code is None:
            terminal.drain()
            requests = self.audit.read_text() if self.audit.exists() else '(no RPC)'
            self.fail('Ctrl+C did not stop the local client within 4 seconds\n' + terminal.transcript() + '\nRPC: ' + requests)
        self.assertEqual(code, 0, terminal.transcript())

    def test_direct_watch_ctrl_c_exits_cleanly(self):
        terminal = self.session(['watch'])
        terminal.expect('等待服务器通知')
        self.stopped(terminal)

    def test_menu_watch_ctrl_c_exits_cleanly(self):
        terminal = self.session([])
        terminal.expect('选择序号: ')
        terminal.send('4\n')
        terminal.expect('等待服务器通知')
        self.stopped(terminal)

    def test_menu_browser_ctrl_c_closes_viewer(self):
        terminal = self.session([])
        terminal.expect('选择序号: ')
        terminal.send('5\n')
        terminal.expect('已打开独立浏览器')
        self.stopped(terminal)
        requests = [json.loads(line)['op'] for line in self.audit.read_text().splitlines()]
        self.assertEqual(requests, ['viewer'])

    def test_terminal_login_hides_password_and_saves_only_account_and_connection(self):
        terminal = self.session(['login'])
        terminal.expect('AutoDL 账号')
        terminal.send('alice@fixture\n')
        terminal.expect('AutoDL 密码')
        terminal.send('private-test-password\n')
        terminal.expect('登录成功')
        terminal.expect('选择序号: ')
        terminal.send('2\n')
        until = time.monotonic() + 4
        while terminal.process.poll() is None and time.monotonic() < until:
            terminal.drain()
            time.sleep(0.02)
        self.assertEqual(terminal.process.poll(), 0, terminal.transcript())
        self.assertNotIn('private-test-password', terminal.transcript())
        saved = (self.home / 'accounts.json').read_text()
        self.assertIn('alice@fixture', saved)
        self.assertNotIn('private-test-password', saved)

    def test_invite_then_account_password_enters_menu_without_manual_key_steps(self):
        b64 = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        key = 'ssh-ed25519 ' + base64.b64encode(bytes.fromhex('0000000b') + b'ssh-ed25519' + bytes.fromhex('00000020') + bytes([7]) * 32).decode()
        payload = {'v': 1, 'i': '1' * 32, 't': 'fixture', 'h': 'example.test', 'p': 22,
                   'k': key, 's': b64(bytes([3]) * 32), 'e': int(time.time() * 1000) + 3600000}
        code = 'FO1-' + b64(json.dumps(payload).encode())
        (self.home / 'config.json').unlink()
        terminal = self.session([])
        terminal.expect('粘贴一次性邀请码')
        terminal.send(code + '\n')
        terminal.expect('AutoDL 账号')
        terminal.send('alice@fixture\n')
        terminal.expect('AutoDL 密码')
        terminal.send('private-test-password\n')
        terminal.expect('登录成功')
        terminal.expect('选择序号: ')
        terminal.send('2\n')
        until = time.monotonic() + 4
        while terminal.process.poll() is None and time.monotonic() < until:
            terminal.drain()
            time.sleep(0.02)
        self.assertEqual(terminal.process.poll(), 0, terminal.transcript())
        self.assertNotIn(code, terminal.transcript())
        self.assertNotIn('private-test-password', terminal.transcript())
        config = json.loads((self.home / 'config.json').read_text())
        self.assertTrue(Path(config['identityFile']).is_file())
        requests = [json.loads(line) for line in self.audit.read_text().splitlines()]
        self.assertEqual(list(requests[0]), ['publicKey'])
        self.assertEqual([r['op'] for r in requests[1:]], ['login-password', 'status'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
