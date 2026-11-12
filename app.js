'use strict';

/* ---------- Data ---------- */
const STORE_KEY = 'seriesTracker.v1';
const IMG = 'https://image.tmdb.org/t/p/';
const STATUSES = { watching: 'Watching', towatch: 'To Watch', watched: 'Watched', onhold: 'On hold', dropped: 'Dropped' };
const DEFAULT_SERVICES = ['Netflix', 'Amazon Prime Video', 'Disney Plus', 'Apple TV+', 'BBC iPlayer', 'ITVX', 'Channel 4', 'Now TV', 'Paramount Plus', 'Sky Go'];
const REGIONS = { GB: 'United Kingdom', IE: 'Ireland', US: 'United States', CA: 'Canada', AU: 'Australia', PT: 'Portugal', ES: 'Spain', FR: 'France', DE: 'Germany', BR: 'Brazil' };
const TABS = { explore: 'Explore', library: 'Library', watched: 'Watched', watchlist: 'To Watch', stats: 'Stats' };

function blankDb() {
  return { settings: { apiKey: '', theme: 'auto', region: 'GB' }, shows: {}, lists: [] };
}
function loadDb() {
  const d = blankDb();
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && typeof raw === 'object') {
      Object.assign(d.settings, raw.settings || {});
      if (raw.shows && typeof raw.shows === 'object') d.shows = raw.shows;
      if (Array.isArray(raw.lists)) d.lists = raw.lists;
    }
  } catch (e) { /* storage unavailable or corrupt: start empty */ }
  return d;
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch (e) { toast('Could not save on this device'); }
}

let db = loadDb();
const ui = {
  tab: 'explore', q: '', exService: '', exGenre: '', exPage: 1,
  libStatus: 'all', libList: '', libSort: 'added', libGroup: false, libQ: '',
  watchedSort: 'rating', pickService: '', pickGenre: ''
};
const seen = new Map();      // id -> summary of shows seen in Explore
let genreMap = null;         // TMDB genre id -> name
let providerList = null;     // streaming services for the region
let cur = null;              // series open in the detail sheet
let dirty = false;
let renderToken = 0;

/* ---------- Helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isManual = (id) => String(id).startsWith('m');
const entries = () => Object.values(db.shows);
const hasKey = () => !!db.settings.apiKey.trim();
const fmtRating = (r) => (Number.isInteger(r) ? String(r) : r.toFixed(1));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function applyTheme() {
  const t = db.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function cleanService(name) {
  return String(name).replace(/ (Standard|Basic) with Ads$/i, '').replace(/ with Ads$/i, '').trim();
}

function posterHtml(s, size = 'w342') {
  if (s.poster) return `<img class="poster" loading="lazy" alt="" src="${IMG}${size}${esc(s.poster)}">`;
  const initials = String(s.name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
  return `<span class="poster" aria-hidden="true">${esc(initials)}</span>`;
}

function card(s) {
  const e = db.shows[s.id];
  let badge = '';
  if (e) badge = `<span class="badge">${e.rating ? '★ ' + fmtRating(e.rating) : esc(STATUSES[e.status])}</span>`;
  const fav = e && e.favourite ? '<span class="badge fav" aria-label="Favourite">♥</span>' : '';
  return `<button class="card" data-act="open" data-id="${esc(s.id)}">${posterHtml(s)}${badge}${fav}
    <span class="card-name">${esc(s.name)}</span><span class="card-year">${esc(s.year || '')}</span></button>`;
}

function row(e, extra = '') {
  const sub = [e.year, e.service].filter(Boolean).join(' · ');
  return `<div class="row"><button class="row-main" data-act="open" data-id="${esc(e.id)}">${posterHtml(e, 'w92')}
    <span class="row-text"><b>${esc(e.name)}${e.favourite ? ' ♥' : ''}</b><small>${esc(sub)}</small></span></button>${extra}</div>`;
}

function scoreHtml(e) {
  return e.rating ? `<span class="score">★ ${fmtRating(e.rating)}<small class="muted">/10</small></span>` : '<span class="score none">Not rated</span>';
}

function groupBy(list, fn) {
  const m = new Map();
  for (const item of list) {
    const k = fn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

/* ---------- TMDB ---------- */
const apiCache = new Map();
async function api(path, params = {}) {
  const key = db.settings.apiKey.trim();
  if (!key) throw new Error('Add your TMDB key in Settings first.');
  const u = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) u.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  else u.searchParams.set('api_key', key);
  const ck = u.toString();
  if (apiCache.has(ck)) return apiCache.get(ck);
  let r;
  try { r = await fetch(u, { headers }); }
  catch (e) { throw new Error('Could not reach TMDB. Check your connection.'); }
  if (r.status === 401) throw new Error('TMDB rejected your key. Check it in Settings.');
  if (!r.ok) throw new Error('TMDB error ' + r.status);
  const j = await r.json();
  apiCache.set(ck, j);
  return j;
}

