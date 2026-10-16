"""Check allowlisted CI builds before upload; never inspect developer state."""
import re
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

PRIVATE_CONTENT = re.compile(
    rb"(?P<key>-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----)"
    rb"|(?P<token>gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"
    # Binary string boundaries cannot be part of a credential-bearing origin.
    rb"|(?P<origin>(?:https?://|ssh://)[^\x00-\x20/:@\"<>]+:[^\x00-\x20/@\"<>]+@)"
    rb"|(?P<ip>(?<![\d.])(?:10\.(?:\d{1,3}\.){2}\d{1,3}"
    rb"|192\.168\.\d{1,3}\.\d{1,3}"
    rb"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.]))"
    rb"|(?P<nas>/volume[0-9]+/|/mnt/(?:nas|media)/)",
    re.IGNORECASE,
)
FORBIDDEN_SUFFIXES = {'.pem', '.key', '.jks', '.keystore', '.p12', '.pfx', '.sqlite', '.sqlite3', '.mp4', '.mkv', '.webm'}
REACT_NATIVE_DEBUG_HINT = b"'Debug server host & port for device' in 'Dev settings' to your machine's IP address and the port of the local dev server - e.g. "


def check(name, content):
    path = Path(name)
    if path.suffix.lower() in FORBIDDEN_SUFFIXES or path.name.startswith('.env'):
        raise SystemExit(f'Unexpected private/state/media file in build: {name}')
    for match in PRIVATE_CONTENT.finditer(content):
        # Locked React Native AndroidInfoHelpers contains these public emulator
        # aliases. Allow only their standalone DEX string constants, not URLs,
        # app JS, configured origins or arbitrary addresses in the same subnet.
        if (path.suffix == '.dex' and match.group() in {b'10.0.2.2', b'10.0.3.2'}
                and content[match.start() - 1:match.start()] == b'\x08'
                and content[match.end():match.end() + 1] == b'\x00'):
            continue
        # DebugServerException's pinned public help text includes this example.
        # Require its exact surrounding instruction and <PORT> placeholder;
        # the same address in an origin, app bundle or other context is rejected.
        if (path.suffix == '.dex' and match.group() == b'10.0.1.1'
                and content[max(0, match.start() - len(REACT_NATIVE_DEBUG_HINT)):match.start()] == REACT_NATIVE_DEBUG_HINT
                and content[match.end():match.end() + 7] == b':<PORT>'):
            continue
        # Do not echo potentially sensitive matched data into the public CI log.
        raise SystemExit(f'Potential private content in build: {name}; rule={match.lastgroup}; bytes={len(match.group())}')


