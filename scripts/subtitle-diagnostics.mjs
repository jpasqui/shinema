import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const subtitleDiagnosticViewport = { width: 1280, height: 1080 };
const phases = new Set([
  'fixtures',
  'server-startup',
  'browser-startup',
  'subtitle-playback',
  'direct-playback',
  'discovery-recovery',
  'discovery-cancellation',
]);
const files = new Set(['failure.png', 'failure.json', 'browser-test.log']);
const serverStates = new Set(['not-started', 'starting', 'running', 'exited']);
const source = 'scripts/subtitle-smoke.mjs';
const sourceUrl = new URL('./subtitle-smoke.mjs', import.meta.url).href;
const sourcePosition = new RegExp(
  sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):\\d+',
);
const bounded = (value, limit) =>
  Number.isInteger(value) && value >= 0 ? Math.min(value, limit) : 0;

function sourceLine(error) {
  const stack =
    typeof error?.stack === 'string' ? error.stack.slice(0, 64000) : '';
  return bounded(Number(sourcePosition.exec(stack)?.[1] ?? 0), 1000000);
}

// This helper is only for the smoke's authored fixtures and isolated loopback
// page. Never retain raw errors, console text, URLs, responses or server stderr.
export function subtitleDiagnostics(directory) {
  let phase = 'fixtures';
  let pageErrors = 0;
  return {
    async prepare() {
      await mkdir(dirname(directory), { recursive: true });
      if ((await lstat(dirname(directory))).isSymbolicLink())
        throw new Error('Subtitle diagnostics parent must be ordinary');
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink())
        throw new Error('Subtitle diagnostics directory must be ordinary');
      const entries = await readdir(directory, { withFileTypes: true });
      if (
        entries.some(
          (entry) =>
            !files.has(entry.name) || !entry.isFile() || entry.isSymbolicLink(),
        )
      )
        throw new Error('Unexpected subtitle diagnostic entry');
      for (const entry of entries) await unlink(join(directory, entry.name));
    },
    at(value) {
      if (!phases.has(value))
        throw new Error('Invalid subtitle diagnostic phase');
      phase = value;
    },
    observe(page) {
      page.on('pageerror', () => {
        pageErrors = Math.min(pageErrors + 1, 100);
      });
    },
    async save(
      error,
      { page, completedChecks = 0, serverState = 'not-started' } = {},
    ) {
      let screenshot = false;
      // The page is fixture-only, and Vite's path-bearing error overlay is
      // disabled. The byte audit remains mandatory before any upload.
      if (
        page &&
        !page.isClosed() &&
        new URL(page.url()).origin === 'http://127.0.0.1:29883'
      ) {
        try {
          const image = await page.screenshot({
            type: 'png',
            fullPage: false,
            animations: 'disabled',
            timeout: 5000,
          });
          if (
            image.length <= 2 * 1024 * 1024 &&
            image
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
            image.readUInt32BE(16) === subtitleDiagnosticViewport.width &&
            image.readUInt32BE(20) === subtitleDiagnosticViewport.height
          ) {
            await writeFile(join(directory, 'failure.png'), image);
            screenshot = true;
          }
        } catch {
          /* A startup/closed-page failure can still retain its summary. */
        }
      }
      const data = {
        schema: 1,
        generatedOnly: true,
        status: 'failed',
        phase,
        source,
        line: sourceLine(error),
        completedChecks: bounded(completedChecks, 64),
        pageErrors,
        serverState: serverStates.has(serverState)
          ? serverState
          : 'not-started',
        screenshot,
      };
      const log = `Generated-only subtitle smoke: failed\n${source}:${data.line} phase=${phase}\ncompletedChecks=${data.completedChecks} pageErrors=${pageErrors} serverState=${data.serverState} screenshot=${screenshot ? 'failure.png' : 'unavailable'}\n`;
      await writeFile(
        join(directory, 'failure.json'),
        JSON.stringify(data, null, 2) + '\n',
      );
      await writeFile(join(directory, 'browser-test.log'), log);
    },
  };
}
