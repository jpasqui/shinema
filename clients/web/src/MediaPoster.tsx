import { useState } from 'react';
export function MediaPoster({
  source,
  title,
  large = false,
  loading = false,
  priority = false,
}: {
  source?: string;
  title: string;
  large?: boolean;
  loading?: boolean;
  priority?: boolean;
}) {
  const [failed, setFailed] = useState<string | undefined>();
  const [loaded, setLoaded] = useState<string | undefined>();
  return (
    <div
      className={`poster real-poster${large ? ' large' : ''}${loading ? ' is-loading' : ''}`}
      aria-hidden="true"
      data-artwork-state={
        loading
          ? 'loading'
          : source && source === loaded
            ? 'loaded'
            : source && source === failed
              ? 'failed'
              : source
                ? 'loading'
                : 'missing'
      }
    >
      {source && source !== failed ? (
        <img
          className={loaded === source ? 'artwork-loaded' : ''}
          src={source}
          loading={large || priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : undefined}
          width="600"
          height="900"
          decoding="async"
          onError={() => setFailed(source)}
          onLoad={() => setLoaded(source)}
          alt=""
        />
      ) : (
        <div className="poster-unavailable">
          <span className="poster-placeholder-icon" aria-hidden="true">
            <svg
              viewBox="0 0 48 48"
              width="40"
              height="40"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              focusable="false"
            >
              <path d="M14 14h27l-7 20H7Z" />
            </svg>
          </span>
          <span>{loading ? '\u00a0' : title}</span>
        </div>
      )}
    </div>
  );
}