async function loadGenres() {
  if (!genreMap) {
    const j = await api('/genre/tv/list');
    genreMap = new Map(j.genres.map((g) => [g.id, g.name]));
  }
  return genreMap;
}

async function loadProviders() {
  if (!providerList) {
    const region = db.settings.region;
    const j = await api('/watch/providers/tv', { watch_region: region });
    const prio = (p) => (p.display_priorities && p.display_priorities[region]) ?? p.display_priority ?? 999;
    providerList = j.results.slice().sort((a, b) => prio(a) - prio(b)).slice(0, 30)
      .map((p) => ({ id: p.provider_id, name: p.provider_name }));
  }
  return providerList;
}

function norm(r) {
  const s = {
    id: r.id, name: r.name || r.original_name || 'Untitled', poster: r.poster_path || '',
    year: (r.first_air_date || '').slice(0, 4), overview: r.overview || '',
    tmdbRating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    genres: (r.genre_ids || []).map((g) => genreMap && genreMap.get(g)).filter(Boolean)
  };
  seen.set(String(s.id), s);
  return s;
}

function fromDetails(d) {
  return {
    id: d.id, name: d.name || 'Untitled', poster: d.poster_path || '',
    year: (d.first_air_date || '').slice(0, 4), overview: d.overview || '',
    tmdbRating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    genres: (d.genres || []).map((g) => g.name),
    seasons: d.number_of_seasons || null, airStatus: d.status || ''
  };
}

function providerNames(d) {
  const reg = d['watch/providers'] && d['watch/providers'].results && d['watch/providers'].results[db.settings.region];
  if (!reg) return [];
  const all = [...(reg.flatrate || []), ...(reg.free || []), ...(reg.ads || [])].map((p) => cleanService(p.provider_name));
  const uniq = [...new Set(all)];
  const isAddOn = (n) => /(Amazon|Apple TV|Roku Premium) Channel$/i.test(n);
  return [...uniq.filter((n) => !isAddOn(n)), ...uniq.filter(isAddOn)];
}

async function recommendations() {
  const top = entries().filter((e) => !isManual(e.id) && e.rating >= 7)
    .sort((a, b) => b.rating - a.rating).slice(0, 5);
  if (!top.length) return [];
  const lists = await Promise.all(top.map((e) => api(`/tv/${e.id}/recommendations`).catch(() => ({ results: [] }))));
  const score = new Map();
  for (const l of lists) for (const r of l.results || []) {
    if (db.shows[r.id]) continue;
    const s = score.get(r.id) || { r, n: 0 };
    s.n += 1;
    score.set(r.id, s);
  }
  return [...score.values()].sort((a, b) => b.n - a.n || (b.r.popularity || 0) - (a.r.popularity || 0))
    .slice(0, 20).map((x) => norm(x.r));
}

/* ---------- Rendering ---------- */
function render() {
  renderToken++;
  $('#title').textContent = TABS[ui.tab];
  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  ({ explore: renderExplore, library: renderLibrary, watched: renderWatched, watchlist: renderWatchlist, stats: renderStats })[ui.tab]();
}

/* Explore */
function renderExplore() {
  const v = $('#view');
  if (!hasKey()) {
    v.innerHTML = `<div class="panel">
      <h2>Connect to TMDB to explore series</h2>
      <p class="muted">Explore uses The Movie Database for posters, descriptions and UK streaming info. A key is free:</p>
      <ol>
        <li>Create a free account at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener">themoviedb.org</a>.</li>
        <li>Open <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Settings → API</a> and request a key (choose personal use).</li>
        <li>Copy the <b>API Key</b> and paste it here.</li>
      </ol>
      <div class="stack">
        <input class="field" id="key-input" placeholder="Paste your TMDB API key" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="TMDB API key">
        <button class="btn primary" data-act="save-key">Save key</button>
        <button class="btn" data-act="manual">Add a series by hand instead</button>
      </div>
    </div>`;
    return;
  }
  v.innerHTML = `
    <input class="field" id="ex-q" type="search" placeholder="Search for a series…" aria-label="Search for a series" value="${esc(ui.q)}">
    <div class="controls">
      <select class="field" id="ex-service" aria-label="Streaming service"><option value="">All services</option></select>
      <select class="field" id="ex-genre" aria-label="Genre"><option value="">All genres</option></select>
    </div>
    <div id="ex-results"></div>`;
  Promise.all([loadProviders(), loadGenres()]).then(([provs, genres]) => {
    const ps = $('#ex-service'), gs = $('#ex-genre');
    if (!ps || !gs) return;
    ps.insertAdjacentHTML('beforeend', provs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join(''));
    gs.insertAdjacentHTML('beforeend', [...genres].map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join(''));
    ps.value = ui.exService;
    gs.value = ui.exGenre;
  }).catch(() => {});
  renderExploreResults();
}

