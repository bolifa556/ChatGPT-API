"""Validate the macOS archive without executing its Mach-O binary."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def check(file):
    checksum = hashlib.sha256(file.read_bytes()).hexdigest()
    assert Path(str(file) + '.sha256').read_text().split()[0] == checksum
    with tarfile.open(file, 'r:gz') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        assert len(names) == len(set(names)), 'Duplicate archive members'
        prefix = names[0].split('/')[0]
        manifest = json.load(archive.extractfile(prefix + '/release.json'))
        assert manifest['product'] == 'chatgpt-apionly-provider'
        assert manifest['version'] == json.loads((ROOT / 'package.json').read_text())['version']
        assert manifest['platform'] == 'darwin-arm64'
        assert archive.extractfile(prefix + '/architecture').read() == b'arm64\n'
        for member in members:
            parts = PurePosixPath(member.name).parts
            assert not member.name.startswith('/') and '..' not in parts
            assert member.isdir() or member.isfile(), 'Links and devices must not ship'
            assert not set(parts) & {'data', '.git', '.github', 'tests', '.env', '__pycache__', 'linux'}
            assert not member.name.endswith(('.exe', '.dll', '.ps1', '.vbs', '.cmd'))
        entries = {entry['path']: entry for entry in manifest['files']}
        assert len(entries) == len(manifest['files'])
        actual = {member.name[len(prefix + '/payload/'):] for member in members if member.isfile() and member.name.startswith(prefix + '/payload/')}
        assert set(entries) == actual, 'Manifest does not match complete payload'
        for relative, entry in entries.items():
            member = archive.getmember(prefix + '/payload/' + relative)
            content = archive.extractfile(member).read()
            assert len(content) == entry['bytes'] and hashlib.sha256(content).hexdigest() == entry['sha256']
            assert member.mode == entry['mode']
            if relative.startswith(('src/', 'macos/', 'assets/')) or relative in ('package.json', 'package-lock.json'):
                assert content == (ROOT / relative).read_bytes(), 'Archive differs from current source: ' + relative
        node = archive.extractfile(prefix + '/payload/runtime/node').read()
        assert node[:4] == b'\xcf\xfa\xed\xfe', 'Node must be a 64-bit little-endian Mach-O executable'
        assert struct.unpack_from('<I', node, 4)[0] == 0x0100000c, 'Wrong CPU architecture'
        assert struct.unpack_from('<I', node, 12)[0] == 2, 'Wrong Mach-O file type'
        runtime = json.loads((ROOT / 'assets/runtime-macos.json').read_text())
        official = ROOT / 'data/cache' / f'node-v{runtime["version"]}-darwin-arm64.tar.gz'
        assert hashlib.sha256(official.read_bytes()).hexdigest() == runtime['arm64']['sha256']
        with tarfile.open(official, 'r:gz') as source:
            assert node == source.extractfile(f'node-v{runtime["version"]}-darwin-arm64/bin/node').read(), 'Official Node binary/signature was changed'
        for name, source in [('install.sh', 'macos/install.sh'), ('Install.command', 'macos/Install.command'), ('payload/macos/chatgpt-apionly', 'macos/chatgpt-apionly')]:
            member = archive.getmember(prefix + '/' + name)
            script = archive.extractfile(member).read()
            assert member.mode == 0o755 and script.startswith(b'#!/bin/sh\n') and b'\r' not in script
            assert script == (ROOT / source).read_bytes()
        assert archive.getmember(prefix + '/payload/runtime/node').mode == 0o755
        assert archive.extractfile(prefix + '/setup/install.mjs').read() == (ROOT / 'macos/setup.mjs').read_bytes()
        assert archive.extractfile(prefix + '/README.md').read() == (ROOT / 'docs/macos-readme.md').read_bytes()
        assert b'Node.js' in archive.extractfile(prefix + '/payload/runtime/LICENSE.txt').read()
        assert b'chatgpt-apionly' in archive.extractfile(prefix + '/README.md').read()
    return {'passed': True, 'archive': str(file), 'architecture': 'arm64', 'payloadFiles': len(entries), 'sha256': checksum,
            'scope': 'Archive, source, permissions and byte-identical official Mach-O validation; native execution not performed.'}

if __name__ == '__main__':
    results = [check(Path(name)) for name in sys.argv[1:]]
    assert results, 'Provide the macOS tar.gz archive'
    print(json.dumps(results, indent=2))
