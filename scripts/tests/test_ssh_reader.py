import importlib.util
import io
from pathlib import Path
import os
import tempfile
import types
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'ssh-media-reader.py'
spec = importlib.util.spec_from_file_location('ssh_media_reader', source)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='shinema-reader-test-')
        self.root = Path(self.temporary.name)
        self.assertEqual(self.root.resolve().parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith('shinema-reader-test-'))
        self.bytes = b'Original generated source bytes.'
        (self.root / 'Generated.mp4').write_bytes(self.bytes)
        self.entry = reader.operate({'root': str(self.root), 'operation': 'catalog'})[0]

    def tearDown(self):
        self.assertEqual(self.root.resolve().parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith('shinema-reader-test-'))
        self.temporary.cleanup()

    def options(self, operation):
        return {'root': str(self.root), 'operation': operation, 'name': self.entry['name'],
                'sizeBytes': self.entry['sizeBytes'], 'modifiedNs': self.entry['modifiedNs']}

    def test_catalog_is_bounded_and_metadata_is_lossless(self):
        (self.root / 'Other.mkv').write_bytes(b'xx')
        (self.root / 'Ignored.txt').write_bytes(b'ignore')
        items = reader.operate({'root': str(self.root), 'operation': 'catalog', 'maxItems': 1})
        self.assertEqual(items[0]['name'], 'Generated.mp4')
        self.assertIsInstance(items[0]['modifiedNs'], str)
        self.assertEqual(reader.operate(self.options('stat'))['modifiedNs'], self.entry['modifiedNs'])

    def test_titles_are_scalar_bounded_and_remove_filename_annotation(self):
        self.assertEqual(reader.display_title('Generated_name #tags [abcdefghijk].mp4'), 'Generated name')
        self.assertEqual(len(reader.display_title('A' * 190 + '\U0001f680' * 20 + '.mp4')), 200)

    def test_source_namespace_keeps_identical_filenames_from_reusing_progress(self):
        first = reader.operate({'root': str(self.root), 'operation': 'catalog', 'namespace': 'first'})[0]
        second = reader.operate({'root': str(self.root), 'operation': 'catalog', 'namespace': 'second'})[0]
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(first['title'], second['title'])

    def test_stream_reads_requested_bytes_without_source_changes(self):
        output = io.BytesIO()
        before = (self.root / 'Generated.mp4').stat()
        with patch.object(reader.sys, 'stdout', types.SimpleNamespace(buffer=output)):
            reader.operate({**self.options('stream'), 'start': 2, 'length': 7})
        self.assertEqual(output.getvalue(), self.bytes[2:9])
        self.assertEqual((self.root / 'Generated.mp4').read_bytes(), self.bytes)
        self.assertEqual((self.root / 'Generated.mp4').stat().st_mtime_ns, before.st_mtime_ns)

    def test_invalid_paths_ranges_and_changed_source_reject(self):
        for name in ['../Generated.mp4', '..\\Generated.mp4', '..', '/etc/passwd', 'bad\x00name']:
            with self.assertRaises((ValueError, OSError)):
                reader.operate({**self.options('stat'), 'name': name})
        with self.assertRaises(ValueError):
            reader.operate({**self.options('stream'), 'start': -1, 'length': 1})
        (self.root / 'Generated.mp4').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            reader.operate(self.options('stat'))

    def test_symlink_media_is_not_cataloged_or_opened(self):
        link = self.root / 'Link.mp4'
        try:
            os.symlink(self.root / 'Generated.mp4', link)
        except (OSError, NotImplementedError):
            self.skipTest('Host does not grant symlink creation; Linux CI covers this check')
        self.assertEqual(len(reader.operate({'root': str(self.root), 'operation': 'catalog'})), 1)
        with self.assertRaises((ValueError, OSError)):
            reader.operate({**self.options('stat'), 'name': 'Link.mp4'})

if __name__ == '__main__':
    unittest.main()
