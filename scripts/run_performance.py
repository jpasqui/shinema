"""Build both revisions, then measure the same generated workload serially.

Runs in an unprivileged PR job: reports are untrusted measurements, never code
or input to a privileged workflow. Only audited aggregate files are published.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile

SHA = re.compile(r'[0-9a-f]{40}\Z')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+\Z')
RAW_KEYS = {'schemaVersion', 'fixtureId', 'workload', 'metrics', 'sqliteBytes', 'sqliteVersion'}
FIXTURE_SETUP = '    owned.series_entries = index_series(&owned.entries);'
RUN_ERRORS = (ValueError, OSError, subprocess.TimeoutExpired)


def command(args, cwd, *, env=None, timeout=60):
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True,
                          text=True, encoding='utf-8', errors='replace', timeout=timeout)


def git(root, *args, required=True):
    result = command(['git', *args], root)
    if required and result.returncode:
        raise ValueError('Git source preparation failed')
    return result


def checked_sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value) or value == '0' * 40:
        raise ValueError('Expected an exact nonzero lowercase commit SHA')
    return value


def inside(path, root):
    resolved = path.resolve()
    if resolved == root.resolve() or not resolved.is_relative_to(root.resolve()):
        raise ValueError('Work path must be inside its dedicated workspace directory')
    return resolved


def artifact_output(path, root):
    resolved = inside(path, root)
    # Reject link/reparse ancestors before resolving, including a junction that
    # happens to point elsewhere inside the workspace.
    relative = path.absolute().relative_to(root.absolute())
    current = root
    for part in relative.parts:
        if part in ('.', '..'):
            raise ValueError('Artifact path traversal is not allowed')
        current = current / part
        if current.exists() and (current.is_symlink()
                or getattr(current, 'is_junction', lambda: False)()):
            raise ValueError('Artifact path must not contain links')
    return resolved


def source_file(root, sha, path, *, optional=False, max_bytes=65536):
    size = git(root, 'cat-file', '-s', f'{checked_sha(sha)}:{path}', required=not optional)
    if size.returncode:
        return None
    if not size.stdout.strip().isdigit() or int(size.stdout.strip()) > max_bytes:
        raise ValueError('Source input exceeds its size limit')
    result = git(root, 'show', f'{checked_sha(sha)}:{path}', required=not optional)
    return result.stdout if result.returncode == 0 else None


def strict_json(text):
    def pairs(entries):
        value = {}
        for key, item in entries:
            if key in value:
                raise ValueError('Duplicate JSON key')
            value[key] = item
        return value
    try:
        return json.loads(text, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
    except RecursionError as error:
        raise ValueError('JSON nesting exceeds its limit') from error


def adapt_harness(harness, library_source):
    """The sole compatibility shim is initializing PR12's representative map."""
    if 'series_entries:' not in library_source:
        harness = harness.replace(FIXTURE_SETUP + '\n', '')
    return harness


