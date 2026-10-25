import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  cueTextAt,
  defaultSubtitle,
  parseVtt,
  type Cue,
  type Media,
  type Playback,
  type SubtitleTrack,
} from '../../../../packages/core/src/index.ts';
import { useConnected } from '../connection';
import { Button } from '../kit/Button';
import { Focusable } from '../kit/Focusable';
import { Message, Screen } from '../kit/Screen';
import { Text } from '../kit/Text';
import { colors, isTV, space } from '../kit/theme';
import { useNavigation } from '../navigation';
import { useRemote } from '../platform/remote';
import { useEngine } from '../player/engine';
import { SeekTarget } from '../player/seek';

const SAVE_EVERY_MS = 10000;
const FLUSH_EVERY_MS = 60000;
const SEEK_STEP = 10;

const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

export function PlayerScreen({
  media,
  start,
}: {
  media: Media;
  start: number;
}) {
  const { api } = useConnected();
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const navigation = useNavigation();

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api
      .playback(media.id, controller.signal)
      .then(setPlayback)
      .catch((problem: Error & { kind?: string }) => {
        if (controller.signal.aborted) return;
        setError(
          problem.kind === 'conflict'
            ? 'This file changed on the server. Go back and open it again.'
            : 'This title could not be prepared for playback.',
        );
      });
    return () => controller.abort();
  }, [api, media.id, attempt]);

  if (error)
    return (
      <Screen>
        <Message
          title="Playback could not start"
          detail={error}
          action={{
            label: 'Try again',
            onPress: () => setAttempt((value) => value + 1),
          }}
        />
        <View style={{ alignItems: 'center', paddingBottom: space.xl }}>
          <Button
            label="Back"
            kind="secondary"
            onPress={() => navigation.back()}
          />
        </View>
      </Screen>
    );
  if (!playback)
    return (
      <Screen>
        <Message title="Starting playback" loading />
      </Screen>
    );
  return (
    <Video
      key={attempt}
      media={media}
      playback={playback}
      start={start}
      onFailed={(message) => setError(message)}
    />
  );
}

