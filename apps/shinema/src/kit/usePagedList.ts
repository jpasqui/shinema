import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  PagedList,
  type ListSnapshot,
  type PageLoader,
} from '../../../../packages/core/src/index.ts';

/** A PagedList bound to a component; recreated when `key` changes. */
export function usePagedList<T>(
  key: string,
  load: PageLoader<T>,
  pageSize = 60,
): [PagedList<T>, ListSnapshot<T>] {
  // `load` is recreated with `key`; the list follows `key` only.
  const list = useMemo(() => new PagedList<T>({ load, pageSize }), [key]);
  useEffect(() => () => list.dispose(), [list]);
  const version = useSyncExternalStore(
    (listener) => list.subscribe(listener),
    () => list.snapshot().version,
  );
  const snapshot = useMemo(() => list.snapshot(), [list, version]);
  return [list, snapshot];
}
