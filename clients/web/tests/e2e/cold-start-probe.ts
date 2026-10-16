import type { Page } from '@playwright/test';

type Rect = { x: number; y: number; width: number; height: number };
type Anchor = {
  id: number;
  rect: Rect;
  visible: boolean;
  rendered: boolean;
  loadedSlot?: boolean;
};
export const startupShellAnchors = [
  'app',
  'header',
  'brand',
  'navigation',
  'navigationItems',
  'navigationSettings',
  'main',
  'sidebar',
  'collectionRow',
  'librarySettings',
  'feature',
  'title',
  'toolbar',
  'search',
  'heading',
  'grid',
  'footer',
  'featureTitle',
  'featureAction',
] as const;
export type StartupSample = {
  frame: number;
  time: number;
  source: 'install' | 'frame' | 'mutation' | 'checkpoint';
  meaningful: boolean;
  terminalEmpty: boolean;
  collectionsPending: boolean;
  catalogRevision: number | null;
  scroll: [number, number];
  overflow: number;
  anchors: Record<string, Anchor>;
};
export type StartupTrace = {
  initialStorage: number;
  firstContentfulPaint: number | null;
  fontAppliedAt: number | null;
  requiredAnchors: string[];
  samples: StartupSample[];
  removals: Array<{ frame: number; anchor: string }>;
  shifts: Array<{
    value: number;
    recentInput: boolean;
    time: number;
    sources: Array<{
      anchor: string;
      kind: 'text' | 'element';
      previous: Rect;
      current: Rect;
    }>;
  }>;
  truncated: boolean;
};
declare global {
  interface Window {
    __shinemaStartup: StartupTrace & { capture: () => void; stop: () => void };
  }
}

