// Failure evidence for the isolated generated-fixture library runner only.
// Never persist error text, stack traces, browser/server output, URLs or storage.
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const libraryDiagnosticStages = [
  'setup',
  'api',
  'migration',
  'restart',
  'baseline',
  'browser-settings',
  'browser-navigation',
  'browser-search',
  'browser-concurrency',
  'browser-unsupported',
  'finalize',
];
export function diagnosticCategory(error) {
  const name = String(error?.name ?? '');
  if (/assert|expect/i.test(name)) return 'assertion';
  if (/timeout/i.test(name)) return 'timeout';
  if (name === 'TypeError' && /fetch|network/i.test(String(error?.message)))
    return 'network';
  if (/Synthetic (?:loopback )?server/.test(String(error?.message)))
    return 'startup';
  return 'runner';
}

/** Same rules run in the page immediately before the fixed-viewport screenshot. */
export function redactDiagnosticText(value, secrets = []) {
  const rules = [
    [/(?:https?|ssh):\/\/\S+/gi, '[redacted address]'],
    [/[A-Z]:[\\/]\S*/gi, '[redacted path]'],
    [/(?:\/(?:[^\s/]+\/)*[^\s]*)/g, '[redacted path]'],
    [
      /(?:gh[opusr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|[A-Za-z0-9_-]{32,})/g,
      '[redacted credential]',
    ],
    [/(?:id_ed25519|known_hosts)/gi, '[redacted file]'],
    [
      /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
      '[redacted address]',
    ],
  ];
  if (Array.isArray(value)) {
    const parts = value.map(String);
    const joined = parts.join('');
    const ranges = [];
    for (const secret of secrets) {
      if (!secret) continue;
      for (
        let offset = joined.indexOf(secret);
        offset !== -1;
        offset = joined.indexOf(secret, offset + secret.length)
      )
        ranges.push([offset, offset + secret.length]);
    }
    for (const [expression] of rules)
      for (const match of joined.matchAll(expression))
        ranges.push([match.index, match.index + match[0].length]);
    let offset = 0;
    return parts.map((part) => {
      const start = offset;
      offset += part.length;
      return ranges.some(([from, to]) => start < to && offset > from)
        ? '[redacted]'
        : part;
    });
  }
  let text = String(value);
  for (const secret of secrets)
    if (secret) text = text.split(secret).join('[redacted]');
  for (const [expression, replacement] of rules)
    text = text.replace(expression, replacement);
  return text;
}

export async function withinLibraryDeadline(job, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      job,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Diagnostic capture timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Close only resources created by this runner; one stuck close cannot skip the rest. */
export async function closeLibraryResources(resources, timeoutMs = 5000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new Error('Invalid cleanup deadline');
  const failed = [];
  const closers = [
    ['context', resources.context && (() => resources.context.close())],
    ['browser', resources.browser && (() => resources.browser.close())],
    [
      'beforeVite',
      resources.beforeVite && (() => resources.beforeVite.close()),
    ],
    ['vite', resources.vite && (() => resources.vite.close())],
    ['server', resources.stopServer],
  ];
  for (const [name, close] of closers) {
    if (!close) continue;
    try {
      await withinLibraryDeadline(Promise.resolve().then(close), timeoutMs);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

export function libraryDiagnosticLog(data) {
  return [
    'Generated-only library suite: failed',
    `sourceRevision=${data.sourceRevision}`,
    `stage=${data.stage} category=${data.category} checks=${data.completedChecks}`,
    `consoleErrors=${data.events.consoleErrors} pageErrors=${data.events.pageErrors} requestFailures=${data.events.requestFailures}`,
    `screenshot=${data.screenshot ? 'failure-1.png' : 'unavailable'}`,
    '',
  ].join('\n');
}

export function libraryDiagnostics({
  directory,
  revision,
  secrets = [],
  timeoutMs = 6500,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Invalid diagnostic revision');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new Error('Invalid diagnostic deadline');
  const events = { consoleErrors: 0, pageErrors: 0, requestFailures: 0 };
  const count = (key) => (events[key] = Math.min(10000, events[key] + 1));
  const attach = (page) => {
    page.on('console', (message) => {
      if (message.type() === 'error') count('consoleErrors');
    });
    page.on('pageerror', () => count('pageErrors'));
    page.on('requestfailed', () => count('requestFailures'));
  };
  return {
    observe(context) {
      context.on('page', attach);
      for (const page of context.pages()) attach(page);
    },
    async save({ page, error, stage, completedChecks }) {
      if (
        !libraryDiagnosticStages.includes(stage) ||
        !Number.isSafeInteger(completedChecks) ||
        completedChecks < 0 ||
        completedChecks > 1000
      )
        throw new Error('Invalid diagnostic checkpoint');
      await mkdir(directory, { recursive: true });
      const output = await lstat(directory);
      if (output.isSymbolicLink() || !output.isDirectory())
        throw new Error('Diagnostic output requires an ordinary directory');
      if ((await readdir(directory)).length)
        throw new Error('Diagnostic output must start empty');
      let screenshot = false;
      if (page && !page.isClosed()) {
        try {
          const url = new URL(page.url());
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
            throw new Error('Expected isolated fixture page');
          // Mask controls and non-text surfaces, and scrub rendered text. Do not
          // read local/session storage, request headers, console text or errors.
          const capture = (async () => {
            await page.evaluate(
              ({ sanitizer, secrets }) => {
                const redact = (0, eval)(`(${sanitizer})`);
                // Snapshotting detaches React's live tree. Shadow DOM is not
                // cloned, and custom elements/non-text surfaces are removed.
                const snapshot = document.body.cloneNode(true);
                snapshot
                  .querySelectorAll(
                    'script, style, template, noscript, iframe, canvas, video, img, svg',
                  )
                  .forEach((node) => node.remove());
                snapshot.querySelectorAll('*').forEach((node) => {
                  if (node.tagName.includes('-')) node.remove();
                  else
                    for (const attribute of [...node.attributes])
                      if (attribute.name.startsWith('on'))
                        node.removeAttribute(attribute.name);
                });
                snapshot
                  .querySelectorAll('input, textarea, select')
                  .forEach((node) => {
                    node.style.setProperty('visibility', 'hidden', 'important');
                  });
                const walker = document.createTreeWalker(
                  snapshot,
                  NodeFilter.SHOW_TEXT,
                );
                const nodes = [];
                while (walker.nextNode()) {
                  if (nodes.length >= 2000)
                    throw new Error('Diagnostic page exceeds its bound');
                  nodes.push(walker.currentNode);
                }
                const redacted = redact(
                  nodes.map((node) => node.textContent),
                  secrets,
                );
                nodes.forEach(
                  (node, index) => (node.textContent = redacted[index]),
                );
                document.body.replaceWith(snapshot);
                const style = document.createElement('style');
                style.textContent =
                  '*{background-image:none!important}*::before,*::after{content:none!important}input,textarea,select{visibility:hidden!important}vite-error-overlay,iframe,canvas,video,img,svg{display:none!important}';
                document.head.append(style);
              },
              { sanitizer: redactDiagnosticText.toString(), secrets },
            );
            return page.screenshot({
              fullPage: false,
              timeout: 5000,
            });
          })();
          // Timed-out work never writes a late image after metadata-only output.
          const bytes = await withinLibraryDeadline(capture, timeoutMs);
          if (
            bytes.length > 2 * 1024 * 1024 ||
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.readUInt32BE(16) !== 1440 ||
            bytes.readUInt32BE(20) !== 1000
          )
            throw new Error('Diagnostic screenshot exceeds its bound');
          await writeFile(join(directory, 'failure-1.png'), bytes);
          screenshot = true;
        } catch {
          // A closed/timed-out/unexpected page cannot produce a trusted image.
        }
      }
      const data = {
        schema: 1,
        generatedOnly: true,
        suite: 'libraries',
        status: 'failed',
        sourceRevision: revision,
        stage,
        category: diagnosticCategory(error),
        completedChecks,
        events: { ...events },
        screenshot,
      };
      await writeFile(
        join(directory, 'failure.json'),
        JSON.stringify(data, null, 2),
      );
      await writeFile(
        join(directory, 'browser-test.log'),
        libraryDiagnosticLog(data),
      );
      return data;
    },
  };
}
