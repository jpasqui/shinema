import { useState } from 'react';
import type { Progress } from '../../../packages/contracts/index.ts';
import { Artwork } from './Artwork.tsx';

export type Featured = {
  title: string;
  backdropPath?: string;
  posterPath?: string;
  summary?: string;
  year?: number;
  genres?: string[];
  container?: string;
};
export type FeatureProps = {
  item?: Featured;
  onOpen: () => void;
  progress?: Progress;
  demo?: boolean;
  loading?: boolean;
};
export function MarqueeHero({
  item,
  onOpen,
  progress,
  demo = false,
  loading = false,
}: FeatureProps) {
  const [loaded, setLoaded] = useState('');
  const [failed, setFailed] = useState('');
  const pending = loading && !item;
  const source = item?.backdropPath ?? item?.posterPath;
  const title = item
    ? demo
      ? item.title.replace(/^Generated /, '')
      : item.title
    : '';
  const kind = demo
    ? Math.max(
        0,
        ['Orbit', 'Horizon', 'Pulse'].findIndex((value) =>
          item?.title.includes(value),
        ),
      )
    : 0;
  return (
    <section
      className="feature marquee-feature"
      aria-label="Featured title"
      aria-busy={pending || undefined}
      data-testid="library-feature"
      data-feature-loading={pending || undefined}
    >
      <div className="hero-backdrop" aria-hidden="true">
        <div className="hero-artwork-fallback" />
        {demo && item ? (
          <Artwork kind={kind} wide />
        ) : source && failed !== source ? (
          <img
            key={source}
            className={loaded === source ? 'artwork-loaded' : ''}
            src={source}
            alt=""
            width="1600"
            height="900"
            loading="eager"
            decoding="async"
            fetchPriority="high"
            onLoad={() => setLoaded(source)}
            onError={() => setFailed(source)}
          />
        ) : null}
      </div>
      <div className="feature-shade" />
      <div className="feature-copy">
        <p className="feature-label">
          {progress?.positionSeconds
            ? 'CONTINUE YOUR EVENING'
            : 'YOUR PERSONAL PICTURE HOUSE'}
        </p>
        <h2 title={title} aria-hidden={pending || undefined}>
          {pending ? (
            <span className="feature-skeleton-line" />
          ) : (
            title || 'Your collection'
          )}
        </h2>
        <p className="feature-meta">
          {pending ? (
            <span className="feature-skeleton-line" aria-hidden="true" />
          ) : demo ? (
            'Generated sample · 1 min'
          ) : (
            [
              item?.year,
              item?.genres?.slice(0, 2).join(' · ') ||
                item?.container?.toUpperCase(),
            ]
              .filter(Boolean)
              .join(' · ') || 'From your collection'
          )}
        </p>
        <p className="hero-summary" aria-hidden={!item?.summary || undefined}>
          {pending ? (
            <span className="feature-skeleton-line" />
          ) : (
            item?.summary || '\u00a0'
          )}
        </p>
        <div className="feature-actions">
          <button className="primary" onClick={onOpen} disabled={!item}>
            View details <span aria-hidden="true">→</span>
          </button>
          <span className="hero-footnote">
            {progress?.positionSeconds
              ? 'Your place, remembered.'
              : 'A collection of your own.'}
          </span>
        </div>
      </div>
    </section>
  );
}
