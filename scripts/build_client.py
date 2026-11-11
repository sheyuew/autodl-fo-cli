#!/usr/bin/env python3
"""Build a member-only download with a fixed file allowlist and no settings."""
import hashlib
import json
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
    raise SystemExit('Invalid release version')
files = [root / p for p in ('fo', 'cli.mjs', 'package.json', 'README.md',
                            'THIRD_PARTY.md', '开始使用.command')]
files += sorted((root / 'lib').glob('*.mjs'))
files += sorted((root / 'docs').glob('*.md'))
files += sorted((root / 'examples').glob('*.json'))
dest = root / 'dist' / f'autodl-fo-cli-v{version}.zip'
dest.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(dest, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in files:
        if file.is_symlink() or not file.is_file():
            raise SystemExit(f'Expected regular source file: {file}')
        info = zipfile.ZipInfo('autodl-fo-cli/' + file.relative_to(root).as_posix(),
                               date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        executable = file.name in ('fo', 'cli.mjs', '开始使用.command')
        info.external_attr = (0o100755 if executable else 0o100644) << 16
        archive.writestr(info, file.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
digest = hashlib.sha256(dest.read_bytes()).hexdigest()
dest.with_suffix('.zip.sha256').write_text(digest + '  ' + dest.name + '\n')
print(dest)
print('SHA256 ' + digest)
