"""Original transient read-only helper, sent over an existing strict-key SSH session.

No files, services, mounts or credentials are created on the remote machine.
All path components are opened relative to directory descriptors with NOFOLLOW.
"""
import json
import os
import stat
import sys

def approved_extensions(values):
    if not isinstance(values, list) or not values or len(values) > 4096:
        raise ValueError('Approved format extensions required')
    for value in values:
        if not isinstance(value, str) or not 1 <= len(value) <= 48 or not value[0].isascii() or not value[0].isalnum() or any(not (char.isascii() and (char.islower() or char.isdigit() or char == '-')) for char in value):
            raise ValueError('Invalid approved format extension')
    if len(set(values)) != len(values):
        raise ValueError('Duplicate approved format extension')
    return set(values)


def parts(path):
    values = path.split('/')
    if not values or any(value in ('', '.', '..') or '\x00' in value for value in values):
        raise ValueError('Invalid relative path')
    return values


def directory(root):
    if not root.startswith('/'):
        raise ValueError('Absolute root required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts(root.lstrip('/')):
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def opened(root, relative):
    path = parts(relative)
    fd = directory(root)
    try:
        for part in path[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        file_fd = os.open(path[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(file_fd)
            raise ValueError('Regular media file required')
        return file_fd, info
    finally:
        os.close(fd)


def scan(roots, extensions):
    extensions = approved_extensions(extensions)
    report = {'items': [], 'filesSeen': 0, 'ignoredFiles': 0, 'linksSkipped': 0}

    def walk(fd, prefix):
        with os.scandir(fd) as iterator:
            for entry in iterator:
                name = entry.name
                name.encode('utf-8', 'strict')  # fail visibly rather than lose path identity
                info = entry.stat(follow_symlinks=False)
                relative = prefix + '/' + name
                if stat.S_ISLNK(info.st_mode):
                    report['linksSkipped'] += 1
                elif stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        walk(child, relative)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    report['filesSeen'] += 1
                    extension = os.path.splitext(name)[1][1:].lower()
                    if extension in extensions:
                        report['items'].append({'relative': relative, 'sizeBytes': info.st_size, 'modifiedNs': str(info.st_mtime_ns)})
                    else:
                        report['ignoredFiles'] += 1
    for kind, root in roots.items():
        if kind not in ('tv', 'movies'):
            raise ValueError('Unsupported collection')
        fd = directory(root)
        try:
            walk(fd, kind)
        finally:
            os.close(fd)
    return report


def main(payload):
    operation = payload['operation']
    if operation == 'scan':
        print(json.dumps(scan(payload['roots'], payload['extensions']), ensure_ascii=True))
        return
    relative = payload['relative']
    collection, rest = relative.split('/', 1)
    fd, info = opened(payload['roots'][collection], rest)
    try:
        if info.st_size != payload['sizeBytes'] or str(info.st_mtime_ns) != payload['modifiedNs']:
            raise ValueError('Source changed; refresh required')
        if operation == 'stat':
            print(json.dumps({'sizeBytes': info.st_size, 'modifiedNs': str(info.st_mtime_ns)}))
        elif operation == 'stream':
            start, length = payload['start'], payload['length']
            if isinstance(start, bool) or isinstance(length, bool) or not isinstance(start, int) or not isinstance(length, int) or start < 0 or length < 0 or start + length > info.st_size:
                raise ValueError('Invalid byte range')
            os.lseek(fd, start, os.SEEK_SET)
            while length:
                data = os.read(fd, min(length, 262144))
                if not data:
                    raise EOFError('Source ended early')
                sys.stdout.buffer.write(data)
                length -= len(data)
            sys.stdout.buffer.flush()
        else:
            raise ValueError('Unknown operation')
    finally:
        os.close(fd)


if __name__ == '__main__':
    main(json.loads(sys.argv[1]))
