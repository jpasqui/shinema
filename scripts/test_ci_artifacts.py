"""Exercise the public-build guard with synthetic data only."""
import tempfile
import hashlib
import json
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

    def test_generated_evidence_rejects_private_markers_before_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            self.generated_evidence(path)
            with (path / 'before-movies.png').open('ab') as output: output.write(b'C:/Users/fixture/private')
            with self.assertRaises(SystemExit): audit('public-fixtures', path)


if __name__ == '__main__':
    unittest.main()
