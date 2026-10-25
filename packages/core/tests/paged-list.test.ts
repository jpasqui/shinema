import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PagedList, type Page } from '../src/paged-list.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function library(total: () => number, failures = new Set<number>()) {
  const requests: number[] = [];
  const load = async (offset: number, limit: number): Promise<Page<string>> => {
    requests.push(offset);
    if (failures.has(offset)) throw new Error('Titles could not be loaded.');
    const count = Math.max(0, Math.min(limit, total() - offset));
    return {
      total: total(),
      items: Array.from(
        { length: count },
        (_, index) => `title-${offset + index}`,
      ),
    };
  };
  return { load, requests };
}

test('loads the first page, then the rest of the visible range', async () => {
  const { load, requests } = library(() => 500);
  const list = new PagedList({ load, pageSize: 60 });
  list.show(0, 150);
  await settle();
  await settle();
  const snapshot = list.snapshot();
  assert.equal(snapshot.total, 500);
  assert.equal(snapshot.itemAt(149), 'title-149');
  assert.deepEqual(
    requests.sort((a, b) => a - b),
    [0, 60, 120],
  );
});

test('keeps a bounded number of pages around the visible range', async () => {
  const { load } = library(() => 6000);
  const list = new PagedList({ load, pageSize: 60, maxPages: 3 });
  list.show(0, 60);
  await settle();
  for (let start = 60; start < 900; start += 60) {
    list.show(start, start + 60);
    await settle();
  }
  const snapshot = list.snapshot();
  assert.equal(snapshot.itemAt(0), undefined);
  assert.equal(snapshot.itemAt(845), 'title-845');
});

test('a changed library resets and reloads instead of getting stuck', async () => {
  let total = 100;
  const { load } = library(() => total);
  const list = new PagedList({ load, pageSize: 60 });
  list.show(0, 60);
  await settle();
  const before = list.snapshot().generation;
  total = 101;
  list.show(60, 120);
  await settle();
  await settle();
  await settle();
  const snapshot = list.snapshot();
  assert.equal(snapshot.total, 101);
  assert.equal(snapshot.generation, before + 1);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.itemAt(100), 'title-100');
});

test('failed pages report a message and recover on retry', async () => {
  const failures = new Set([60]);
  const { load } = library(() => 200, failures);
  const list = new PagedList({ load, pageSize: 60 });
  list.show(0, 120);
  await settle();
  await settle();
  assert.match(list.snapshot().error ?? '', /could not be loaded/);
  failures.clear();
  list.retry();
  await settle();
  assert.equal(list.snapshot().error, null);
  assert.equal(list.snapshot().itemAt(70), 'title-70');
});

test('listeners hear about changes and stop after dispose', async () => {
  const { load } = library(() => 10);
  const list = new PagedList({ load });
  let heard = 0;
  list.subscribe(() => (heard += 1));
  list.show(0, 10);
  await settle();
  assert.ok(heard >= 2);
  list.dispose();
  const count = heard;
  list.refresh();
  await settle();
  assert.equal(heard, count);
});