export async function installStartupProbe(
  page: Page,
  options: {
    saved?: Record<string, string>;
    noStorage?: boolean;
    requiredAnchors?: string[];
  } = {},
) {
  const required = options.requiredAnchors ?? [...startupShellAnchors];
  await page.addInitScript(
    ({ options, required }) => {
      localStorage.clear();
      sessionStorage.clear();
      const initialStorage = localStorage.length;
      for (const [key, value] of Object.entries(options.saved ?? {}))
        localStorage.setItem(key, value);
      if (options.noStorage)
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            throw new DOMException(
              'Synthetic unavailable storage',
              'SecurityError',
            );
          },
        });
      const trace: StartupTrace = {
        initialStorage,
        firstContentfulPaint: null,
        fontAppliedAt: null,
        requiredAnchors: required,
        samples: [],
        removals: [],
        shifts: [],
        truncated: false,
      };
      const ids = new WeakMap<Element, number>();
      const persistent = new Map<string, Element>();
      let nextId = 0;
      let frame = 0;
      let running = true;
      const selectors: Record<string, string> = {
        app: '#root > .app',
        header: '.header',
        brand: '.brand',
        navigation: '.top-navigation',
        navigationItems: '.top-navigation-items',
        navigationSlotCustom: '[data-navigation-slot="custom-link"]',
        navigationSlotSearch: '[data-navigation-slot="search-link"]',
        navigationSettings: '.navigation-settings-button',
        main: '.app main',
        sidebar: '.library-sidebar',
        collectionRow: '.library-sidebar nav',
        librarySettings: '.library-sidebar > button',
        storageNotice: '.notice[role="alert"]',
        feature:
          '[data-testid="library-feature"], [aria-label="Featured title"]',
        title: '.app main .page-title',
        toolbar: '.browse-toolbar',
        search: '#library-search',
        heading: '.app main .section-heading',
        grid: '.app main .poster-grid',
        footer: '.app main footer',
        featureTitle: '.feature-copy h2, .programme-copy h2',
        featureAction: '.feature-copy button, .programme-copy button',
      };
      const controls: Array<[string, string, string]> = [
        ['navLibrary', '.top-navigation-items > button', 'Library'],
        ['navSearch', '.top-navigation-items > button', 'Search'],
        ['collectionMovies', '.library-sidebar nav button', 'Movies'],
        ['collectionTV', '.library-sidebar nav button', 'TV shows'],
        ['collectionMusic', '.library-sidebar nav button', 'Music'],
      ];
      const measure = (node: Element, clip: boolean): Anchor => {
        if (!ids.has(node)) ids.set(node, ++nextId);
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const rendered =
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity) > 0 &&
          box.width > 0 &&
          box.height > 0;
        const visible =
          rendered &&
          box.bottom > 0 &&
          box.right > 0 &&
          box.top < innerHeight &&
          box.left < innerWidth;
        const x = clip ? Math.max(0, Math.min(innerWidth, box.x)) : box.x;
        const y = clip ? Math.max(0, Math.min(innerHeight, box.y)) : box.y;
        return {
          id: ids.get(node)!,
          visible,
          rendered,
          rect: {
            x,
            y,
            width: clip
              ? Math.max(0, Math.min(innerWidth, box.right) - x)
              : box.width,
            height: clip
              ? Math.max(0, Math.min(innerHeight, box.bottom) - y)
              : box.height,
          },
        };
      };
      const capture = (source: StartupSample['source']) => {
        if (trace.samples.length >= 4000) {
          trace.truncated = true;
          return;
        }
        const anchors: Record<string, Anchor> = {};
        for (const [name, selector] of Object.entries(selectors)) {
          const node = document.querySelector(selector);
          if (!node) continue;
          anchors[name] = measure(
            node,
            ['app', 'main', 'sidebar', 'grid', 'footer'].includes(name),
          );
          if (!persistent.has(name)) persistent.set(name, node);
        }
        for (const [name, selector, label] of controls) {
          const node = [...document.querySelectorAll(selector)].find(
            (node) => node.textContent?.trim() === label,
          );
          if (node) {
            anchors[name] = measure(node, false);
            if (!persistent.has(name)) persistent.set(name, node);
          }
        }
        const collectionNames: Record<string, string> = {
          movies: 'Movies',
          tv: 'TV',
          custom: 'Custom',
          music: 'Music',
        };
        for (const node of document.querySelectorAll(
          '.library-sidebar [data-collection-position]',
        )) {
          const position = node.getAttribute('data-collection-position');
          if (position !== null && /^\d+$/.test(position))
            anchors[`collectionPosition${position}`] = {
              ...measure(node, false),
              loadedSlot: node.tagName === 'BUTTON',
            };
          const id = node.getAttribute('data-collection-slot');
          if (id && collectionNames[id])
            anchors[`collectionSlot${collectionNames[id]}`] = {
              ...measure(node, false),
              loadedSlot: node.tagName === 'BUTTON',
            };
        }
        const slots = [
          ...document.querySelectorAll(
            '.poster-grid > [data-browse-slot], .poster-grid > .media-card, .poster-grid > .skeleton',
          ),
        ];
        slots.forEach((node, index) => {
          const box = measure(node, false);
          const declared =
            node.getAttribute('data-browse-slot') ??
            node.getAttribute('data-browse-index');
          const logicalIndex =
            declared !== null && /^\d+$/.test(declared)
              ? Number(declared)
              : index;
          if (logicalIndex < 12 || box.visible)
            anchors[`slot${logicalIndex}`] = {
              ...box,
              loadedSlot: node.hasAttribute('data-browse-id'),
            };
          if (logicalIndex < 12 || box.visible)
            for (const [part, selector] of [
              ['Poster', '.poster'],
              ['Title', 'h3'],
              ['Meta', '.card-copy > span'],
            ] as const) {
              const child = node.querySelector(selector);
              if (child)
                anchors[`slot${logicalIndex}${part}`] = {
                  ...measure(child, false),
                  loadedSlot: node.hasAttribute('data-browse-id'),
                };
            }
          const image = node.querySelector<HTMLImageElement>('.poster img');
          if (
            (logicalIndex < 12 || box.visible) &&
            image?.complete &&
            image.naturalWidth > 0
          )
            anchors[`slot${logicalIndex}Artwork`] = {
              ...measure(image, false),
              loadedSlot: true,
            };
        });
        trace.samples.push({
          frame: frame++,
          time: performance.now(),
          source,
          meaningful: !!anchors.app?.visible,
          catalogRevision: (() => {
            const value = Number(
              document
                .querySelector('[data-testid="library-feed"]')
                ?.getAttribute('data-library-revision'),
            );
            return Number.isSafeInteger(value) && value > 0 ? value : null;
          })(),
          collectionsPending:
            document
              .querySelector('.library-sidebar nav')
              ?.getAttribute('aria-busy') === 'true',
          terminalEmpty:
            [...document.querySelectorAll('.empty-state')].some((node) =>
              node.textContent?.includes('No libraries are visible.'),
            ) &&
            document
              .querySelector('[data-testid="library-feed"]')
              ?.getAttribute('aria-busy') !== 'true',
          scroll: [scrollX, scrollY],
          overflow: Math.max(
            0,
            (document.documentElement?.scrollWidth ?? 0) - innerWidth,
          ),
          anchors,
        });
        trace.firstContentfulPaint ??=
          performance.getEntriesByName('first-contentful-paint')[0]
            ?.startTime ?? null;
      };
      const mutations = new MutationObserver((records) => {
        for (const record of records)
          for (const removed of record.removedNodes)
            for (const [anchor, node] of persistent)
              if (removed === node || removed.contains(node))
                trace.removals.push({ frame, anchor });
        capture('mutation');
      });
      mutations.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      const shifts = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const value = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: Array<{
              node?: Node;
              previousRect: DOMRectReadOnly;
              currentRect: DOMRectReadOnly;
            }>;
          };
          const rect = (box: DOMRectReadOnly) => ({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          });
          trace.shifts.push({
            value: value.value,
            recentInput: value.hadRecentInput,
            time: value.startTime,
            sources: (value.sources ?? []).slice(0, 5).map((source) => {
              const element =
                source.node instanceof Element
                  ? source.node
                  : source.node?.parentElement;
              return {
                anchor:
                  [
                    ['browseNotice', '.browse-notice-slot > .notice'],
                    ...Object.entries(selectors).reverse(),
                  ].find(([, selector]) => element?.closest(selector))?.[0] ??
                  'other',
                kind:
                  source.node?.nodeType === Node.TEXT_NODE ? 'text' : 'element',
                previous: rect(source.previousRect),
                current: rect(source.currentRect),
              };
            }),
          });
        }
      });
      shifts.observe({ type: 'layout-shift', buffered: true });
      const tick = () => {
        if (running) {
          capture('frame');
          requestAnimationFrame(tick);
        }
      };
      window.__shinemaStartup = Object.assign(trace, {
        capture: () => capture('checkpoint'),
        stop: () => {
          running = false;
          mutations.disconnect();
          shifts.disconnect();
        },
      });
      capture('install');
      requestAnimationFrame(tick);
    },
    { options, required },
  );
}

