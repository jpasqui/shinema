import logo from './tmdb-logo.svg';
export function MetadataCredits() {
  return (
    <details className="metadata-credits">
      <summary>Metadata credits</summary>
      <p>Local files remain browsable when provider metadata is unavailable.</p>
      <p>
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
          <img src={logo} alt="TMDB" width="100" />
        </a>
      </p>
      <p>
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>
      <p>
        <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer">
          TVmaze
        </a>{' '}
        data is available under{' '}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noreferrer"
        >
          CC BY-SA
        </a>
        . Source links accompany matched titles.
      </p>
    </details>
  );
}
