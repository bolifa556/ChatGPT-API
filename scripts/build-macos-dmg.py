"""Package the frozen 3.0.9 provider as a native App in one real UDIF/HFS+ DMG."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def digest(file):
    checksum = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()

def run(args):
    result = subprocess.run([str(value) for value in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'Build command failed: {args[0]}\n{result.stdout[-5000:]}\n{result.stderr[-5000:]}')
    return result

def require_tool(value, default):
    candidate = value or shutil.which(default)
    if not candidate or not Path(candidate).is_file():
        raise RuntimeError(f'Build tool is missing: {default}')
    return Path(candidate).resolve()

def extract_provider(archive_path, release):
    expected = Path(str(archive_path) + '.sha256').read_text().split()[0]
    if digest(archive_path) != expected:
        raise RuntimeError('Provider archive SHA-256 mismatch.')
    with tarfile.open(archive_path, 'r:gz') as archive:
        prefix = archive.getmembers()[0].name.split('/')[0]
        manifest_bytes = archive.extractfile(prefix + '/release.json').read()
        manifest = json.loads(manifest_bytes)
        if manifest.get('product') != 'chatgpt-apionly-provider' or manifest.get('platform') != 'darwin-arm64':
            raise RuntimeError('This DMG requires the Apple Silicon API-only provider.')
        release.mkdir(parents=True)
        (release / 'release.json').write_bytes(manifest_bytes)
        seen = set()
        for entry in manifest['files']:
            relative = entry['path']
            parts = PurePosixPath(relative).parts
            if relative in seen or '\\' in relative or relative.startswith('/') or any(part in ('..', '.', 'data', '.env', '.git') for part in parts):
                raise RuntimeError('Unsafe provider path.')
            if parts[0] not in ('src', 'macos', 'runtime', 'assets', 'node_modules', 'package.json', 'package-lock.json'):
                raise RuntimeError('Unexpected provider program path.')
            seen.add(relative)
            member = archive.getmember(prefix + '/payload/' + relative)
            if not member.isfile() or entry['mode'] not in (0o644, 0o755):
                raise RuntimeError('Provider entries must be regular program files.')
            content = archive.extractfile(member).read()
            if len(content) != entry['bytes'] or hashlib.sha256(content).hexdigest() != entry['sha256']:
                raise RuntimeError('Provider program checksum mismatch: ' + relative)
            target = release / 'payload' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(entry['mode'])
    return manifest, expected

def verify_payload(release, manifest):
    for entry in manifest['files']:
        if digest(release / 'payload' / entry['path']) != entry['sha256']:
            raise RuntimeError('Packaging changed the frozen provider: ' + entry['path'])

def build(args):
    if sys.platform not in ('darwin', 'linux'):
        raise RuntimeError('Build on macOS, or run this script through WSL/Linux.')
    package = json.loads((ROOT / 'package.json').read_text())
    version = package['version']
    source = args.provider_archive or ROOT / 'release' / f'ChatGPT-API-Provider-{version}-macos-arm64.tar.gz'
    source = source.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f'ChatGPT-API-Provider-{version}-macos-arm64.dmg'
    if destination.exists():
        raise RuntimeError('Release already exists: ' + str(destination))
    native = sys.platform == 'darwin'
    if native:
        compiler = ['/usr/bin/xcrun', 'clang', '-arch', 'arm64', '-mmacosx-version-min=13.5']
    else:
        compiler = [require_tool(args.zig, 'zig'), 'cc', '-target', 'aarch64-macos.13.5']
        rcodesign = require_tool(args.rcodesign, 'rcodesign')
        mkfs = require_tool(args.mkfs_hfsplus, 'mkfs.hfsplus')
        hfsplus = require_tool(args.hfsplus, 'hfsplus')
        dmgtool = require_tool(args.dmgtool, 'dmg')
    # Use a POSIX filesystem for executable permissions, not a Windows mount.
    with tempfile.TemporaryDirectory(prefix='chatgpt-apionly-dmg-') as temporary:
        work = Path(temporary)
        stage = work / 'volume'
        app = stage / 'chatgpt-apionly.app'
        contents = app / 'Contents'
        resources = contents / 'Resources'
        (contents / 'MacOS').mkdir(parents=True)
        resources.mkdir()
        release = resources / 'release'
        manifest, archive_sha = extract_provider(source, release)
        if manifest['version'] != version:
            raise RuntimeError('Provider version does not match package.json.')
        launcher = contents / 'MacOS/chatgpt-apionly'
        run([*compiler, '-Os', ROOT / 'macos/dmg/launcher.c', '-o', launcher])
        launcher.chmod(0o755)
        header = launcher.read_bytes()[:16]
        if header[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', header, 4)[0] != 0x0100000c:
            raise RuntimeError('The App launcher is not an ARM64 Mach-O binary.')
        shutil.copyfile(ROOT / 'macos/dmg/gui.mjs', resources / 'gui.mjs')
        info = {'CFBundleIdentifier': 'local.chatgpt-api.apionly', 'CFBundleName': 'chatgpt-apionly',
                'CFBundleDisplayName': 'chatgpt-apionly', 'CFBundleExecutable': 'chatgpt-apionly',
                'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': version,
                'LSMinimumSystemVersion': '13.5', 'LSUIElement': True, 'NSHighResolutionCapable': True}
        (contents / 'Info.plist').write_bytes(plistlib.dumps(info, sort_keys=True))
        metadata = {'schemaVersion': 1, 'version': version, 'platform': 'darwin-arm64',
                    'entry': 'chatgpt-apionly.app', 'providerArchiveSHA256': archive_sha,
                    'launcherSourceSHA256': digest(ROOT / 'macos/dmg/launcher.c'),
                    'guiSourceSHA256': digest(ROOT / 'macos/dmg/gui.mjs'),
                    'signature': 'ad-hoc', 'developerID': False, 'notarized': False}
        (resources / 'dmg-build.json').write_text(json.dumps(metadata, indent=2) + '\n')
        if native:
            run(['/usr/bin/codesign', '--force', '--sign', '-', app])
            run(['/usr/bin/codesign', '--verify', '--strict', app])
        else:
            run([rcodesign, 'sign', '--config-file', '/dev/null', '--exclude', '**', '--timestamp-url', 'none', app])
        # Signing the wrapper must not re-sign Node or mutate the provider.
        verify_payload(release, manifest)
        (stage / 'Applications').symlink_to('/Applications', target_is_directory=True)
        shutil.copyfile(ROOT / 'docs/macos-dmg-readme.md', stage / 'README.txt')
        if native:
            partial = work / 'distribution.dmg'
            run(['/usr/bin/hdiutil', 'create', '-srcfolder', stage, '-volname', 'chatgpt-apionly ' + version,
                 '-fs', 'HFS+', '-format', 'UDZO', partial])
            run(['/usr/bin/hdiutil', 'verify', partial])
        else:
            raw = work / 'volume.hfs'
            payload_bytes = sum(file.stat().st_size for file in stage.rglob('*') if file.is_file() and not file.is_symlink())
            size = ((int(payload_bytes * 1.4) + 64 * 1024 * 1024 + 4095) // 4096) * 4096
            with raw.open('wb') as stream:
                stream.truncate(size)
            run([mkfs, '-v', 'chatgpt-apionly ' + version, raw])
            run([hfsplus, '--symlinks', 'clone_link', '--special-modes', 'no', raw, 'addall', stage, '/'])
            partial = work / 'distribution.dmg'
            run([dmgtool, 'build', raw, partial])
        with partial.open('rb') as stream:
            stream.seek(-512, os.SEEK_END)
            if stream.read(4) != b'koly':
                raise RuntimeError('Output is not a UDIF disk image.')
        checksum = digest(partial)
        # Publish only after all assembly and integrity checks succeed.
        with destination.open('xb') as target, partial.open('rb') as src:
            shutil.copyfileobj(src, target)
        Path(str(destination) + '.sha256').write_text(checksum + '  ' + destination.name + '\n')
        print(json.dumps({'archive': str(destination), 'bytes': destination.stat().st_size, 'sha256': checksum,
                          'entry': 'chatgpt-apionly.app', 'signature': 'ad-hoc', 'notarized': False,
                          'providerFilesUnchanged': len(manifest['files'])}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider-archive', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'release')
    parser.add_argument('--zig')
    parser.add_argument('--rcodesign')
    parser.add_argument('--mkfs-hfsplus')
    parser.add_argument('--hfsplus')
    parser.add_argument('--dmgtool')
    build(parser.parse_args())
