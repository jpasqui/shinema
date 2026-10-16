import { useEffect, useMemo, useRef, useState } from 'react';
import {
  RequestClient,
  RequestError,
} from '../../../packages/contracts/requests.ts';
import type {
  RequestCandidate,
  RequestCapabilities,
  RequestKind,
  RequestRecord,
  SonarrCompatibility,
} from '../../../packages/contracts/requests.ts';
import './requests.css';

const statusLabel = {
  not_requested: 'Not requested',
  requested: 'Requested',
  available: 'Provider complete',
  uncertain: 'Needs review',
  failed: 'Needs attention',
};

function errorMessage(error: unknown) {
  return error instanceof RequestError
    ? error.message
    : 'The request service could not be reached. Check the server and try again.';
}

const sonarrPreviewPolicy =
  'New series use English metadata and Official episode order. Other language and order choices are not supported here.';

function SonarrStatus({
  compatibility,
  loading,
  problem,
}: {
  compatibility: SonarrCompatibility | null;
  loading: boolean;
  problem: string;
}) {
  const ready = compatibility?.status === 'ready';
  const description = loading
    ? 'Checking the series service. Your saved request list remains available.'
    : problem ||
      (ready
        ? compatibility.preview
          ? sonarrPreviewPolicy
          : 'Series requests are supported by this Sonarr version.'
        : compatibility?.status === 'disabled'
          ? 'Series requests are disabled. Ask your server operator to review setup.'
          : compatibility?.status === 'unsupported'
            ? 'This Sonarr version is not supported for series requests. Ask your server operator to review it.'
            : 'Sonarr is unavailable. Refresh statuses to check again.');
  return (
    <section
      className={`requests-sonarr${!loading && !ready ? ' requests-sonarr-warning' : ''}`}
      aria-label="Sonarr compatibility"
    >
      <h3>
        {loading
          ? 'Checking Sonarr compatibility...'
          : ready
            ? `Sonarr ${compatibility.version}${compatibility.preview ? ' preview' : ''}`
            : 'Sonarr needs attention'}
      </h3>
      <p>{description}</p>
      {ready && !loading && (
        <p className="requests-small">
          The server checks compatibility again when you submit a series
          request.
        </p>
      )}
    </section>
  );
}

