"""Exercise the public-build guard with synthetic data only."""
import tempfile
import hashlib
import json
import random
import struct
import zlib
from unittest.mock import patch
from types import SimpleNamespace
import unittest
import zipfile
from pathlib import Path

from audit_ci_artifacts import REACT_NATIVE_DEBUG_HINT, audit, check


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

    def playback_evidence(self, path):
        data = {'schema': 1, 'generatedOnly': True, 'status': 'failed',
                'runnerErrors': 0, 'omittedFailures': 0, 'failures': [
                    {'source': 'tests/e2e/playback.spec.ts', 'line': 10,
                     'outcome': 'failed', 'errorCount': 1, 'screenshot': True}]}
        (path / 'failure.json').write_text(json.dumps(data), encoding='utf-8')
        (path / 'browser-test.log').write_text(
            'Generated-only playback suite: failed\nrunnerErrors=0 omittedFailures=0\n'
            'tests/e2e/playback.spec.ts:10 outcome=failed errors=1 screenshot=failure-1.png\n', encoding='utf-8')
        png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8 + (1280).to_bytes(4, 'big') + (900).to_bytes(4, 'big')
        (path / 'failure-1.png').write_bytes(png)
        return data

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
            for marker in [b'C:/Users/fixture/private', b'/Users/fixture/private', b'/tmp/fixture',
                           b'ghp_' + b'x' * 36, b'https://fixture:password@example.invalid/', b'/volume1/fixture']:
                self.playback_evidence(path)
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


    def subtitle_png(self, width=1280, height=1080):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        rows = (b'\x00' + b'\x00' * width) * height
        return (b'\x89PNG\r\n\x1a\n'
                + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))

    def subtitle_evidence(self, path, **changes):
        data = {'schema': 1, 'generatedOnly': True, 'status': 'failed',
                'phase': 'fixtures', 'source': 'scripts/subtitle-smoke.mjs',
                'line': 0, 'completedChecks': 0, 'pageErrors': 0,
                'serverState': 'not-started', 'screenshot': False}
        data.update(changes)
        (path / 'failure.json').write_text(json.dumps(data), encoding='utf-8')
        log = (f"Generated-only subtitle smoke: failed\n"
               f"{data['source']}:{data['line']} phase={data['phase']}\n"
               f"completedChecks={data['completedChecks']} pageErrors={data['pageErrors']} "
               f"serverState={data['serverState']} "
               f"screenshot={'failure.png' if data['screenshot'] else 'unavailable'}\n")
        (path / 'browser-test.log').write_bytes(log.encode('utf-8'))
        if data['screenshot']:
            (path / 'failure.png').write_bytes(self.subtitle_png())
        return data

    def test_subtitle_diagnostics_allow_startup_failure_without_screenshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.subtitle_evidence(path)
            audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_allow_fixed_screenshot_and_bounded_counters(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.subtitle_evidence(path, phase='direct-playback', line=1000000,
                                   completedChecks=64, pageErrors=100,
                                   serverState='running', screenshot=True)
            audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_allow_only_declared_phases_and_server_states(self):
        phases = ['fixtures', 'server-startup', 'browser-startup', 'subtitle-playback',
                  'direct-playback', 'discovery-recovery', 'discovery-cancellation']
        for phase in phases:
            for state in ['not-started', 'starting', 'running', 'exited']:
                with self.subTest(phase=phase, state=state), tempfile.TemporaryDirectory() as temporary:
                    path = Path(temporary)
                    self.subtitle_evidence(path, phase=phase, serverState=state)
                    audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_reject_empty_and_oversized_files(self):
        for name, limit in [('failure.json', 65536), ('browser-test.log', 65536),
                            ('failure.png', 2 * 1024 * 1024)]:
            for size in [0, limit + 1]:
                with self.subTest(name=name, size=size), tempfile.TemporaryDirectory() as temporary:
                    path = Path(temporary)
                    self.subtitle_evidence(path, screenshot=True)
                    (path / name).write_bytes(b'x' * size)
                    with self.assertRaises(SystemExit):
                        audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_reject_extra_media_trace_and_directory_entries(self):
        for name in ['extra.json', 'fixture.mp4', 'fixture.mkv', 'recording.webm',
                     'trace.zip', 'error-context.md', '.env.local']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.subtitle_evidence(path)
                (path / name).write_bytes(b'generated fixture')
                with self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', path)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.subtitle_evidence(path)
            (path / 'failure.png').mkdir()
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', path)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.subtitle_evidence(path, screenshot=True)
            (path / 'extra.json').write_text('{}')
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_require_exact_summary_and_screenshot_files(self):
        for name in ['failure.json', 'browser-test.log', 'failure.png']:
            with self.subTest(missing=name), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.subtitle_evidence(path, screenshot=True)
                (path / name).unlink()
                with self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', path)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.subtitle_evidence(path)
            (path / 'failure.png').write_bytes(self.subtitle_png())
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', path)
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', Path(temporary))

    def test_subtitle_diagnostics_reject_wrong_screenshot_format_or_dimensions(self):
        for image in [b'not a PNG', b'\x89PNG\r\n\x1a\n',
                      self.subtitle_png(1280, 900), self.subtitle_png(640, 1080)]:
            with self.subTest(bytes=len(image)), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.subtitle_evidence(path, screenshot=True)
                (path / 'failure.png').write_bytes(image)
                with self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_require_exact_field_schema_and_types(self):
        invalid = [
            ('schema', 2), ('schema', True), ('schema', 1.0), ('schema', '1'),
            ('generatedOnly', False), ('generatedOnly', 1), ('generatedOnly', 'true'),
            ('status', 'passed'), ('status', []), ('phase', 'unknown'), ('phase', []),
            ('source', 'scripts/another-smoke.mjs'), ('source', []),
            ('serverState', 'unknown'), ('serverState', {}),
            ('screenshot', 0), ('screenshot', 'false'), ('screenshot', None),
        ]
        for field, limit in [('line', 1000000), ('completedChecks', 64), ('pageErrors', 100)]:
            invalid.extend((field, value) for value in [-1, limit + 1, True, 0.5, '0', None])
        for field, value in invalid:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.subtitle_evidence(path, **{field: value})
                with self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', path)
        for summary in [None, [], {}, {'extra': 'value'}, b'\xff', b'{']:
            with self.subTest(summary=summary), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.subtitle_evidence(path)
                (path / 'failure.json').write_bytes(
                    summary if isinstance(summary, bytes) else json.dumps(summary).encode('utf-8'))
                with self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', path)
        for change in ['missing', 'extra']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                summary = self.subtitle_evidence(path)
                if change == 'missing':
                    del summary['line']
                else:
                    summary['message'] = 'unexpected field'
                (path / 'failure.json').write_text(json.dumps(summary), encoding='utf-8')
                with self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_reject_raw_or_mismatched_logs(self):
        for extra in [b'Unexpected raw error stack\n', b'\n', b'\xff']:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                self.subtitle_evidence(path)
                with (path / 'browser-test.log').open('ab') as output:
                    output.write(extra)
                with self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', path)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.subtitle_evidence(path)
            log = path / 'browser-test.log'
            log.write_bytes(log.read_bytes().replace(b'\n', b'\r\n'))
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_reject_private_markers_without_echoing_them(self):
        markers = [b'C:/Users/fixture/private', b'C:\\Users\\fixture\\private',
                   b'/Users/fixture/private', b'/home/fixture', b'/tmp/fixture',
                   b'/var/fixture', b'/mnt/fixture', b'id_ed25519', b'known_hosts',
                   b'ghp_' + b'x' * 36, b'https://fixture:password@example.invalid/',
                   b'192.168.2.3', b'/volume1/fixture']
        for name in ['failure.png', 'failure.json', 'browser-test.log']:
            for marker in markers:
                with self.subTest(name=name, marker=marker), tempfile.TemporaryDirectory() as temporary:
                    path = Path(temporary)
                    self.subtitle_evidence(path, screenshot=True)
                    with (path / name).open('ab') as output:
                        output.write(marker)
                    with self.assertRaises(SystemExit) as caught:
                        audit('subtitle-diagnostics', path)
                    self.assertNotIn(marker.decode(), str(caught.exception))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.subtitle_evidence(path)
            with (path / 'browser-test.log').open('ab') as output:
                output.write(b'Q:/fixture')
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', path)

    def test_subtitle_diagnostics_require_ordinary_directory_and_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            path = base / 'evidence'
            path.mkdir()
            self.subtitle_evidence(path, screenshot=True)
            target = base / 'generated.png'
            (path / 'failure.png').rename(target)
            link = path / 'failure.png'
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest('Symbolic links are unavailable on this host')
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', path)
            directory_link = base / 'linked-evidence'
            directory_link.symlink_to(path, target_is_directory=True)
            with self.assertRaises(SystemExit):
                audit('subtitle-diagnostics', directory_link)
            for ordinary in [base / 'missing', target]:
                with self.subTest(path=ordinary.name), self.assertRaises(SystemExit):
                    audit('subtitle-diagnostics', ordinary)

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
                'hevcStartupMs': 1000, 'assets': assets}
        (path / 'provenance.json').write_text(json.dumps(data), encoding='utf-8')
        return data

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
