import type { ReactNode } from 'react';
import { useAppearance } from './Appearance.tsx';
import { MarqueeHero } from './MarqueeHero.tsx';
import type { FeatureProps } from './MarqueeHero.tsx';
import { MediaPoster } from './MediaPoster.tsx';
import { Artwork } from './Artwork.tsx';

function ArchiveProgramme({
  item,
  onOpen,
  progress,
  demo = false,
  loading = false,
  disabled = false,
}: FeatureProps) {
  const pending = loading && !item;
  const title = item
    ? demo
      ? item.title.replace(/^Generated /, '')
      : item.title
    : '';
  return (
    <section
      className="archive-programme"
      aria-label="Featured title"
      aria-busy={loading || undefined}
      data-testid="library-feature"
      data-feature-loading={pending || undefined}
    >
      <div className="programme-folio">
        <span>YOUR COLLECTION / THE EVENING PROGRAMME</span>
        <span>01</span>
      </div>
      <div className="programme-body">
        <div className="programme-copy">
          <p className="eyebrow">
            {progress?.positionSeconds
              ? 'A STORY TO RETURN TO'
              : 'FROM YOUR COLLECTION'}
          </p>
          <h2 title={title} aria-hidden={pending || undefined}>
            {pending ? (
              <span className="feature-skeleton-line" />
            ) : (
              title || 'Your collection'
            )}
          </h2>
          <p className="programme-meta">
            {pending ? (
              <span className="feature-skeleton-line" aria-hidden="true" />
            ) : (
              [
                item?.year,
                item?.genres?.join(' / ') || item?.container?.toUpperCase(),
              ]
                .filter(Boolean)
                .join(' / ') || 'Your personal picture house'
            )}
          </p>
          <p className="programme-summary">
            {pending ? (
              <span className="feature-skeleton-line" aria-hidden="true" />
            ) : (
              item?.summary ||
              'Choose a title and settle in. Your collection is ready when you are.'
            )}
          </p>
          <button
            className="primary"
            onClick={onOpen}
            disabled={!item || disabled}
          >
            View details <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="programme-poster">
          {demo && item ? (
            <div className="poster">
              <Artwork kind={0} />
            </div>
          ) : (
            <MediaPoster
              source={item?.posterPath ?? item?.backdropPath}
              title={title}
              loading={pending}
              priority
            />
          )}
        </div>
      </div>
    </section>
  );
}

// Only trusted React components are registered. Imported themes select a key;
// they never supply a module, render function, template or resource URL.
const features = { marquee: MarqueeHero, archive: ArchiveProgramme };
export function LibraryFeature(props: FeatureProps) {
  const { theme } = useAppearance();
  const Feature = features[theme.design.skin];
  return <Feature {...props} />;
}
export function SkinHeader({ children }: { children: ReactNode }) {
  const { theme } = useAppearance();
  return (
    <header className={`header header--${theme.design.skin}`}>
      {children}
      {theme.design.skin === 'archive' && (
        <span className="header-folio" aria-hidden="true">
          THE PERSONAL PICTURE HOUSE
        </span>
      )}
    </header>
  );
}
export function DetailPresentation({
  artwork,
  children,
}: {
  artwork: ReactNode;
  children: ReactNode;
}) {
  const { theme } = useAppearance();
  return theme.design.skin === 'archive' ? (
    <div className="detail-layout archive-detail-layout">
      <figure className="detail-programme-poster">
        {artwork}
        <figcaption>A title from your collection.</figcaption>
      </figure>
      <div className="detail-programme-copy">{children}</div>
    </div>
  ) : (
    <div className="detail-layout">
      {artwork}
      {children}
    </div>
  );
}
