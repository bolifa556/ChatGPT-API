"""Build a standalone Linux provider package without personal state or Windows files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
from datetime import datetime, timezone
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]

def digest(file):
    with file.open('rb') as stream:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
        return checksum.hexdigest()

def build(arch, output):
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    runtime = json.loads((ROOT / 'assets/runtime-linux.json').read_text(encoding='utf-8'))
    name = f'ChatGPT-API-Provider-{package["version"]}-linux-{arch}'
    output.mkdir(parents=True, exist_ok=True)
    archive = output / (name + '.tar.gz')
    if archive.exists():
        raise RuntimeError(f'Release already exists: {archive}')
    cache = ROOT / 'data/cache'
    cache.mkdir(parents=True, exist_ok=True)
    node_tar = cache / f'node-v{runtime["version"]}-linux-{arch}.tar.xz'
    if not node_tar.exists():
        with urlopen(runtime[arch]['url'], timeout=60) as response, node_tar.open('wb') as target:
            shutil.copyfileobj(response, target)
    if digest(node_tar) != runtime[arch]['sha256']:
        raise RuntimeError('Node archive does not match the pinned official SHA-256.')
    build_root = ROOT / 'data/build'
    build_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='linux-', dir=build_root) as temporary:
        bundle = Path(temporary) / name
        payload = bundle / 'payload'
        payload.mkdir(parents=True)
        files = ['package.json', 'package-lock.json', 'linux/provider.mjs', 'linux/settings.mjs', 'linux/chatgpt-api','linux/console',
                 'assets/model-template.json', 'assets/reasoning-levels.json', 'assets/model-contexts.json','assets/console/index.html','assets/console/console.css','assets/console/console.js','assets/console/icon.svg',
                 'src/shim.mjs','src/transport.mjs','src/response-state.mjs','src/settings.mjs','src/gateway-sources.mjs','src/console.mjs', 'src/chat-compat.mjs', 'src/history-compat.mjs', 'src/non-gpt-compat.mjs', 'src/sse.mjs', 'src/image-compat.mjs', 'src/model-context.mjs', 'src/gateway-recovery.mjs']
        locked = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))['packages']
        for relative, metadata in locked.items():
            if not relative:
                continue
            directory = ROOT / relative
            installed = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
            if installed['version'] != metadata['version']:
                raise RuntimeError(f'Dependency lock mismatch: {relative}')
            for file in directory.rglob('*'):
                if file.is_symlink():
                    raise RuntimeError(f'Linked dependency: {file}')
                if file.is_file():
                    files.append(file.relative_to(ROOT).as_posix())
        for relative in sorted(set(files)):
            source, target = ROOT / relative, payload / relative
            if source.is_symlink():
                raise RuntimeError(f'Linked source: {source}')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        prefix = f'node-v{runtime["version"]}-linux-{arch}'
        with tarfile.open(node_tar, 'r:xz') as source:
            for member, target in [('bin/node', 'runtime/node'), ('LICENSE', 'runtime/LICENSE.txt')]:
                entry = source.getmember(prefix + '/' + member)
                if not entry.isfile():
                    raise RuntimeError('Unexpected Node archive member.')
                target = payload / target
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(entry) as stream, target.open('wb') as writer:
                    shutil.copyfileobj(stream, writer)
        (bundle / 'setup').mkdir()
        shutil.copyfile(ROOT / 'linux/install.mjs', bundle / 'setup/install.mjs')
        shutil.copyfile(ROOT / 'linux/install.sh', bundle / 'install.sh')
        shutil.copyfile(ROOT / 'docs/linux-readme.md', bundle / 'README.md')
        (bundle / 'architecture').write_text(arch + '\n', encoding='ascii', newline='\n')
        manifest = {'schemaVersion': 1, 'product': 'chatgpt-api-provider', 'version': package['version'],
                    'platform': 'linux-' + arch, 'builtAt': datetime.now(timezone.utc).isoformat(), 'files': []}
        for file in sorted(payload.rglob('*')):
            if file.is_file():
                relative = file.relative_to(payload).as_posix()
                mode = 0o755 if relative in ('runtime/node', 'linux/chatgpt-api', 'linux/console') else 0o644
                manifest['files'].append({'path': relative, 'bytes': file.stat().st_size, 'sha256': digest(file), 'mode': mode})
        (bundle / 'release.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
        def metadata(info):
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mode = 0o755 if info.isdir() or info.name.endswith(('/install.sh', '/linux/chatgpt-api', '/linux/console', '/runtime/node')) else 0o644
            return info
        try:
            with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as target:
                target.add(bundle, arcname=name, filter=metadata)
        except BaseException:
            archive.unlink(missing_ok=True)
            raise
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'programFiles': len(manifest['files'])}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--arch', choices=['x64', 'arm64', 'all'], default='all')
    parser.add_argument('--output', type=Path, default=ROOT / 'release' / json.loads((ROOT / 'package.json').read_text())['version'])
    args = parser.parse_args()
    for architecture in ['x64', 'arm64'] if args.arch == 'all' else [args.arch]:
        build(architecture, args.output.resolve())
