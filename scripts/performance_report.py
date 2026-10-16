"""Audit generated benchmark JSON and write a static, advisory Markdown summary.

This module never executes, downloads, or extracts report content. Timing changes
are informational; deterministic structural budgets are enforced by Rust tests.
Only schema-validated, synthetic measurements may be retained as CI artifacts.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


MAX_REPORT_BYTES = 32 * 1024
MAX_SUMMARY_BYTES = 16 * 1024
REPORT_NAMES = {"head.json", "base.json", "summary.md"}
METRICS = {
    "moviesFirst": "Movies: first page",
    "moviesDeep": "Movies: deep page",
    "movieSearch": "Movies: search",
    "episodesPage": "Episodes: page",
    "seriesPage": "Series: page",
}
WORKLOAD_LIMITS = {
    "movies": (1, 1_000_000),
    "series": (1, 100_000),
    "episodesPerSeries": (1, 1_000),
    "pageSize": (1, 500),
    "deepOffset": (0, 1_000_000),
    "warmups": (0, 100),
    "samples": (5, 1_000),
    "concurrency": (1, 1_024),
}
OS_NAMES = {name: name for name in ("Linux", "Windows", "Darwin")}
ARCH_NAMES = {name: name for name in (
    "x86_64", "amd64", "aarch64", "arm64", "x86", "i686", "armv7l", "riscv64",
)}
SHA_PATTERN = re.compile(r"[0-9a-f]{40}", re.ASCII)
DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}", re.ASCII)
FIXTURE_PATTERN = re.compile(r"catalog-v[1-9][0-9]{0,3}-[1-9][0-9]{0,8}", re.ASCII)
VERSION_PATTERN = re.compile(
    r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-(?:beta|nightly|dev)(?:\.[0-9]{1,4})?)?",
    re.ASCII,
)
ROOT_KEYS = {
    "schemaVersion", "sourceSha", "role", "fixtureId", "workload", "metrics",
    "sqliteBytes", "environment", "budgetVersion", "budgetDigest",
}


class ReportError(ValueError):
    """A bounded, constant message safe to show in a public CI log."""


def _object(value, keys, message):
    if type(value) is not dict or set(value) != set(keys):
        raise ReportError(message)


def _integer(value, minimum, maximum, message):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ReportError(message)


def _string(value, pattern, message):
    if type(value) is not str or not pattern.fullmatch(value):
        raise ReportError(message)


def validate_report(data, *, expected_role, expected_sha=None):
    """Validate exact schema without returning or logging arbitrary strings.

    budgetVersion and budgetDigest identify the source-owned structural contract.
    Reports deliberately cannot provide thresholds or override those budgets.
    Different valid versions can be audited, but cannot be compared.
    """
    if expected_role not in {"base", "head"}:
        raise ReportError("Expected report role is invalid")
    if expected_sha is not None:
        _string(expected_sha, SHA_PATTERN, "Expected source revision is invalid")
    _object(data, ROOT_KEYS, "Report fields do not match schema")
    _integer(data["schemaVersion"], 1, 1, "Unsupported report schema")
    _string(data["sourceSha"], SHA_PATTERN, "Report revision is invalid")
    if data["role"] != expected_role:
        raise ReportError("Report role does not match its filename")
    if expected_sha is not None and data["sourceSha"] != expected_sha:
        raise ReportError("Report revision does not match the expected source")
    _string(data["fixtureId"], FIXTURE_PATTERN, "Fixture identifier is invalid")
    if data["budgetDigest"] == "absent":
        if expected_role != "base":
            raise ReportError("Head structural budget manifest is required")
        _integer(data["budgetVersion"], 0, 0, "Absent budget contract must use version zero")
    else:
        _string(data["budgetDigest"], DIGEST_PATTERN, "Budget contract digest is invalid")
        _integer(data["budgetVersion"], 1, 10_000, "Budget contract version is invalid")
    _object(data["workload"], WORKLOAD_LIMITS, "Workload fields do not match schema")
    for name, (minimum, maximum) in WORKLOAD_LIMITS.items():
        _integer(data["workload"][name], minimum, maximum, "Workload value is invalid")
    if (data["workload"]["deepOffset"] >= data["workload"]["movies"]
            or data["workload"]["series"] * data["workload"]["episodesPerSeries"] > 1_000_000):
        raise ReportError("Workload size or offset is invalid")
    _object(data["metrics"], METRICS, "Metric fields do not match schema")
    for measurement in data["metrics"].values():
        _object(measurement, {"medianMs", "p95Ms"}, "Measurement fields do not match schema")
        for value in measurement.values():
            if (type(value) not in {int, float} or not 0 <= value <= 3_600_000
                    or not math.isfinite(value)):
                raise ReportError("Measurement value is invalid")
        if measurement["p95Ms"] < measurement["medianMs"]:
            raise ReportError("Measurement percentile ordering is invalid")
    _integer(data["sqliteBytes"], 1, 1_000_000_000_000, "SQLite allocation is invalid")
    environment = data["environment"]
    _object(environment, {"os", "arch", "rustc", "sqlite"}, "Environment fields do not match schema")
    if (type(environment["os"]) is not str or environment["os"] not in OS_NAMES
            or type(environment["arch"]) is not str or environment["arch"] not in ARCH_NAMES):
        raise ReportError("Environment platform is invalid")
    for name in ("rustc", "sqlite"):
        _string(environment[name], VERSION_PATTERN, "Environment version is invalid")
    return data


def _duplicates_rejected(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ReportError("Duplicate JSON key")
        result[key] = value
    return result


def _nonfinite_rejected(_value):
    raise ReportError("Nonfinite JSON number")


def _is_link(metadata):
    return (stat.S_ISLNK(metadata.st_mode)
            or bool(getattr(metadata, "st_file_attributes", 0)
                    & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)))


def _identity(metadata):
    return metadata.st_dev, metadata.st_ino


def _ordinary_directory(directory):
    path = Path(directory)
    if ".." in path.parts:
        raise ReportError("Artifact directory traversal is not permitted")
    path = path.absolute()
    for component in (path, *path.parents):
        metadata = component.lstat()
        if _is_link(metadata) or not stat.S_ISDIR(metadata.st_mode):
            raise ReportError("Artifacts require an ordinary directory path")
    return path


def _read_regular(path, limit):
    before = path.lstat()
    if (_is_link(before) or not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1 or not 0 < before.st_size <= limit):
        raise ReportError("Artifact must be a bounded ordinary file with one link")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if (_is_link(opened) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or _identity(opened) != _identity(before) or opened.st_size != before.st_size):
            raise ReportError("Artifact changed during audit")
        content = handle.read(limit + 1)
        after = os.fstat(handle.fileno())
    current = path.lstat()
    if (len(content) != before.st_size or len(content) > limit or _is_link(current)
            or current.st_nlink != 1 or _identity(current) != _identity(before)
            or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns):
        raise ReportError("Artifact changed during audit")
    return content


def _load_report(content, *, expected_role, expected_sha):
    try:
        value = json.loads(content.decode("utf-8"), object_pairs_hook=_duplicates_rejected,
                           parse_constant=_nonfinite_rejected)
        return validate_report(value, expected_role=expected_role, expected_sha=expected_sha)
    except ReportError:
        raise
    except (UnicodeError, ValueError, RecursionError, OverflowError):
        raise ReportError("Report is not valid bounded JSON") from None


def comparison_reasons(head, base):
    """Return constant labels for metadata that makes a timing delta invalid."""
    if base is None:
        return ("missing baseline",)
    reasons = []
    for key, label in (
        ("fixtureId", "fixture changed"), ("workload", "workload changed"),
        ("environment", "environment changed"),
    ):
        if head[key] != base[key]:
            reasons.append(label)
    if (base["budgetDigest"] != "absent"
            and (head["budgetVersion"] != base["budgetVersion"]
                 or head["budgetDigest"] != base["budgetDigest"])):
        reasons.append("budget contract changed")
    return tuple(reasons)


def percent_change(head_value, base_value):
    """Avoid misleading/infinite percentages for zero or subnanosecond bases."""
    return None if base_value < 0.000001 else (head_value - base_value) / base_value * 100


def render_summary(head, base):
    """Render trusted labels, canonical numeric values, and tightly validated IDs."""
    reasons = comparison_reasons(head, base)
    lines = [
        "## Synthetic browse performance (advisory)", "",
        "PR-produced measurements are untrusted and advisory. Report content is never executed or used in a privileged stage.",
        "Timing changes do not fail CI. Structural budget tests are separate blocking checks.",
        "Measurements cover generated in-process libraries; no NAS, network, playback, or device timing.",
        "",
        f"Head source: `{bytes.fromhex(head['sourceSha']).hex()}`.",
    ]
    if base is not None:
        lines.append(f"Base source: `{bytes.fromhex(base['sourceSha']).hex()}`.")
        if base["budgetDigest"] == "absent":
            lines.extend(["", "Base predates structural budgets. Timing comparison remains advisory and requires identical fixture, workload and environment."])
    if reasons:
        lines.extend(["", "Comparison unavailable: " + "; ".join(reasons) + ".",
                      "No percentage or absolute timing deltas are reported for incompatible inputs."])
    else:
        matches = ("Base and head use the same fixture, workload and environment; the pre-budget baseline exception applies."
                   if base["budgetDigest"] == "absent" else
                   "Base and head use the same fixture, workload, budget contract and environment.")
        lines.extend(["", matches])
    workload = head["workload"]
    fixture_version, fixture_size = head["fixtureId"].removeprefix("catalog-v").split("-")
    lines.extend([
        "", f"Fixture: `catalog-v{int(fixture_version)}-{int(fixture_size)}`.",
        f"Workload: {workload['movies']:,} generated movies; {workload['series']:,} series; "
        f"{workload['episodesPerSeries']:,} episodes per series; page size {workload['pageSize']:,}; "
        f"deep offset {workload['deepOffset']:,}.",
        f"Sampling: {workload['warmups']:,} warmups; {workload['samples']:,} samples; "
        f"concurrency {workload['concurrency']:,}. Budget contract version: {head['budgetVersion']:,}.",
        "", "| Workload | Head median ms | Head p95 ms | Base median ms | Base p95 ms | Median delta ms | Median delta % | p95 delta ms | p95 delta % |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ])
    for name, label in METRICS.items():
        current = head["metrics"][name]
        cells = [label, f"{current['medianMs']:.4f}", f"{current['p95Ms']:.4f}"]
        if reasons:
            cells.extend(["n/a"] * 6)
        else:
            previous = base["metrics"][name]
            cells.extend([f"{previous['medianMs']:.4f}", f"{previous['p95Ms']:.4f}"])
            for percentile in ("medianMs", "p95Ms"):
                percent = percent_change(current[percentile], previous[percentile])
                cells.extend([f"{current[percentile] - previous[percentile]:+.4f}",
                              "n/a (near-zero base)" if percent is None else f"{percent:+.2f}%"])
        lines.append("| " + " | ".join(cells) + " |")
    lines.extend(["", f"Head SQLite allocation: {head['sqliteBytes']:,} bytes."])
    if not reasons:
        delta = head["sqliteBytes"] - base["sqliteBytes"]
        percent = delta / base["sqliteBytes"] * 100
        lines.append(f"Base SQLite allocation: {base['sqliteBytes']:,} bytes; delta: {delta:+,} bytes ({percent:+.2f}%).")
    environment = head["environment"]
    lines.extend(["", f"Head environment: {OS_NAMES[environment['os']]} / {ARCH_NAMES[environment['arch']]}; "
                  f"Rust {environment['rustc']}; SQLite {environment['sqlite']}.", ""])
    result = "\n".join(lines)
    if len(result.encode("utf-8")) > MAX_SUMMARY_BYTES:
        raise ReportError("Generated summary exceeds its bound")
    return result


def audit_directory(directory, *, expected_head, expected_base=None):
    """Audit only allowlisted files; existing summary must be canonical output."""
    try:
        path = _ordinary_directory(directory)
        names = set()
        for file in path.iterdir():
            if file.name not in REPORT_NAMES or len(names) == len(REPORT_NAMES):
                raise ReportError("Artifact directory contains unexpected files")
            names.add(file.name)
        if not names:
            raise ReportError("Artifact directory contains unexpected files")
        if "head.json" not in names:
            raise ReportError("Head report is required")
        head = _load_report(_read_regular(path / "head.json", MAX_REPORT_BYTES),
                            expected_role="head", expected_sha=expected_head)
        base = None
        if "base.json" in names:
            base = _load_report(_read_regular(path / "base.json", MAX_REPORT_BYTES),
                                expected_role="base", expected_sha=expected_base)
        elif expected_base is not None:
            _string(expected_base, SHA_PATTERN, "Expected source revision is invalid")
        summary = render_summary(head, base)
        if "summary.md" in names and _read_regular(path / "summary.md", MAX_SUMMARY_BYTES) != summary.encode("utf-8"):
            raise ReportError("Existing summary is not canonical audited output")
        return head, base, summary
    except OSError:
        raise ReportError("Artifact path cannot be safely read") from None


def write_summary(directory, summary):
    """Atomically replace the fixed summary name without following an output link."""
    temporary_name = None
    try:
        path = _ordinary_directory(directory)
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".summary-", suffix=".tmp",
                                         dir=path, delete=False) as output:
            temporary_name = output.name
            output.write(summary.encode("utf-8"))
        os.replace(temporary_name, path / "summary.md")
        temporary_name = None
    except OSError:
        raise ReportError("Audited summary cannot be safely written") from None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


class _SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        raise ReportError("Invalid command arguments; see --help")


def main(arguments=None):
    parser = _SafeParser(description=__doc__)
    parser.add_argument("artifact_directory")
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--expected-base")
    try:
        options = parser.parse_args(arguments)
        _, _, summary = audit_directory(options.artifact_directory,
                                         expected_head=options.expected_head,
                                         expected_base=options.expected_base)
        write_summary(options.artifact_directory, summary)
        # Public logs contain only generated constants and validated measurements.
        print(summary, end="")
        return 0
    except ReportError as error:
        print(f"Performance artifact audit failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