def policy_identity(root, sha):
    text = source_file(root, sha, 'server/src/performance-budgets.json', optional=True,
                       max_bytes=8192)
    if text is None:
        return 0, 'absent'
    if len(text.encode('utf-8')) > 8192:
        raise ValueError('Budget policy is oversized')
    policy = strict_json(text)
    if type(policy) is not dict:
        raise ValueError('Budget policy must be an object')
    version = policy.get('budgetVersion')
    if type(version) is not int or not 1 <= version <= 1000:
        raise ValueError('Budget policy version is invalid')
    # Hash actual policy contents so changing a ceiling without a version bump
    # is still shown as a policy change by the report comparator.
    canonical = json.dumps(policy, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return version, hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def prepare(root, source, role, sha, harness):
    checkout = artifact_output(source / role, source)
    git(root, 'worktree', 'add', '--detach', str(checkout), checked_sha(sha))
    library = checkout / 'server/src/lib.rs'
    library_text = library.read_text(encoding='utf-8')
    (checkout / 'server/src/performance_tests.rs').write_text(
        adapt_harness(harness, library_text), encoding='utf-8', newline='\n')
    if 'mod performance_tests;' not in library_text:
        with library.open('a', encoding='utf-8', newline='\n') as stream:
            stream.write('\n#[cfg(test)]\nmod performance_tests;\n')
    return checkout


def build(checkout, target, log):
    result = command(['cargo', 'test', '--release', '--locked', '-p', 'shinema-server',
                      '--lib', '--no-run', '--message-format=json', '--target-dir', str(target)],
                     checkout, timeout=900)
    log.write_text(result.stdout + result.stderr, encoding='utf-8')
    if result.returncode:
        raise ValueError('Release benchmark build failed; local build log retained')
    executables = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (value.get('reason') == 'compiler-artifact' and value.get('executable')
                and value.get('target', {}).get('kind') == ['lib']
                and value.get('profile', {}).get('test')):
            executables.append(inside(Path(value['executable']), target))
    if len(executables) != 1 or not executables[0].is_file():
        raise ValueError('Expected one local release library test executable')
    return executables[0]


def measure(executable, checkout, raw, environment, role, sha, policy):
    env = os.environ.copy()
    # Never permit configured providers to influence the synthetic fixture.
    env.pop('SHINEMA_TMDB_TOKEN_FILE', None)
    env.pop('SHINEMA_TVMAZE', None)
    env['SHINEMA_BENCH_OUTPUT'] = str(raw)
    result = command([str(executable), 'performance_tests::browse_benchmark', '--exact',
                      '--ignored', '--nocapture', '--test-threads=1'], checkout,
                     env=env, timeout=300)
    if result.returncode or not raw.is_file() or raw.stat().st_size > 32768:
        raise ValueError('Synthetic benchmark failed or produced invalid output')
    if raw.is_symlink() or raw.stat().st_nlink != 1:
        raise ValueError('Raw benchmark output must be an ordinary file')
    with raw.open('r', encoding='utf-8') as stream:
        raw_text = stream.read(32769)
    if len(raw_text.encode('utf-8')) > 32768:
        raise ValueError('Raw benchmark output exceeds its size limit')
    data = strict_json(raw_text)
    if not isinstance(data, dict) or set(data) != RAW_KEYS:
        raise ValueError('Unexpected raw benchmark schema')
    sqlite = data.pop('sqliteVersion')
    if not isinstance(sqlite, str) or not VERSION.fullmatch(sqlite):
        raise ValueError('Unexpected SQLite version')
    data.update(sourceSha=checked_sha(sha), role=role,
                environment={**environment, 'sqlite': sqlite},
                budgetVersion=policy[0], budgetDigest=policy[1])
    return data


def run(root, head, base, output):
    head = checked_sha(head)
    if base:
        checked_sha(base)
    if git(root, 'rev-parse', 'HEAD').stdout.strip() != head:
        raise ValueError('Runner checkout must match the expected head SHA')
    output = artifact_output(output, root)
    if output.exists() and (output.is_symlink() or any(output.iterdir())):
        raise ValueError('Artifact output must be a new or empty regular directory')
    output.mkdir(parents=True, exist_ok=True)
    local = artifact_output(root / '.local/performance-runs', root)
    local.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='run-', dir=local))
    inside(work, local)
    harness = source_file(root, head, 'server/src/performance_tests.rs')
    if len(harness.encode('utf-8')) > 65536:
        raise ValueError('Benchmark harness is oversized')
    rust = command(['rustc', '--version'], root)
    match = re.match(r'rustc ([0-9]+\.[0-9]+\.[0-9]+) ', rust.stdout)
    if rust.returncode or not match:
        raise ValueError('Cannot identify the Rust version')
    environment = {'os': platform.system(), 'arch': platform.machine().lower(),
                   'rustc': match[1]}
    sources = [('head', head)]
    if base and git(root, 'cat-file', '-e', f'{base}^{{commit}}', required=False).returncode == 0:
        sources.insert(0, ('base', base))
    builds = []
    for role, sha in sources:
        try:
            checkout = prepare(root, work, role, sha, harness)
            target = artifact_output(work / f'target-{role}', work)
            executable = build(checkout, target, work / f'build-{role}.log')
            builds.append((role, sha, checkout, executable, policy_identity(root, sha)))
        except RUN_ERRORS:
            if role != 'base':
                raise
            print('Baseline preparation/build unavailable; comparison will show head only.')
    # Both builds finish before either timing run. Different targets prevent
    # Cargo artifact aliasing between source worktrees; runs are serial.
    for role, sha, checkout, executable, policy in builds:
        try:
            report = measure(executable, checkout, work / f'raw-{role}.json', environment,
                             role, sha, policy)
        except RUN_ERRORS:
            if role != 'base':
                raise
            print('Baseline measurement unavailable; comparison will show head only.')
            continue
        (output / f'{role}.json').write_text(
            json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    args = [sys.executable, str(root / 'scripts/performance_report.py'), str(output),
            '--expected-head', head]
    if base:
        args += ['--expected-base', base]
    if command(args, root).returncode:
        raise ValueError('Performance artifact audit/comparison failed')
    print('Synthetic performance reports audited; timing differences are advisory.')
    print('Build worktrees and logs remain in ignored local state for diagnosis.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--head', required=True)
    parser.add_argument('--base')
    parser.add_argument('--output', default='ci-artifacts/performance')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        run(root, args.head, args.base, root / args.output)
    except (ValueError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        # Do not echo raw compiler output, host paths or PR-supplied JSON.
        print('Performance run failed validation/preparation; inspect ignored local logs.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
