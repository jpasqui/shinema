import { useState } from 'react';
export function MediaPoster({
  source,
  title,
  large = false,
}: {
  source?: string;
  title: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState<string | undefined>();
  return (
    <div
      className={`poster real-poster${large ? ' large' : ''}`}
      aria-hidden="true"
    >
      {source && source !== failed ? (
        <img
          src={source}
          loading={large ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(source)}
          alt=""
        />
      ) : (
        <div className="poster-unavailable">
          <span aria-hidden="true">▱</span>
          <span>{title}</span>
        </div>
      )}
    </div>
  );
}
