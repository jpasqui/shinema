"""Check allowlisted CI builds before upload; never inspect developer state."""
import re
import sys
import zipfile
from pathlib import Path

PRIVATE_CONTENT = re.compile(
    rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"
    rb"|(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"
    rb"|(?:https?://|ssh://)[^\s/]+:[^\s/@]+@"
    rb"|(?<![\d.])(?:10\.(?:\d{1,3}\.){2}\d{1,3}"
    rb"|192\.168\.\d{1,3}\.\d{1,3}"
    rb"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])"
    rb"|/volume[0-9]+/|/mnt/(?:nas|media)/",
    re.IGNORECASE,
)
FORBIDDEN_SUFFIXES = {'.pem', '.key', '.jks', '.keystore', '.p12', '.pfx', '.sqlite', '.sqlite3', '.mp4', '.mkv', '.webm'}


def check(name, content):
    path = Path(name)
    if path.suffix.lower() in FORBIDDEN_SUFFIXES or path.name.startswith('.env'):
        raise SystemExit(f'Unexpected private/state/media file in build: {name}')
    if PRIVATE_CONTENT.search(content):
        # Do not echo potentially sensitive matched data into the public CI log.
        raise SystemExit(f'Potential private endpoint or credential in build: {name}')


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
    else:
        raise SystemExit('Expected web or android')
    print(f'Audited {count} build files: no credential markers, private IPs, NAS roots, state or media detected.')


if __name__ == '__main__':
    audit(sys.argv[1], Path(sys.argv[2]))
