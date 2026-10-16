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
// Exact pairs emitted by the tracked Playwright config and responsive tests.
const screenshotViewports = new Set([
  '390x844',
  '390x900',
  '768x900',
  '1100x900',
  '1280x900',
  '1600x900',
]);
const layoutAnchors = new Set([
  'brand',
  'header',
  'navigation',
  'navigationItems',
  'navigationPrimary',
  'navigationSettings',
  'feature',
  'title',
  'toolbar',
  'search',
  'searchAction',
  'refresh',
  'heading',
  'card',
  'poster',
  'cardTitle',
  'cardMeta',
  'featureTitle',
  'featureMeta',
  'featureSummary',
  'featureAction',
  'metadata',
  'description',
  'play',
  'artwork',
  'back',
  'selected',
  'tail',
  'intent',
]);

export function supportedPlaybackScreenshot(bytes: Buffer) {
  return (
    bytes.length >= 24 &&
    bytes.length <= maxScreenshotBytes &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    screenshotViewports.has(
      `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`,
    )
  );
}

/** One explicit numeric protocol, never a general attachment/stdout forwarder. */
export function safeLayoutDiagnostic(bytes: Buffer | undefined) {
  if (!bytes || !bytes.length || bytes.length > 30 * 1024) return;
  const number = (value: unknown, minimum = -1000000, maximum = 1000000) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum;
  const integer = (value: unknown, minimum = 0) =>
    number(value, minimum) && Number.isInteger(value);
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const keys = (value: Record<string, unknown>, names: string[]) =>
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name));
  const box = (value: unknown) =>
    object(value) &&
    keys(value, ['x', 'y', 'width', 'height']) &&
    number(value.x) &&
    number(value.y) &&
    number(value.width, 0) &&
    number(value.height, 0);
  try {
    const data: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !object(data) ||
      !keys(data, [
        'schema',
        'line',
        'skin',
        'width',
        'omittedSnapshots',
        'snapshots',
        'shifts',
      ]) ||
      data.schema !== 1 ||
      !integer(data.line, 1) ||
      (data.skin !== 'marquee' && data.skin !== 'archive') ||
      ![0, 390, 1280].includes(Number(data.width)) ||
      typeof data.width !== 'number' ||
      !integer(data.omittedSnapshots) ||
      !Array.isArray(data.snapshots) ||
      data.snapshots.length > 16 ||
      !data.snapshots.every(
        (snapshot: unknown) =>
          object(snapshot) &&
          keys(snapshot, ['step', 'scroll', 'anchors']) &&
          integer(snapshot.step) &&
          Array.isArray(snapshot.scroll) &&
          snapshot.scroll.length === 2 &&
          snapshot.scroll.every((value) => number(value)) &&
          object(snapshot.anchors) &&
          Object.entries(snapshot.anchors).every(
            ([anchor, rect]) => layoutAnchors.has(anchor) && box(rect),
          ),
      ) ||
      !object(data.shifts) ||
      !keys(data.shifts, ['count', 'cls', 'entries']) ||
      !integer(data.shifts.count) ||
      !number(data.shifts.cls, 0) ||
      !Array.isArray(data.shifts.entries) ||
      data.shifts.entries.length > 16 ||
      !data.shifts.entries.every(
        (entry: unknown) =>
          object(entry) &&
          keys(entry, ['value', 'recentInput', 'time', 'sources']) &&
          number(entry.value, 0, 1) &&
          typeof entry.recentInput === 'boolean' &&
          number(entry.time, 0, 1000000000) &&
          Array.isArray(entry.sources) &&
          entry.sources.length <= 5 &&
          entry.sources.every(
            (source: unknown) =>
              object(source) &&
              keys(source, ['anchor', 'kind', 'previous', 'current']) &&
              typeof source.anchor === 'string' &&
              (source.anchor === 'other' || layoutAnchors.has(source.anchor)) &&
              (source.kind === 'text' || source.kind === 'element') &&
              box(source.previous) &&
              box(source.current),
          ),
      )
    )
      return;
    return JSON.stringify(data);
  } catch {
    return;
  }
}

// Never serialize error messages, stacks, console output, URLs or arbitrary
// attachments. Only screenshots and the validated numeric protocol are allowed;
// other content can contain local paths or assertion secrets.
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
    const diagnostic = safeLayoutDiagnostic(
      result.attachments.find(
        (attachment) =>
          attachment.name === 'generated-layout-diagnostic' &&
          attachment.contentType === 'application/json',
      )?.body,
    );
    if (diagnostic) console.log(`GeneratedLayoutDiagnostic ${diagnostic}`);
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
          if (supportedPlaybackScreenshot(bytes)) {
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
