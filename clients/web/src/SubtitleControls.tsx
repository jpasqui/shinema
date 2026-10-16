import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  defaultSubtitle,
  parseSubtitles,
} from '../../../packages/contracts/index.ts';
import type { Subtitles } from '../../../packages/contracts/index.ts';
import {
  subtitleContent,
  subtitleManifest,
  SubtitlePreferences,
} from './subtitles.ts';

const preferences = new SubtitlePreferences();

export function SubtitleControls({
  mediaId,
  video,
}: {
  mediaId: string;
  video: RefObject<HTMLVideoElement | null>;
}) {
  const [info, setInfo] = useState<Subtitles>({ tracks: [] });
  const [selected, setSelected] = useState(
    () => preferences.get(mediaId) ?? '',
  );
  const [automatic, setAutomatic] = useState(
    () => preferences.get(mediaId) === undefined,
  );
  const [loading, setLoading] = useState(true);
  const [loadingTrack, setLoadingTrack] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const chosen = useRef(preferences.get(mediaId) !== undefined);
  const managed = useRef<HTMLTrackElement | null>(null);
  useEffect(() => {
    const node = video.current;
    if (!node) return;
    const disableEmbedded = () => {
      for (const track of node.textTracks)
        if (track !== managed.current?.track) track.mode = 'disabled';
    };
    disableEmbedded();
    node.textTracks.addEventListener('addtrack', disableEmbedded);
    node.addEventListener('loadedmetadata', disableEmbedded);
    return () => {
      node.textTracks.removeEventListener('addtrack', disableEmbedded);
      node.removeEventListener('loadedmetadata', disableEmbedded);
    };
  }, [video]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const result = parseSubtitles(
          await subtitleManifest(
            `/api/media/${mediaId}/subtitles`,
            controller.signal,
          ),
          mediaId,
        );
        if (controller.signal.aborted) return;
        setInfo(result);
        if (!chosen.current)
          setSelected(defaultSubtitle(result.tracks, navigator.languages));
        else
          setSelected((id) =>
            result.tracks.some((track) => track.id === id && track.contentPath)
              ? id
              : '',
          );
      } catch {
        if (!controller.signal.aborted)
          setError('Subtitles could not be loaded. Playback can continue.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [mediaId, retry]);
  const track = info.tracks.find(
    (track) => track.id === selected && track.contentPath,
  );
  useEffect(() => {
    const node = video.current;
    if (!node || !track?.contentPath) {
      setLoadingTrack(false);
      return;
    }
    const controller = new AbortController();
    let element: HTMLTrackElement | undefined;
    let url: string | undefined;
    setLoadingTrack(true);
    setError('');
    void (async () => {
      try {
        const content = await subtitleContent(
          track.contentPath!,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
        element = document.createElement('track');
        element.kind = 'subtitles';
        element.label = track.label;
        element.srclang = track.language ?? 'und';
        element.src = url;
        managed.current = element;
        element.addEventListener('load', () => {
          if (controller.signal.aborted || !element) return;
          element.track.mode = 'showing';
          setLoadingTrack(false);
        });
        element.addEventListener('error', () => {
          if (!controller.signal.aborted) {
            setLoadingTrack(false);
            setError(
              'This subtitle track could not be displayed. Choose another track or retry.',
            );
          }
        });
        node.append(element);
        element.track.mode = 'hidden';
      } catch {
        if (!controller.signal.aborted) {
          setLoadingTrack(false);
          setError(
            'This subtitle track could not be loaded. Choose another track or retry.',
          );
        }
      }
    })();
    return () => {
      controller.abort();
      if (element) {
        element.track.mode = 'disabled';
        element.remove();
      }
      managed.current = null;
      if (url) URL.revokeObjectURL(url);
    };
  }, [track, video, retry]);
  return (
    <section className="subtitle-controls" aria-label="Subtitle controls">
      <label>
        Subtitles{' '}
        <select
          aria-label="Subtitles"
          value={automatic ? 'automatic' : selected}
          onChange={(event) => {
            const auto = event.target.value === 'automatic';
            chosen.current = !auto;
            setAutomatic(auto);
            preferences.set(mediaId, auto ? undefined : event.target.value);
            setError('');
            setSelected(
              auto
                ? defaultSubtitle(info.tracks, navigator.languages)
                : event.target.value,
            );
          }}
        >
          <option value="automatic">Auto: default / browser language</option>
          <option value="">Off</option>
          {info.tracks.map((track) => (
            <option
              key={track.id}
              value={track.id}
              disabled={!track.contentPath}
            >
              {track.label}
              {track.default ? ' (default)' : ''}
              {track.unsupportedReason ? ` — ${track.unsupportedReason}` : ''}
            </option>
          ))}
        </select>
      </label>
      <span className="quiet" role="status">
        {loading
          ? 'Finding subtitle tracks…'
          : loadingTrack
            ? 'Loading subtitles…'
            : error ||
              (info.tracks.length
                ? selected
                  ? automatic
                    ? `Auto: ${track?.label ?? 'Subtitles ready'}`
                    : 'Subtitles ready'
                  : 'Subtitles Off'
                : 'No subtitle tracks found.')}
      </span>
      {error && (
        <button
          className="control-button"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry subtitles
        </button>
      )}
      {info.warnings?.map((warning) => (
        <p className="quiet" key={warning}>
          {warning}
        </p>
      ))}
    </section>
  );
}
