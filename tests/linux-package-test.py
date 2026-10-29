"""Check both Linux archives without executing a foreign-architecture binary."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def check(file):
    with tarfile.open(file, 'r:gz') as archive:
        members = archive.getmembers()
        names = [item.name for item in members]
        assert len(names) == len(set(names)), 'Duplicate archive members'
        prefix = names[0].split('/')[0]
        manifest = json.load(archive.extractfile(prefix + '/release.json'))
        architecture = manifest['platform'].removeprefix('linux-')
        assert architecture in ('x64', 'arm64')
        assert archive.extractfile(prefix + '/architecture').read() == (architecture + '\n').encode()
        for member in members:
            parts = Path(member.name).parts
            assert not member.name.startswith('/') and '..' not in parts
            assert member.isdir() or member.isfile(), 'Links and devices must not ship'
            assert not set(parts) & {'data', '.git', '.github', 'tests', '.env', '__pycache__'}
            assert not member.name.endswith(('.exe', '.dll', '.ps1', '.vbs', '.cmd'))
        entries = {item['path']: item for item in manifest['files']}
        actual = {item.name[len(prefix + '/payload/'):] for item in members if item.isfile() and item.name.startswith(prefix + '/payload/')}
        assert set(entries) == actual, 'Manifest does not match the complete payload'
        for relative, entry in entries.items():
            member = archive.getmember(prefix + '/payload/' + relative)
            content = archive.extractfile(member).read()
            assert len(content) == entry['bytes'] and hashlib.sha256(content).hexdigest() == entry['sha256']
            assert member.mode == entry['mode']
            if relative.startswith('src/') or relative.startswith('assets/') or relative.startswith('linux/'):
                assert content == (ROOT / relative).read_bytes(), 'Archive differs from current source: ' + relative
        node = archive.extractfile(prefix + '/payload/runtime/node').read(64)
        assert node[:6] == b'\x7fELF\x02\x01'
        assert struct.unpack('<H', node[18:20])[0] == {'x64': 62, 'arm64': 183}[architecture]
        assert archive.getmember(prefix + '/payload/runtime/node').mode == 0o755
        installer = archive.extractfile(prefix + '/install.sh').read()
        assert installer.startswith(b'#!/bin/sh\n') and b'\r' not in installer
        assert archive.getmember(prefix + '/install.sh').mode == 0o755
        assert b'Node.js' in archive.extractfile(prefix + '/payload/runtime/LICENSE.txt').read()
    return {'passed': True, 'archive': str(file), 'architecture': architecture, 'payloadFiles': len(entries)}

if __name__ == '__main__':
    results = [check(Path(name)) for name in sys.argv[1:]]
    assert results, 'Provide one or more Linux .tar.gz archives'
    print(json.dumps(results, indent=2))