// keep === true refreshes in place (Load more, closing a series) without jumping to the top.
async function renderExploreResults(keep) {
  const token = ++renderToken;
  const box = $('#ex-results');
  if (!box) return;
  const live = () => token === renderToken && ui.tab === 'explore';
  const view = $('#view');
  const pos = keep === true && box.children.length
    ? { top: view.scrollTop, rows: [...box.querySelectorAll('.hrow')].map((r) => r.scrollLeft) } : null;
  const restore = () => {
    if (!pos) return;
    box.querySelectorAll('.hrow').forEach((r, i) => { r.scrollLeft = pos.rows[i] || 0; });
    view.scrollTop = pos.top;
  };
  if (!pos) box.innerHTML = '<p class="muted" style="margin-top:16px">Loading…</p>';
  try {
    await loadGenres();
    const q = ui.q.trim();
    if (q || ui.exService || ui.exGenre) {
      let items = [], total = 1;
      for (let p = 1; p <= ui.exPage; p++) {
        const j = q
          ? await api('/search/tv', { query: q, page: p })
          : await api('/discover/tv', {
            page: p, sort_by: 'popularity.desc', with_genres: ui.exGenre,
            with_watch_providers: ui.exService, watch_region: ui.exService ? db.settings.region : ''
          });
        items = items.concat(j.results || []);
        total = j.total_pages || 1;
      }
      if (!live()) return;
      const title = q ? `Results for “${esc(q)}”` : 'Browse';
      box.innerHTML = `<div class="section-head"><h2>${title}</h2></div>` +
        (items.length ? `<div class="grid">${items.map((r) => card(norm(r))).join('')}</div>` : '<div class="empty">Nothing found. Try another search.</div>') +
        (ui.exPage < total && items.length ? '<p style="text-align:center;margin-top:16px"><button class="btn" data-act="more">Load more</button></p>' : '') +
        '<p style="text-align:center;margin-top:16px"><button class="btn small" data-act="manual">Can’t find it? Add by hand</button></p>';
      restore();
      return;
    }
    const [recs, trending, popular, top] = await Promise.all([
      recommendations().catch(() => []), api('/trending/tv/week'), api('/tv/popular'), api('/tv/top_rated')
    ]);
    if (!live()) return;
    const section = (title, list, note = '') => list.length
      ? `<div class="section-head"><h2>${title}</h2><small>${note}</small></div><div class="hrow">${list.map(card).join('')}</div>` : '';
    box.innerHTML =
      section('Recommended for you', recs, 'From your top ratings') +
      section('Trending this week', trending.results.map(norm)) +
      section('Popular', popular.results.map(norm)) +
      section('Top rated', top.results.map(norm)) +
      (recs.length ? '' : '<p class="muted" style="margin-top:18px">Rate a few series 7 or higher to get personal recommendations.</p>');
    restore();
  } catch (e) {
    if (live()) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* Library */
function renderLibrary() {
  const statusChips = [['all', 'All'], ...Object.entries(STATUSES), ['fav', '♥ Favourites']]
    .map(([k, l]) => `<button class="chip" data-act="lib-status" data-v="${k}" aria-pressed="${ui.libStatus === k && !ui.libList}">${esc(l)}</button>`).join('');
  const listChips = db.lists
    .map((l) => `<button class="chip" data-act="lib-list" data-v="${esc(l.id)}" aria-pressed="${ui.libList === l.id}">${esc(l.name)} (${l.ids.filter((id) => db.shows[id]).length})</button>`).join('');
  $('#view').innerHTML = `
    <input class="field" id="lib-q" type="search" placeholder="Filter your library…" aria-label="Filter your library" value="${esc(ui.libQ)}">
    <div class="chips" role="group" aria-label="Status">${statusChips}</div>
    <div class="chips" role="group" aria-label="Your lists">${listChips}<button class="chip" data-act="list-new">+ New list</button></div>
    <div class="controls">
      <select class="field" id="lib-sort" aria-label="Sort by">
        <option value="added">Recently added</option><option value="name">A–Z</option><option value="rating">My rating</option>
      </select>
      <button class="chip" data-act="lib-group" aria-pressed="${ui.libGroup}">Group by service</button>
    </div>
    <div id="lib-results"></div>`;
  $('#lib-sort').value = ui.libSort;
  renderLibraryResults();
}

function renderLibraryResults() {
  const box = $('#lib-results');
  if (!box) return;
  let list = entries();
  const activeList = db.lists.find((l) => l.id === ui.libList);
  if (activeList) list = list.filter((e) => activeList.ids.includes(String(e.id)));
  else if (ui.libStatus === 'fav') list = list.filter((e) => e.favourite);
  else if (ui.libStatus !== 'all') list = list.filter((e) => e.status === ui.libStatus);
  const q = ui.libQ.trim().toLowerCase();
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
  const sorters = {
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0)
  };
  list.sort(sorters[ui.libSort]);

  let head = '';
  if (activeList) {
    head = `<div class="section-head"><h2>${esc(activeList.name)}</h2>
      <span class="inline"><button class="btn small" data-act="list-rename">Rename</button><button class="btn small danger" data-act="list-delete">Delete list</button></span></div>`;
  }
  if (!list.length) {
    box.innerHTML = head + `<div class="empty">${entries().length ? 'No series match this filter.' : 'Your library is empty. Find series in Explore and add them.'}</div>`;
    return;
  }
  if (ui.libGroup) {
    const groups = [...groupBy(list, (e) => e.service || 'Other')].sort((a, b) => b[1].length - a[1].length);
    box.innerHTML = head + groups.map(([name, items]) =>
      `<div class="section-head"><h2>${esc(name)}</h2><small>${items.length}</small></div><div class="grid">${items.map(card).join('')}</div>`).join('');
  } else {
    box.innerHTML = head + `<div class="grid" style="margin-top:12px">${list.map(card).join('')}</div>`;
  }
}

/* Watched */
function renderWatched() {
  const list = entries().filter((e) => e.status === 'watched');
  if (!list.length) {
    $('#view').innerHTML = '<div class="empty">Nothing marked as watched yet. Open a series and choose “Watched”, then give it a rating out of 10.</div>';
    return;
  }
  const rated = list.filter((e) => e.rating);
  const avg = rated.length ? (rated.reduce((s, e) => s + e.rating, 0) / rated.length).toFixed(1) : '–';
  const sorter = ui.watchedSort === 'name'
    ? (a, b) => a.name.localeCompare(b.name)
    : ui.watchedSort === 'recent' ? (a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)
      : (a, b) => (b.rating || 0) - (a.rating || 0) || a.name.localeCompare(b.name);
  const groups = [...groupBy(list, (e) => e.service || 'Other')].sort((a, b) => b[1].length - a[1].length);
  $('#view').innerHTML = `
    <div class="controls" style="margin-top:0">
      <p class="muted" style="align-self:center">${list.length} watched · average ★ ${avg}</p>
      <select class="field" id="watched-sort" aria-label="Sort by">
        <option value="rating">Highest rated</option><option value="recent">Recently watched</option><option value="name">A–Z</option>
      </select>
    </div>` +
    groups.map(([name, items]) => {
      const r = items.filter((e) => e.rating);
      const a = r.length ? ' · avg ★ ' + (r.reduce((s, e) => s + e.rating, 0) / r.length).toFixed(1) : '';
      return `<div class="section-head"><h2>${esc(name)}</h2><small>${items.length}${a}</small></div>` +
        items.sort(sorter).map((e) => row(e, scoreHtml(e))).join('');
    }).join('');
  $('#watched-sort').value = ui.watchedSort;
}

/* To Watch */
function renderWatchlist() {
  const watching = entries().filter((e) => e.status === 'watching').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const todo = entries().filter((e) => e.status === 'towatch').sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const paused = entries().filter((e) => e.status === 'onhold');
  if (!watching.length && !todo.length && !paused.length) {
    $('#view').innerHTML = '<div class="empty">Your watchlist is empty. Find something in Explore and choose “To Watch”.</div>';
    return;
  }
  const services = [...new Set(todo.map((e) => e.service || 'Other'))].sort();
  const genres = [...new Set(todo.flatMap((e) => e.genres || []))].sort();
  const act = (id, status, label) => `<button class="btn small" data-act="quick" data-id="${esc(id)}" data-v="${status}">${label}</button>`;
  let html = '';
  if (todo.length) {
    html += `<div class="panel"><h2>Can’t decide?</h2>
      <div class="controls">
        <select class="field" id="pick-service" aria-label="Service for random pick"><option value="">Any service</option>${services.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
        <select class="field" id="pick-genre" aria-label="Genre for random pick"><option value="">Any genre</option>${genres.map((g) => `<option>${esc(g)}</option>`).join('')}</select>
      </div>
      <button class="btn primary block" data-act="pick" style="margin-top:8px">Pick something for me</button></div>`;
  }
  if (watching.length) {
    html += `<div class="section-head"><h2>Currently watching</h2><small>${watching.length}</small></div>` +
      watching.map((e) => row(e, `<span class="row-actions">${act(e.id, 'watched', 'Finished')}</span>`)).join('');
  }
  if (todo.length) {
    html += `<div class="section-head"><h2>To watch</h2><small>${todo.length}</small></div>` +
      todo.map((e) => row(e, `<span class="row-actions">${act(e.id, 'watching', 'Start')}</span>`)).join('');
  }
  if (paused.length) {
    html += `<div class="section-head"><h2>On hold</h2><small>${paused.length}</small></div>` +
      paused.map((e) => row(e, `<span class="row-actions">${act(e.id, 'watching', 'Resume')}</span>`)).join('');
  }
  $('#view').innerHTML = html;
  if ($('#pick-service')) {
    $('#pick-service').value = services.includes(ui.pickService) ? ui.pickService : '';
    $('#pick-genre').value = genres.includes(ui.pickGenre) ? ui.pickGenre : '';
  }
}

function pickRandom() {
  const service = $('#pick-service') ? $('#pick-service').value : ui.pickService;
  const genre = $('#pick-genre') ? $('#pick-genre').value : ui.pickGenre;
  ui.pickService = service;
  ui.pickGenre = genre;
  const pool = entries().filter((e) => e.status === 'towatch' &&
    (!service || (e.service || 'Other') === service) && (!genre || (e.genres || []).includes(genre)));
  if (!pool.length) return toast('Nothing on your list matches those filters');
  const e = pool[Math.floor(Math.random() * pool.length)];
  const m = $('#modal');
  m.innerHTML = `<button class="icon-btn close" data-act="close" aria-label="Close">✕</button>
    <div class="sheet-body">
      <p class="muted">Tonight you’re watching…</p>
      <div class="sheet-head" style="margin-top:10px">${posterHtml(e)}
        <div><h2>${esc(e.name)}</h2><p class="meta">${esc([e.year, e.service].filter(Boolean).join(' · '))}</p>
        <p class="meta">${esc((e.genres || []).join(', '))}</p></div></div>
      <div class="stack" style="margin-top:18px">
        <button class="btn primary" data-act="quick" data-id="${esc(e.id)}" data-v="watching">Start watching</button>
        ${pool.length > 1 ? '<button class="btn" data-act="pick">Pick again</button>' : ''}
        <button class="btn" data-act="open" data-id="${esc(e.id)}">Details</button>
      </div></div>`;
  if (!m.open) m.showModal();
}

/* Stats */
function bars(pairs, fmt = (v) => v) {
  const max = Math.max(...pairs.map((p) => p[1]), 1);
  return pairs.map(([label, v, note]) => `<div class="bar-row"><span>${esc(label)}</span>
    <span class="bar"><i style="width:${(v / max) * 100}%"></i></span><em>${fmt(v)}${note ? ' · ' + esc(note) : ''}</em></div>`).join('');
}

function renderStats() {
  const all = entries();
  if (!all.length) {
    $('#view').innerHTML = '<div class="empty">Add some series to see your stats.</div>';
    return;
  }
  const count = (s) => all.filter((e) => e.status === s).length;
  const rated = all.filter((e) => e.rating);
  const avg = rated.length ? (rated.reduce((s, e) => s + e.rating, 0) / rated.length).toFixed(1) : '–';
  const tile = (n, l) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`;
  const byService = [...groupBy(all, (e) => e.service || 'Other')].map(([name, items]) => {
    const r = items.filter((e) => e.rating);
    return [name, items.length, r.length ? '★ ' + (r.reduce((s, e) => s + e.rating, 0) / r.length).toFixed(1) : ''];
  }).sort((a, b) => b[1] - a[1]);
  const genreCount = new Map();
  for (const e of all) for (const g of e.genres || []) genreCount.set(g, (genreCount.get(g) || 0) + 1);
  const byGenre = [...genreCount].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const dist = Array.from({ length: 10 }, (_, i) => [String(i + 1), rated.filter((e) => Math.ceil(e.rating) === i + 1).length]).reverse();
  const top = rated.slice().sort((a, b) => b.rating - a.rating).slice(0, 5);

  $('#view').innerHTML = `
    <div class="tiles">${tile(all.length, 'In library')}${tile(count('watched'), 'Watched')}${tile(count('watching'), 'Watching')}
      ${tile(count('towatch'), 'To watch')}${tile(avg, 'Average rating')}${tile(all.filter((e) => e.favourite).length, 'Favourites')}</div>
    <div class="section-head"><h2>By streaming service</h2><small>series · average rating</small></div>${bars(byService)}
    ${byGenre.length ? `<div class="section-head"><h2>Favourite genres</h2></div>${bars(byGenre)}` : ''}
    ${rated.length ? `<div class="section-head"><h2>Your ratings</h2><small>series per score (rounded up)</small></div>${bars(dist)}
      <div class="section-head"><h2>Your top rated</h2></div>${top.map((e) => row(e, scoreHtml(e))).join('')}` : ''}`;
}

/* ---------- Detail sheet ---------- */
async function openDetail(id) {
  id = String(id);
  const base = db.shows[id] || seen.get(id);
  if (!base) return;
  if ($('#modal').open) $('#modal').close();
  cur = { id, info: { ...base }, providers: [] };
  renderDetail();
  const dlg = $('#detail');
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  if (isManual(id) || !hasKey()) return;
  try {
    const d = await api(`/tv/${id}`, { append_to_response: 'watch/providers' });
    if (!cur || cur.id !== id) return;
    const info = fromDetails(d);
    cur.info = { ...cur.info, ...info };
    cur.providers = providerNames(d);
    const e = db.shows[id];
    if (e) {
      Object.assign(e, info, { id: e.id });
      if (!e.serviceManual && cur.providers[0]) e.service = cur.providers[0];
      save();
    }
    renderDetail();
  } catch (e) { /* keep showing what we have */ }
}

function serviceOptions(current) {
  const names = [...new Set([...(cur ? cur.providers : []), ...entries().map((e) => e.service).filter(Boolean), ...DEFAULT_SERVICES, 'Other'])];
  if (current && !names.includes(current)) names.unshift(current);
  return names.map((n) => `<option${n === current ? ' selected' : ''}>${esc(n)}</option>`).join('') + '<option value="__custom">Type another…</option>';
}

function renderDetail() {
  const s = cur.info, e = db.shows[cur.id];
  const meta = [s.year, s.seasons ? `${s.seasons} season${s.seasons > 1 ? 's' : ''}` : '', s.airStatus].filter(Boolean).join(' · ');
  const statusBtns = Object.entries(STATUSES).map(([k, l]) =>
    `<button class="chip" data-act="status" data-v="${k}" aria-pressed="${!!e && e.status === k}">${esc(l)}</button>`).join('');
  let mine = '';
  if (e) {
    mine = `
      <h3>My rating</h3>
      <div class="rating-line">
        <input type="range" id="rating" min="0" max="10" step="0.5" value="${e.rating || 0}" aria-label="My rating out of 10">
        <span class="rating-value" id="rating-value">${e.rating ? fmtRating(e.rating) + '<small> / 10</small>' : '<small>Not rated</small>'}</span>
      </div>
      <h3>Streaming service</h3>
      <select class="field" id="service" aria-label="Streaming service">${serviceOptions(e.service || 'Other')}</select>
      <h3>Favourites and lists</h3>
      <label class="check"><input type="checkbox" id="fav" ${e.favourite ? 'checked' : ''}> ♥ Favourite</label>
      ${db.lists.map((l) => `<label class="check"><input type="checkbox" data-list="${esc(l.id)}" ${l.ids.includes(cur.id) ? 'checked' : ''}> ${esc(l.name)}</label>`).join('')}
      <div class="inline" style="margin-top:10px">
        <button class="btn small" data-act="list-new">+ New list</button>
        <button class="btn small danger" data-act="remove">Remove from library</button>
      </div>`;
  }
  $('#detail').innerHTML = `<button class="icon-btn close" data-act="close" aria-label="Close">✕</button>
    <div class="sheet-body">
      <div class="sheet-head">${posterHtml(s)}
        <div><h2>${esc(s.name)}</h2><p class="meta">${esc(meta)}</p>
          ${s.tmdbRating ? `<p class="meta">TMDB score ★ ${s.tmdbRating}</p>` : ''}
          <p class="meta">${esc((s.genres || []).join(', '))}</p>
          ${cur.providers.length ? `<p class="meta">Streaming on: ${esc(cur.providers.slice(0, 4).join(', '))}</p>` : ''}
        </div></div>
      ${s.overview ? `<p class="overview">${esc(s.overview)}</p>` : ''}
      <h3>${e ? 'Status' : 'Add to my library as'}</h3>
      <div class="status-grid">${statusBtns}</div>
      ${mine}
    </div>`;
}

function setStatus(id, status) {
  id = String(id);
  let e = db.shows[id];
  const now = Date.now();
  if (!e) {
    const info = (cur && cur.id === id ? cur.info : seen.get(id)) || {};
    e = db.shows[id] = {
      ...info, id: info.id ?? id, rating: null, favourite: false, addedAt: now,
      service: (cur && cur.id === id && cur.providers[0]) || info.service || 'Other', serviceManual: false
    };
  }
  e.status = status;
  e.updatedAt = now;
  if (status === 'watched' && !e.watchedAt) e.watchedAt = now;
  save();
  dirty = true;
}

/* ---------- Dialogs: settings, manual add ---------- */
function openSettings() {
  const s = db.settings;
  const m = $('#modal');
  m.innerHTML = `<button class="icon-btn close" data-act="close" aria-label="Close">✕</button>
    <div class="sheet-body">
      <h2>Settings</h2>
      <h3>TMDB API key</h3>
      <div class="stack">
        <input class="field" id="key-input" value="${esc(s.apiKey)}" placeholder="Paste your TMDB API key" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="TMDB API key">
        <button class="btn primary" data-act="save-key">Save key</button>
        <p class="muted" style="font-size:.85rem">Free from <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org → Settings → API</a>. It is stored only on this device.</p>
      </div>
      <h3>Appearance</h3>
      <select class="field" id="set-theme" aria-label="Theme">
        <option value="auto">Match my device</option><option value="dark">Dark</option><option value="light">Light</option>
      </select>
      <h3>Country for streaming services</h3>
      <select class="field" id="set-region" aria-label="Country">${Object.entries(REGIONS).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
      <h3>Backup</h3>
      <div class="inline">
        <button class="btn" data-act="export">Export my data</button>
        <button class="btn" data-act="import">Import a backup</button>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>
      <p class="muted" style="font-size:.85rem;margin-top:8px">Your library lives in this browser. Export a backup now and then, or to move to another device.</p>
      <h3>Danger zone</h3>
      <button class="btn danger" data-act="wipe">Delete all my data</button>
      <p class="muted" style="font-size:.78rem;margin-top:20px">This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data is provided by JustWatch.</p>
    </div>`;
  $('#set-theme').value = s.theme;
  $('#set-region').value = s.region;
  if (!m.open) m.showModal();
}

function openManual() {
  const m = $('#modal');
  m.innerHTML = `<button class="icon-btn close" data-act="close" aria-label="Close">✕</button>
    <form class="sheet-body stack" id="manual-form">
      <h2>Add a series by hand</h2>
      <input class="field" name="name" placeholder="Series name" required aria-label="Series name">
      <input class="field" name="year" placeholder="Year (optional)" inputmode="numeric" maxlength="4" aria-label="Year">
      <input class="field" name="genres" placeholder="Genres, separated by commas (optional)" aria-label="Genres">
      <select class="field" name="service" aria-label="Streaming service">${[...DEFAULT_SERVICES, 'Other'].map((n) => `<option>${esc(n)}</option>`).join('')}</select>
      <select class="field" name="status" aria-label="Status">${Object.entries(STATUSES).map(([k, l]) => `<option value="${k}"${k === 'towatch' ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn primary">Add to library</button>
    </form>`;
  if (!m.open) m.showModal();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ ...db, settings: { ...db.settings, apiKey: '' } }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `series-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || typeof raw.shows !== 'object') throw new Error('bad');
    if (entries().length && !confirm('Replace your current library with this backup?')) return;
    db.shows = raw.shows;
    db.lists = Array.isArray(raw.lists) ? raw.lists : [];
    save();
    $('#modal').close();
    render();
    toast(`Imported ${entries().length} series`);
  } catch (e) { toast('That file is not a Series Tracker backup'); }
}

function newList() {
  const name = (prompt('Name for the new list:') || '').trim();
  if (!name) return;
  const list = { id: 'l' + Date.now(), name, ids: [] };
  if (cur && db.shows[cur.id] && $('#detail').open) list.ids.push(cur.id);
  db.lists.push(list);
  save();
  dirty = true;
  if ($('#detail').open) renderDetail(); else render();
  toast(`Created “${name}”`);
}

/* ---------- Events ---------- */
const actions = {
  tab(el) { ui.tab = el.dataset.tab; $('#view').scrollTop = 0; render(); },
  open(el) { openDetail(el.dataset.id); },
  close(el) { el.closest('dialog').close(); },
  settings() { openSettings(); },
  manual() { openManual(); },
  theme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    db.settings.theme = dark ? 'light' : 'dark';
    save();
    applyTheme();
  },
  'save-key'(el) {
    const input = $('#key-input', el.closest('dialog') || document);
    db.settings.apiKey = input.value.trim();
    save();
    apiCache.clear();
    if ($('#modal').open) $('#modal').close();
    toast(db.settings.apiKey ? 'Key saved' : 'Key removed');
    render();
  },
  more(el) { ui.exPage++; el.disabled = true; el.textContent = 'Loading…'; renderExploreResults(true); },
  'lib-status'(el) { ui.libStatus = el.dataset.v; ui.libList = ''; renderLibrary(); },
  'lib-list'(el) { ui.libList = ui.libList === el.dataset.v ? '' : el.dataset.v; renderLibrary(); },
  'lib-group'() { ui.libGroup = !ui.libGroup; renderLibrary(); },
  'list-new'() { newList(); },
  'list-rename'() {
    const l = db.lists.find((x) => x.id === ui.libList);
    const name = l && (prompt('Rename list:', l.name) || '').trim();
    if (name) { l.name = name; save(); renderLibrary(); }
  },
  'list-delete'() {
    const l = db.lists.find((x) => x.id === ui.libList);
    if (l && confirm(`Delete the list “${l.name}”? The series stay in your library.`)) {
      db.lists = db.lists.filter((x) => x !== l);
      ui.libList = '';
      save();
      renderLibrary();
    }
  },
  status(el) {
    const wasNew = !db.shows[cur.id];
    setStatus(cur.id, el.dataset.v);
    renderDetail();
    toast(wasNew ? `Added as ${STATUSES[el.dataset.v]}` : `Marked as ${STATUSES[el.dataset.v]}`);
  },
  quick(el) {
    setStatus(el.dataset.id, el.dataset.v);
    if ($('#modal').open) $('#modal').close();
    dirty = false;
    render();
    if (el.dataset.v === 'watched') { toast('Finished! Give it a rating'); openDetail(el.dataset.id); }
    else toast(`Marked as ${STATUSES[el.dataset.v]}`);
  },
  remove() {
    const e = db.shows[cur.id];
    if (!e || !confirm(`Remove “${e.name}” from your library? Your rating will be lost.`)) return;
    delete db.shows[cur.id];
    db.lists.forEach((l) => { l.ids = l.ids.filter((id) => id !== cur.id); });
    save();
    dirty = true;
    $('#detail').close();
    toast('Removed');
  },
  pick() { pickRandom(); },
  export() { exportData(); },
  import() { $('#import-file').click(); },
  wipe() {
    if (!confirm('Delete your whole library, ratings and lists from this device? This cannot be undone.')) return;
    const settings = db.settings;
    db = blankDb();
    db.settings = settings;
    save();
    $('#modal').close();
    render();
    toast('All data deleted');
  }
};

document.addEventListener('click', (ev) => {
  if (ev.target instanceof HTMLDialogElement) { ev.target.close(); return; } // backdrop tap
  const el = ev.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});

let searchTimer;
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'ex-q') {
    ui.q = t.value;
    ui.exPage = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderExploreResults, 350);
  } else if (t.id === 'lib-q') {
    ui.libQ = t.value;
    renderLibraryResults();
  } else if (t.id === 'rating') {
    const v = Number(t.value);
    $('#rating-value').innerHTML = v ? fmtRating(v) + '<small> / 10</small>' : '<small>Not rated</small>';
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  const e = cur && db.shows[cur.id];
  if (t.id === 'ex-service') { ui.exService = t.value; ui.exPage = 1; renderExploreResults(); }
  else if (t.id === 'ex-genre') { ui.exGenre = t.value; ui.exPage = 1; renderExploreResults(); }
  else if (t.id === 'lib-sort') { ui.libSort = t.value; renderLibraryResults(); }
  else if (t.id === 'watched-sort') { ui.watchedSort = t.value; renderWatched(); }
  else if (t.id === 'set-theme') { db.settings.theme = t.value; save(); applyTheme(); }
  else if (t.id === 'set-region') { db.settings.region = t.value; providerList = null; apiCache.clear(); save(); render(); }
  else if (t.id === 'import-file') { if (t.files[0]) importData(t.files[0]); }
  else if (t.id === 'rating' && e) {
    e.rating = Number(t.value) || null;
    e.updatedAt = Date.now();
    save();
    dirty = true;
  } else if (t.id === 'service' && e) {
    let v = t.value;
    if (v === '__custom') v = (prompt('Streaming service name:') || '').trim() || e.service;
    e.service = v;
    e.serviceManual = true;
    save();
    dirty = true;
    renderDetail();
  } else if (t.id === 'fav' && e) {
    e.favourite = t.checked;
    save();
    dirty = true;
  } else if (t.dataset.list && e) {
    const l = db.lists.find((x) => x.id === t.dataset.list);
    if (l) {
      l.ids = l.ids.filter((id) => id !== cur.id);
      if (t.checked) l.ids.push(cur.id);
      save();
      dirty = true;
    }
  }
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'manual-form') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const now = Date.now();
  const id = 'm' + now;
  const status = f.get('status');
  db.shows[id] = {
    id, name: String(f.get('name')).trim(), poster: '', year: String(f.get('year')).trim(), overview: '', tmdbRating: null,
    genres: String(f.get('genres')).split(',').map((g) => g.trim()).filter(Boolean),
    status, rating: null, favourite: false, service: f.get('service'), serviceManual: true,
    addedAt: now, updatedAt: now, watchedAt: status === 'watched' ? now : undefined
  };
  save();
  $('#modal').close();
  ui.tab = 'library';
  render();
  toast('Added to your library');
});

$('#detail').addEventListener('close', () => {
  cur = null;
  if (!dirty) return;
  dirty = false;
  if (ui.tab === 'explore') renderExploreResults(true); else render();
});

/* ---------- Start ---------- */
applyTheme();
if (!hasKey() && entries().length) ui.tab = 'library';
render();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
