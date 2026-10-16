import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const commit = '633b063e1ab7599d47569d659c9e0886896db92b';
const route = '/__cold-history/633b063/';
const repository = fileURLToPath(new URL('../../../..', import.meta.url));
const maxFiles = 256;
const maxBytes = 8 * 1024 * 1024;

function inside(root, target) {
  const path = relative(root, target);
  if (
    path === '..' ||
    path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(path)
  )
    throw new Error('Historical fixture path escaped its generated root');
  return target;
}

async function directory(root, target) {
  inside(root, target);
  const parts = relative(root, target).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        'Historical fixture directories must be ordinary directories',
      );
  }
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repository,
    maxBuffer: maxBytes + 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function historicalFiles() {
  // No fetch or revision fallback: this optional proof needs the actual local object.
  const resolved = git(['rev-parse', '--verify', `${commit}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  if (resolved !== commit)
    throw new Error('Unexpected historical fixture commit');
  const entries = git([
    'ls-tree',
    '-rlz',
    '--full-tree',
    commit,
    '--',
    'clients/web',
    'packages',
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/.exec(
        entry,
      );
      if (!match)
        throw new Error('Historical fixture contains a non-file entry');
      const [, mode, hash, sizeText, path] = match;
      const size = Number(sizeText);
      if (
        !/^(clients\/web|packages)\//.test(path) ||
        path
          .split('/')
          .some((part) => !part || part === '.' || part === '..') ||
        path.includes('\\') ||
        path.includes(':') ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > maxBytes
      )
        throw new Error('Invalid historical fixture file');
      return { mode, hash, size, path };
    });
  const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!entries.length || entries.length > maxFiles || bytes > maxBytes)
    throw new Error('Historical fixture exceeds its extraction budget');
  const blobs = git(['cat-file', '--batch'], {
    input: entries.map((entry) => `${entry.hash}\n`).join(''),
  });
  let offset = 0;
  return entries.map((entry) => {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString('ascii');
    if (end < offset || header !== `${entry.hash} blob ${entry.size}`)
      throw new Error('Invalid historical fixture blob response');
    offset = end + 1;
    const content = blobs.subarray(offset, offset + entry.size);
    offset += entry.size;
    if (content.length !== entry.size || blobs[offset++] !== 10)
      throw new Error('Incomplete historical fixture blob');
    return { ...entry, content };
  });
}

async function immutableFile(root, entry) {
  const target = inside(root, resolve(root, entry.path));
  await directory(root, dirname(target));
  try {
    await writeFile(target, entry.content, {
      flag: 'wx',
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Historical fixture files must be ordinary files', {
        cause: error,
      });
    if (!(await readFile(target)).equals(entry.content))
      throw new Error(
        'Existing immutable historical fixture differs from Git',
        {
          cause: error,
        },
      );
  }
}

/** Opt-in local proof only. Default CI never invokes Git or materializes history. */
export async function prepareColdStartHistory() {
  if (process.env.SHINEMA_COLD_HISTORY !== '1') return null;
  const files = historicalFiles();
  // Generated source lives in an ignored build directory; lint must not scan old code.
  const root = inside(
    repository,
    join(repository, 'ci-artifacts', 'cold-start-history', commit, 'build'),
  );
  await directory(repository, root);
  for (const entry of files) await immutableFile(root, entry);

  const installed = await realpath(
    join(repository, 'clients/web/node_modules'),
  );
  const linked = join(root, 'clients/web/node_modules');
  try {
    await symlink(
      installed,
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if ((await realpath(linked)) !== installed)
    throw new Error(
      'Historical fixture must reuse the installed web dependencies',
    );

  const html = await readFile(join(root, 'clients/web/index.html'), 'utf8');
  if ((html.match(/src="\/src\/main\.tsx"/g) ?? []).length !== 1)
    throw new Error('Unexpected historical HTML entry point');
  const main = join(root, 'clients/web/src/main.tsx').replaceAll('\\', '/');
  const entryHtml = html.replace('src="/src/main.tsx"', `src="/@fs/${main}"`);
  return {
    commit,
    root,
    route,
    fileCount: files.length,
    plugin: {
      name: 'actual-cold-start-history',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.split('?')[0] !== route) return next();
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.statusCode = 405;
            response.end();
            return;
          }
          server.transformIndexHtml(route, entryHtml).then((transformed) => {
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('X-Shinema-Cold-History', commit);
            response.end(request.method === 'HEAD' ? undefined : transformed);
          }, next);
        });
      },
    },
  };
}