export async function startupTrace(page: Page): Promise<StartupTrace> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__shinemaStartup.capture();
            resolve();
          }),
        ),
      ),
  );
  return page.evaluate(() => {
    const {
      initialStorage,
      firstContentfulPaint,
      fontAppliedAt,
      requiredAnchors,
      samples,
      removals,
      shifts,
      truncated,
    } = window.__shinemaStartup;
    return {
      initialStorage,
      firstContentfulPaint,
      fontAppliedAt,
      requiredAnchors,
      samples,
      removals,
      shifts,
      truncated,
    };
  });
}

export function startupProblems(
  trace: StartupTrace,
  options: {
    allowEmptySlots?: boolean;
    allLibrariesHidden?: boolean;
    removedPendingCollectionPositions?: number[];
    allowCatalogRevisionReset?: boolean;
  } = {},
) {
  const problems: Array<{
    frame: number;
    anchor: string;
    kind: string;
    delta?: number;
  }> = [];
  if (trace.truncated)
    problems.push({ frame: 0, anchor: 'trace', kind: 'truncated' });
  const first = trace.samples.find((sample) => sample.meaningful);
  if (!first) return [{ frame: 0, anchor: 'app', kind: 'never-painted' }];
  const remaining = trace.samples.filter(
    (sample) => sample.frame >= first.frame,
  );
  let terminalStart = remaining.length;
  while (
    terminalStart > 0 &&
    remaining[terminalStart - 1].terminalEmpty &&
    !Object.keys(remaining[terminalStart - 1].anchors).some((name) =>
      name.startsWith('slot'),
    )
  )
    terminalStart--;
  const terminalFrames = new Set(
    remaining.slice(terminalStart).map((sample) => sample.frame),
  );
  let settledStart = remaining.length;
  while (settledStart > 0 && !remaining[settledStart - 1].collectionsPending)
    settledStart--;
  const settledFrames = new Set(
    remaining.slice(settledStart).map((sample) => sample.frame),
  );
  const baselines = new Map<string, Anchor>();
  const loadedSlots = new Map<string, number>();
  let catalogRevision: number | null = null;
  const pendingArtwork = new Set<string>();
  const realCollectionPositions = new Set(
    remaining.flatMap((sample) =>
      Object.entries(sample.anchors)
        .filter(
          ([name, anchor]) =>
            name.startsWith('collectionPosition') && anchor.loadedSlot,
        )
        .map(([name]) => name),
    ),
  );
  const final = remaining.at(-1)!;
  const finalPosition = Math.max(
    -1,
    ...Object.keys(final.anchors)
      .filter((name) => name.startsWith('collectionPosition'))
      .map((name) => Number(name.slice('collectionPosition'.length))),
  );
  const permanentlyRemovedTail = new Set(
    (options.removedPendingCollectionPositions ?? [])
      .filter(
        (position) =>
          position > finalPosition &&
          remaining
            .slice(settledStart)
            .every(
              (sample) => !sample.anchors[`collectionPosition${position}`],
            ),
      )
      .map((position) => `collectionPosition${position}`),
  );
  for (const sample of remaining) {
    if (
      sample.catalogRevision !== null &&
      catalogRevision !== null &&
      sample.catalogRevision < catalogRevision
    )
      problems.push({
        frame: sample.frame,
        anchor: 'catalogRevision',
        kind: 'revision-regressed',
        delta: sample.catalogRevision - catalogRevision,
      });
    if (
      options.allowCatalogRevisionReset &&
      sample.catalogRevision !== null &&
      catalogRevision !== null &&
      sample.catalogRevision > catalogRevision
    ) {
      // A confirmed newer scope may recreate data nodes. Its first decoded
      // images establish new identity, while every reserved box stays fixed.
      for (const name of loadedSlots.keys())
        if (/^slot\d/.test(name)) loadedSlots.delete(name);
      for (const name of baselines.keys())
        if (/^slot\d+Artwork$/.test(name)) pendingArtwork.add(name);
    }
    if (
      sample.catalogRevision !== null &&
      (catalogRevision === null || sample.catalogRevision > catalogRevision)
    )
      catalogRevision = sample.catalogRevision;
    for (const name of Object.keys(sample.anchors)) pendingArtwork.delete(name);
    // The first painted shell must already reserve every logical slot. Learning
    // a slot only when it appears later would accept a three-card opening.
    if (!(options.allowEmptySlots && terminalFrames.has(sample.frame)))
      for (let index = 0; index < 12; index++) {
        const name = `slot${index}`;
        if (!sample.anchors[name])
          problems.push({
            frame: sample.frame,
            anchor: name,
            kind: 'required-missing',
          });
        else if (!sample.anchors[name].rendered)
          problems.push({
            frame: sample.frame,
            anchor: name,
            kind: 'required-hidden',
          });
      }
    for (const name of trace.requiredAnchors ?? startupShellAnchors)
      if (!sample.anchors[name])
        problems.push({
          frame: sample.frame,
          anchor: name,
          kind: 'required-missing',
        });
      else if (!sample.anchors[name].rendered)
        problems.push({
          frame: sample.frame,
          anchor: name,
          kind: 'required-hidden',
        });
    for (const name of Object.keys(sample.anchors).filter((name) =>
      /^slot\d+$/.test(name),
    ))
      for (const part of ['Poster', 'Title', 'Meta'])
        if (!sample.anchors[`${name}${part}`])
          problems.push({
            frame: sample.frame,
            anchor: `${name}${part}`,
            kind: 'required-missing',
          });
    for (const [name, anchor] of Object.entries(sample.anchors))
      if (!baselines.has(name)) baselines.set(name, anchor);
    for (const [name, anchor] of Object.entries(sample.anchors))
      if (name.startsWith('collectionPosition') && anchor.loadedSlot)
        realCollectionPositions.add(name);
    if (sample.scroll.some((value) => Math.abs(value) > 1))
      problems.push({
        frame: sample.frame,
        anchor: 'viewport',
        kind: 'scroll',
      });
    if (sample.overflow > 1)
      problems.push({
        frame: sample.frame,
        anchor: 'viewport',
        kind: 'overflow',
        delta: sample.overflow,
      });
    for (const [name, original] of baselines) {
      // Only the specifically declared cached pending cell may disappear when
      // authoritative discovery removes that library. A real button never may.
      if (
        name.startsWith('collectionPosition') &&
        !sample.anchors[name] &&
        settledFrames.has(sample.frame) &&
        !realCollectionPositions.has(name) &&
        permanentlyRemovedTail.has(name)
      )
        continue;
      if (
        options.allLibrariesHidden &&
        terminalFrames.has(sample.frame) &&
        (['collectionMovies', 'collectionTV'].includes(name) ||
          name.startsWith('collectionPosition') ||
          name.startsWith('collectionSlot')) &&
        !sample.anchors[name]
      )
        continue;
      if (
        name.startsWith('slot') &&
        options.allowEmptySlots &&
        terminalFrames.has(sample.frame) &&
        !Object.keys(sample.anchors).some((name) => name.startsWith('slot'))
      )
        continue;
      const current = sample.anchors[name];
      if (!current) {
        if (pendingArtwork.has(name)) continue;
        problems.push({ frame: sample.frame, anchor: name, kind: 'missing' });
        continue;
      }
      // A navigation slot may change between inert span and actionable button;
      // its reserved box and the persistent navigation list must stay fixed.
      if (
        !name.startsWith('slot') &&
        !name.startsWith('navigationSlot') &&
        !name.startsWith('collectionPosition') &&
        !name.startsWith('collectionSlot') &&
        current.id !== original.id
      )
        problems.push({ frame: sample.frame, anchor: name, kind: 'replaced' });
      if (
        (name.startsWith('slot') || name.startsWith('collectionSlot')) &&
        current.loadedSlot
      ) {
        if (!loadedSlots.has(name)) loadedSlots.set(name, current.id);
        else if (loadedSlots.get(name) !== current.id)
          problems.push({
            frame: sample.frame,
            anchor: name,
            kind: 'replaced',
          });
      }
      if (original.visible && !current.visible)
        problems.push({ frame: sample.frame, anchor: name, kind: 'hidden' });
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        const delta = current.rect[key] - original.rect[key];
        if (Math.abs(delta) > 1)
          problems.push({
            frame: sample.frame,
            anchor: name,
            kind: key,
            delta,
          });
      }
    }
  }
  for (const removal of trace.removals)
    if (
      removal.frame >= first.frame &&
      !removal.anchor.startsWith('navigationSlot') &&
      !(
        options.allLibrariesHidden &&
        terminalFrames.has(removal.frame) &&
        ['collectionMovies', 'collectionTV'].includes(removal.anchor)
      )
    )
      problems.push({ ...removal, kind: 'removed' });
  return problems;
}