def audit(kind, path):
    count = 0
    if kind == 'web':
        if not (path / 'index.html').is_file():
            raise SystemExit('Web build is missing index.html')
        for file in path.rglob('*'):
            if file.is_symlink():
                raise SystemExit('Web build contains a symbolic link')
            if file.is_file():
                check(file.relative_to(path).as_posix(), file.read_bytes())
                count += 1
    elif kind == 'android':
        if path.name != 'app-release-unsigned.apk':
            raise SystemExit('Only the unsigned development release APK is permitted')
        with zipfile.ZipFile(path) as apk:
            for entry in apk.infolist():
                if entry.is_dir():
                    continue
                if re.fullmatch(r'META-INF/[^/]+\.(?:RSA|DSA|EC|SF)', entry.filename, re.IGNORECASE):
                    raise SystemExit('Expected an unsigned APK, found a signing entry')
                check(entry.filename, apk.read(entry))
                count += 1
        # APK v2/v3 signatures live outside ZIP entries.
        if b'APK Sig Block 42' in path.read_bytes():
            raise SystemExit('Expected an unsigned APK, found an APK signing block')
    elif kind == 'diagnostics':
        if not (path / 'browser-test.log').is_file():
            raise SystemExit('Browser failure evidence is missing the workload log')
        for file in path.iterdir():
            if file.is_symlink() or not file.is_file() or not re.fullmatch(
                    r'(?:failure-[0-9]+\.png|failure\.json|web-smoke-results\.json|browser-test\.log)', file.name):
                raise SystemExit('Unexpected file in browser failure evidence')
            check(file.name, file.read_bytes())
            count += 1
    elif kind == 'playback-diagnostics':
        if path.is_symlink() or not path.is_dir():
            raise SystemExit('Playback diagnostics require an ordinary directory')
        files = list(path.iterdir())
        if not 2 <= len(files) <= 18:
            raise SystemExit('Playback diagnostic file count exceeds its bound')
        for file in files:
            if file.is_symlink() or not file.is_file() or not re.fullmatch(
                    r'(?:failure-(?:[1-9]|1[0-6])\.png|failure\.json|browser-test\.log)', file.name):
                raise SystemExit('Unexpected file in playback diagnostics')
            limit = 2 * 1024 * 1024 if file.suffix == '.png' else 64 * 1024
            if not 0 < file.stat().st_size <= limit:
                raise SystemExit('Playback diagnostic file exceeds its bound')
            content = file.read_bytes()
            check(file.name, content)
            # Short drive-root strings can occur by chance in compressed PNGs.
            # Use distinctive host markers there; text logs reject any drive root.
            host_marker = (rb'[A-Z]:[\\/]+Users[\\/]|/(?:Users|home|tmp|var|mnt)/|id_ed25519|known_hosts'
                           if file.suffix == '.png' else rb'[A-Z]:[\\/]|/(?:Users|home|tmp|var|mnt)/|id_ed25519|known_hosts')
            if re.search(host_marker, content, re.IGNORECASE):
                raise SystemExit('Private host/source marker in playback diagnostics')
            if file.suffix == '.png' and (not content.startswith(b'\x89PNG\r\n\x1a\n')
                    or content[16:24] not in {
                        (width).to_bytes(4, 'big') + (900).to_bytes(4, 'big')
                        for width in (390, 1280)}):
                raise SystemExit('Playback screenshots must use a declared fixed viewport')
            count += 1
        try:
            data = json.loads((path / 'failure.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise SystemExit('Playback diagnostic summary is missing or invalid')
        if (not isinstance(data, dict) or set(data) != {'schema', 'generatedOnly', 'status', 'runnerErrors', 'omittedFailures', 'failures'}
                or data['schema'] != 1 or data['generatedOnly'] is not True
                or data['status'] not in {'failed', 'timedout', 'interrupted'}
                or type(data['runnerErrors']) is not int or not 0 <= data['runnerErrors'] <= 100
                or type(data['omittedFailures']) is not int or not 0 <= data['omittedFailures'] <= 1000000
                or not isinstance(data['failures'], list) or len(data['failures']) > 16):
            raise SystemExit('Playback diagnostic summary is missing or invalid')
        expected = {'failure.json', 'browser-test.log'}
        lines = [f"Generated-only playback suite: {data['status']}",
                 f"runnerErrors={data['runnerErrors']} omittedFailures={data['omittedFailures']}"]
        for index, item in enumerate(data['failures'], 1):
            if (not isinstance(item, dict) or set(item) != {'source', 'line', 'outcome', 'errorCount', 'screenshot'}
                    or not isinstance(item['source'], str) or not re.fullmatch(r'tests/e2e/[a-z0-9-]+\.spec\.ts', item['source'])
                    or type(item['line']) is not int or not 1 <= item['line'] <= 1000000
                    or item['outcome'] not in {'passed', 'failed', 'timedOut', 'skipped', 'interrupted'}
                    or type(item['errorCount']) is not int or not 0 <= item['errorCount'] <= 100
                    or type(item['screenshot']) is not bool):
                raise SystemExit('Playback failure record is invalid')
            screenshot = f'failure-{index}.png' if item['screenshot'] else 'unavailable'
            if item['screenshot']:
                expected.add(screenshot)
            lines.append(f"{item['source']}:{item['line']} outcome={item['outcome']} errors={item['errorCount']} screenshot={screenshot}")
        if {file.name for file in files} != expected:
            raise SystemExit('Playback diagnostic screenshots do not match the summary')
        if (path / 'browser-test.log').read_text(encoding='utf-8') != '\n'.join(lines) + '\n':
            raise SystemExit('Playback diagnostic log contains unexpected content')
    elif kind == 'public-fixtures':
        expected = {'before-movies.png', 'before-series.png', 'after-movies.png',
                    'after-series.png', 'interactions.webm', 'provenance.json'}
        entries = list(path.iterdir())
        if {file.name for file in entries} != expected:
            raise SystemExit('Public fixture evidence must contain exactly the dedicated allowlist')
        for file in entries:
            if file.is_symlink() or not file.is_file():
                raise SystemExit('Public fixture evidence cannot contain links or directories')
            size = file.stat().st_size
            limit = 100 * 1024 * 1024 if file.suffix == '.webm' else 10 * 1024 * 1024
            if not 0 < size <= limit:
                raise SystemExit('Public fixture evidence exceeds its per-file bound')
            content = file.read_bytes()
            # Media suffixes remain forbidden for all ordinary build/diagnostic
            # uploads. Only this exact generated-evidence allowlist permits them.
            check(file.name + '.generated-bytes', content)
            if re.search(rb'C:[\\/]+Users[\\/]|/Users/|/mnt/Storage/|id_ed25519|known_hosts', content, re.IGNORECASE):
                raise SystemExit('Private host/source marker in public fixture evidence')
            if file.suffix == '.png':
                if not content.startswith(b'\x89PNG\r\n\x1a\n'):
                    raise SystemExit('Invalid public screenshot format')
                if content[16:24] != (1280).to_bytes(4, 'big') + (900).to_bytes(4, 'big'):
                    raise SystemExit('Public screenshots must use the declared fixed viewport')
            if file.suffix == '.webm':
                if not content.startswith(b'\x1a\x45\xdf\xa3'):
                    raise SystemExit('Invalid public recording format')
            count += 1
        # Scan every allowlisted byte stream before running a media decoder.
        file = path / 'interactions.webm'
        try:
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                                'format=duration:format_tags:stream=codec_type,width,height',
                                '-of', 'json', str(file)], capture_output=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            raise SystemExit('Public recording probe is unavailable')
        if probe.returncode:
            raise SystemExit('Public recording cannot be decoded/probed')
        check('recording-probe.json', probe.stdout)
        info = json.loads(probe.stdout)
        streams = info.get('streams', [])
        if (len(streams) != 1 or streams[0].get('codec_type') != 'video'
                or streams[0].get('width') != 1280 or streams[0].get('height') != 900
                or not 1 <= float(info.get('format', {}).get('duration', 0)) <= 600):
            raise SystemExit('Public recording must be bounded, silent and at the fixed viewport')
        data = json.loads((path / 'provenance.json').read_text(encoding='utf-8'))
        allowed = {'schema', 'generatedOnly', 'fixtureCount', 'providersEnabled', 'sourceRevision',
                   'beforeRevision', 'viewport', 'recording', 'methodology', 'checks', 'seeks',
                   'browser', 'hevcStartupMs', 'assets'}
        if (set(data) != allowed or data['schema'] != 1 or data['generatedOnly'] is not True
                or data['fixtureCount'] != 1457 or data['providersEnabled'] is not False
                or not re.fullmatch(r'[a-f0-9]{40}', data['sourceRevision'])
                or data['beforeRevision'] != 'c2d82902fab5fc9e4e16555d5978df943f5ab865'
                or data['viewport'] != {'width': 1280, 'height': 900}
                or set(data['assets']) != expected - {'provenance.json'}):
            raise SystemExit('Public fixture provenance is missing or invalid')
        for name, digest in data['assets'].items():
            if digest != hashlib.sha256((path / name).read_bytes()).hexdigest():
                raise SystemExit('Public fixture evidence hash mismatch')
    else:
        raise SystemExit('Expected web, android, diagnostics, playback-diagnostics or public-fixtures')
    print(f'Audited {count} allowlisted files: no forbidden content or unexpected files detected.')


if __name__ == '__main__':
    audit(sys.argv[1], Path(sys.argv[2]))
