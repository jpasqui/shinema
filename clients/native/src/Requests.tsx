import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ServerTransport } from '../../../packages/contracts/index.ts';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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

const statusLabel = {
  not_requested: 'Not requested',
  requested: 'Requested',
  available: 'Provider complete',
  uncertain: 'Needs review',
  failed: 'Needs attention',
};
const errorMessage = (error: unknown) =>
  error instanceof RequestError
    ? error.message
    : 'The request service could not be reached. Check the server and try again.';

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
    <View style={[styles.sonarr, !loading && !ready && styles.sonarrWarning]}>
      <Text accessibilityRole="header" style={styles.label}>
        {loading
          ? 'Checking Sonarr compatibility...'
          : ready
            ? `Sonarr ${compatibility.version}${compatibility.preview ? ' preview' : ''}`
            : 'Sonarr needs attention'}
      </Text>
      <Text style={styles.small}>{description}</Text>
      {ready && !loading && (
        <Text style={styles.small}>
          The server checks compatibility again when you submit a series
          request.
        </Text>
      )}
    </View>
  );
}

export function Requests({
  origin,
  transport,
  onBack,
  backHandler,
}: {
  origin: string;
  transport?: ServerTransport;
  onBack: () => void;
  backHandler: MutableRefObject<() => void>;
}) {
  const localHttpOrigin = transport?.localHttpOrigin ?? null;
  const client = useMemo(
    () =>
      new RequestClient(origin, undefined, Object.freeze({ localHttpOrigin })),
    [origin, localHttpOrigin],
  );
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
    lock();
    setNotice('');
    setCapabilities(null);
    return () => {
      epoch.current++;
      searchSequence.current++;
      listSequence.current++;
      sonarrSequence.current++;
      client.lock();
    };
  }, [client]);

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

  backHandler.current = () => {
    if (selected && !submitting) setSelected(null);
    else onBack();
  };

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
  const button = (
    label: string,
    action: () => void,
    disabled = false,
    primary = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={action}
      style={({ focused, pressed }) => [
        styles.button,
        primary && styles.primary,
        disabled && styles.disabled,
        (focused || pressed) && styles.focus,
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.primaryText]}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        {button('Back to library', onBack)}
        {unlocked && button('Lock requests', lock)}
      </View>
      <Text style={styles.eyebrow}>YOUR NEXT WATCH</Text>
      <Text accessibilityRole="header" style={styles.title}>
        Requests
      </Text>
      <Text style={styles.copy}>
        Find a title and follow its request status.
      </Text>
      {problem ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {problem}
        </Text>
      ) : null}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      ) : null}
      {checking ? (
        <Text style={styles.empty}>Checking request service...</Text>
      ) : !capabilities ? (
        <View style={styles.panel}>
          <Text style={styles.subtitle}>Request service unavailable</Text>
          <Text style={styles.copy}>
            Check the Shinema server connection. Library playback is still
            available.
          </Text>
          {button('Retry connection', () =>
            setCapabilityAttempt((value) => value + 1),
          )}
        </View>
      ) : !enabled ? (
        <View style={styles.panel}>
          <Text style={styles.eyebrow}>OPERATOR SETUP REQUIRED</Text>
          <Text style={styles.subtitle}>Requests are not configured yet</Text>
          <Text style={styles.copy}>
            A server operator must enable Radarr or Sonarr and configure a
            separate Shinema request access token on the server. See
            docs/requests.md in the Shinema setup guide.
          </Text>
          <Text style={styles.small}>
            Provider API keys belong on the server. Do not enter them here.
          </Text>
        </View>
      ) : !unlocked ? (
        <View style={styles.panel}>
          <Text style={styles.eyebrow}>OPERATOR ACCESS</Text>
          <Text style={styles.subtitle}>Unlock your request list</Text>
          <Text style={styles.copy}>
            Use the Shinema request access token supplied by your server
            operator. This is separate from any Radarr or Sonarr API key.
          </Text>
          <Text style={styles.label}>Request access token</Text>
          <TextInput
            accessibilityLabel="Request access token"
            secureTextEntry
            autoComplete="off"
            textContentType="none"
            autoCorrect={false}
            autoCapitalize="none"
            value={token}
            onChangeText={setToken}
            editable={!unlocking}
            maxLength={512}
            style={styles.input}
            onSubmitEditing={() => void unlock()}
          />
          {button(
            unlocking ? 'Unlocking...' : 'Unlock requests',
            () => void unlock(),
            unlocking || !token.trim(),
            true,
          )}
          <Text style={styles.small}>
            Session only. Access clears when you leave this screen or lock
            requests.
          </Text>
        </View>
      ) : (
        <>
          {selected ? (
            <View style={styles.panel} accessibilityViewIsModal>
              <Text style={styles.eyebrow}>CONFIRM YOUR CHOICE</Text>
              <Text accessibilityRole="header" style={styles.subtitle}>
                Request {selected.title}
                {selected.year ? ` (${selected.year})` : ''}?
              </Text>
              <Text style={styles.copy}>
                Add this{' '}
                {selected.kind === 'movie'
                  ? 'movie to Radarr'
                  : 'series to Sonarr'}{' '}
                and the shared request list. No automatic search starts.
              </Text>
              {selected.kind === 'series' && sonarr?.preview && (
                <Text style={styles.sonarrPolicy}>{sonarrPreviewPolicy}</Text>
              )}
              <Text style={styles.small}>
                Check the title and year. A series request adds the series, not
                an individual episode.
              </Text>
              <View style={styles.actions}>
                {button('Cancel', () => setSelected(null), submitting)}
                {button(
                  submitting ? 'Adding request...' : 'Confirm request',
                  () => void submit(),
                  submitting ||
                    (selected.kind === 'series' &&
                      (sonarrChecking || sonarr?.status !== 'ready')),
                  true,
                )}
              </View>
            </View>
          ) : (
            <>
              <View style={styles.panel}>
                <Text accessibilityRole="header" style={styles.subtitle}>
                  Find a title
                </Text>
                <View style={styles.actions}>
                  {(['movie', 'series'] as const).map((value) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{
                        selected: kind === value,
                        disabled: !providerEnabled(value) || submitting,
                      }}
                      key={value}
                      disabled={!providerEnabled(value) || submitting}
                      onPress={() => {
                        setKind(value);
                        clearSearch();
                        setProblem('');
                      }}
                      style={({ focused, pressed }) => [
                        styles.button,
                        kind === value && styles.primary,
                        !providerEnabled(value) && styles.disabled,
                        (focused || pressed) && styles.focus,
                      ]}
                    >
                      <Text
                        style={[
                          styles.buttonText,
                          kind === value && styles.primaryText,
                        ]}
                      >
                        {value === 'movie' ? 'Movies' : 'Series'}
                        {!providerEnabled(value) ? ' (unavailable)' : ''}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {providerEnabled('series') && (
                  <SonarrStatus
                    compatibility={sonarr}
                    loading={sonarrChecking}
                    problem={sonarrProblem}
                  />
                )}
                <Text style={styles.label}>Search titles</Text>
                <TextInput
                  accessibilityLabel="Search titles"
                  style={styles.input}
                  value={query}
                  onChangeText={(value) => {
                    setQuery(value);
                    clearSearch();
                  }}
                  editable={!submitting}
                  maxLength={200}
                  placeholder={
                    kind === 'movie'
                      ? 'Search for a movie...'
                      : 'Search for a series...'
                  }
                  placeholderTextColor="#93a294"
                  returnKeyType="search"
                  onSubmitEditing={() => void search()}
                />
                {button(
                  searching ? 'Searching...' : 'Search',
                  () => void search(),
                  searching ||
                    submitting ||
                    (kind === 'series' &&
                      (sonarrChecking || sonarr?.status !== 'ready')) ||
                    Array.from(query.trim()).length < 2 ||
                    Array.from(query.trim()).length > 100,
                  true,
                )}
                <Text style={styles.small}>
                  Search {kind === 'movie' ? 'Radarr' : 'Sonarr'} by title.
                  Review the year before requesting.
                </Text>
              </View>
              {searching ? (
                <Text style={styles.empty}>Searching titles...</Text>
              ) : results === null ? (
                <Text style={styles.empty}>
                  Search a title to see its request status and details.
                </Text>
              ) : results.length === 0 ? (
                <Text style={styles.empty}>
                  No titles found. Try a different title or type.
                </Text>
              ) : (
                results.map((item) => (
                  <View
                    key={`${item.kind}:${item.externalId}`}
                    style={styles.result}
                  >
                    <View style={styles.resultHeading}>
                      <Text
                        accessibilityRole="header"
                        style={styles.resultTitle}
                      >
                        {item.title}
                        {item.year ? ` (${item.year})` : ''}
                      </Text>
                      <Text style={styles.badge}>
                        {statusLabel[item.status]}
                      </Text>
                    </View>
                    <Text style={styles.copy}>
                      {item.overview ||
                        'No description is available for this title.'}
                    </Text>
                    {button(
                      item.status === 'not_requested'
                        ? 'Review request'
                        : item.status === 'available'
                          ? 'Complete at provider'
                          : item.status === 'uncertain' ||
                              item.status === 'failed'
                            ? 'Ask operator to review'
                            : 'Already requested',
                      () => setSelected(item),
                      item.status !== 'not_requested' ||
                        mustRefresh ||
                        submitting ||
                        refreshing ||
                        (item.kind === 'series' &&
                          (sonarrChecking || sonarr?.status !== 'ready')),
                    )}
                  </View>
                ))
              )}
              <View style={styles.panel}>
                <View style={styles.resultHeading}>
                  <Text accessibilityRole="header" style={styles.subtitle}>
                    Request status
                  </Text>
                  {button(
                    refreshing ? 'Refreshing...' : 'Refresh statuses',
                    () => void refresh(),
                    refreshing || submitting,
                  )}
                </View>
                <Text style={styles.small}>
                  Provider complete means the provider has all files. Shinema
                  indexing and playback availability are separate. Requested
                  titles may still need operator action.
                </Text>
                {records.length === 0 ? (
                  <Text style={styles.empty}>
                    No requests yet. Your first request will appear here.
                  </Text>
                ) : (
                  records.map((item) => (
                    <View key={item.id} style={styles.record}>
                      <View style={styles.resultHeading}>
                        <Text style={styles.resultTitle}>
                          {item.title}
                          {item.year ? ` (${item.year})` : ''}
                        </Text>
                        <Text style={styles.badge}>
                          {statusLabel[item.status]}
                        </Text>
                      </View>
                      <Text style={styles.small}>
                        {item.kind === 'movie' ? 'Movie' : 'Series'}
                      </Text>
                      {item.message && (
                        <Text style={styles.small}>{item.message}</Text>
                      )}
                      {item.status === 'uncertain' && (
                        <Text style={styles.small}>
                          Refresh and ask your server operator to review before
                          submitting again.
                        </Text>
                      )}
                    </View>
                  ))
                )}
                <Text style={styles.small}>
                  Requests add titles to the provider list. No automatic search
                  starts.
                </Text>
              </View>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sonarr: {
    borderWidth: 1,
    borderColor: '#435446',
    borderRadius: 6,
    padding: 15,
    gap: 8,
  },
  sonarrWarning: { borderColor: '#886b4b' },
  sonarrPolicy: {
    color: '#e5ecd9',
    borderLeftWidth: 2,
    borderColor: '#b6cba5',
    paddingLeft: 14,
    fontSize: 16,
    lineHeight: 25,
  },
  screen: { flex: 1 },
  content: {
    paddingBottom: 36,
    gap: 14,
    maxWidth: 1000,
    width: '100%',
    alignSelf: 'center',
  },
  heading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 6,
  },
  eyebrow: { color: '#b6cba5', fontSize: 11, letterSpacing: 1.8 },
  title: { color: '#f3f2e9', fontSize: 36, fontWeight: '500' },
  subtitle: {
    color: '#f3f2e9',
    fontSize: 24,
    fontWeight: '500',
    flexShrink: 1,
  },
  copy: { color: '#b9c4b6', fontSize: 16, lineHeight: 25 },
  small: { color: '#a4b29f', fontSize: 13, lineHeight: 22 },
  panel: {
    backgroundColor: '#1c261f',
    borderWidth: 1,
    borderColor: '#344237',
    padding: 24,
    borderRadius: 10,
    gap: 17,
  },
  label: { color: '#f3f2e9', fontSize: 15 },
  input: {
    backgroundColor: '#131d17',
    borderWidth: 1,
    borderColor: '#435446',
    color: '#f3f2e9',
    padding: 14,
    borderRadius: 6,
    fontSize: 18,
  },
  actions: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  button: {
    borderWidth: 2,
    borderColor: '#475c48',
    borderRadius: 6,
    paddingHorizontal: 19,
    paddingVertical: 13,
    alignSelf: 'flex-start',
    minHeight: 48,
  },
  primary: { backgroundColor: '#dce7c5', borderColor: '#dce7c5' },
  buttonText: { color: '#e5ecd9', fontSize: 16, fontWeight: '500' },
  primaryText: { color: '#1c271f' },
  focus: { borderColor: '#7ce8cb', borderWidth: 2 },
  disabled: { opacity: 0.5 },
  error: {
    color: '#ebc49b',
    borderWidth: 1,
    borderColor: '#886b4b',
    padding: 16,
    borderRadius: 6,
    fontSize: 15,
    lineHeight: 23,
  },
  notice: {
    color: '#c4dcb1',
    borderWidth: 1,
    borderColor: '#536c47',
    padding: 16,
    borderRadius: 6,
    fontSize: 15,
    lineHeight: 23,
  },
  empty: {
    color: '#a4b29f',
    padding: 26,
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 24,
  },
  result: {
    padding: 23,
    borderBottomWidth: 1,
    borderColor: '#344237',
    gap: 15,
  },
  resultHeading: {
    flexDirection: 'row',
    gap: 15,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  resultTitle: { color: '#f3f2e9', fontSize: 19, flexShrink: 1 },
  badge: {
    color: '#d1dec5',
    borderWidth: 1,
    borderColor: '#52664a',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 12,
  },
  record: { borderTopWidth: 1, borderColor: '#344237', paddingTop: 17, gap: 8 },
});
