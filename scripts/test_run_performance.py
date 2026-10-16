"""Preparation tests never build code or contact a host."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run_performance as runner


class PreparationTests(unittest.TestCase):
    def test_exact_shas_only(self):
        good = 'a' * 40
        self.assertEqual(runner.checked_sha(good), good)
        for value in ['main', '-option', 'a' * 39, 'A' * 40, '0' * 40, good + '\n', None]:
            with self.assertRaises(ValueError):
                runner.checked_sha(value)

    def test_baseline_compatibility_only_removes_exact_map_setup(self):
        harness = 'before\n' + runner.FIXTURE_SETUP + '\nafter\n'
        self.assertEqual(runner.adapt_harness(harness, 'no map'), 'before\nafter\n')
        self.assertEqual(runner.adapt_harness(harness, 'series_entries: map'), harness)
        other = '    run_series_entries();\n'
        self.assertEqual(runner.adapt_harness(other, 'no map'), other)

    def test_strict_json_rejects_duplicates_and_nonfinite(self):
        for text in ['{"n":1,"n":2}', '{"n":NaN}', '{"n":Infinity}']:
            with self.assertRaises(ValueError):
                runner.strict_json(text)

    def test_policy_changes_detected_without_version_bump(self):
        def identity(policy):
            with patch.object(runner, 'source_file', return_value=json.dumps(policy)):
                return runner.policy_identity(Path('.'), 'a' * 40)
        before = identity({'budgetVersion': 1, 'maxRows': 60})
        after = identity({'budgetVersion': 1, 'maxRows': 600})
        self.assertEqual(before[0], after[0])
        self.assertNotEqual(before[1], after[1])
        self.assertEqual(before, identity({'maxRows': 60, 'budgetVersion': 1}))
        canonical = '{"budgetVersion":1,"maxRows":60}'.encode()
        self.assertEqual(before[1], hashlib.sha256(canonical).hexdigest())

    def test_pre_budget_baseline_is_explicit(self):
        with patch.object(runner, 'source_file', return_value=None):
            self.assertEqual(runner.policy_identity(Path('.'), 'a' * 40), (0, 'absent'))

    def test_invalid_budget_policy_rejected(self):
        for text in ['{"budgetVersion":true}', '{"budgetVersion":0}', '{"budgetVersion":1,"budgetVersion":2}',
                     '{"budgetVersion":1}' + ' ' * 8192, '[]', 'null', '1', '"text"']:
            with patch.object(runner, 'source_file', return_value=text):
                with self.assertRaises(ValueError):
                    runner.policy_identity(Path('.'), 'a' * 40)

    def test_output_cannot_escape_or_use_parent_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.assertEqual(runner.artifact_output(root / 'artifacts', root), root / 'artifacts')
            for path in [root, root.parent / 'outside', root / 'one/../artifacts']:
                with self.assertRaises(ValueError):
                    runner.artifact_output(path, root)

    def test_link_ancestor_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / 'link'
            path.mkdir()
            with patch.object(Path, 'is_symlink', lambda p: p == path):
                with self.assertRaises(ValueError):
                    runner.artifact_output(path / 'artifacts', root)

    def test_deep_json_is_a_sanitized_validation_error(self):
        with patch.object(runner.json, 'loads', side_effect=RecursionError):
            with self.assertRaisesRegex(ValueError, 'JSON nesting exceeds its limit'):
                runner.strict_json('[]')

    def run_mocked(self, root, base, build_error=None, measure_error=None):
        class Result:
            returncode = 0
            stdout = 'a' * 40

        class RustResult(Result):
            stdout = 'rustc 1.94.0 (version metadata)'

        def build(checkout, target, log):
            if checkout.name == build_error:
                raise ValueError('incompatible source')
            return target / 'benchmark'

        def measure(executable, checkout, raw, environment, role, sha, policy):
            if role == measure_error:
                raise ValueError('incompatible measurement')
            return {'sourceSha': sha}

        def command(args, *unused, **kwargs):
            return RustResult() if args == ['rustc', '--version'] else Result()

        with patch.object(runner, 'git', return_value=Result()), \
                patch.object(runner, 'source_file', return_value='shared harness'), \
                patch.object(runner, 'prepare', side_effect=lambda root, work, role, *args: work / role) as prepare, \
                patch.object(runner, 'build', side_effect=build), \
                patch.object(runner, 'measure', side_effect=measure), \
                patch.object(runner, 'policy_identity', return_value=(1, 'b' * 64)), \
                patch.object(runner, 'command', side_effect=command):
            runner.run(root, 'a' * 40, base, root / 'artifacts')
            return prepare.call_count

    def test_incompatible_baseline_preserves_head_observations(self):
        for failure in ['build', 'measure']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                self.run_mocked(root, 'b' * 40, build_error='base' if failure == 'build' else None,
                                measure_error='base' if failure == 'measure' else None)
                self.assertTrue((root / 'artifacts/head.json').is_file())
                self.assertFalse((root / 'artifacts/base.json').exists())

    def test_missing_baseline_never_prepares_a_second_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.assertEqual(self.run_mocked(root, None), 1)
            self.assertTrue((root / 'artifacts/head.json').is_file())

    def test_head_build_failure_is_blocking(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with self.assertRaises(ValueError):
                self.run_mocked(root, 'b' * 40, build_error='head')

    def test_source_size_is_checked_before_reading(self):
        class Result:
            stdout = '1000000'
            returncode = 0
        with patch.object(runner, 'git', return_value=Result()) as git:
            with self.assertRaises(ValueError):
                runner.source_file(Path('.'), 'a' * 40, 'fixture', max_bytes=8192)
            self.assertEqual(git.call_count, 1)

    def test_wrong_checkout_stops_before_build(self):
        class Result:
            stdout = 'b' * 40
        with patch.object(runner, 'git', return_value=Result()), patch.object(runner, 'build') as build:
            with self.assertRaises(ValueError):
                runner.run(Path('.'), 'a' * 40, None, Path('unused'))
            build.assert_not_called()


if __name__ == '__main__':
    unittest.main()
