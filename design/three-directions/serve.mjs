import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const types = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.md': 'text/plain',
};
export function startServer(port = 4179) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = resolve(
        root,
        `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`,
      );
      if (
        !path.startsWith(`${root}${sep}`) ||
        !types[extname(path)] ||
        !['GET', 'HEAD'].includes(request.method)
      ) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, {
        'Content-Type': `${types[extname(path)]}${extname(path) === '.png' ? '' : '; charset=utf-8'}`,
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self'; connect-src 'none'; frame-ancestors 'self'",
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startServer();
  console.log('Shinema design comparison: http://127.0.0.1:4179');
}