function Video({
  media,
  playback,
  start,
  onFailed,
}: {
  media: Media;
  playback: Playback;
  start: number;
  onFailed: (message: string) => void;
}) {
  useKeepAwake();
  const { api, progress } = useConnected();
  const seek = useRef(new SeekTarget()).current;
  const [time, setTime] = useState(start);
  const [controlsUntil, setControlsUntil] = useState(Date.now() + 4000);
  const [menu, setMenu] = useState(false);
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [trackId, setTrackId] = useState('');
  const [cues, setCues] = useState<Cue[]>([]);
  const started = useRef(false);
  const lastSave = useRef(Date.now());
  const lastFlush = useRef(Date.now());
  const duration = playback.durationSeconds;

  const source = useMemo(
    () => ({
      uri: api.mediaUrl(playback.streamPath),
      hls: playback.mode === 'transcode',
      title: media.title,
    }),
    [api, playback, media.title],
  );
  // Progress is recorded every 10 seconds and sent to the server every minute.
  const engine = useEngine(source, (currentTime) => {
    setTime(currentTime);
    const now = Date.now();
    if (!started.current || now - lastSave.current < SAVE_EVERY_MS) return;
    lastSave.current = now;
    if (!(duration > 0)) return;
    progress.record(media.id, seek.current(currentTime, now), duration);
    if (now - lastFlush.current >= FLUSH_EVERY_MS) {
      lastFlush.current = now;
      void progress
        .persist()
        .then(() => progress.flush(api))
        .catch(() => {});
    }
  });
  const latestEngine = useRef(engine);
  latestEngine.current = engine;

  // Jump to the resume point once the stream is ready.
  useEffect(() => {
    if (engine.status === 'ready' && !started.current) {
      started.current = true;
      if (start > 0) engine.seek(start);
    }
    if (engine.status === 'error')
      onFailed(
        'The player could not play this file. It may use a format this device cannot decode.',
      );
  }, [engine, start, onFailed]);

  // Save and sync when leaving the player, including via Back.
  useEffect(
    () => () => {
      if (!started.current || !(duration > 0)) return;
      progress.record(
        media.id,
        seek.current(latestEngine.current.currentTime()),
        duration,
      );
      void progress
        .persist()
        .then(() => progress.flush(api))
        .catch(() => {});
    },
    [api, progress, seek, media.id, duration],
  );

  // Subtitles: pick the default track, then load its cues.
  useEffect(() => {
    const controller = new AbortController();
    api
      .subtitles(media.id, controller.signal)
      .then((value) => {
        const usable = value.tracks.filter((track) => track.contentPath);
        setTracks(usable);
        const languages =
          typeof navigator !== 'undefined' && navigator.languages
            ? [...navigator.languages]
            : [];
        setTrackId(defaultSubtitle(usable, languages));
      })
      .catch(() => setTracks([]));
    return () => controller.abort();
  }, [api, media.id]);

  useEffect(() => {
    const track = tracks.find((item) => item.id === trackId);
    setCues([]);
    if (!track?.contentPath) return;
    const controller = new AbortController();
    fetch(api.mediaUrl(track.contentPath), { signal: controller.signal })
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => setCues(parseVtt(text)))
      .catch(() => {});
    return () => controller.abort();
  }, [api, tracks, trackId]);

  const showControls = () => setControlsUntil(Date.now() + 4000);
  const toggle = () => {
    if (engine.playing) engine.pause();
    else engine.play();
    showControls();
  };
  const jump = (delta: number) => {
    const target = seek.step(engine.currentTime(), duration, delta);
    engine.seek(target);
    setTime(target);
    showControls();
  };

  useRemote((key) => {
    if (menu) {
      if (key === 'back') {
        setMenu(false);
        return true;
      }
      return false; // let focus move through the subtitle menu
    }
    switch (key) {
      case 'left':
      case 'right':
        jump(key === 'left' ? -SEEK_STEP : SEEK_STEP);
        return true;
      case 'select':
      case 'playPause':
        toggle();
        return true;
      case 'up':
        if (tracks.length) setMenu(true);
        showControls();
        return true;
      case 'down':
        showControls();
        return true;
      default:
        return false;
    }
  });

  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const controlsVisible = !engine.playing || menu || Date.now() < controlsUntil;
  const shown = seek.current(time);
  const caption = cueTextAt(cues, time);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {engine.surface}
      {/* Holds TV focus so remote keys reach the player; a tap shows controls. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={engine.playing ? 'Pause' : 'Play'}
        hasTVPreferredFocus={!menu}
        focusable={isTV && !menu}
        onPress={isTV ? toggle : showControls}
        style={{ position: 'absolute', inset: 0 }}
      />
      {caption ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: space.gutter,
            right: space.gutter,
            bottom: controlsVisible ? 180 : space.xl,
            alignItems: 'center',
          }}
        >
          <Text
            variant="subtitle"
            style={{
              textAlign: 'center',
              backgroundColor: 'rgba(0,0,0,0.65)',
              paddingHorizontal: space.sm,
              paddingVertical: 2,
            }}
          >
            {caption}
          </Text>
        </View>
      ) : null}
      {engine.status === 'loading' ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: space.lg, right: space.gutter }}
        >
          <Text variant="caption" muted>
            Loading…
          </Text>
        </View>
      ) : null}
      {controlsVisible ? (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: space.gutter,
            paddingTop: space.lg,
            backgroundColor: colors.scrim,
            gap: space.sm,
          }}
        >
          <Text variant="title" numberOfLines={1}>
            {media.title}
          </Text>
          <View
            style={{
              height: 4,
              backgroundColor: colors.track,
              borderRadius: 2,
            }}
          >
            <View
              style={{
                width: `${duration > 0 ? Math.min(100, (shown / duration) * 100) : 0}%`,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.accent,
              }}
            />
          </View>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: space.md,
            }}
          >
            <Text variant="caption">
              {clock(shown)} / {clock(duration)}
            </Text>
            {isTV ? (
              <Text variant="caption" muted>
                {engine.playing ? 'OK to pause' : 'OK to play'} · ◀ ▶ 10 seconds
                {tracks.length ? ' · ▲ subtitles' : ''}
              </Text>
            ) : (
              // Mouse and touch need visible controls; TVs use the remote.
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button
                  label="Back 10 s"
                  kind="secondary"
                  onPress={() => jump(-SEEK_STEP)}
                />
                <Button
                  label={engine.playing ? 'Pause' : 'Play'}
                  onPress={toggle}
                />
                <Button
                  label="Forward 10 s"
                  kind="secondary"
                  onPress={() => jump(SEEK_STEP)}
                />
                {tracks.length ? (
                  <Button
                    label="Subtitles"
                    kind="secondary"
                    onPress={() => setMenu(true)}
                  />
                ) : null}
              </View>
            )}
          </View>
        </View>
      ) : null}
      {menu ? (
        <View
          style={{
            position: 'absolute',
            right: space.gutter,
            bottom: 160,
            width: 300,
            padding: space.md,
            gap: space.xs,
            backgroundColor: colors.surface,
            borderRadius: 8,
          }}
        >
          <Text variant="heading" muted>
            Subtitles
          </Text>
          {[{ id: '', label: 'Off' }, ...tracks].map((track, index) => (
            <Focusable
              key={track.id || 'off'}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: track.id === trackId }}
              preferred={track.id === trackId || (index === 0 && !trackId)}
              onPress={() => {
                setTrackId(track.id);
                setMenu(false);
              }}
              style={{ paddingHorizontal: space.sm, paddingVertical: 8 }}
            >
              <Text variant="label">
                {track.id === trackId ? '✓ ' : '   '}
                {track.label}
              </Text>
            </Focusable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
