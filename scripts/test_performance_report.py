"""Exercise benchmark audits with generated data and no network/device I/O."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from performance_report import (
    MAX_REPORT_BYTES, MAX_SUMMARY_BYTES, ReportError, audit_directory,
    _is_link, comparison_reasons, main, percent_change, render_summary, validate_report,
)


HEAD_SHA = "1" * 40
BASE_SHA = "2" * 40
DIGEST = "3" * 64


def report(role="head"):
    return {
        "schemaVersion": 1,
        "sourceSha": HEAD_SHA if role == "head" else BASE_SHA,
        "role": role,
        "fixtureId": "catalog-v1-120000",
        "workload": {
            "movies": 100_000, "series": 1_000, "episodesPerSeries": 20,
            "pageSize": 60, "deepOffset": 90_000, "warmups": 3,
            "samples": 30, "concurrency": 1,
        },
        "metrics": {name: {"medianMs": 10, "p95Ms": 20} for name in (
            "moviesFirst", "moviesDeep", "movieSearch", "episodesPage", "seriesPage",
        )},
        "sqliteBytes": 1_000_000,
        "environment": {"os": "Linux", "arch": "x86_64", "rustc": "1.94.0", "sqlite": "3.46.0"},
        "budgetVersion": 1,
        "budgetDigest": DIGEST,
    }


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def write(self, name, value):
        path = self.directory / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def audit(self):
        return audit_directory(self.directory, expected_head=HEAD_SHA, expected_base=BASE_SHA)

    def run_cli(self, *arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main([str(self.directory), "--expected-head", HEAD_SHA,
                         "--expected-base", BASE_SHA, *arguments])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_exact_median_p95_and_allocation_delta_math(self):
        head, base = report(), report("base")
        head["metrics"]["moviesFirst"] = {"medianMs": 15, "p95Ms": 16}
        head["sqliteBytes"] = 1_100_000
        self.write("head.json", head)
        self.write("base.json", base)
        _, _, summary = self.audit()
        self.assertIn("| Movies: first page | 15.0000 | 16.0000 | 10.0000 | 20.0000 | +5.0000 | +50.00% | -4.0000 | -20.00% |", summary)
        self.assertIn("delta: +100,000 bytes (+10.00%).", summary)
        self.assertIn("PR-produced measurements are untrusted and advisory", summary)
        self.assertLess(len(summary.encode()), MAX_SUMMARY_BYTES)

    def test_cli_writes_canonical_summary_and_is_idempotent(self):
        self.write("head.json", report())
        self.write("base.json", report("base"))
        first = self.run_cli()
        self.assertEqual((first[0], first[2]), (0, ""))
        self.assertEqual((self.directory / "summary.md").read_text(), first[1])
        self.assertEqual(self.run_cli(), first)
        self.assertEqual({path.name for path in self.directory.iterdir()}, {"head.json", "base.json", "summary.md"})

    def test_arbitrarily_large_valid_slowdown_is_advisory(self):
        head = report()
        head["metrics"]["moviesFirst"] = {"medianMs": 3_000_000, "p95Ms": 3_600_000}
        self.write("head.json", head)
        self.write("base.json", report("base"))
        code, summary, error = self.run_cli()
        self.assertEqual((code, error), (0, ""))
        self.assertIn("+29999900.00%", summary)
        self.assertIn("Timing changes do not fail CI", summary)

    def test_missing_baseline_is_unavailable_and_successful(self):
        self.write("head.json", report())
        code, summary, error = self.run_cli()
        self.assertEqual((code, error), (0, ""))
        self.assertIn("Comparison unavailable: missing baseline.", summary)
        self.assertNotIn("+0.00%", summary)
        self.assertNotIn("Base source", summary)
        self.assertIn("| Movies: first page | 10.0000 | 20.0000 | n/a | n/a | n/a | n/a | n/a | n/a |", summary)

    def test_each_comparability_field_change_suppresses_every_delta(self):
        for name, mutate, reason in [
            ("fixture", lambda value: value.update(fixtureId="catalog-v2-120000"), "fixture changed"),
            ("workload", lambda value: value["workload"].update(samples=31), "workload changed"),
            ("budget version", lambda value: value.update(budgetVersion=2), "budget contract changed"),
            ("same-version budget digest", lambda value: value.update(budgetDigest="4" * 64), "budget contract changed"),
            ("environment", lambda value: value["environment"].update(sqlite="3.47.0"), "environment changed"),
        ]:
            with self.subTest(name=name):
                head, base = report(), report("base")
                mutate(head)
                validate_report(head, expected_role="head")
                self.assertIn(reason, comparison_reasons(head, base))
                summary = render_summary(head, base)
                self.assertIn(reason, summary)
                self.assertNotIn("+0.00%", summary)
                self.assertNotIn("Base SQLite allocation", summary)
                self.assertIn("| n/a | n/a | n/a | n/a | n/a | n/a |", summary)

    def test_pre_manifest_base_is_comparable_with_explicit_caveat(self):
        base = report("base")
        base.update(budgetVersion=0, budgetDigest="absent")
        self.write("base.json", base)
        self.write("head.json", report())
        _, _, summary = self.audit()
        self.assertEqual(comparison_reasons(report(), base), ())
        self.assertIn("Base predates structural budgets", summary)
        self.assertIn("pre-budget baseline exception applies", summary)
        self.assertNotIn("same fixture, workload, budget contract", summary)
        self.assertIn("+0.00%", summary)
        base["workload"]["samples"] = 31
        self.assertEqual(comparison_reasons(report(), base), ("workload changed",))

    def test_absent_manifest_does_not_silently_disable_head_protection(self):
        for role, version, digest in [
            ("head", 0, "absent"), ("base", 1, "absent"),
            ("base", 0, DIGEST), ("head", 0, DIGEST),
        ]:
            with self.subTest(role=role, version=version, digest=digest):
                value = report(role)
                value.update(budgetVersion=version, budgetDigest=digest)
                with self.assertRaises(ReportError):
                    validate_report(value, expected_role=role)

    def test_threshold_inflation_is_rejected_even_inside_known_objects(self):
        for mutate in (
            lambda value: value.update(budgets={"maximumVmSteps": 1_000_000_000}),
            lambda value: value["workload"].update(maximumVmSteps=1_000_000_000),
            lambda value: value["metrics"]["moviesFirst"].update(budgetMs=1_000_000),
        ):
            value = report()
            mutate(value)
            with self.assertRaises(ReportError):
                validate_report(value, expected_role="head")

    def test_altered_comparator_produces_detectably_different_summary(self):
        head, base = report(), report("base")
        head["metrics"]["moviesFirst"]["medianMs"] = 15
        correct = render_summary(head, base)
        with patch("performance_report.percent_change", return_value=-50):
            mutated = render_summary(head, base)
        self.assertNotEqual(correct, mutated)
        self.write("head.json", head)
        self.write("base.json", base)
        (self.directory / "summary.md").write_text(mutated, encoding="utf-8")
        with self.assertRaisesRegex(ReportError, "not canonical"):
            self.audit()

    def test_zero_and_tiny_baseline_percentage_is_not_infinite(self):
        for number in (0, 1e-300, 0.0000001):
            with self.subTest(number=number):
                self.assertIsNone(percent_change(1, number))
                base = report("base")
                base["metrics"]["moviesFirst"] = {"medianMs": number, "p95Ms": number}
                summary = render_summary(report(), base)
                self.assertIn("n/a (near-zero base)", summary)
                self.assertNotIn("inf", summary)

    def test_expected_role_and_sha_are_checked(self):
        for mutate in (
            lambda value: value.update(role="base"),
            lambda value: value.update(sourceSha=BASE_SHA),
            lambda value: value.update(sourceSha="A" * 40),
        ):
            value = report()
            mutate(value)
            self.write("head.json", value)
            with self.assertRaises(ReportError):
                self.audit()
        self.write("head.json", report())
        base = report("base")
        base["sourceSha"] = HEAD_SHA
        self.write("base.json", base)
        with self.assertRaisesRegex(ReportError, "expected source"):
            self.audit()

    def test_exact_keys_required_at_every_level(self):
        for path in ((), ("environment",), ("workload",), ("metrics",), ("metrics", "moviesFirst")):
            for mode in ("extra", "missing"):
                with self.subTest(path=path, mode=mode):
                    value = report()
                    target = value
                    for part in path:
                        target = target[part]
                    if mode == "extra":
                        target["privatePath"] = "not published"
                    else:
                        target.pop(next(iter(target)))
                    with self.assertRaises(ReportError):
                        validate_report(value, expected_role="head")

    def test_numbers_reject_boolean_negative_nonfinite_and_bounds(self):
        for path, invalid_values in (
            (("schemaVersion",), [True, 0, 2, 1.0]),
            (("budgetVersion",), [True, 0, -1, 10_001, 1.0]),
            (("sqliteBytes",), [True, 0, -1, 1_000_000_000_001, 1.0]),
            (("workload", "samples"), [True, 4, 1_001, 30.0]),
            (("metrics", "moviesFirst", "medianMs"), [True, -1, float("nan"), float("inf"), 3_600_001, "1", 10**400]),
        ):
            for invalid in invalid_values:
                with self.subTest(path=path, invalid=type(invalid).__name__):
                    value = report()
                    target = value
                    for part in path[:-1]:
                        target = target[part]
                    target[path[-1]] = invalid
                    with self.assertRaises(ReportError):
                        validate_report(value, expected_role="head")

    def test_invalid_percentile_order_and_workload_shapes(self):
        for mutate in (
            lambda value: value["metrics"]["moviesFirst"].update(medianMs=21),
            lambda value: value["workload"].update(deepOffset=100_000),
            lambda value: value["workload"].update(series=100_000, episodesPerSeries=1_000),
        ):
            value = report()
            mutate(value)
            with self.assertRaises(ReportError):
                validate_report(value, expected_role="head")

    def test_platform_and_version_strings_are_strictly_constrained(self):
        for field, invalid in (
            ("os", "Linux\n::warning::injected"), ("arch", "<script>"),
            ("rustc", "1.94.0 (private-host)"), ("sqlite", "3.46.0\n[secret](https://example.invalid)"),
            ("rustc", "1.94.0/../../private"), ("sqlite", "3.46.0😀"),
        ):
            value = report()
            value["environment"][field] = invalid
            self.write("head.json", value)
            code, output, error = self.run_cli()
            self.assertEqual((code, output), (1, ""))
            self.assertNotIn(invalid, error)
            self.assertFalse((self.directory / "summary.md").exists())

    def test_json_duplicate_keys_nonfinite_and_malformed_input(self):
        valid = json.dumps(report())
        for content in (
            valid[:-1] + ', "sourceSha": "' + HEAD_SHA + '"}',
            valid.replace('"medianMs": 10', '"medianMs": NaN'),
            valid.replace('"medianMs": 10', '"medianMs": Infinity'),
            valid.replace('"medianMs": 10', '"medianMs": 1e999'),
            '{"private": "secret",', "[" * 2_000, '\ufeff' + valid,
            valid.replace('"sqliteBytes": 1000000', '"sqliteBytes": ' + '9' * 5_000),
        ):
            with self.subTest(prefix=content[:12]):
                (self.directory / "head.json").write_text(content, encoding="utf-8")
                code, output, error = self.run_cli()
                self.assertEqual((code, output), (1, ""))
                self.assertNotIn("secret", error)

    def test_private_payloads_cannot_fit_allowed_string_fields(self):
        for field, invalid in (
            ("sourceSha", "ghp_" + "x" * 36),
            ("fixtureId", "catalog-v1-120000\n::error::private"),
            ("fixtureId", "C:\\Users\\Generated\\private.sqlite"),
            ("budgetDigest", "https://fixture:secret@example.invalid/"),
        ):
            value = report()
            value[field] = invalid
            self.write("head.json", value)
            code, output, error = self.run_cli()
            self.assertEqual((code, output), (1, ""))
            self.assertNotIn(invalid, error)

    def test_unknown_filename_subdirectory_and_missing_head_fail_closed(self):
        self.write("head.json", report())
        for name in ("private.log", "HEAD.json", "head.json.exe", "manifest.json", "nested"):
            if name != "head.json" and os.path.normcase(name) == os.path.normcase("head.json"):
                continue  # Case-insensitive filesystems cannot create this extra file.
            with self.subTest(name=name):
                extra = self.directory / name
                if name == "nested":
                    extra.mkdir()
                else:
                    extra.write_text("synthetic private payload")
                with self.assertRaises(ReportError):
                    self.audit()
                if extra.is_dir():
                    extra.rmdir()
                else:
                    extra.unlink()
        (self.directory / "head.json").unlink()
        self.write("base.json", report("base"))
        with self.assertRaisesRegex(ReportError, "Head report"):
            self.audit()

    def test_file_size_bounds_and_invalid_utf8(self):
        for content in (b"", b"x" * (MAX_REPORT_BYTES + 1), b"\xff\xfe"):
            with self.subTest(length=len(content)):
                (self.directory / "head.json").write_bytes(content)
                with self.assertRaises(ReportError):
                    self.audit()

    def test_summary_injection_and_oversize_are_rejected(self):
        self.write("head.json", report())
        for content in ("::warning::private\n<script>bad</script>", "x" * (MAX_SUMMARY_BYTES + 1)):
            with self.subTest(length=len(content)):
                (self.directory / "summary.md").write_text(content, encoding="utf-8")
                with self.assertRaises(ReportError):
                    self.audit()

    def test_hardlinked_report_is_rejected(self):
        source = self.directory / "ordinary.tmp"
        source.write_text(json.dumps(report()), encoding="utf-8")
        try:
            os.link(source, self.directory / "head.json")
        except OSError:
            self.skipTest("OS does not permit synthetic hardlink creation")
        source.rename(self.directory.parent / (self.directory.name + "-linked.tmp"))
        linked = self.directory.parent / (self.directory.name + "-linked.tmp")
        self.addCleanup(lambda: linked.unlink(missing_ok=True))
        with self.assertRaisesRegex(ReportError, "one link"):
            self.audit()

    def test_hardlink_metadata_and_windows_reparse_flags_are_rejected(self):
        path = self.write("head.json", report())
        original = Path.lstat

        def linked_metadata(candidate):
            metadata = original(candidate)
            if candidate == path:
                return SimpleNamespace(st_mode=metadata.st_mode, st_nlink=2,
                                       st_size=metadata.st_size, st_file_attributes=0)
            return metadata

        with patch.object(Path, "lstat", autospec=True, side_effect=linked_metadata):
            with self.assertRaisesRegex(ReportError, "one link"):
                self.audit()
        self.assertTrue(_is_link(SimpleNamespace(st_mode=path.stat().st_mode, st_file_attributes=0x400)))

    def test_symlinked_report_and_directory_are_rejected(self):
        target = self.directory / "ordinary.tmp"
        target.write_text(json.dumps(report()), encoding="utf-8")
        link = self.directory / "head.json"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("OS does not permit synthetic symlink creation")
        target.rename(self.directory.parent / (self.directory.name + "-target.tmp"))
        external = self.directory.parent / (self.directory.name + "-target.tmp")
        self.addCleanup(lambda: external.unlink(missing_ok=True))
        with self.assertRaises(ReportError):
            self.audit()
        directory_link = self.directory.parent / (self.directory.name + "-directory")
        directory_link.symlink_to(self.directory, target_is_directory=True)
        self.addCleanup(lambda: directory_link.unlink(missing_ok=True))
        with self.assertRaisesRegex(ReportError, "ordinary directory"):
            audit_directory(directory_link, expected_head=HEAD_SHA)

    def test_parent_traversal_and_argument_injection_do_not_echo_inputs(self):
        self.write("head.json", report())
        with self.assertRaisesRegex(ReportError, "traversal"):
            audit_directory(self.directory / ".." / self.directory.name, expected_head=HEAD_SHA)
        code, output, error = self.run_cli("--injected=::warning::private")
        self.assertEqual((code, output), (1, ""))
        self.assertNotIn("private", error)


if __name__ == "__main__":
    unittest.main()
