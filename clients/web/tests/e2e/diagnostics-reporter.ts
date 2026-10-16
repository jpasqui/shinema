import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(
  new URL('../../../../ci-artifacts/playback-failure/', import.meta.url),
);
const maxFailures = 16;
const maxScreenshotBytes = 2 * 1024 * 1024;

// Never serialize error messages, stacks, console output, URLs or attachments
// other than screenshots. They can contain local paths or assertion secrets.
export function failureRecord(test: TestCase, result: TestResult) {
  const file = test.location.file.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return {
    source: `tests/e2e/${/^[a-z0-9-]+\.spec\.ts$/.test(file) ? file : 'unknown.spec.ts'}`,
    line: Math.max(1, Math.min(1000000, Math.trunc(test.location.line) || 1)),
    outcome: [
      'passed',
      'failed',
      'timedOut',
      'skipped',
      'interrupted',
    ].includes(result.status)
      ? result.status
      : 'failed',
    errorCount: Math.min(100, result.errors.length),
    screenshot: false,
  };
}

export default class PlaybackDiagnostics implements Reporter {
  private failures: ReturnType<typeof failureRecord>[] = [];
  private runnerErrors = 0;
  private omittedFailures = 0;
  private initialized = false;
  private pending: Promise<void> = Promise.resolve();

  private async initialize() {
    if (this.initialized) return;
    // This fixed generated-only output directory is never supplied by a caller.
    if (
      !directory.endsWith(
        join('ci-artifacts', 'playback-failure') +
          (process.platform === 'win32' ? '\\' : '/'),
      )
    )
      throw new Error('Unexpected playback diagnostic destination');
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    this.initialized = true;
  }

  onBegin() {
    this.pending = this.pending.then(() => this.initialize());
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === test.expectedStatus) return;
    if (this.failures.length === maxFailures) {
      this.omittedFailures++;
      return;
    }
    const record = failureRecord(test, result);
    this.failures.push(record);
    const number = this.failures.length;
    // Playwright does not await onBegin/onTestEnd. Flush every queued export
    // in onEnd (which it does await) before publishing the summary.
    this.pending = this.pending.then(async () => {
      await this.initialize();
      await this.exportScreenshot(record, result, number);
    });
  }

  private async exportScreenshot(
    record: ReturnType<typeof failureRecord>,
    result: TestResult,
    number: number,
  ) {
    const screenshot = result.attachments.find(
      (attachment) =>
        attachment.name === 'screenshot' &&
        attachment.contentType === 'image/png',
    );
    if (screenshot?.path) {
      try {
        const metadata = await stat(screenshot.path);
        if (metadata.size > 0 && metadata.size <= maxScreenshotBytes) {
          const bytes = await readFile(screenshot.path);
          if (
            bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
            bytes.readUInt32BE(16) === 1280 &&
            bytes.readUInt32BE(20) === 900
          ) {
            await writeFile(join(directory, `failure-${number}.png`), bytes);
            record.screenshot = true;
          }
        }
      } catch {
        // Startup/closed-page failures retain the structured log without an image.
      }
    }
    console.log(
      `Playback ${record.source}:${record.line}: ${record.outcome}; screenshot=${record.screenshot}`,
    );
  }

  onError() {
    this.runnerErrors = Math.min(100, this.runnerErrors + 1);
  }

  async onEnd(result: FullResult) {
    await this.pending;
    // Runner/web-server startup errors can happen before onBegin.
    await this.initialize();
    const status = ['passed', 'failed', 'timedout', 'interrupted'].includes(
      result.status,
    )
      ? result.status
      : 'failed';
    const data = {
      schema: 1,
      generatedOnly: true,
      status,
      runnerErrors: this.runnerErrors,
      omittedFailures: this.omittedFailures,
      failures: this.failures,
    };
    await writeFile(
      join(directory, 'failure.json'),
      JSON.stringify(data, null, 2),
    );
    const lines = this.failures.map(
      (item, index) =>
        `${item.source}:${item.line} outcome=${item.outcome} errors=${item.errorCount} screenshot=${item.screenshot ? `failure-${index + 1}.png` : 'unavailable'}`,
    );
    await writeFile(
      join(directory, 'browser-test.log'),
      [
        `Generated-only playback suite: ${status}`,
        `runnerErrors=${this.runnerErrors} omittedFailures=${this.omittedFailures}`,
        ...lines,
        '',
      ].join('\n'),
    );
    console.log(
      `Generated-only playback suite: ${status}; failures=${this.failures.length}`,
    );
  }
}
