"""Check allowlisted CI builds before upload; never inspect developer state."""
import re
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
    else:
        raise SystemExit('Expected web, android or diagnostics')
    print(f'Audited {count} build files: no credential markers, unexpected private IPs, NAS roots, state or media detected.')


if __name__ == '__main__':
    audit(sys.argv[1], Path(sys.argv[2]))