export function Requests({ onBack }: { onBack: () => void }) {
  const client = useMemo(() => new RequestClient(), []);
  const [capabilities, setCapabilities] = useState<RequestCapabilities | null>(
    null,
  );
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [checking, setChecking] = useState(true);
  const [token, setToken] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [kind, setKind] = useState<RequestKind>('movie');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RequestCandidate[] | null>(null);
  const [records, setRecords] = useState<RequestRecord[]>([]);
  const [selected, setSelected] = useState<RequestCandidate | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mustRefresh, setMustRefresh] = useState(false);
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [sonarr, setSonarr] = useState<SonarrCompatibility | null>(null);
  const [sonarrChecking, setSonarrChecking] = useState(false);
  const [sonarrProblem, setSonarrProblem] = useState('');
  const epoch = useRef(0);
  const searchSequence = useRef(0);
  const listSequence = useRef(0);
  const authBusy = useRef(false);
  const submitBusy = useRef(false);
  const refreshBusy = useRef(false);
  const sonarrSequence = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const searchReturnFocus = useRef<HTMLButtonElement | null>(null);

  function clearSearch() {
    searchSequence.current++;
    setSearching(false);
    setResults(null);
    setSelected(null);
  }

  function lock() {
    epoch.current++;
    listSequence.current++;
    sonarrSequence.current++;
    client.lock();
    authBusy.current = false;
    submitBusy.current = false;
    refreshBusy.current = false;
    setUnlocked(false);
    setUnlocking(false);
    setSubmitting(false);
    setRefreshing(false);
    setMustRefresh(false);
    setToken('');
    setRecords([]);
    setSonarr(null);
    setSonarrChecking(false);
    setSonarrProblem('');
    setQuery('');
    setProblem('');
    setNotice('Request access is locked.');
    clearSearch();
  }

  function failed(error: unknown) {
    if (error instanceof RequestError && error.code === 'unauthorized') lock();
    setProblem(errorMessage(error));
  }

  async function refreshSonarr(session: number) {
    if (
      !capabilities?.providers.some(
        (provider) => provider.kind === 'series' && provider.enabled,
      )
    )
      return;
    const ticket = ++sonarrSequence.current;
    setSonarr(null);
    setSonarrChecking(true);
    setSonarrProblem('');
    try {
      const value = await client.sonarr();
      if (session === epoch.current && ticket === sonarrSequence.current)
        setSonarr(value);
    } catch (error) {
      if (session !== epoch.current) return;
      if (error instanceof RequestError && error.code === 'unauthorized')
        failed(error);
      else if (ticket === sonarrSequence.current)
        setSonarrProblem(
          'Sonarr compatibility could not be checked. Refresh statuses to try again.',
        );
    } finally {
      if (session === epoch.current && ticket === sonarrSequence.current)
        setSonarrChecking(false);
    }
  }

  useEffect(() => {
    let active = true;
    setChecking(true);
    setProblem('');
    void client
      .capabilities()
      .then(
        (value) => {
          if (!active) return;
          setCapabilities(value);
          const first = value.providers.find((provider) => provider.enabled);
          if (first) setKind(first.kind);
        },
        (error: unknown) => {
          if (active) setProblem(errorMessage(error));
        },
      )
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [client, capabilityAttempt]);

  useEffect(
    () => () => {
      epoch.current++;
      searchSequence.current++;
      listSequence.current++;
      sonarrSequence.current++;
      client.lock();
    },
    [client],
  );

  useEffect(() => {
    if (selected) {
      if (submitting) dialog.current?.focus();
      else confirmation.current?.focus();
    }
  }, [selected, submitting]);

  async function unlock() {
    if (authBusy.current || !token.trim()) return;
    authBusy.current = true;
    const ticket = ++epoch.current;
    const entered = token;
    setToken('');
    setUnlocking(true);
    setProblem('');
    setNotice('');
    try {
      const items = await client.unlock(entered);
      if (ticket !== epoch.current) return;
      setRecords(items);
      setUnlocked(true);
      void refreshSonarr(ticket);
      setMustRefresh(client.refreshIncomplete);
      if (client.refreshIncomplete)
        setNotice(
          'Some statuses could not be refreshed; saved status is shown. Refresh before requesting.',
        );
      requestAnimationFrame(() => searchInput.current?.focus());
    } catch (error) {
      if (ticket !== epoch.current) return;
      client.lock();
      setProblem(errorMessage(error));
    } finally {
      if (ticket === epoch.current) {
        authBusy.current = false;
        setUnlocking(false);
      }
    }
  }

  async function search() {
    const term = query.trim();
    if (
      !unlocked ||
      submitting ||
      (kind === 'series' && (sonarrChecking || sonarr?.status !== 'ready')) ||
      Array.from(term).length < 2 ||
      Array.from(term).length > 100
    )
      return;
    const ticket = ++searchSequence.current;
    const session = epoch.current;
    setSearching(true);
    setSelected(null);
    setResults(null);
    setProblem('');
    if (!mustRefresh) setNotice('');
    try {
      const items = await client.search(kind, term);
      if (session === epoch.current && ticket === searchSequence.current)
        setResults(items);
    } catch (error) {
      if (session === epoch.current && ticket === searchSequence.current)
        failed(error);
    } finally {
      if (session === epoch.current && ticket === searchSequence.current)
        setSearching(false);
    }
  }

  async function refresh() {
    if (!unlocked || submitBusy.current || refreshBusy.current) return;
    refreshBusy.current = true;
    const ticket = ++listSequence.current;
    const session = epoch.current;
    const searchAtStart = searchSequence.current;
    void refreshSonarr(session);
    setRefreshing(true);
    setProblem('');
    try {
      const items = await client.list();
      if (session !== epoch.current || ticket !== listSequence.current) return;
      setRecords(items);
      setMustRefresh(client.refreshIncomplete);
      setNotice(
        client.refreshIncomplete
          ? 'Some statuses could not be refreshed; saved status is shown. Refresh before requesting.'
          : 'Request statuses refreshed.',
      );
      // Search again to get provider status before another confirmation.
      if (searchAtStart === searchSequence.current) clearSearch();
    } catch (error) {
      if (session === epoch.current && ticket === listSequence.current) {
        failed(error);
        setMustRefresh(true);
        setNotice(
          'Statuses could not be checked. Refresh successfully before requesting.',
        );
      }
    } finally {
      if (session === epoch.current && ticket === listSequence.current) {
        refreshBusy.current = false;
        setRefreshing(false);
      }
    }
  }

  async function submit() {
    if (
      !unlocked ||
      !selected ||
      selected.status !== 'not_requested' ||
      submitBusy.current ||
      refreshBusy.current ||
      mustRefresh ||
      (selected.kind === 'series' &&
        (sonarrChecking || sonarr?.status !== 'ready'))
    )
      return;
    submitBusy.current = true;
    const candidate = selected;
    const session = epoch.current;
    listSequence.current++;
    setRefreshing(false);
    setSubmitting(true);
    setProblem('');
    setNotice('');
    try {
      const result = await client.submit(candidate);
      if (session !== epoch.current) return;
      setRecords((items) => [
        result.item,
        ...items.filter((item) => item.id !== result.item.id),
      ]);
      setResults(
        (items) =>
          items?.map((item) =>
            item.kind === candidate.kind &&
            item.externalId === candidate.externalId
              ? {
                  ...item,
                  status: result.item.status,
                  requestId: result.item.id,
                }
              : item,
          ) ?? null,
      );
      if (
        result.item.status === 'uncertain' ||
        result.item.status === 'failed'
      ) {
        setMustRefresh(true);
        setNotice(
          `${candidate.title}: ${statusLabel[result.item.status]}. Refresh statuses and ask your server operator to review. No automatic retry was made.`,
        );
      } else
        setNotice(
          result.duplicate
            ? `${candidate.title} is already on the request list. No duplicate was added.`
            : `${candidate.title} was added to the request list. No automatic search starts.`,
        );
    } catch (error) {
      if (session !== epoch.current) return;
      failed(error);
      setMustRefresh(true);
      setNotice(
        'The outcome may need review. Refresh statuses before making another request. Submissions are never retried automatically.',
      );
    } finally {
      if (session === epoch.current) {
        submitBusy.current = false;
        setSubmitting(false);
        setSelected(null);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
    }
  }

  const enabled = Boolean(
    capabilities?.enabled &&
    capabilities.providers.some((provider) => provider.enabled),
  );
  const providerEnabled = (value: RequestKind) =>
    capabilities?.providers.some(
      (provider) => provider.kind === value && provider.enabled,
    ) ?? false;
  const cancelConfirmation = () => {
    setSelected(null);
    requestAnimationFrame(() => searchReturnFocus.current?.focus());
  };

  return (
    <main className="requests-page">
      <button className="back-button" onClick={onBack}>
        &larr; Back to library
      </button>
      <div className="requests-heading">
        <div>
          <p className="requests-eyebrow">Your next watch</p>
          <h1>Requests</h1>
          <p>Find something new. Keep track of what is on the way.</p>
        </div>
        {unlocked && (
          <button className="requests-secondary" onClick={lock}>
            Lock requests
          </button>
        )}
      </div>
      {problem && (
        <div className="requests-feedback requests-error" role="alert">
          {problem}
        </div>
      )}
      {notice && (
        <div className="requests-feedback" role="status">
          {notice}
        </div>
      )}
      {checking ? (
        <p className="requests-empty" role="status">
          Checking request service...
        </p>
      ) : !capabilities ? (
        <section className="requests-access">
          <h2>Request service unavailable</h2>
          <p>
            Library playback is still available. Check the Shinema server
            connection, then retry.
          </p>
          <button
            className="requests-secondary"
            onClick={() => setCapabilityAttempt((value) => value + 1)}
          >
            Retry connection
          </button>
        </section>
      ) : !enabled ? (
        <section className="requests-access">
          <span className="requests-kicker">Operator setup required</span>
          <h2>Requests are not configured yet</h2>
          <p>
            A server operator must enable a Radarr or Sonarr provider and
            configure a separate Shinema request access token on the server.
          </p>
          <p>Provider API keys belong on the server. Do not enter them here.</p>
          <p className="requests-small">
            Setup guide: docs/requests.md in the Shinema repository.
          </p>
        </section>
      ) : !unlocked ? (
        <section className="requests-access">
          <span className="requests-kicker">Operator access</span>
          <h2>Unlock your request list</h2>
          <p>
            Use the Shinema request access token supplied by your server
            operator. This is separate from any Radarr or Sonarr API key.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <label htmlFor="request-token">Request access token</label>
            <div className="requests-input-row">
              <input
                id="request-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={unlocking}
                maxLength={512}
              />
              <button className="primary" disabled={unlocking || !token.trim()}>
                {unlocking ? 'Unlocking...' : 'Unlock requests'}
              </button>
            </div>
          </form>
          <p className="requests-small">
            Session only. Access is cleared when you leave this screen or lock
            requests.
          </p>
        </section>
      ) : (
        <div className="requests-layout">
          <section aria-labelledby="request-search-heading">
            <h2 id="request-search-heading">Find a title</h2>
            <div className="requests-kind" aria-label="Title type">
              {(['movie', 'series'] as const).map((value) => (
                <button
                  key={value}
                  className={kind === value ? 'selected' : ''}
                  aria-pressed={kind === value}
                  disabled={!providerEnabled(value) || submitting}
                  onClick={() => {
                    setKind(value);
                    clearSearch();
                    setProblem('');
                  }}
                >
                  {value === 'movie' ? 'Movies' : 'Series'}
                  {!providerEnabled(value) ? ' · unavailable' : ''}
                </button>
              ))}
            </div>
            {providerEnabled('series') && (
              <SonarrStatus
                compatibility={sonarr}
                loading={sonarrChecking}
                problem={sonarrProblem}
              />
            )}
            <form
              className="requests-search"
              onSubmit={(event) => {
                event.preventDefault();
                void search();
              }}
            >
              <label htmlFor="request-search">Search titles</label>
              <div className="requests-input-row">
                <input
                  ref={searchInput}
                  id="request-search"
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    clearSearch();
                  }}
                  placeholder={
                    kind === 'movie'
                      ? 'Search for a movie...'
                      : 'Search for a series...'
                  }
                  maxLength={200}
                  disabled={submitting}
                />
                <button
                  className="primary"
                  disabled={
                    searching ||
                    submitting ||
                    (kind === 'series' &&
                      (sonarrChecking || sonarr?.status !== 'ready')) ||
                    Array.from(query.trim()).length < 2 ||
                    Array.from(query.trim()).length > 100
                  }
                >
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </div>
              <p className="requests-small">
                Search {kind === 'movie' ? 'Radarr' : 'Sonarr'} by title. Review
                the year before requesting.
              </p>
            </form>
            <div
              className="requests-results"
              aria-live="polite"
              aria-busy={searching}
            >
              {searching ? (
                <p className="requests-empty">Searching titles...</p>
              ) : results === null ? (
                <div className="requests-intro">
                  <span aria-hidden="true">+</span>
                  <h3>Make room for a new favorite</h3>
                  <p>Search a title to see its request status and details.</p>
                </div>
              ) : results.length === 0 ? (
                <p className="requests-empty">
                  No titles found. Try a different title or switch Movies /
                  Series.
                </p>
              ) : (
                <>
                  <p className="requests-result-count">
                    {results.length}{' '}
                    {results.length === 1 ? 'result' : 'results'}
                  </p>
                  {results.map((item) => (
                    <article
                      className="request-result"
                      key={`${item.kind}:${item.externalId}`}
                    >
                      <div className="requests-title-mark" aria-hidden="true">
                        {item.kind === 'movie' ? 'M' : 'S'}
                      </div>
                      <div className="request-result-copy">
                        <div className="request-result-heading">
                          <h3>
                            {item.title}
                            {item.year ? <span> ({item.year})</span> : null}
                          </h3>
                          <span
                            className={`request-status status-${item.status}`}
                          >
                            {statusLabel[item.status]}
                          </span>
                        </div>
                        <p>
                          {item.overview ||
                            'No description is available for this title.'}
                        </p>
                        <button
                          className="requests-secondary"
                          disabled={
                            item.status !== 'not_requested' ||
                            mustRefresh ||
                            submitting ||
                            refreshing ||
                            (item.kind === 'series' &&
                              (sonarrChecking || sonarr?.status !== 'ready'))
                          }
                          onClick={(event) => {
                            searchReturnFocus.current = event.currentTarget;
                            setSelected(item);
                          }}
                        >
                          {' '}
                          {item.status === 'not_requested'
                            ? 'Review request'
                            : item.status === 'available'
                              ? 'Complete at provider'
                              : item.status === 'uncertain' ||
                                  item.status === 'failed'
                                ? 'Ask operator to review'
                                : 'Already requested'}
                        </button>
                      </div>
                    </article>
                  ))}
                </>
              )}
            </div>
          </section>
          <aside
            className="requests-tracker"
            aria-labelledby="request-list-heading"
          >
            <div className="requests-tracker-heading">
              <div>
                <p className="requests-kicker">Shared list</p>
                <h2 id="request-list-heading">Request status</h2>
              </div>
              <button
                className="text-button"
                disabled={refreshing || submitting}
                onClick={() => void refresh()}
              >
                {refreshing ? 'Refreshing...' : 'Refresh statuses'}
              </button>
            </div>
            <p className="requests-small">
              Provider complete means the provider has all files. Shinema
              indexing and playback availability are separate. Requested titles
              may still need operator action.
            </p>
            {records.length === 0 ? (
              <p className="requests-list-empty">
                No requests yet.
                <br />
                Your first request will appear here.
              </p>
            ) : (
              <ul className="request-records">
                {records.map((item) => (
                  <li key={item.id}>
                    <div>
                      <h3>
                        {item.title}
                        {item.year ? ` (${item.year})` : ''}
                      </h3>
                      <span className="requests-small">
                        {item.kind === 'movie' ? 'Movie' : 'Series'}
                      </span>
                    </div>
                    <span className={`request-status status-${item.status}`}>
                      {statusLabel[item.status]}
                    </span>
                    {item.message && <p>{item.message}</p>}
                    {item.status === 'uncertain' && (
                      <p>
                        Refresh and ask your server operator to review before
                        submitting again.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="requests-safety">
              <span aria-hidden="true">✓</span>
              <p>
                Requests add titles to the provider list.
                <br />
                No automatic search starts.
              </p>
            </div>
          </aside>
        </div>
      )}
      {selected && (
        <div className="requests-modal-backdrop">
          <section
            ref={dialog}
            tabIndex={-1}
            className="requests-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="request-confirm-title"
            aria-describedby={
              selected.kind === 'series' && sonarr?.preview
                ? 'request-confirm-description request-sonarr-policy'
                : 'request-confirm-description'
            }
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !submitting) {
                event.preventDefault();
                event.stopPropagation();
                cancelConfirmation();
              }
              if (event.key === 'Tab') {
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll('button:not(:disabled)'),
                );
                const current = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  (current + (event.shiftKey ? -1 : 1) + buttons.length) %
                  buttons.length;
                (buttons[next] as HTMLButtonElement | undefined)?.focus();
              }
            }}
          >
            <p className="requests-kicker">Confirm your choice</p>
            <h2 id="request-confirm-title">
              Request {selected.title}
              {selected.year ? ` (${selected.year})` : ''}?
            </h2>
            <p id="request-confirm-description">
              Add this{' '}
              {selected.kind === 'movie'
                ? 'movie to Radarr'
                : 'series to Sonarr'}{' '}
              and the shared request list. No automatic search starts.
            </p>
            {selected.kind === 'series' && sonarr?.preview && (
              <p id="request-sonarr-policy" className="requests-sonarr-policy">
                {sonarrPreviewPolicy}
              </p>
            )}
            <p className="requests-small">
              Check the title and year. A series request adds the series, not an
              individual episode.
            </p>
            <div className="requests-confirm-actions">
              <button
                className="requests-secondary"
                disabled={submitting}
                onClick={cancelConfirmation}
              >
                Cancel
              </button>
              <button
                ref={confirmation}
                className="primary"
                disabled={
                  submitting ||
                  (selected.kind === 'series' &&
                    (sonarrChecking || sonarr?.status !== 'ready'))
                }
                onClick={() => void submit()}
              >
                {submitting ? 'Adding request...' : 'Confirm request'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
