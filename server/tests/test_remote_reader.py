"""Generated local POSIX fixtures only; never connects to a NAS."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location('reader', Path(__file__).parents[1] / 'src' / 'remote_reader.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
registry = json.loads((Path(__file__).parents[2] / 'packages' / 'contracts' / 'content-registry.json').read_text())
extensions = [extension for value in registry['formats'] if value['availability'] == 'available' and value['capabilities']['play'] for extension in value['extensions']]


class ExtensionPolicyTests(unittest.TestCase):
    def test_extension_payload_is_explicit_and_cannot_contain_paths(self):
        self.assertEqual(reader.approved_extensions(extensions), set(extensions))
        for values in [None, [], ['../mp4'], ['.mp4'], ['MP4'], ['mp4','mp4'], ['mp4\x00']]:
            with self.assertRaises(ValueError):
                reader.approved_extensions(values)


@unittest.skipUnless(os.name == 'posix', 'NOFOLLOW/dir_fd helper runs on the POSIX source host')
class ReaderTests(unittest.TestCase):
    def test_scan_includes_all_deep_files_and_skips_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'tv'
            folder = root / 'Generated series' / 'Season 1'
            folder.mkdir(parents=True)
            for index in range(601):
                (folder / f'S01E{index:03}.mkv').write_bytes(b'fixture')
            deep = folder / '/'.join('abcdefghijk')
            deep.mkdir(parents=True)
            (deep / 'deep.avi').write_bytes(b'deep')
            (folder / 'subtitle.srt').write_text('sidecar')
            (folder / 'escape.mkv').symlink_to('/etc/passwd')
            result = reader.scan({'tv': str(root)}, extensions)
            self.assertEqual(len(result['items']), 602)
            self.assertEqual(result['linksSkipped'], 1)
            self.assertEqual(result['ignoredFiles'], 1)

    def test_changed_identity_and_traversal_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'movie.mkv'
            source.write_bytes(b'original')
            info = source.stat()
            payload = {'roots': {'movies': str(root)}, 'relative': 'movies/movie.mkv', 'sizeBytes': info.st_size, 'modifiedNs': str(info.st_mtime_ns), 'operation': 'stat'}
            with redirect_stdout(io.StringIO()) as output:
                reader.main(payload)
            self.assertEqual(json.loads(output.getvalue())['sizeBytes'], 8)
            source.write_bytes(b'changed!')
            os.utime(source, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000))
            with self.assertRaises(ValueError):
                reader.main(payload)
            for value in ['../movie.mkv', 'a/../movie.mkv', '/movie.mkv', 'a//movie.mkv']:
                with self.assertRaises(ValueError):
                    reader.opened(str(root), value)

    def test_directory_and_final_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'secret.mkv').write_bytes(b'secret')
            (root / 'link').symlink_to(outside, target_is_directory=True)
            (root / 'file.mkv').symlink_to(outside / 'secret.mkv')
            for value in ['link/secret.mkv', 'file.mkv']:
                with self.assertRaises(OSError):
                    reader.opened(str(root), value)

    def test_extension_choices_are_validated_without_expanding_to_all_files(self):
        for values in [None, [], ['../mp4'], ['.mp4'], ['MP4'], ['mp4','mp4'], ['mp4\x00']]:
            with self.assertRaises(ValueError):
                reader.approved_extensions(values)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for extension in ['mp4','mp3','docx','exe','json']:
                (root / f'fixture.{extension}').write_bytes(b'fixture')
            result = reader.scan({'movies': str(root)},extensions)
            self.assertEqual([value['relative'] for value in result['items']],['movies/fixture.mp4'])
            self.assertEqual(result['ignoredFiles'],4)


if __name__ == '__main__':
    unittest.main()
