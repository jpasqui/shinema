import { MetadataCredits } from './MetadataCredits.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type Hls from 'hls.js';
import { restoreBrowserResume } from './playback.ts';
import type { PlaybackDriver } from './playback.ts';
import { LibraryBrowser } from './LibraryBrowser.tsx';
import { initialBrowse } from './browse.ts';
import {
  parseCatalog,
  parsePlayback,
} from '../../../packages/contracts/index.ts';
import type { Media, Progress } from '../../../packages/contracts/index.ts';
import {
  clock,
  empty,
  initializeSilentVideo,
  loadPlaybackProgress,
  NavigationGuard,
  progressValue,
  Queue,
  recover,
  resumeAt,
  synchronize,
} from './model.ts';
import type { Cache } from './model.ts';
import { Artwork } from './Artwork.tsx';
import { MediaPoster } from './MediaPoster.tsx';

const storageKey = 'shinema.web.cache.v1';
const demo = import.meta.env.VITE_DEMO_MODE === 'true';
const descriptions = [
  'A generated sample with original lunar landscape artwork.',
  'A generated sample with original desert landscape artwork.',
  'A generated sample with original architectural artwork.',
];
const artwork = (item: Media) =>
  demo
    ? ['Orbit', 'Horizon', 'Pulse'].findIndex((name) =>
        item.title.includes(name),
      )
    : parseInt(item.id.slice(0, 2), 16) % 3;
const title = (item: Media) =>
  demo ? item.title.replace(/^Generated /, '') : item.title;
async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(6000)])
      : AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error('Server request failed');
  return response.json();
}
function Poster({ item, large = false }: { item: Media; large?: boolean }) {
  if (!demo)
    return (
      <MediaPoster source={item.posterPath} title={item.title} large={large} />
    );
  return (
    <div
      aria-hidden="true"
      className={`poster art-${Math.max(0, artwork(item))}${large ? ' large' : ''}`}
    >
      <Artwork kind={Math.max(0, artwork(item))} />
    </div>
  );
}

