"""Round-trip the DMG and verify chat/console Apps and ad-hoc signatures."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']

def digest(file):
    checksum = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()

def run(args):
    result = subprocess.run([str(value) for value in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stdout[-3000:] + '\n' + result.stderr[-3000:])
    return result

def code_directory(file, resources=None, info=None):
    data = file.read_bytes()
    assert data[:4] == b'\xcf\xfa\xed\xfe' and struct.unpack_from('<I', data, 4)[0] == 0x0100000c
    offset, signature = 32, None
    for _ in range(struct.unpack_from('<I', data, 16)[0]):
        command, size = struct.unpack_from('<II', data, offset)
        assert size >= 8
        if command == 0x1d:
            start, length = struct.unpack_from('<II', data, offset + 8)
            signature = data[start:start + length]
        offset += size
    assert signature is not None
    magic, length, count = struct.unpack_from('>III', signature)
    assert magic == 0xfade0cc0 and length <= len(signature)
    blobs = {}
    for index in range(count):
        kind, start = struct.unpack_from('>II', signature, 12 + index * 8)
        blob_length = struct.unpack_from('>I', signature, start + 4)[0]
        blobs[kind] = signature[start:start + blob_length]
    directory = blobs[0]
    assert struct.unpack_from('>I', directory)[0] == 0xfade0c02
    _, flags, hashes, identifier, specials, pages, limit = struct.unpack_from('>7I', directory, 8)
    hash_size, hash_type, _, page_bits = struct.unpack_from('4B', directory, 36)
    algorithm = {1: 'sha1', 2: 'sha256', 3: 'sha256'}[hash_type]
    calculate = lambda value: hashlib.new(algorithm, value).digest()[:hash_size]
    page_size = 1 << page_bits
    assert pages == math.ceil(limit / page_size) and limit <= len(data)
    for index in range(pages):
        actual = calculate(data[index * page_size:min((index + 1) * page_size, limit)])
        assert actual == directory[hashes + index * hash_size:hashes + (index + 1) * hash_size], 'Executable page hash mismatch'
    if resources is not None:
        assert flags & 2, 'The unsigned release must use ad-hoc signing, not pretend to have Developer ID'
        assert not blobs.get(0x10000) or len(blobs[0x10000]) <= 8
        for slot, file in [(1, info), (3, resources)]:
            assert specials >= slot
            assert calculate(file.read_bytes()) == directory[hashes - slot * hash_size:hashes - (slot - 1) * hash_size]
    identity = directory[identifier:directory.index(b'\0', identifier)].decode()
    return hashlib.new(algorithm, directory).digest()[:20], identity, pages

ENTRIES = [('official', 'chatgpt-official'), ('api', 'chatgpt-api'), ('apionly', 'chatgpt-apionly'), ('console', 'chatgpt-console')]

def validate_app(volume, entry, name):
    app = volume / (name + '.app')
    contents = app / 'Contents'
    info = plistlib.loads((contents / 'Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'local.chatgpt-api.' + entry
    assert info['CFBundleExecutable'] == name
    assert info['CFBundlePackageType'] == 'APPL' and info['CFBundleShortVersionString'] == VERSION
    privacy_keys = ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription', 'NSAudioCaptureUsageDescription',
                    'NSAppleEventsUsageDescription', 'NSAppDataUsageDescription',
                    'NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription']
    assert all(isinstance(info.get(key), str) and info[key].strip() for key in privacy_keys), 'Missing a native feature privacy purpose string'
    launcher = contents / 'MacOS' / name
    assert launcher.stat().st_mode & 0o111
    resources = contents / 'Resources'
    assert info['CFBundleIconFile'] == 'ChatGPT.icns' and info['CFBundleIconName'] == 'Icon'
    assert (resources / 'ChatGPT.icns').read_bytes() == (ROOT / 'assets/ChatGPT.icns').read_bytes()
    assert (resources / 'Assets.car').read_bytes() == (ROOT / 'assets/macos/Assets.car').read_bytes()
    assert (resources / 'gui.mjs').read_bytes() == (ROOT / 'macos/dmg/gui.mjs').read_bytes()
    metadata = json.loads((resources / 'dmg-build.json').read_text())
    assert metadata['notarized'] is False and metadata['developerID'] is False
    assert metadata['signature'] == 'ad-hoc'
    assert metadata['entryMode'] == entry and metadata['entry'] == name + '.app'
    assert metadata['launcherSourceSHA256'] == digest(ROOT / 'macos/dmg/launcher.c')
    assert metadata['guiSourceSHA256'] == digest(ROOT / 'macos/dmg/gui.mjs')
    release = resources / 'release'
    assert metadata['manifestSHA256'] == digest(release / 'release.json')
    manifest = json.loads((release / 'release.json').read_text())
    assert manifest['product'] == 'chatgpt-apionly-provider' and manifest['platform'] == 'darwin-arm64'
    assert manifest['version'] == VERSION and metadata['version'] == VERSION
    expected = {entry['path'] for entry in manifest['files']}
    actual = {file.relative_to(release / 'payload').as_posix() for file in (release / 'payload').rglob('*') if file.is_file()}
    assert expected == actual
    for entry in manifest['files']:
        file = release / 'payload' / entry['path']
        assert not file.is_symlink() and digest(file) == entry['sha256']
        assert not set(file.relative_to(app).parts) & {'data', '.env', 'auth.json', '.codex', '.git', 'tests'}
        assert file.stat().st_mode & 0o777 == entry['mode'], 'Executable permission mismatch: ' + entry['path']
        if entry['path'].split('/')[0] != 'runtime':
            assert file.read_bytes() == (ROOT / entry['path']).read_bytes(), 'Payload is not the current source: ' + entry['path']
    node = release / 'payload/runtime/node'
    assert node.read_bytes()[:4] == b'\xcf\xfa\xed\xfe'
    envelope_file = contents / '_CodeSignature/CodeResources'
    envelope = plistlib.loads(envelope_file.read_bytes())
    sealed = set(envelope['files2'])
    required_seals = {'Resources/gui.mjs', 'Resources/dmg-build.json', 'Resources/release/release.json', 'Resources/ChatGPT.icns', 'Resources/Assets.car'}
    required_seals |= {'Resources/release/payload/' + entry['path'] for entry in manifest['files']}
    assert required_seals <= sealed, 'Required App resources are not sealed'
    for relative, record in envelope['files2'].items():
        file = contents / relative
        assert '..' not in Path(relative).parts
        if isinstance(record, bytes):
            assert hashlib.sha1(file.read_bytes()).digest() == record
        elif 'hash2' in record:
            assert hashlib.sha256(file.read_bytes()).digest() == record['hash2']
        elif 'hash' in record:
            assert hashlib.sha1(file.read_bytes()).digest() == record['hash']
        elif 'cdhash' in record:
            assert code_directory(file)[0] == record['cdhash']
        elif 'symlink' in record:
            assert file.readlink().as_posix() == record['symlink']
        else:
            raise AssertionError('Unknown resource envelope record: ' + relative)
    _, identifier, pages = code_directory(launcher, envelope_file, contents / 'Info.plist')
    assert identifier == info['CFBundleIdentifier']
    assert (volume / 'README.txt').read_bytes() == (ROOT / 'docs/macos-dmg-readme.md').read_bytes()
    return {'entry': name + '.app', 'entryMode': metadata['entryMode'], 'programFiles': len(manifest['files']), 'privacyUsageKeys': privacy_keys,
            'signedLauncherPagesVerified': pages, 'manifestSHA256': metadata['manifestSHA256']}

def validate_volume(volume):
    assert {file.name for file in volume.iterdir()} == {name + '.app' for _, name in ENTRIES} | {'Applications', 'README.txt'}
    link = volume / 'Applications'
    assert link.is_symlink() and link.readlink().as_posix() == '/Applications'
    results = [validate_app(volume, entry, name) for entry, name in ENTRIES]
    assert len({item['manifestSHA256'] for item in results}) == 1, 'Entries have different provider programs'
    assert (volume / 'README.txt').read_bytes() == (ROOT / 'docs/macos-dmg-readme.md').read_bytes()
    return results

def check(args):
    archive = args.archive.resolve()
    with archive.open('rb') as stream:
        stream.seek(-512, 2); assert stream.read(4) == b'koly', 'Not a UDIF image'
    with tempfile.TemporaryDirectory(prefix='chatgpt-dmg-test-') as temporary:
        work = Path(temporary)
        assert work.resolve().name.startswith('chatgpt-dmg-test-')
        volume = work / 'volume'; volume.mkdir()
        if sys.platform == 'darwin':
            run(['/usr/bin/hdiutil', 'verify', archive])
            run(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', volume, archive])
            try:
                result = validate_volume(volume)
                for _, name in ENTRIES:
                    run(['/usr/bin/codesign', '--verify', '--strict', volume / (name + '.app')])
            finally:
                run(['/usr/bin/hdiutil', 'detach', volume])
        else:
            dmgtool = args.dmgtool or shutil.which('dmg')
            hfsplus = args.hfsplus or shutil.which('hfsplus')
            assert dmgtool and hfsplus, 'Provide --dmgtool and --hfsplus on Linux/WSL'
            raw = work / 'roundtrip.hfs'
            run([dmgtool, 'extract', archive, raw])
            run([hfsplus, raw, 'extractall', '/', volume])
            result = validate_volume(volume)
    return {'passed': True, 'archive': str(archive), 'bytes': archive.stat().st_size, 'entries': result, 'hostPlatform': sys.platform, 'notarized': False,
            'scope': 'Three chat Apps and a console App, current payload, official Mac icon resources and signature hashes; Gatekeeper approval and native GUI not executed.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--dmgtool')
    parser.add_argument('--hfsplus')
    print(json.dumps(check(parser.parse_args()), indent=2))
