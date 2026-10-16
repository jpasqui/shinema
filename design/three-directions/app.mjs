const params = new URLSearchParams(location.search);
const option = ['marquee', 'archive', 'signal'].includes(params.get('option'))
  ? params.get('option')
  : 'marquee';
let view = ['home', 'library', 'detail', 'series', 'player'].includes(
  params.get('view'),
)
  ? params.get('view')
  : 'home';
let state = ['loading', 'empty'].includes(params.get('state'))
  ? params.get('state')
  : 'ready';
const films = [
  {
    title: 'The Last Latitude',
    subtitle: 'Beyond the edge of the map.',
    type: 'FILM',
    year: '2025',
    genre: 'Adventure',
    duration: '1h 48m',
    art: 0,
    progress: 38,
    description:
      'A cartographer follows a forgotten route into the far north. In a landscape without borders, she discovers what it means to find her way home.',
  },
  {
    title: 'Night Transit',
    subtitle: 'Every city has another side.',
    type: 'SERIES',
    year: '2025',
    genre: 'Thriller',
    duration: '8 episodes',
    art: 1,
    progress: 64,
    description:
      'The last train has left. A night-shift detective and a missing passenger unravel the stories a city keeps after dark.',
  },
  {
    title: 'Summer, Elsewhere',
    subtitle: 'Some places stay with you.',
    type: 'FILM',
    year: '2024',
    genre: 'Drama',
    duration: '1h 36m',
    art: 2,
    progress: 0,
    description:
      'An unexpected letter brings two old friends back to the coast where they spent a summer that changed everything.',
  },
  {
    title: 'Red Horizon',
    subtitle: 'A world waiting to be found.',
    type: 'FILM',
    year: '2025',
    genre: 'Sci-fi',
    duration: '2h 06m',
    art: 3,
    progress: 0,
    description:
      'Alone on an uncharted planet, an explorer begins receiving transmissions from a place that should not exist.',
  },
  {
    title: 'After Hours',
    subtitle: 'One night. Every note.',
    type: 'FILM',
    year: '2023',
    genre: 'Documentary',
    duration: '1h 24m',
    art: 4,
    progress: 0,
    description:
      'An intimate portrait of the musicians, rooms and late-night conversations that keep a city’s jazz scene alive.',
  },
  {
    title: 'Evergreen',
    subtitle: 'The forest remembers.',
    type: 'SERIES',
    year: '2024',
    genre: 'Mystery',
    duration: '6 episodes',
    art: 5,
    progress: 0,
    description:
      'A forest ranger returns to her childhood town as a familiar cabin appears in a place it has never stood before.',
  },
];
let selected = view === 'series' ? 1 : 0;
let selectedFocus = null;
let browseView = 'home';
let filter = '';
let typeFilter = 'all';
let episode = 2;
const episodeTitles = [
  'The last train',
  'A familiar stranger',
  'The city below',
];
let quality = 'Auto \u00b7 Direct play';
let savedOnly = false;
const saved = new Set([3]);
let paused = true;
let seconds = 41 * 60;
let subtitles = 'English';
let audio = 'English · 5.1';
let season = 1;
let sheet = null;
const app = document.querySelector('#app');
document.body.className = option;
const paths = {
  play: '<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  home: '<path d="m3 10 9-7 9 7v10H3zM9 20v-7h6v7"/>',
  library:
    '<rect x="4" y="4" width="6" height="16" rx="1"/><path d="M14 4h6v16h-6zM7 8v4M17 8v4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  captions:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 9H6v6h4M18 9h-4v6h4"/>',
  volume:
    '<path d="M3 9h4l5-5v16l-5-5H3zM16 8a6 6 0 0 1 0 8M19 4a11 11 0 0 1 0 16"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/>',
  rewind: '<path d="m11 7-7 5 7 5zM20 7l-7 5 7 5z"/>',
  forward: '<path d="m4 7 7 5-7 5zM13 7l7 5-7 5z"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.play}</svg>`;
}
function art(index, classes = '') {
  return `<div class="art art-${index} ${classes}" role="img" aria-label="Original fictional ${films[index].title} key art"></div>`;
}
function btn(
  label,
  action,
  { primary = false, symbol = '', extra = '', id = '' } = {},
) {
  return `<button ${id ? `data-focus="${id}"` : ''} class="action ${primary ? 'primary' : ''} ${extra}" data-action="${action}">${symbol ? icon(symbol) : ''}<span>${label}</span></button>`;
}
function brand() {
  return '<span class="brand"><span class="brand-mark">s</span> shinema<span class="brand-dot">.</span></span>';
}
function nav() {
  return `<nav class="navigation" aria-label="Main navigation">${brand()}<div class="nav-links">${[
    ['home', 'Home', 'home'],
    ['library', 'Movies', 'library'],
    ['series', 'Shows', 'play'],
    ['saved', 'My list', 'plus'],
  ]
    .map(
      ([action, title, symbol]) =>
        `<button class="nav-item ${view === action || (action === 'home' && view === 'detail') || (action === 'saved' && savedOnly) ? 'active' : ''}" data-action="${action}" data-focus="nav-${action}">${icon(symbol)}<span>${title}</span></button>`,
    )
    .join(
      '',
    )}</div><div class="nav-end"><button class="icon-button" aria-label="Search library" data-action="search">${icon('search')}</button><span class="profile" aria-label="Demo viewer profile">J</span></div></nav>`;
}
function meta(film, detailed = false) {
  return `<div class="meta"><span>${film.year}</span><span class="rating">${film.type === 'SERIES' ? 'TV-14' : '12'}</span><span>${film.duration}</span><span>${film.genre}</span>${detailed ? '<span class="quality">4K</span><span class="quality">HDR</span>' : ''}</div>`;
}
function actions(film) {
  return `<div class="actions">${btn(film.progress ? `Resume${option === 'signal' ? ' · 41:00' : ''}` : 'Play film', 'play', { primary: true, symbol: 'play', id: 'primary' })}${btn(saved.has(selected) ? 'In my list' : 'My list', 'save', { symbol: saved.has(selected) ? 'check' : 'plus', id: 'save' })}</div>`;
}
function poster(film, index, landscape = false) {
  return `<button class="poster ${landscape ? 'landscape' : ''}" data-action="select-${index}" data-focus="film-${index}" aria-label="${film.title}, ${film.year}${film.progress ? ', continue watching' : ''}"><div class="poster-image">${art(index)}<span class="poster-type">${film.type === 'SERIES' ? 'SERIES' : 'SHINEMA COLLECTION'}</span><span class="poster-title title-${index}">${film.title.replace('The Last ', 'The Last<br>')}</span>${film.progress ? `<span class="progress-track"><i style="width:${film.progress}%"></i></span>` : ''}</div><div class="poster-caption"><strong>${film.title}</strong><span>${film.progress ? (index === 1 ? 'S1 E3 · 18 min left' : '1h 07m left') : `${film.year} · ${film.genre}`}</span></div></button>`;
}
function rail(title, items = films.slice(0, 5), landscape = false) {
  return `<section class="rail"><div class="section-heading"><h2>${title}</h2><span>${landscape ? 'Pick up where you left off' : 'Your collection, ready to play'}</span></div><div class="posters ${landscape ? 'wide-posters' : ''}">${items.map((film) => poster(film, film.art, landscape)).join('')}</div></section>`;
}
function marqueeHome() {
  const film = films[0];
  return `<section class="hero">${art(0, 'hero-art')}<div class="hero-content"><div class="eyebrow">TONIGHT, GO SOMEWHERE ELSE</div><h1 class="cinema-title">The Last<br><em>Latitude</em></h1>${meta(film)}<p>${film.subtitle} A journey into the far north.</p><div class="actions">${btn('Continue watching', 'play', { primary: true, symbol: 'play', id: 'primary' })}${btn('View film', 'hero-detail', { id: 'detail' })}</div><div class="hero-pagination"><b>01</b><span></span>06</div></div><span class="hero-credit">A FILM BY ELENA NORTH</span></section>${rail('Continue your evening', films.slice(0, 4), true)}`;
}
function archiveHome() {
  return `<section class="archive-intro"><div><div class="eyebrow">THE PERSONAL PICTURE HOUSE / VOL. 01</div><h1>A good night.<br><em>A great film.</em></h1></div><div class="editor-note"><span class="issue">THE OCTOBER SELECTION</span><p>Faraway places.<br>Stories that bring us closer.</p><button data-action="hero-detail" class="text-button">Open the programme <span>↗</span></button></div></section><section class="catalogue"><div class="section-heading"><h2>On your shelf</h2><span>6 titles · A collection of your own</span></div><div class="posters">${films.map((film) => poster(film, film.art)).join('')}</div></section><div class="archive-footnote"><span>01 — The collection</span><span>Something worth coming back to.</span><span>CURATED BY YOU</span></div>`;
}
function signalList() {
  return `<aside class="signal-list"><div class="eyebrow">YOUR COLLECTION</div><div class="signal-list-heading"><h1>Find your next.</h1><span>06</span></div><div class="list-tabs"><button class="active" data-action="home">All titles</button><button data-action="saved">My list</button></div><div class="title-list">${films
    .filter((film) => !savedOnly || saved.has(film.art))
    .map(
      (film) =>
        `<button class="title-row ${selected === film.art ? 'selected' : ''}" data-preview="${film.art}" data-action="select-${film.art}" data-focus="row-${film.art}">${art(film.art)}<span><strong>${film.title}</strong><small>${film.type === 'SERIES' ? 'Series' : film.year} · ${film.genre}</small></span>${film.progress ? `<span class="row-progress">${film.progress}%</span>` : '<span class="row-arrow">↗</span>'}</button>`,
    )
    .join(
      '',
    )}</div><div class="remote-note">↑ ↓ Browse <span>→ Open title</span></div></aside>`;
}
function signalFeature() {
  const film = films[selected];
  return `<section class="signal-feature">${art(selected, 'feature-art')}<div class="feature-copy"><div class="eyebrow">${film.progress ? 'CONTINUE WATCHING' : 'IN YOUR COLLECTION'} <span>0${selected + 1} / 06</span></div><h2>${film.title}</h2>${meta(film, true)}<p>${film.description}</p>${actions(film)}<div class="signal-footer"><span>${film.progress ? '41:00 / 1:48:00' : 'Ready when you are'}</span><span>${film.type === 'SERIES' ? 'EPISODES AVAILABLE' : 'DIRECT PLAY AVAILABLE'}</span></div></div></section>`;
}
function signalHome() {
  return `<div class="signal-browser">${signalList()}${signalFeature()}</div>`;
}
function library() {
  const items = films.filter(
    (film) =>
      (!savedOnly || saved.has(film.art)) &&
      (typeFilter === 'all' ||
        film.type === (typeFilter === 'films' ? 'FILM' : 'SERIES')) &&
      film.title.toLowerCase().includes(filter.toLowerCase()),
  );
  return `<section class="library-page"><div class="eyebrow">YOUR PERSONAL PICTURE HOUSE</div><div class="library-heading"><h1>${savedOnly ? 'My list' : 'The collection'}<span>${String(items.length).padStart(2, '0')}</span></h1><button class="filter-button" data-action="search">${icon('search')} Find a title</button></div><div class="library-filters"><button class="${typeFilter === 'all' ? 'active' : ''}" data-action="all">All titles</button><button class="${typeFilter === 'films' ? 'active' : ''}" data-action="films">Films</button><button class="${typeFilter === 'shows-filter' ? 'active' : ''}" data-action="shows-filter">Shows</button><span>Title A–Z</span></div><div class="posters library-posters">${items.map((film) => poster(film, film.art)).join('')}</div>${!items.length ? '<p class="no-results">No matching titles. Try another search.</p>' : ''}</section>`;
}
function episodes() {
  return `<section class="episodes"><div class="section-heading"><h2>Episodes</h2><button class="season-button" data-action="season">Season ${season} <span>⌄</span></button></div><div class="episode-list">${[0, 1, 2].map((number) => `<button class="episode" data-action="episode-${number}" data-focus="episode-${number}">${art(1)}<span class="episode-index">0${number + 1}</span><span><strong>${episodeTitles[number]}</strong><small>${42 + number * 3} min <span>${number === 2 ? 'Continue watching' : 'Night Transit'}</span></small></span><span class="episode-play">${icon('play')}</span></button>`).join('')}</div></section>`;
}
function detail() {
  const film = films[selected];
  const show = view === 'series' || film.type === 'SERIES';
  return `<section class="detail-page ${show ? 'show-detail' : ''}">${art(selected, 'detail-backdrop')}<button class="back-button" data-action="back" data-focus="back">${icon('back')}<span>Back to collection</span></button><div class="detail-main"><div class="detail-poster">${art(selected)}<span class="poster-type">${film.type === 'SERIES' ? 'A SHINEMA SERIES' : 'A FILM BY ELENA NORTH'}</span><span class="poster-title">${film.title}</span></div><div class="detail-copy"><div class="eyebrow">${show ? 'SHINEMA SERIES / SEASON 01' : 'FROM YOUR COLLECTION'}</div><h1>${film.title}</h1>${meta(film, true)}<p class="tagline">${film.subtitle}</p><p class="synopsis">${film.description}</p>${actions(film)}<div class="detail-facts"><div><span>${show ? 'CREATED BY' : 'DIRECTOR'}</span><strong>${show ? 'Ren Sato' : 'Elena North'}</strong></div><div><span>${show ? 'SEASONS' : 'CAST'}</span><strong>${show ? '2 seasons · 16 episodes' : 'Mara Vale, Theo Rowan'}</strong></div><div><span>AVAILABLE IN</span><strong>English · Subtitles</strong></div></div></div></div>${show ? episodes() : `<div class="detail-bottom"><span class="thin-rule"></span><span>A story for a quiet evening.</span>${btn('Browse the collection', 'library', { extra: 'quiet' })}</div>`}</section>`;
}
function signalDetail() {
  const sections = [
    ['Overview', 'detail'],
    ...(films[selected].type === 'SERIES'
      ? [['Episodes', 'show-episodes']]
      : []),
    ['Audio & subtitles', 'captions'],
  ];
  return `<div class="signal-detail"><aside class="detail-sections"><button class="back-button" data-action="back">${icon('back')} Collection</button><div class="eyebrow">${films[selected].type}</div><h2>${films[selected].title}</h2>${sections.map(([label, action], index) => `<button class="section-row ${index === 0 ? 'active' : ''}" data-action="${action}">${label}<span>→</span></button>`).join('')}<span class="remote-note">← Collection · → Actions</span></aside><div class="signal-detail-content">${detail()}</div></div>`;
}
function formatTime(value) {
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
function player() {
  return `<section class="player-page">${art(selected, 'player-art')}<header class="player-header"><button class="back-button" data-action="back" data-focus="back">${icon('back')}<span>Back</span></button><span class="playing-label">NOW PLAYING</span>${brand()}</header><div class="frame-caption"><span>${paused ? 'Paused' : 'Playing'}</span><h1>${films[selected].title}</h1></div><div class="player-controls"><div class="player-title-row"><div><span class="eyebrow">${films[selected].type === 'SERIES' ? `S${season} E${episode + 1} · ${episodeTitles[episode].toUpperCase()}` : 'YOUR EVENING, UNINTERRUPTED'}</span><h2>${films[selected].title}</h2></div><span class="player-quality">${quality.startsWith('Auto') ? '4K <span>HDR</span>' : quality.split(' ')[0]} · ${paused ? 'Paused' : 'Playing'}</span></div><div class="timeline"><span class="time-current">${formatTime(seconds)}</span><input aria-label="Playback position" type="range" min="0" max="6480" value="${seconds}" style="--progress:${(seconds / 6480) * 100}%"/><span class="time-remaining">−${formatTime(6480 - seconds)}</span></div><div class="transport-row"><div class="transport-side"><span>01</span> <span>THE JOURNEY NORTH</span></div><div class="transport"><button class="icon-button" data-action="rewind" aria-label="Back 10 seconds">${icon('rewind')}<small>10</small></button><button class="play-control" data-action="toggle" data-focus="primary" aria-label="${paused ? 'Play' : 'Pause'}">${icon(paused ? 'play' : 'pause')}</button><button class="icon-button" data-action="forward" aria-label="Forward 10 seconds">${icon('forward')}<small>10</small></button></div><div class="player-settings"><button class="icon-button" data-action="audio" aria-label="Audio options">${icon('volume')}</button><button class="icon-button" data-action="captions" aria-label="Subtitle options">${icon('captions')}</button><button class="icon-button" data-action="settings" aria-label="Playback settings">${icon('settings')}</button></div></div><div class="player-hint">← → Seek 10 seconds <span>Space Play / pause</span><span>Esc Back to title</span></div></div></section>`;
}
function empty() {
  return `<section class="state-page"><div class="empty-art">${icon('library')}<span>01</span></div><div class="eyebrow">ROOM FOR YOUR STORIES</div><h1>A collection starts<br>with one great film.</h1><p>Your library will appear here when titles are added.<br>For now, explore a small collection we made for you.</p>${btn('Explore the demo collection', 'demo', { primary: true, symbol: 'play', id: 'primary' })}<span class="state-footnote">Nothing here yet. Plenty to look forward to.</span></section>`;
}
function loading() {
  return `<section class="loading-page" aria-busy="true" aria-label="Loading library"><div class="eyebrow">YOUR COLLECTION</div><h1>Setting the scene.</h1><p>Gathering your titles and artwork…</p><div class="loading-hero skeleton"></div><div class="loading-row">${Array.from({ length: 5 }, () => '<div class="skeleton"></div>').join('')}</div><div class="loading-status" role="status"><span></span>Loading your library</div></section>`;
}
function overlay() {
  if (!sheet) return '';
  let content;
  if (sheet === 'search')
    content = `<label class="search-label">Find something good.<input id="search-input" type="search" placeholder="Search your collection" value="${filter.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"/></label><p>Search the six fictional demo titles.</p>${btn('View results', 'search-submit', { primary: true, symbol: 'search' })}`;
  else {
    const values =
      sheet === 'captions'
        ? ['Off', 'English', 'English CC', 'Français']
        : sheet === 'audio'
          ? ['English · 5.1', 'English · Stereo', 'Audio description']
          : ['Auto · Direct play', '1080p · Compatible', '720p · Data saver'];
    content = `<h2>${sheet === 'captions' ? 'Subtitles' : sheet === 'audio' ? 'Audio' : 'Playback quality'}</h2><p>${sheet === 'captions' ? 'Make every word yours.' : 'Choose how you watch.'}</p><div class="sheet-options">${values.map((value, index) => `<button data-action="choice-${index}" aria-pressed="${value === (sheet === 'captions' ? subtitles : sheet === 'audio' ? audio : quality)}"><span>${value}</span>${value === (sheet === 'captions' ? subtitles : sheet === 'audio' ? audio : quality) ? icon('check') : ''}</button>`).join('')}</div><small>Preview setting · no media connection</small>`;
  }
  return `<div class="sheet-backdrop"><section class="sheet" role="dialog" aria-modal="true" aria-label="${sheet === 'captions' ? 'Subtitle options' : sheet === 'audio' ? 'Audio options' : sheet === 'search' ? 'Search library' : 'Playback settings'}"><button class="sheet-close icon-button" data-action="close" aria-label="Close options">✕</button>${content}</section></div>`;
}
function render(focus = 'primary') {
  const content =
    state === 'empty'
      ? empty()
      : state === 'loading'
        ? loading()
        : view === 'player'
          ? player()
          : view === 'library'
            ? library()
            : view === 'detail' || view === 'series'
              ? option === 'signal'
                ? signalDetail()
                : detail()
              : option === 'archive'
                ? archiveHome()
                : option === 'signal'
                  ? signalHome()
                  : marqueeHome();
  app.innerHTML = `<main class="screen view-${view} state-${state}">${view === 'player' ? '' : nav()}<div class="page-content">${content}</div><div class="toast" role="status" hidden></div>${overlay()}</main>`;
  requestAnimationFrame(() => {
    const target = sheet
      ? document.querySelector(
          sheet === 'search' ? '#search-input' : '.sheet-options button',
        )
      : document.querySelector(`[data-focus="${focus}"]`) ||
        document.querySelector('.poster, .title-row, .primary');
    target?.focus({ preventScroll: true });
  });
}
function openView(next) {
  view = next;
  state = 'ready';
  sheet = null;
  render();
}
function toast(message) {
  const element = document.querySelector('.toast');
  element.textContent = message;
  element.hidden = false;
  setTimeout(() => {
    element.hidden = true;
  }, 1800);
}
function handle(action) {
  if (action.startsWith('select-')) {
    browseView = view === 'library' ? 'library' : 'home';
    selectedFocus = `film-${action.slice(7)}`;
    if (option === 'signal' && view === 'home')
      selectedFocus = `row-${action.slice(7)}`;
    selected = Number(action.slice(7));
    openView(films[selected].type === 'SERIES' ? 'series' : 'detail');
  } else if (action === 'home' || action === 'library') {
    savedOnly = false;
    filter = '';
    typeFilter = 'all';
    openView(action);
  } else if (action === 'series') {
    selected = 1;
    openView('series');
  } else if (action === 'hero-detail') {
    selected = 0;
    openView('detail');
  } else if (action === 'detail') openView('detail');
  else if (action === 'play' || action.startsWith('episode-')) {
    if (view === 'home' && option !== 'signal') selected = 0;
    if (action.startsWith('episode-')) episode = Number(action.slice(8));
    paused = false;
    openView('player');
  } else if (action === 'toggle') {
    paused = !paused;
    render();
  } else if (action === 'rewind' || action === 'forward') {
    seconds = Math.min(
      6480,
      Math.max(0, seconds + (action === 'forward' ? 10 : -10)),
    );
    render();
  } else if (action === 'back') {
    if (sheet) {
      sheet = null;
      render();
    } else if (view === 'player')
      openView(films[selected].type === 'SERIES' ? 'series' : 'detail');
    else {
      view = browseView;
      render(selectedFocus);
    }
  } else if (action === 'save') {
    if (saved.has(selected)) saved.delete(selected);
    else saved.add(selected);
    render('save');
    toast(
      saved.has(selected) ? 'Added to your list' : 'Removed from your list',
    );
  } else if (action === 'saved') {
    savedOnly = true;
    openView('library');
  } else if (['captions', 'audio', 'settings', 'search'].includes(action)) {
    sheet = action;
    render();
  } else if (action === 'close') {
    sheet = null;
    render();
  } else if (action.startsWith('choice-')) {
    const index = Number(action.slice(7));
    if (sheet === 'captions')
      subtitles = ['Off', 'English', 'English CC', 'Français'][index];
    if (sheet === 'audio')
      audio = ['English · 5.1', 'English · Stereo', 'Audio description'][index];
    if (sheet === 'settings')
      quality = [
        'Auto \u00b7 Direct play',
        '1080p \u00b7 Compatible',
        '720p \u00b7 Data saver',
      ][index];
    sheet = null;
    render();
    toast('Preview preference updated');
  } else if (action === 'search-submit') {
    filter = document.querySelector('#search-input').value;
    savedOnly = false;
    typeFilter = 'all';
    openView('library');
  } else if (action === 'demo') {
    state = 'ready';
    openView('home');
  } else if (action === 'season') {
    season = season === 1 ? 2 : 1;
    render();
  } else if (action === 'show-episodes') {
    if (films[selected].type !== 'SERIES') return;
    openView('series');
    document.querySelector('.episodes')?.scrollIntoView({ block: 'end' });
  } else if (['all', 'films', 'shows-filter'].includes(action)) {
    typeFilter = action;
    render();
  }
}
app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) handle(target.dataset.action);
});
app.addEventListener('input', (event) => {
  if (event.target.type === 'range') {
    seconds = Number(event.target.value);
    event.target.style.setProperty('--progress', `${(seconds / 6480) * 100}%`);
    document.querySelector('.time-current').textContent = formatTime(seconds);
    document.querySelector('.time-remaining').textContent =
      `−${formatTime(6480 - seconds)}`;
  }
});
app.addEventListener('focusin', (event) => {
  const row = event.target.closest('[data-preview]');
  if (
    option !== 'signal' ||
    !row ||
    selected === Number(row.dataset.preview) ||
    view !== 'home'
  )
    return;
  selected = Number(row.dataset.preview);
  document
    .querySelectorAll('.title-row')
    .forEach((item) => item.classList.toggle('selected', item === row));
  document.querySelector('.signal-feature').outerHTML = signalFeature();
});
function focusable() {
  const root = sheet ? document.querySelector('.sheet') : app;
  return [...root.querySelectorAll('button,input,a')].filter(
    (element) =>
      !element.hidden &&
      element.getClientRects().length &&
      !element.closest('[hidden]'),
  );
}
document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Escape' ||
    (event.key === 'Backspace' && event.target.tagName !== 'INPUT')
  ) {
    event.preventDefault();
    handle('back');
    return;
  }
  if (event.target.type === 'search') {
    if (event.key === 'Enter') handle('search-submit');
    return;
  }
  if (
    view === 'player' &&
    !sheet &&
    document.activeElement?.dataset.action === 'toggle' &&
    event.key === 'ArrowDown'
  ) {
    event.preventDefault();
    document.querySelector('[data-action="captions"]').focus();
    return;
  }
  if (event.key === ' ' && view === 'player' && !sheet) {
    event.preventDefault();
    handle('toggle');
    return;
  }
  if (sheet && event.key === 'Tab') {
    const items = focusable();
    const index = items.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (index - 1 + items.length) % items.length
      : (index + 1) % items.length;
    event.preventDefault();
    items[next]?.focus();
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))
    return;
  if (event.target.type === 'range') {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      document
        .querySelector(
          event.key === 'ArrowDown'
            ? '[data-action="toggle"]'
            : '.player-header [data-action="back"]',
        )
        .focus();
    }
    return;
  }
  if (
    view === 'player' &&
    !sheet &&
    ['ArrowLeft', 'ArrowRight'].includes(event.key) &&
    document.activeElement?.dataset.action === 'toggle'
  ) {
    event.preventDefault();
    handle(event.key === 'ArrowLeft' ? 'rewind' : 'forward');
    return;
  }
  event.preventDefault();
  const current = document.activeElement;
  const origin = current?.getBoundingClientRect();
  const horizontal = ['ArrowLeft', 'ArrowRight'].includes(event.key);
  const positive = ['ArrowDown', 'ArrowRight'].includes(event.key);
  const candidates = focusable()
    .filter((element) => element !== current)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const dx = rect.x + rect.width / 2 - (origin?.x + origin?.width / 2 || 0);
      const dy =
        rect.y + rect.height / 2 - (origin?.y + origin?.height / 2 || 0);
      const primary = horizontal ? dx : dy;
      const perpendicular = horizontal ? dy : dx;
      return {
        element,
        primary,
        score: Math.abs(primary) + Math.abs(perpendicular) * 2.5,
      };
    })
    .filter((candidate) =>
      positive ? candidate.primary > 10 : candidate.primary < -10,
    )
    .sort((a, b) => a.score - b.score);
  candidates[0]?.element.focus({ preventScroll: true });
  candidates[0]?.element.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior: 'instant',
  });
});
render(option === 'signal' && view === 'home' ? 'row-0' : 'primary');