export default function App() {
  const cache = useRef<Cache>(empty());
  const [version, render] = useState(0);
  const [browseNavigation, setBrowseNavigation] = useState(initialBrowse);
  const [route, setRoute] = useState<'library' | 'detail' | 'player'>(
    'library',
  );
  const [selected, setSelected] = useState<Media | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [opening, setOpening] = useState(false);
  const [resume, setResume] = useState<Progress | null>(null);
  const [focus, setFocus] = useState(0);
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  const libraryScroll = useRef(0);
  const back = useRef<HTMLButtonElement | null>(null);
  const guard = useRef(new NavigationGuard());
  const catalogRequest = useRef(0);
  const catalogAbort = useRef<AbortController | null>(null);
  const queue = useRef(new Queue());
  const progressRevisions = useRef(new Map<string, number>());
  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cache.current));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
    render((value) => value + 1);
  }, []);
  const sync = useCallback(
    (id: string, value: Progress) =>
      queue.current
        .run(() =>
          synchronize(id, value, {
            read: () => cache.current,
            write: (next) => {
              cache.current = next;
            },
            persist,
            send: async (key, progress) => {
              const response = await fetch(`/api/media/${key}/progress`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(progress),
                signal: AbortSignal.timeout(6000),
              });
              if (!response.ok) throw new Error('Progress sync failed');
            },
          }),
        )
        .catch(() => {}),
    [persist],
  );
  const refresh = useCallback(async () => {
    catalogAbort.current?.abort();
    const controller = new AbortController();
    catalogAbort.current = controller;
    const generation = ++catalogRequest.current;
    setLoading(true);
    setError('');
    try {
      const catalog = parseCatalog(
        await json(
          demo
            ? '/api/catalog?limit=60'
            : '/api/catalog?collection=movies&limit=60',
          { signal: controller.signal },
        ),
      );
      if (generation !== catalogRequest.current) return;
      cache.current = { ...cache.current, catalog };
      persist();
      for (const [id, progress] of Object.entries(cache.current.pending))
        void sync(id, progress);
    } catch {
      if (generation === catalogRequest.current)
        setError(
          cache.current.catalog
            ? 'The server is unavailable. Your saved library is still here.'
            : 'The server is unavailable. Start the local demo server and retry.',
        );
    } finally {
      if (generation === catalogRequest.current) setLoading(false);
    }
  }, [persist, sync]);
  useEffect(() => {
    try {
      cache.current = recover(localStorage.getItem(storageKey));
    } catch {
      setStorageError(true);
    }
    persist();
    void refresh();
    const online = () => {
      void refresh();
    };
    window.addEventListener('online', online);
    return () => {
      catalogAbort.current?.abort();
      catalogRequest.current++;
      guard.current.next();
      window.removeEventListener('online', online);
    };
  }, [refresh, persist]);
  useEffect(() => {
    if (demo || route !== 'detail' || !selected) return;
    const id = selected.id;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      try {
        const response = await fetch(`/api/media/${id}/metadata`, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(6000),
          ]),
          priority: 'high',
        });
        if (!response.ok) return;
        const raw = await response.json();
        const item = parseCatalog(raw).items[0];
        if (active && item)
          setSelected((previous) => (previous?.id === id ? item : previous));
        if (active && raw.metadataPending)
          timer = setTimeout(() => {
            void update();
          }, 2000);
      } catch {
        /* Browsing and playback remain available without external metadata. */
      }
    };
    void update();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [route, selected?.id]);
  const save = useCallback(
    (id: string, position: number, duration: number) => {
      const value = progressValue(position, duration);
      if (!value) return;
      progressRevisions.current.set(
        id,
        (progressRevisions.current.get(id) ?? 0) + 1,
      );
      cache.current = {
        ...cache.current,
        progress: { ...cache.current.progress, [id]: value },
        pending: { ...cache.current.pending, [id]: value },
      };
      persist();
      void sync(id, value);
    },
    [persist, sync],
  );
  const showDetail = (item: Media, index: number) => {
    guard.current.next();
    setOpening(false);
    libraryScroll.current = window.scrollY;
    setFocus(index);
    setSelected(item);
    setRoute('detail');
    window.scrollTo(0, 0);
  };
  const showLibrary = useCallback(() => {
    guard.current.next();
    setOpening(false);
    setRoute('library');
    requestAnimationFrame(() => {
      cards.current[focus]?.focus({ preventScroll: true });
      window.scrollTo(0, libraryScroll.current);
    });
  }, [focus]);
  const play = async () => {
    if (!selected || opening) return;
    const item = selected;
    const ticket = guard.current.next();
    setOpening(true);
    const value = await loadPlaybackProgress(item.id, {
      read: () => cache.current,
      revision: (id) => progressRevisions.current.get(id) ?? 0,
      load: (id) => json(`/api/media/${id}/progress`),
    });
    if (!guard.current.current(ticket)) return;
    setOpening(false);
    setResume(value);
    setRoute('player');
  };
  useEffect(() => {
    if (route === 'detail') back.current?.focus({ preventScroll: true });
  }, [route]);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && route === 'detail') {
        event.preventDefault();
        showLibrary();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [route, showLibrary]);
  const navigateCard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const items = cache.current.catalog?.items ?? [];
    let next = index;
    if (event.key === 'ArrowRight')
      next = Math.min(index + 1, items.length - 1);
    else if (event.key === 'ArrowLeft') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rect = cards.current[index]?.getBoundingClientRect();
      if (!rect) return;
      const center = rect.x + rect.width / 2;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const candidates = cards.current
        .map((node, i) => ({ i, rect: node?.getBoundingClientRect() }))
        .filter(
          (value) => value.rect && (value.rect.y - rect.y) * direction > 10,
        );
      candidates.sort(
        (a, b) =>
          Math.abs(a.rect!.y - rect.y) - Math.abs(b.rect!.y - rect.y) ||
          Math.abs(a.rect!.x + a.rect!.width / 2 - center) -
            Math.abs(b.rect!.x + b.rect!.width / 2 - center),
      );
      next = candidates[0]?.i ?? index;
    } else return;
    event.preventDefault();
    setFocus(next);
    cards.current[next]?.focus();
  };
  const items = cache.current.catalog?.items ?? [];
  const fullLibrary =
    !demo &&
    (cache.current.catalog?.fullLibrary === true ||
      items.some((item) => item.collection));
  const featured =
    items.find((item) => item.title.includes('Orbit')) ?? items[0];
  return (
    <div className="app" data-cache-version={version}>
      <header className="header">
        <button
          className="brand"
          onClick={showLibrary}
          aria-label="Shinema library"
        >
          Shinema
        </button>
        <nav aria-label="Main navigation">
          <button
            className={route === 'library' ? 'nav-link active' : 'nav-link'}
            onClick={showLibrary}
          >
            Library
          </button>
        </nav>
        <span className="context-label">
          {demo ? 'Demo library' : 'Connected library'}
        </span>
      </header>
      {storageError && (
        <div className="notice" role="alert">
          Browser storage is unavailable. Resume changes will last for this
          session only.
        </div>
      )}
      {route === 'player' && selected ? (
        <Player
          item={selected}
          progress={resume}
          save={save}
          back={() => {
            guard.current.next();
            setRoute('detail');
          }}
        />
      ) : route === 'detail' && selected ? (
        <main className={`detail${!demo ? ' connected-detail' : ''}`}>
          {!demo && selected.backdropPath && (
            <div className="detail-backdrop" aria-hidden="true">
              <img src={selected.backdropPath} alt="" />
            </div>
          )}
          <button ref={back} className="back-button" onClick={showLibrary}>
            &larr; Back to library
          </button>
          <div className="detail-layout">
            <Poster item={selected} large />
            <section className="detail-copy">
              <p className="detail-category">
                {demo
                  ? 'Generated sample'
                  : selected.collection === 'tv'
                    ? (selected.seriesTitle ?? 'TV episode')
                    : selected.collection === 'movies'
                      ? 'Movie'
                      : 'Library title'}
              </p>
              <h1>{title(selected)}</h1>
              <div className="metadata">
                <span>
                  {demo
                    ? '1 min'
                    : (selected.year ?? selected.container.toUpperCase())}
                </span>
                <span>
                  {!demo && selected.genres?.length
                    ? selected.genres.join(' · ')
                    : selected.container.toUpperCase()}
                </span>
              </div>
              <p className="description">
                {demo
                  ? descriptions[Math.max(0, artwork(selected))]
                  : (selected.summary ??
                    'No description is available for this title.')}
              </p>
              <button
                className="primary"
                onClick={() => {
                  void play();
                }}
                disabled={opening}
              >
                {opening
                  ? 'Preparing playback...'
                  : (cache.current.progress[selected.id]?.positionSeconds ??
                        0) > 0
                    ? '\u25b6 Resume'
                    : '\u25b6 Play'}
              </button>
              <p className="quiet">
                Starts muted &middot; progress saved automatically
              </p>
              {selected.metadataUrl && (
                <p className="quiet">
                  Metadata from{' '}
                  <a
                    href={selected.metadataUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {selected.metadataSource === 'tvmaze' ? 'TVmaze' : 'TMDB'}
                  </a>
                  {selected.metadataSource === 'tvmaze' ? ' · CC BY-SA' : ''}
                </p>
              )}
            </section>
          </div>
        </main>
      ) : fullLibrary ? (
        <LibraryBrowser
          navigation={browseNavigation}
          setNavigation={setBrowseNavigation}
          onSelect={showDetail}
          progress={cache.current.progress}
        />
      ) : (
        <main>
          <div className="page-title">
            <h1>Library</h1>
            <p>
              {demo
                ? 'Generated clips with original demo artwork.'
                : 'Browse your saved titles.'}
            </p>
          </div>
          {featured && (
            <section className="feature" aria-label="Featured title">
              <Artwork kind={Math.max(0, artwork(featured))} wide />
              <div className="feature-shade" />
              <div className="feature-copy">
                <p className="feature-label">Featured</p>
                <h2 title={title(featured)}>{title(featured)}</h2>
                <p className="feature-meta">
                  {demo ? 'Generated sample · 1 min' : 'Direct playback'}
                </p>
                <button
                  className="primary"
                  onClick={() => showDetail(featured, items.indexOf(featured))}
                >
                  View details <span aria-hidden="true">&rarr;</span>
                </button>
              </div>
            </section>
          )}
          <section className="library-section">
            <div className="section-heading">
              <h2>
                All titles <span className="title-count">{items.length}</span>
              </h2>
              <div className="connection">
                {loading ? (
                  <span>Connecting...</span>
                ) : error ? (
                  <span>
                    {cache.current.catalog ? 'Cached library' : 'Offline'}
                  </span>
                ) : null}
                <button
                  className="text-button"
                  onClick={() => {
                    void refresh();
                  }}
                  disabled={loading}
                >
                  {loading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>
            {error && (
              <div className="notice" role="status">
                {error}{' '}
                <button
                  className="text-button"
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Retry connection
                </button>
              </div>
            )}
            {loading && !items.length ? (
              <div
                className="poster-grid"
                aria-label="Loading library"
                aria-busy="true"
              >
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton" />
                ))}
              </div>
            ) : items.length ? (
              <div className="poster-grid">
                {items.map((item, index) => {
                  const progress = cache.current.progress[item.id];
                  return (
                    <button
                      key={item.id}
                      ref={(node) => {
                        cards.current[index] = node;
                      }}
                      className="media-card"
                      tabIndex={index === focus ? 0 : -1}
                      onFocus={() => setFocus(index)}
                      onKeyDown={(event) => navigateCard(event, index)}
                      onClick={() => showDetail(item, index)}
                      aria-label={`Open ${title(item)}`}
                    >
                      <Poster item={item} />
                      <div className="card-copy">
                        <h3>{title(item)}</h3>
                        <span>
                          {progress
                            ? `Resume at ${clock(progress.positionSeconds)}`
                            : demo
                              ? `1 min · ${item.container.toUpperCase()}`
                              : item.container.toUpperCase()}
                        </span>
                      </div>
                      {progress && (
                        <div
                          className="watch-progress"
                          aria-label={`${Math.round((progress.positionSeconds / progress.durationSeconds) * 100)} percent watched`}
                        >
                          <div
                            style={{
                              width: `${(progress.positionSeconds / progress.durationSeconds) * 100}%`,
                            }}
                          />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                <h3>
                  {error ? 'Waiting for your server' : 'Your library is empty'}
                </h3>
                <p>
                  {error
                    ? 'Your library will appear when the connection returns.'
                    : 'Add supported media to the server fixture directory, then refresh your library.'}
                </p>
              </div>
            )}
          </section>
          <footer>
            <span>Shinema</span>
            <span>Local preview</span>
          </footer>
        </main>
      )}
      <MetadataCredits />
    </div>
  );
}

function Player({
  item,
  progress,
  save,
  back,
}: {
  item: Media;
  progress: Progress | null;
  save: (id: string, position: number, duration: number) => void;
  back: () => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const lastSave = useRef(0);
  const started = useRef(false);
  const playbackDriver = useRef<PlaybackDriver>('');
  const [muted, setMuted] = useState(true);
  const [mode, setMode] = useState('');
  const snapshot = useCallback(() => {
    const node = video.current;
    if (node) save(item.id, node.currentTime, node.duration);
  }, [item.id, save]);
  useEffect(() => {
    const node = video.current;
    if (!node) return;
    const controller = new AbortController();
    let hls: Hls | undefined;
    node.defaultMuted = true;
    node.muted = true;
    node.volume = 0;
    container.current?.focus();
    const prepare = async () => {
      try {
        const response = await fetch(`/api/media/${item.id}/playback`, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(50000),
          ]),
        });
        if (!response.ok) throw new Error('Playback unavailable');
        const info = parsePlayback(await response.json(), item.id);
        if (controller.signal.aborted) return;
        setDuration(info.durationSeconds);
        setMode(info.mode);
        if (info.mode === 'direct') {
          playbackDriver.current = 'direct';
          initializeSilentVideo(node, info.streamPath);
        } else {
          const { default: Hls } = await import('hls.js');
          if (controller.signal.aborted) return;
          if (Hls.isSupported()) {
            playbackDriver.current = 'hls-js';
            hls = new Hls({
              startPosition: resumeAt(progress, info.durationSeconds),
              maxBufferLength: 18,
              maxMaxBufferLength: 36,
              backBufferLength: 18,
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal && !controller.signal.aborted)
                setError(
                  'Playback stopped. Check the server connection and try again.',
                );
            });
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (!controller.signal.aborted && !started.current) {
                started.current = true;
                startPlayback('Press Play to start playback.');
              }
            });
            hls.attachMedia(node);
            hls.loadSource(info.streamPath);
          } else if (node.canPlayType('application/vnd.apple.mpegurl')) {
            playbackDriver.current = 'native-hls';
            initializeSilentVideo(node, info.streamPath);
          } else {
            setError('This browser cannot play the compatibility stream.');
          }
        }
      } catch {
        if (!controller.signal.aborted)
          setError(
            'This item could not play. Check your server connection and browser codec support.',
          );
      }
    };
    void prepare();
    const hide = () => snapshot();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', hide);
    return () => {
      controller.abort();
      save(item.id, node.currentTime, node.duration);
      node.pause();
      hls?.destroy();
      node.removeAttribute('src');
      node.load();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', hide);
    };
  }, [item.id, item.streamPath, snapshot, progress]);
  const startPlayback = (message: string) => {
    const node = video.current;
    if (!node) return;
    void node.play().catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (node.isConnected) setError(message);
    });
  };
  const toggle = () => {
    const node = video.current;
    if (!node) return;
    if (node.paused)
      startPlayback(
        'Playback could not start. Check the connection or media format.',
      );
    else node.pause();
  };
  const seek = (value: number) => {
    const node = video.current;
    if (node && Number.isFinite(node.duration))
      node.currentTime = Math.max(0, Math.min(value, node.duration));
  };
  const key = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      snapshot();
      back();
    } else if (event.target instanceof HTMLInputElement) return;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      seek(
        (video.current?.currentTime ?? 0) +
          (event.key === 'ArrowRight' ? 10 : -10),
      );
    } else if (
      event.key === ' ' &&
      !(event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      toggle();
    }
  };
  return (
    <main
      className="player-page"
      ref={container}
      tabIndex={-1}
      onKeyDown={key}
      aria-label="Video player"
    >
      <div className="player-heading">
        <button
          className="back-button"
          onClick={() => {
            snapshot();
            back();
          }}
        >
          &larr; Back to details
        </button>
        <span className="context-label">{muted ? 'Muted' : 'Sound on'}</span>
      </div>
      <div className="video-stage">
        <video
          ref={video}
          playsInline
          muted
          preload="metadata"
          aria-label={`Playing ${title(item)}`}
          onLoadedMetadata={() => {
            const node = video.current!;
            setDuration(node.duration);
            restoreBrowserResume(node, playbackDriver.current, progress);
            setPosition(node.currentTime);
          }}
          onCanPlay={() => {
            setReady(true);
            if (!started.current) {
              started.current = true;
              startPlayback('Press Play to start playback.');
            }
          }}
          onPlay={() => {
            setPaused(false);
            setError('');
          }}
          onPause={() => {
            setPaused(true);
            snapshot();
          }}
          onSeeked={() => {
            setPosition(video.current?.currentTime ?? 0);
            snapshot();
          }}
          onEnded={snapshot}
          onTimeUpdate={() => {
            const node = video.current!;
            setPosition(node.currentTime);
            if (Math.abs(node.currentTime - lastSave.current) >= 5) {
              lastSave.current = node.currentTime;
              snapshot();
            }
          }}
          onError={() =>
            setError(
              'This item could not play. Check your server connection and browser codec support.',
            )
          }
        />
        {!ready && !error && (
          <div className="video-message" role="status">
            Loading video...
          </div>
        )}
        {error && (
          <div className="video-message" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="player-controls">
        <button
          className="primary"
          onClick={toggle}
          aria-label={paused ? 'Play video' : 'Pause video'}
        >
          {paused ? '\u25b6 Play' : '\u2161 Pause'}
        </button>
        <button
          className="control-button"
          onClick={() => seek(position - 10)}
          aria-label="Back ten seconds"
        >
          -10s
        </button>
        <button
          className="control-button"
          onClick={() => seek(position + 10)}
          aria-label="Forward ten seconds"
        >
          +10s
        </button>
        <input
          aria-label="Playback position"
          type="range"
          min="0"
          max={duration || 1}
          step="0.1"
          value={position}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="time">
          {clock(position)} / {clock(duration)}
        </span>
        <button
          className="control-button"
          aria-label={muted ? 'Enable audio' : 'Mute audio'}
          onClick={() => {
            const node = video.current;
            if (node) {
              node.muted = !muted;
              node.volume = muted ? 1 : 0;
              setMuted(!muted);
            }
          }}
        >
          {muted ? 'Enable audio' : 'Mute'}
        </button>
      </div>
      <div className="now-playing">
        <div>
          <h1>{title(item)}</h1>
          <p className="quiet">
            {demo
              ? 'Generated sample'
              : mode === 'transcode'
                ? 'Full-length playback'
                : mode === 'direct'
                  ? 'Full-length playback'
                  : 'Preparing playback'}
          </p>
        </div>
        <p className="keyboard-hint">
          Space to pause &middot; Arrows to seek &middot; Esc to return
        </p>
      </div>
    </main>
  );
}
