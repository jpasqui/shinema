"""One bounded read-only operation over an existing authenticated SSH session."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import re

def display_title(name):
    title = Path(name).stem.replace('_', ' ').split(' #')[0].split(' \uff5c')[0]
    return re.sub(r'\s*\[[^\[\]]{11}\]$', '', title)[:200]

def operate(options):
    root = Path(options['root'])
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError('Use an existing absolute media directory without a symlink')
    root = root.resolve(strict=True)
    if options['operation'] == 'catalog':
        entries = []
        for index, entry in enumerate(os.scandir(root)):
            if index >= 512:
                break
            if not entry.is_file(follow_symlinks=False):
                continue
            suffix = Path(entry.name).suffix.lower()
            info = entry.stat(follow_symlinks=False)
            if suffix not in ('.mp4', '.m4v', '.webm', '.mkv') or not 0 < info.st_size <= options.get('maxBytes', 67108864):
                continue
            if '\\' in entry.name:
                continue
            try:
                identity = 'shinema-ssh-preview-v1\x00' + options.get('namespace', str(root)) + '\x00' + entry.name
                identifier = hashlib.sha256(identity.encode('utf-8')).hexdigest()
            except UnicodeEncodeError:
                continue
            entries.append({'id': identifier, 'title': display_title(entry.name),
                            'container': suffix[1:], 'sizeBytes': info.st_size,
                            'streamPath': '/api/media/' + identifier + '/stream',
                            'name': entry.name, 'modifiedNs': str(info.st_mtime_ns)})
        entries.sort(key=lambda entry: (entry['container'] not in ('mp4', 'm4v'), entry['sizeBytes'], entry['name']))
        return entries[:max(1, min(12, options.get('maxItems', 3)))]
    name = options['name']
    if name in ('', '.', '..') or '/' in name or '\\' in name or '\x00' in name or Path(name).is_absolute():
        raise ValueError('Invalid media filename')
    path = root / name
    if path.is_symlink():
        raise ValueError('Symlink media is unsupported')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size != options['sizeBytes'] or str(info.st_mtime_ns) != options['modifiedNs']:
            raise ValueError('Media changed since catalog scan')
        if options['operation'] == 'stat':
            return {'sizeBytes': info.st_size, 'modifiedNs': str(info.st_mtime_ns)}
        if options['operation'] != 'stream':
            raise ValueError('Unknown operation')
        start, length = options['start'], options['length']
        if not isinstance(start, int) or not isinstance(length, int) or start < 0 or length < 0 or start + length > info.st_size:
            raise ValueError('Invalid byte interval')
        os.lseek(descriptor, start, os.SEEK_SET)
        while length:
            data = os.read(descriptor, min(length, 262144))
            if not data:
                raise IOError('Unexpected media EOF')
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            length -= len(data)
        return None
    finally:
        os.close(descriptor)

if __name__ == '__main__':
    try:
        result = operate(json.loads(base64.b64decode(sys.argv[1]).decode('utf-8')))
        if result is not None:
            print(json.dumps(result, ensure_ascii=True))
    except BrokenPipeError:
        sys.exit(0)
    except Exception:
        print('Read-only media operation failed', file=sys.stderr)
        sys.exit(1)
