import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Use only with generated fixtures and isolated loopback browser contexts.
export function browserDiagnostics(browser, directory) {
  const messages = [];
  const record = (value) => {
    if (messages.length < 500) messages.push(value.slice(0, 4000));
  };
  const attach = (page) => {
    page.on('console', (message) =>
      record(`console ${message.type()}: ${message.text()}`),
    );
    page.on('pageerror', (error) =>
      record(`pageerror: ${error.stack ?? error.message}`),
    );
    page.on('requestfailed', (request) =>
      record(`requestfailed: ${request.url()} ${request.failure()?.errorText}`),
    );
  };
  return {
    observe(context) {
      context.on('page', attach);
      for (const page of context.pages()) attach(page);
    },
    async save(error, serverLog = '') {
      await mkdir(directory, { recursive: true });
      let number = 0;
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (page.isClosed()) continue;
          try {
            await page.screenshot({
              path: join(directory, `failure-${++number}.png`),
              fullPage: true,
              timeout: 5000,
            });
          } catch (screenshotError) {
            record(`Screenshot unavailable: ${screenshotError.message}`);
          }
        }
      }
      await writeFile(
        join(directory, 'failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            error: error.stack ?? String(error),
            browserMessages: messages,
            serverLog: serverLog.slice(-32000),
          },
          null,
          2,
        ),
      );
    },
  };
}
