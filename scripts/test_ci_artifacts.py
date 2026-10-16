"""Exercise the public-build guard with synthetic data only."""
import tempfile
import copy
import hashlib
import json
import random
import struct
import subprocess
import zlib
from unittest.mock import patch
from types import SimpleNamespace
import unittest
import zipfile
from pathlib import Path

from audit_ci_artifacts import REACT_NATIVE_DEBUG_HINT, audit, check


def generated_png(width, height, extra_text_bytes=0):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = (b'\x00' + b'\x00' * width) * height
    padding = chunk(b'tEXt', b'Description\x00' + b'A' * extra_text_bytes) if extra_text_bytes else b''
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)) + padding
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


class ArtifactAuditTests(unittest.TestCase):
    def test_private_content_is_rejected_without_echoing_values(self):
        for content in [
            b'-----BEGIN ' + b'RSA PRIVATE KEY-----',
            b'ghp_' + b'x' * 36,
            b'https://fixture:password@example.invalid/',
            b'http://192.168.2.3:8787',
            b'10.2.3.4',
            b'172.31.2.3',
            b'/volume1/fixture',
        ]:
            with self.subTest(content=content):
                with self.assertRaises(SystemExit) as caught:
                    check('assets/generated.js', content)
                self.assertNotIn(content.decode(), str(caught.exception))

    def test_loopback_and_public_source_are_allowed(self):
        check('assets/generated.js', b'http://127.0.0.1:8787 https://example.invalid')

    def test_binary_string_boundaries_cannot_form_a_credential_origin(self):
        check('classes2.dex', b'http://\x00unrelated:descriptor@\x00')
        check('classes2.dex', b'http://example.invalid\x00unrelated:descriptor@\x00')
        with self.assertRaises(SystemExit):
            check('classes2.dex', b'\x00https://fixture:password@example.invalid/\x00')

    def test_only_standalone_dex_emulator_alias_constants_are_allowed(self):
        for alias in [b'10.0.2.2', b'10.0.3.2']:
            check('classes2.dex', b'\x08' + alias + b'\x00')
            for name, value in [
                ('assets/index.android.bundle', b'\x08' + alias + b'\x00'),
                ('classes2.dex', b'http://' + alias + b'\x00'),
                ('classes2.dex', alias),
                ('classes2.dex', b'\x08' + alias + b'/api\x00'),
                ('classes2.dex', b'\x08' + alias + b'\x00 192.168.2.3'),
            ]:
                with self.subTest(name=name, value=value), self.assertRaises(SystemExit):
                    check(name, value)

    def test_state_media_and_credentials_are_rejected(self):
        for name in ['.env.local', 'identity.pem', 'state.sqlite3', 'fixture.mp4']:
            with self.subTest(name=name), self.assertRaises(SystemExit):
                check(name, b'generated fixture')

    def test_public_debugger_example_needs_exact_dex_help_context(self):
        example = REACT_NATIVE_DEBUG_HINT + b'10.0.1.1:<PORT>'
        check('classes2.dex', example)
        for name, content in [
            ('assets/index.android.bundle', example),
            ('classes2.dex', b'http://10.0.1.1:8787'),
            ('classes2.dex', b'10.0.1.1:<PORT>'),
            ('classes2.dex', REACT_NATIVE_DEBUG_HINT + b'10.0.1.1:8787'),
            ('classes2.dex', example + b' 192.168.2.3'),
        ]:
            with self.subTest(name=name, content=content), self.assertRaises(SystemExit):
                check(name, content)

    def test_web_requires_an_entrypoint_and_checks_all_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            with self.assertRaises(SystemExit):
                audit('web', path)
            (path / 'index.html').write_text('<html>Generated fixture</html>')
            audit('web', path)
            (path / '.env').write_text('generated fixture')
            with self.assertRaises(SystemExit):
                audit('web', path)

    def test_apk_checks_entries_and_both_signing_forms(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'app-release-unsigned.apk'
            with zipfile.ZipFile(path, 'w') as apk:
                apk.writestr('assets/index.android.bundle', b'generated fixture')
            audit('android', path)
            with path.open('ab') as output:
                output.write(b'APK Sig Block 42')
            with self.assertRaises(SystemExit):
                audit('android', path)
            with zipfile.ZipFile(path, 'w') as apk:
                apk.writestr('META-INF/TEST.RSA', b'generated fixture')
            with self.assertRaises(SystemExit):
                audit('android', path)

    def test_diagnostics_require_logs_and_reject_unrelated_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            with self.assertRaises(SystemExit):
                audit('diagnostics', path)
            (path / 'browser-test.log').write_text('Generated failure')
            (path / 'failure.json').write_text('{"status":"failed"}')
            audit('diagnostics', path)
            (path / 'unrelated.json').write_text('{}')
            with self.assertRaises(SystemExit):
                audit('diagnostics', path)

    def playback_evidence(self, path, width=1280, height=900):
        data = {'schema': 1, 'generatedOnly': True, 'status': 'failed',
                'runnerErrors': 0, 'omittedFailures': 0, 'failures': [
                    {'source': 'tests/e2e/playback.spec.ts', 'line': 10,
                     'outcome': 'failed', 'errorCount': 1, 'screenshot': True}]}
        (path / 'failure.json').write_text(json.dumps(data), encoding='utf-8')
        (path / 'browser-test.log').write_text(
            'Generated-only playback suite: failed\nrunnerErrors=0 omittedFailures=0\n'
            'tests/e2e/playback.spec.ts:10 outcome=failed errors=1 screenshot=failure-1.png\n', encoding='utf-8')
        png = generated_png(width, height)
        (path / 'failure-1.png').write_bytes(png)
        return data

    def test_playback_diagnostics_accept_only_the_six_exact_screenshot_viewports(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for width, height in [(390, 844), (390, 900), (768, 900), (1100, 900), (1280, 900), (1600, 900)]:
                with self.subTest(width=width, height=height):
                    self.playback_evidence(path, width, height)
                    audit('playback-diagnostics', path)
            for width, height in [(389, 900), (391, 900), (767, 900), (769, 900),
                                  (1099, 900), (1101, 900), (1279, 900), (1281, 900),
                                  (390, 843), (390, 845), (768, 844), (1100, 844), (1280, 844),
                                  (390, 899), (390, 901), (1280, 899), (1280, 901),
                                  (1599, 900), (1601, 900), (1600, 899), (1600, 901), (1600, 844),
                                  (900, 390), (900, 1280), (900, 1600), (1920, 1080)]:
                with self.subTest(width=width, height=height):
                    self.playback_evidence(path, width, height)
                    with self.assertRaises(SystemExit):
                        audit('playback-diagnostics', path)

    def test_playback_diagnostics_reject_truncated_and_non_png_screenshot_headers(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for width in (390, 1280, 1600):
                self.playback_evidence(path, width)
                png = (path / 'failure-1.png').read_bytes()
                for length in (1, 7, 8, 16, 20, 23):
                    with self.subTest(width=width, length=length):
                        (path / 'failure-1.png').write_bytes(png[:length])
                        with self.assertRaises(SystemExit):
                            audit('playback-diagnostics', path)
                for signature in (b'\xff\xd8\xff\xe0JFIF', b'GIF89a\x00\x00', b'notPNG!!'):
                    with self.subTest(width=width, signature=signature):
                        (path / 'failure-1.png').write_bytes(signature + png[8:])
                        with self.assertRaises(SystemExit):
                            audit('playback-diagnostics', path)

    def test_playback_tv_screenshot_keeps_the_existing_two_megabyte_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.playback_evidence(path, 1600, 900)
            png = generated_png(1600, 900, extra_text_bytes=2 * 1024 * 1024)
            self.assertTrue(png.endswith(b'IEND\xaeB`\x82'))
            self.assertGreater(len(png), 2 * 1024 * 1024)
            (path / 'failure-1.png').write_bytes(png)
            with self.assertRaisesRegex(SystemExit, 'file exceeds its bound'):
                audit('playback-diagnostics', path)

    def test_playback_diagnostics_are_bounded_allowlisted_and_source_relative(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.playback_evidence(path)
            audit('playback-diagnostics', path)
            for name, content in [
                ('browser-test.log', b'x' * (65536 + 1)),
                ('failure.json', b'x' * (65536 + 1)),
                ('failure-1.png', b'x' * (2 * 1024 * 1024 + 1)),
                ('error-context.md', b'raw context'),
                ('fixture.mp4', b'generated fixture'),
                ('trace.zip', b'raw trace'),
            ]:
                with self.subTest(name=name):
                    self.playback_evidence(path)
                    (path / name).write_bytes(content)
                    with self.assertRaises(SystemExit):
                        audit('playback-diagnostics', path)
                    (path / name).unlink()
            self.playback_evidence(path)
            data = self.playback_evidence(path)
            data['failures'][0]['source'] = '/home/fixture/private.spec.ts'
            (path / 'failure.json').write_text(json.dumps(data))
            with self.assertRaises(SystemExit):
                audit('playback-diagnostics', path)

    def test_playback_diagnostics_reject_private_markers_without_echoing_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for width in (390, 1280, 1600):
                for marker in [b'C:/Users/fixture/private', b'/Users/fixture/private', b'/tmp/fixture',
                               b'ghp_' + b'x' * 36, b'https://fixture:password@example.invalid/', b'/volume1/fixture']:
                    with self.subTest(width=width, marker=marker):
                        self.playback_evidence(path, width)
                        with (path / 'failure-1.png').open('ab') as output:
                            output.write(marker)
                        with self.assertRaises(SystemExit) as caught:
                            audit('playback-diagnostics', path)
                        self.assertNotIn(marker.decode(), str(caught.exception))

    def test_playback_diagnostics_reject_missing_images_and_unstructured_logs(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.playback_evidence(path)
            (path / 'failure-1.png').unlink()
            with self.assertRaises(SystemExit):
                audit('playback-diagnostics', path)
            self.playback_evidence(path)
            with (path / 'browser-test.log').open('a') as output:
                output.write('Unexpected raw error stack')
            with self.assertRaises(SystemExit):
                audit('playback-diagnostics', path)

    def test_playback_screenshot_compression_is_not_mistaken_for_a_drive_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.playback_evidence(path)
            noise = random.Random(0).randbytes(1280 * 900)
            rows = b''.join(b'\x00' + noise[row * 1280:(row + 1) * 1280] for row in range(900))
            def chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
            png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1280, 900, 8, 0, 0, 0, 0))
                   + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
            self.assertIn(b'D:/', png)
            (path / 'failure-1.png').write_bytes(png)
            audit('playback-diagnostics', path)

    def libraries_evidence(self, path, screenshot=True, **overrides):
        data = {'schema': 1, 'generatedOnly': True, 'suite': 'libraries', 'status': 'failed',
                'sourceRevision': 'a' * 40, 'stage': 'browser-settings', 'category': 'assertion',
                'completedChecks': 12, 'events': {'consoleErrors': 0, 'pageErrors': 0, 'requestFailures': 0},
                'screenshot': screenshot}
        data.update(overrides)
        (path / 'failure.json').write_text(json.dumps(data), encoding='utf-8')
        image = 'failure-1.png' if screenshot else 'unavailable'
        lines = ['Generated-only library suite: failed', f"sourceRevision={data['sourceRevision']}",
                 f"stage={data['stage']} category={data['category']} checks={data['completedChecks']}",
                 f"consoleErrors={data['events']['consoleErrors']} pageErrors={data['events']['pageErrors']} requestFailures={data['events']['requestFailures']}",
                 f'screenshot={image}']
        (path / 'browser-test.log').write_bytes(('\n'.join(lines) + '\n').encode())
        if screenshot:
            png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8 + (1440).to_bytes(4, 'big') + (1000).to_bytes(4, 'big')
            (path / 'failure-1.png').write_bytes(png)
        return data

    def test_libraries_diagnostics_accept_only_declared_stages_categories_and_bounds(self):
        stages = ['setup', 'api', 'migration', 'restart', 'baseline', 'browser-settings',
                  'browser-navigation', 'browser-search', 'browser-concurrency', 'browser-unsupported', 'finalize']
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for stage in stages:
                self.libraries_evidence(path, stage=stage)
                audit('libraries-diagnostics', path)
            for category in ['assertion', 'timeout', 'network', 'startup', 'runner']:
                self.libraries_evidence(path, category=category)
                audit('libraries-diagnostics', path)
            for bound in [0, 1000]:
                self.libraries_evidence(path, completedChecks=bound,
                                        events={'consoleErrors': bound * 10, 'pageErrors': bound * 10, 'requestFailures': bound * 10})
                audit('libraries-diagnostics', path)
            self.libraries_evidence(path)
            summary = path / 'failure.json'
            summary.write_bytes(summary.read_bytes().ljust(16384, b' '))
            image = path / 'failure-1.png'
            image.write_bytes(image.read_bytes().ljust(2 * 1024 * 1024, b'\x00'))
            audit('libraries-diagnostics', path)

    def test_libraries_diagnostics_reject_malformed_or_extended_summaries(self):
        mutations = [
            {'schema': True}, {'schema': 2}, {'generatedOnly': False}, {'generatedOnly': 1},
            {'suite': 'playback'}, {'status': 'passed'}, {'sourceRevision': 'A' * 40},
            {'sourceRevision': 'a' * 39}, {'sourceRevision': None}, {'sourceRevision': ['a' * 40]},
            {'stage': 'unknown'}, {'stage': []}, {'category': 'unknown'}, {'category': {}},
            {'completedChecks': -1}, {'completedChecks': 1001}, {'completedChecks': True}, {'completedChecks': 1.0},
            {'events': []}, {'events': {}},
            {'events': {'consoleErrors': 0, 'pageErrors': 0, 'requestFailures': 0, 'raw': 1}},
            {'screenshot': 1}, {'screenshot': 'failure-1.png'}, {'rawError': 'unstructured'},
        ]
        for field in ['consoleErrors', 'pageErrors', 'requestFailures']:
            for value in [-1, 10001, True, 1.0, '1']:
                events = {'consoleErrors': 0, 'pageErrors': 0, 'requestFailures': 0}
                events[field] = value
                mutations.append({'events': events})
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for mutation in mutations:
                with self.subTest(fields=list(mutation)):
                    data = self.libraries_evidence(path)
                    data.update(mutation)
                    (path / 'failure.json').write_text(json.dumps(data), encoding='utf-8')
                    with self.assertRaisesRegex(SystemExit, 'summary is missing or invalid'):
                        audit('libraries-diagnostics', path)
            for raw in [b'[]', b'null', b'{', b'\xff']:
                self.libraries_evidence(path)
                (path / 'failure.json').write_bytes(raw)
                with self.assertRaisesRegex(SystemExit, 'summary is missing or invalid'):
                    audit('libraries-diagnostics', path)
            data = self.libraries_evidence(path)
            for field in data:
                missing = dict(data)
                del missing[field]
                (path / 'failure.json').write_text(json.dumps(missing), encoding='utf-8')
                with self.assertRaisesRegex(SystemExit, 'summary is missing or invalid'):
                    audit('libraries-diagnostics', path)

    def test_libraries_diagnostics_reject_unbounded_or_unexpected_files(self):
        for name, content in [
            ('browser-test.log', b'x' * 16385), ('failure.json', b'x' * 16385),
            ('failure-1.png', b'x' * (2 * 1024 * 1024 + 1)),
            ('browser-test.log', b''), ('failure.json', b''), ('failure-1.png', b''),
            ('failure-2.png', b'generated'), ('error-context.md', b'raw context'),
            ('trace.zip', b'raw trace'), ('fixture.mp4', b'generated fixture'),
        ]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.libraries_evidence(path)
                (path / name).write_bytes(content)
                with self.assertRaises(SystemExit):
                    audit('libraries-diagnostics', path)
        for size in [(1280, 900), (1440, 999), (1439, 1000)]:
            with self.subTest(size=size), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.libraries_evidence(path)
                (path / 'failure-1.png').write_bytes(b'\x89PNG\r\n\x1a\n' + b'\x00' * 8
                                                    + size[0].to_bytes(4, 'big') + size[1].to_bytes(4, 'big'))
                with self.assertRaises(SystemExit):
                    audit('libraries-diagnostics', path)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.libraries_evidence(path)
            image = path / 'failure-1.png'
            image.write_bytes(b'invalid!' + image.read_bytes()[8:])
            with self.assertRaises(SystemExit):
                audit('libraries-diagnostics', path)

    def test_libraries_diagnostics_require_the_declared_image_and_exact_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.libraries_evidence(path, screenshot=False)
            audit('libraries-diagnostics', path)
            (path / 'failure.json').unlink()
            with self.assertRaisesRegex(SystemExit, 'file count'):
                audit('libraries-diagnostics', path)
            self.libraries_evidence(path)
            (path / 'failure-1.png').unlink()
            with self.assertRaises(SystemExit):
                audit('libraries-diagnostics', path)
            self.libraries_evidence(path)
            self.libraries_evidence(path, screenshot=False)
            with self.assertRaises(SystemExit):
                audit('libraries-diagnostics', path)
            for name in ['failure.json', 'browser-test.log']:
                self.libraries_evidence(path)
                (path / name).unlink()
                with self.assertRaises(SystemExit):
                    audit('libraries-diagnostics', path)
            for suffix in [b'Unexpected raw error stack', b'\n', b'\xff']:
                self.libraries_evidence(path)
                with (path / 'browser-test.log').open('ab') as output:
                    output.write(suffix)
                with self.assertRaises(SystemExit):
                    audit('libraries-diagnostics', path)
            self.libraries_evidence(path)
            log = path / 'browser-test.log'
            log.write_bytes(log.read_bytes().replace(b'\n', b'\r\n'))
            with self.assertRaises(SystemExit):
                audit('libraries-diagnostics', path)

    def test_libraries_diagnostics_reject_private_markers_without_echoing_them(self):
        markers = [b'C:/Users/fixture/private', b'/Users/fixture/private', b'/home/fixture', b'/tmp/fixture',
                   b'/var/fixture', b'/mnt/fixture', b'id_ed25519', b'known_hosts', b'ghp_' + b'x' * 36,
                   b'https://fixture:password@example.invalid/', b'/volume1/fixture', b'192.168.2.3']
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for name in ['browser-test.log', 'failure.json', 'failure-1.png']:
                for marker in markers:
                    self.libraries_evidence(path)
                    with (path / name).open('ab') as output:
                        output.write(marker)
                    with self.assertRaises(SystemExit) as caught:
                        audit('libraries-diagnostics', path)
                    self.assertNotIn(marker.decode(), str(caught.exception))
            for name in ['browser-test.log', 'failure.json']:
                self.libraries_evidence(path)
                with (path / name).open('ab') as output:
                    output.write(b'Z:/fixture')
                with self.assertRaisesRegex(SystemExit, 'Private host/source marker'):
                    audit('libraries-diagnostics', path)

    def test_libraries_screenshot_compression_is_not_mistaken_for_a_drive_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.libraries_evidence(path)
            noise = random.Random(0).randbytes(1440 * 1000)
            rows = b''.join(b'\x00' + noise[row * 1440:(row + 1) * 1440] for row in range(1000))
            def chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
            png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1440, 1000, 8, 0, 0, 0, 0))
                   + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
            self.assertRegex(png, rb'[A-Z]:[\\/]')
            (path / 'failure-1.png').write_bytes(png)
            audit('libraries-diagnostics', path)

    def test_libraries_diagnostics_require_ordinary_root_and_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.libraries_evidence(path)
            audit('libraries-diagnostics', path)
            with patch('audit_ci_artifacts.Path.is_symlink', return_value=True):
                with self.assertRaisesRegex(SystemExit, 'ordinary directory'):
                    audit('libraries-diagnostics', path)
            with patch('audit_ci_artifacts.Path.lstat', return_value=SimpleNamespace(st_mode=0, st_file_attributes=0x400)):
                with self.assertRaisesRegex(SystemExit, 'ordinary directory'):
                    audit('libraries-diagnostics', path)
            image = path / 'failure-1.png'
            with patch('audit_ci_artifacts.Path.is_symlink', lambda file: file == image):
                with self.assertRaisesRegex(SystemExit, 'Unexpected file'):
                    audit('libraries-diagnostics', path)
            image.unlink()
            image.mkdir()
            with self.assertRaisesRegex(SystemExit, 'Unexpected file'):
                audit('libraries-diagnostics', path)
            with self.assertRaisesRegex(SystemExit, 'ordinary directory'):
                audit('libraries-diagnostics', path / 'failure.json')
            with self.assertRaisesRegex(SystemExit, 'ordinary directory'):
                audit('libraries-diagnostics', path / 'missing')

    def generated_evidence(self, path):
        png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8 + (1280).to_bytes(4, 'big') + (900).to_bytes(4, 'big')
        assets = {}
        for name in ['before-movies.png', 'before-series.png', 'after-movies.png', 'after-series.png', 'interactions.webm']:
            content = b'\x1a\x45\xdf\xa3generated fixture' if name.endswith('webm') else png
            (path / name).write_bytes(content)
            assets[name] = hashlib.sha256(content).hexdigest()
        data = {'schema': 1, 'generatedOnly': True, 'fixtureCount': 1457, 'providersEnabled': False,
                'sourceRevision': 'a' * 40, 'beforeRevision': 'c2d82902fab5fc9e4e16555d5978df943f5ab865',
                'viewport': {'width': 1280, 'height': 900}, 'recording': 'Generated silent recording',
                'methodology': 'Generated fixtures', 'checks': [], 'seeks': [], 'browser': 'fixture',
                'hevcStartupMs': 1000, 'assets': assets,
                'feedAppends': self.generated_feed_appends(),
                'layoutOracle': {'positionAndSizeMutationsRejected': True}}
        (path / 'provenance.json').write_text(json.dumps(data), encoding='utf-8')
        return data

    def generated_feed_appends(self):
        records = []
        for resource, count in [('series', 70), ('catalog', 75)]:
            anchors = {'first': {'x': 48.25, 'y': 450.5, 'width': 180, 'height': 320},
                       'last': {'x': 1050.25, 'y': 4800.5, 'width': 180, 'height': 320}}
            records.append({'resource': resource, 'initialCount': 60, 'count': count,
                            'before': anchors, 'after': copy.deepcopy(anchors)})
        return records

    def test_public_provenance_uses_the_real_emitter_metric_projection(self):
        probe_result = SimpleNamespace(returncode=0, stdout=json.dumps({
            'streams': [{'codec_type': 'video', 'width': 1280, 'height': 900}],
            'format': {'duration': '60'}}).encode())
        public_keys = {'methodology', 'checks', 'seeks', 'browser', 'hevcStartupMs', 'feedAppends', 'layoutOracle'}
        program = '''
import { readFileSync } from 'node:fs';
const { publicFixtureMetrics } = await import(process.argv[1]);
process.stdout.write(JSON.stringify(publicFixtureMetrics(JSON.parse(readFileSync(0, 'utf8')))));
'''
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            data = self.generated_evidence(path)
            result = {key: data[key] for key in public_keys}
            result['privateDiagnostic'] = '/volume1/generated-private-marker'
            result['futureMetric'] = {'unapproved': 'synthetic-only'}
            produced = subprocess.run(
                ['node', '--input-type=module', '-e', program,
                 Path(__file__).with_name('public-fixture-provenance.mjs').resolve().as_uri()],
                input=json.dumps(result), capture_output=True, text=True, timeout=10, check=True)
            metrics = json.loads(produced.stdout)
            self.assertEqual(set(metrics), public_keys)
            self.assertEqual(metrics, {key: data[key] for key in public_keys})
            self.assertNotIn('generated-private-marker', produced.stdout)
            (path / 'provenance.json').write_text(json.dumps({**data, **metrics}))
            # Producer-shaped metrics pass the same strict gate used before upload.
            with patch('audit_ci_artifacts.subprocess.run', return_value=probe_result):
                audit('public-fixtures', path)

    @patch('audit_ci_artifacts.subprocess.run')
    def test_public_feed_metrics_reject_malformed_or_extended_producer_shapes(self, probe):
        probe.return_value = SimpleNamespace(returncode=0, stdout=json.dumps({
            'streams': [{'codec_type': 'video', 'width': 1280, 'height': 900}],
            'format': {'duration': '60'}}).encode())
        records = self.generated_feed_appends()
        mutations = [
            {'feedAppends': None}, {'feedAppends': {}}, {'feedAppends': []},
            {'feedAppends': records[:1]}, {'feedAppends': records + records[:1]},
            {'feedAppends': [records[0], records[0]]}, {'feedAppends': [None, records[1]]},
            {'layoutOracle': None}, {'layoutOracle': []}, {'layoutOracle': {}},
            {'layoutOracle': {'positionAndSizeMutationsRejected': False}},
            {'layoutOracle': {'positionAndSizeMutationsRejected': 1}},
            {'layoutOracle': {'positionAndSizeMutationsRejected': 'true'}},
            {'layoutOracle': {'positionAndSizeMutationsRejected': True, 'raw': 'unapproved'}},
            {'unapprovedMetric': 'synthetic-only'},
        ]
        for field, values in {
            'resource': [None, [], 'unknown'], 'initialCount': [True, 60.0, 59, 61],
            'count': [True, 70.0, 69, 71, 1458], 'before': [None, {}, []],
            'after': [None, {}, []], 'raw': ['unapproved'],
        }.items():
            for value in values:
                changed = copy.deepcopy(records)
                changed[0][field] = value
                mutations.append({'feedAppends': changed})
        for field in records[0]:
            changed = copy.deepcopy(records)
            del changed[0][field]
            mutations.append({'feedAppends': changed})
        for phase in ['before', 'after']:
            for anchors in [{'first': records[0][phase]['first']},
                            {**records[0][phase], 'extra': records[0][phase]['first']}]:
                changed = copy.deepcopy(records)
                changed[0][phase] = anchors
                mutations.append({'feedAppends': changed})
            for anchor in ['first', 'last']:
                for value in [None, {}, [], {'x': 1, 'y': 2, 'width': 3, 'height': 4, 'raw': 0}]:
                    changed = copy.deepcopy(records)
                    changed[0][phase][anchor] = value
                    mutations.append({'feedAppends': changed})
                for key in ['x', 'y', 'width', 'height']:
                    changed = copy.deepcopy(records)
                    del changed[0][phase][anchor][key]
                    mutations.append({'feedAppends': changed})
                    for value in [True, '1', None, float('nan'), float('inf'), -float('inf'), 10 ** 1000, -1000001, 1000001]:
                        changed = copy.deepcopy(records)
                        changed[0][phase][anchor][key] = value
                        mutations.append({'feedAppends': changed})
                    if key in {'width', 'height'}:
                        for value in [0, -1, 10001]:
                            changed = copy.deepcopy(records)
                            changed[0][phase][anchor][key] = value
                            mutations.append({'feedAppends': changed})
        moved = copy.deepcopy(records)
        moved[0]['after']['last']['y'] += 1.01
        mutations.append({'feedAppends': moved})
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            original = self.generated_evidence(path)
            for mutation in mutations:
                with self.subTest(fields=list(mutation)):
                    data = {**original, **mutation}
                    (path / 'provenance.json').write_text(json.dumps(data), encoding='utf-8')
                    with self.assertRaisesRegex(SystemExit, 'Public fixture provenance is missing or invalid'):
                        audit('public-fixtures', path)
            for field in ['feedAppends', 'layoutOracle']:
                data = dict(original)
                del data[field]
                (path / 'provenance.json').write_text(json.dumps(data), encoding='utf-8')
                with self.assertRaisesRegex(SystemExit, 'Public fixture provenance is missing or invalid'):
                    audit('public-fixtures', path)

    @patch('audit_ci_artifacts.subprocess.run')
    def test_public_feed_metrics_allow_exact_finite_bounds_and_one_pixel_tolerance(self, probe):
        probe.return_value = SimpleNamespace(returncode=0, stdout=json.dumps({
            'streams': [{'codec_type': 'video', 'width': 1280, 'height': 900}],
            'format': {'duration': '60'}}).encode())
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            data = self.generated_evidence(path)
            data['feedAppends'].reverse()
            for record in data['feedAppends']:
                for phase in ['before', 'after']:
                    record[phase]['first'] = {'x': -1000000, 'y': 1000000, 'width': 10000, 'height': 0.5}
                for key in ['x', 'y', 'width', 'height']:
                    record['after']['last'][key] += 1
            (path / 'provenance.json').write_text(json.dumps(data), encoding='utf-8')
            audit('public-fixtures', path)

    @patch('audit_ci_artifacts.subprocess.run')
    def test_public_feed_metrics_reject_private_diagnostics_before_probe(self, probe):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for field in ['feedAppends', 'layoutOracle']:
                data = self.generated_evidence(path)
                target = data[field][0] if field == 'feedAppends' else data[field]
                marker = '/volume1/generated-private-marker'
                target['privateDiagnostic'] = marker
                (path / 'provenance.json').write_text(json.dumps(data), encoding='utf-8')
                with self.assertRaises(SystemExit) as caught:
                    audit('public-fixtures', path)
                self.assertNotIn(marker, str(caught.exception))
            probe.assert_not_called()

    @patch('audit_ci_artifacts.subprocess.run')
    def test_public_fixture_screenshots_keep_the_desktop_viewport(self, probe):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.generated_evidence(path)
            png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8 + (390).to_bytes(4, 'big') + (900).to_bytes(4, 'big')
            (path / 'before-movies.png').write_bytes(png)
            with self.assertRaises(SystemExit):
                audit('public-fixtures', path)
            probe.assert_not_called()

    @patch('audit_ci_artifacts.subprocess.run')
    def test_generated_evidence_requires_provenance_and_rejects_extra_files(self, probe):
        probe.return_value = SimpleNamespace(returncode=0, stdout=json.dumps({
            'streams': [{'codec_type': 'video', 'width': 1280, 'height': 900}],
            'format': {'duration': '60'}}).encode())
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            data = self.generated_evidence(path)
            audit('public-fixtures', path)
            (path / 'source.mp4').write_bytes(b'generated')
            with self.assertRaises(SystemExit): audit('public-fixtures', path)
            (path / 'source.mp4').unlink()
            data['generatedOnly'] = False
            (path / 'provenance.json').write_text(json.dumps(data))
            with self.assertRaises(SystemExit): audit('public-fixtures', path)

    @patch('audit_ci_artifacts.subprocess.run')
    def test_generated_evidence_rejects_hash_mismatch_and_audio(self, probe):
        probe.return_value = SimpleNamespace(returncode=0, stdout=json.dumps({
            'streams': [{'codec_type': 'video', 'width': 1280, 'height': 900}],
            'format': {'duration': '60'}}).encode())
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.generated_evidence(path)
            with (path / 'before-movies.png').open('ab') as output: output.write(b'changed')
            with self.assertRaises(SystemExit): audit('public-fixtures', path)
            self.generated_evidence(path)
            probe.return_value.stdout = json.dumps({'streams': [{'codec_type': 'audio'}], 'format': {'duration': '60'}}).encode()
            with self.assertRaises(SystemExit): audit('public-fixtures', path)

    @patch('audit_ci_artifacts.subprocess.run')
    def test_generated_evidence_rejects_private_markers_before_probe(self, probe):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.generated_evidence(path)
            with (path / 'before-movies.png').open('ab') as output: output.write(b'C:/Users/fixture/private')
            entries = list(path.iterdir())
            entries.sort(key=lambda file: file.name != 'interactions.webm')
            with patch('audit_ci_artifacts.Path.iterdir', return_value=iter(entries)):
                with self.assertRaises(SystemExit): audit('public-fixtures', path)
            probe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
