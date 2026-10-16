// Halo Ranked Tracker dashboard. Reads only /api/ranks; never contacts Halo services.
const MODE_ORDER = ['arena', 'doubles', 'slayer', 'snipers'];
const SHORT = { arena: 'Arena', doubles: 'Doubles', slayer: 'Slayer', snipers: 'Snipers' };
const TIER_COLORS = { bronze: '#d29466', silver: '#c9d2dc', gold: '#f4c95d', platinum: '#79e6d8', diamond: '#8cc4ff', onyx: '#f0e6c8', unranked: '#7c8a9b' };
const STALE_HOURS = 26;
const $ = (id) => document.getElementById(id);

const DEFAULT_PLAYER = 'DaLuminar';
const MAX_RECENT = 8;
// data is what gets rendered: the looked-up player (view 'player') or the daily roster (view 'roster').
const state = { data: null, roster: null, lookup: null, view: 'player', player: DEFAULT_PLAYER, recent: [], busy: false, note: '', q: '', sort: 'arena', dir: 'desc' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rankName = (tier, sub) => (tier ? (sub ? `${tier} ${sub}` : tier) : '');
const modeKeys = () => MODE_ORDER.filter((k) => state.data?.modes?.[k]).concat(Object.keys(state.data?.modes ?? {}).filter((k) => !MODE_ORDER.includes(k)));
const label = (k) => SHORT[k] ?? state.data?.modes?.[k]?.label ?? k;

// --- URL state -------------------------------------------------------------
// Saved in localStorage: the last player looked up and the recent ones. A ?player= link wins over it.
const PREFS_KEY = 'lookup-prefs';
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();
function loadPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(PREFS_KEY));
    const clean = (s) => (typeof s === 'string' ? s.trim().slice(0, 40) : '');
    return { last: clean(o?.last), recent: Array.isArray(o?.recent) ? o.recent.map(clean).filter(Boolean).slice(0, MAX_RECENT) : [] };
  } catch { return { last: '', recent: [] }; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ last: state.player, recent: state.recent })); } catch {}
}
function remember(gamertag) {
  state.player = gamertag;
  state.recent = [gamertag, ...state.recent.filter((g) => !sameTag(g, gamertag))].slice(0, MAX_RECENT);
  savePrefs();
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  const prefs = loadPrefs();
  state.recent = prefs.recent;
  state.player = p.get('player')?.trim().slice(0, 40) || prefs.last || DEFAULT_PLAYER;
  state.view = p.get('view') === 'roster' ? 'roster' : 'player';
  state.q = p.get('q') ?? '';
  state.sort = p.get('sort') ?? 'arena';
  state.dir = p.get('dir') === 'asc' ? 'asc' : 'desc';
}
function writeUrl() {
  const p = new URLSearchParams();
  if (state.view === 'roster') {
    p.set('view', 'roster');
    if (state.q) p.set('q', state.q);
    if (state.sort !== 'arena') p.set('sort', state.sort);
    if (state.dir !== 'desc') p.set('dir', state.dir);
  } else if (state.lookup) p.set('player', state.lookup.player.gamertag);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// --- Images ----------------------------------------------------------------
function iconSrc(url) {
  return url || '';
}
/** Built-in SVG badge used when an official tier icon can't be loaded. */
function fallbackBadge(name) {
  const [tier, n] = String(name).split('_');
  const c = TIER_COLORS[tier] ?? '#7c8a9b';
  const txt = tier === 'unranked' ? '?' : tier === 'onyx' ? 'O' : `${tier[0].toUpperCase()}${n}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M20 2 36 11v18L20 38 4 29V11z" fill="${c}22" stroke="${c}" stroke-width="2"/><text x="20" y="25" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${txt.length > 1 ? 11 : 14}" fill="${c}">${txt}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.fallback === '1') return;
  img.dataset.fallback = '1';
  if (img.classList.contains('ti')) img.src = fallbackBadge(img.dataset.icon);
  else if (img.classList.contains('avatar')) img.replaceWith(Object.assign(document.createElement('span'), { className: 'avatar initials', textContent: img.dataset.initials, ariaHidden: 'true' }));
}, true);

// --- Time ------------------------------------------------------------------
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
function fmtWhen(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

// --- Sorting ---------------------------------------------------------------
const hasCsr = (m) => m && (m.status === 'ranked' || m.status === 'not_in_rotation') && typeof m.csr === 'number';
function group(m) {
  if (hasCsr(m)) return 0;
  if (m?.status === 'placement') return 1;
  if (m?.status === 'unranked') return 2;
  return 3;
}
function sorted(players) {
  const sign = state.dir === 'asc' ? 1 : -1;
  const byName = (a, b) => a.gamertag.localeCompare(b.gamertag, undefined, { sensitivity: 'base' });
  if (state.sort === 'gamertag') return players.slice().sort((a, b) => sign * byName(a, b));
  const k = state.sort;
  return players.slice().sort((a, b) => {
    const ma = a.modes?.[k], mb = b.modes?.[k];
    const ga = group(ma), gb = group(mb);
    if (ga !== gb) return ga - gb; // non-ranked always last, regardless of direction
    if (ga === 0 && ma.csr !== mb.csr) return sign * (ma.csr - mb.csr);
    return byName(a, b);
  });
}

// --- Rendering -------------------------------------------------------------
function tierIcon(m, alt) {
  if (!m.tierIconUrl) return '<span class="dash" aria-hidden="true">–</span>';
  const name = m.tierIconUrl.split('/').pop().replace(/\.png$/, '');
  return `<img class="ti" src="${esc(iconSrc(m.tierIconUrl))}" data-icon="${esc(name)}" width="40" height="40" loading="lazy" decoding="async" alt="${esc(alt)}">`;
}
function rankedBody(m, dim) {
  const name = rankName(m.tier, m.subTier);
  const peak = typeof m.peakCsr === 'number' ? `Peak ${m.peakCsr}` : '';
  let extra = '';
  if (m.nextTierCsr != null && m.progressPct != null && !dim) {
    const next = rankName(m.nextTier, m.nextSubTier);
    extra = `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${m.progressPct}" aria-label="${m.progressPct}% to ${esc(next)}"><i style="width:${m.progressPct}%"></i></div>
      <div class="next">${m.nextTierCsr - m.csr} to ${esc(next)}</div>`;
  } else if (/onyx/i.test(m.tier ?? '') && !dim) {
    extra = `<div class="next">${typeof m.allTimePeakCsr === 'number' ? `All-time ${m.allTimePeakCsr}` : 'Top tier'}</div>`;
  }
  return `${tierIcon(m, name)}<div class="meta"><div class="rank">${esc(name)}${dim ? '<span class="tag">Out of rotation</span>' : ''}</div>
    <div class="csr"><b>${m.csr}</b>${esc(peak)}</div>${extra}</div>`;
}
function modeCell(k, m) {
  const lbl = label(k);
  if (!m) m = { status: 'unavailable' };
  const tierCls = m.tier ? ` t-${String(m.tier).toLowerCase()}` : '';
  const staleCls = m.stale ? ' mode-stale' : '';
  const title = m.stale ? ` title="Showing last good data. ${esc(m.error ?? 'Latest fetch failed')}"` : m.status === 'error' ? ` title="${esc(m.error)}"` : '';
  let body;
  switch (m.status) {
    case 'ranked':
      body = rankedBody(m, false);
      break;
    case 'not_in_rotation':
      body = hasCsr(m) ? rankedBody(m, true) : `${tierIcon(m, 'Out of rotation')}<div class="meta"><div class="rank">Out of rotation</div><div class="next">Playlist not live right now</div></div>`;
      break;
    case 'placement': {
      const played = m.matchesPlayed ?? 0, total = played + (m.matchesRemaining ?? 0);
      const pips = Array.from({ length: total }, (_, i) => `<i class="${i < played ? 'on' : ''}"></i>`).join('');
      body = `${tierIcon(m, `Placement, ${m.matchesRemaining} matches left`)}<div class="meta"><div class="rank">Placement · ${m.matchesRemaining} left</div>
        <div class="pips" aria-hidden="true">${pips}</div><div class="next">${played} of ${total} played</div></div>`;
      break;
    }
    case 'unranked':
      body = `${tierIcon(m, 'Unranked')}<div class="meta"><div class="rank">Unranked</div><div class="next">${typeof m.allTimePeakCsr === 'number' ? `All-time peak ${m.allTimePeakCsr}` : 'No placements yet'}</div></div>`;
      break;
    case 'error':
      body = `<span class="dash" aria-hidden="true">!</span><div class="meta"><div class="rank">Error</div><div class="next">${esc(prettyError(m.error))}</div></div>`;
      break;
    default:
      body = `<span class="dash" aria-hidden="true">–</span><div class="meta"><div class="rank">Unavailable</div><div class="next">${m.reason === 'no_playlist_id' ? 'No playlist ID set' : 'No data'}</div></div>`;
  }
  return `<td class="mode s-${esc(m.status)}${tierCls}${staleCls}" data-label="${esc(lbl)}"${title}><div class="cell">${body}</div></td>`;
}
function prettyError(e) {
  if (!e) return 'Fetch failed';
  if (e === 'gamertag_not_found') return 'Gamertag not found';
  return e.replace(/^csr_request_failed: /, 'Request failed · ').replace(/^lookup_failed: /, 'Lookup failed · ');
}
function initials(gt) {
  return gt.replace(/#\d+$/, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}
function playerCell(p, i) {
  const av = p.emblemUrl
    ? `<img class="avatar" src="${esc(p.emblemUrl)}" data-initials="${esc(initials(p.gamertag))}" width="40" height="40" loading="lazy" decoding="async" alt="">`
    : `<span class="avatar initials" aria-hidden="true">${esc(initials(p.gamertag))}</span>`;
  const stale = p.stale ? `<span class="stale-dot" role="img" aria-label="Stale data" title="Stale: ${esc(p.error ?? 'latest fetch failed')}"></span>` : '';
  let sub = '';
  if (p.stale) sub = `<div class="sub">Stale · ${esc(prettyError(p.error))}</div>`;
  else if (p.error === 'gamertag_not_found') sub = '<div class="sub err">Gamertag not found</div>';
  else if (p.error) sub = `<div class="sub err">${esc(prettyError(p.error))}</div>`;
  return `<td class="td-player"><div class="player"><span class="rankpos">${i + 1}</span>${av}<div class="gt-wrap"><div class="gt" title="${esc(p.gamertag)}">${esc(p.gamertag)}${stale}</div>${sub}</div></div></td>`;
}

function renderHead() {
  const cols = [['gamertag', 'Player', 'col-player'], ...modeKeys().map((k) => [k, label(k), ''])];
  $('head').innerHTML = cols.map(([k, name, cls]) => {
    const active = state.sort === k;
    const aria = active ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    const rot = k !== 'gamertag' && state.data.modes[k]?.inRotation === false ? '<span class="rot">Off rotation</span>' : '';
    const arrow = active ? `<span class="arrow" aria-hidden="true">${state.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th scope="col" class="${cls}"${aria}><button type="button" data-sort="${k}">${esc(name)}${rot}${arrow}</button></th>`;
  }).join('');
  $('sort').innerHTML = cols.map(([k, name]) => `<option value="${k}"${state.sort === k ? ' selected' : ''}>${k === 'gamertag' ? 'Gamertag' : `${esc(name)} CSR`}</option>`).join('');
  $('dir-label').textContent = state.sort === 'gamertag' ? (state.dir === 'asc' ? 'A → Z' : 'Z → A') : state.dir === 'asc' ? 'Low → High' : 'High → Low';
}

const matches = (p, q) => p.gamertag.toLowerCase().includes(q);
function renderCount() {
  if (state.view === 'player') return ($('count').textContent = '');
  const q = state.q.trim().toLowerCase();
  const all = state.data?.players ?? [];
  const text = q ? `${all.filter((p) => matches(p, q)).length} of ${all.length} players` : `${all.length} players`;
  $('count').textContent = text + (state.note ? ` · ${state.note}` : '');
}

function renderRows() {
  const q = state.view === 'roster' ? state.q.trim().toLowerCase() : '';
  const all = state.data.players ?? [];
  const list = sorted(q ? all.filter((p) => p.gamertag.toLowerCase().includes(q)) : all);
  const keys = modeKeys();
  $('rows').innerHTML = list.map((p, i) => {
    const cls = p.stale ? 'row-stale' : p.error && !keys.some((k) => p.modes?.[k] && p.modes[k].status !== 'error') ? 'row-error' : '';
    return `<tr class="${cls}">${playerCell(p, i)}${keys.map((k) => modeCell(k, p.modes?.[k])).join('')}</tr>`;
  }).join('');
  renderCount();
  const empty = $('empty');
  empty.hidden = list.length > 0;
  if (!list.length) empty.innerHTML = all.length ? `<h2>No matches</h2><p>No gamertag contains “${esc(state.q)}”.</p>` : '<h2>No players yet</h2><p>Add gamertags to <code>accounts.txt</code>, then run <code>npm run fetch</code>.</p>';
}

function renderKpis() {
  const players = state.data.players ?? [];
  let best = null;
  let onyx = 0, ranked = 0, placement = 0;
  for (const p of players) {
    let isOnyx = false;
    for (const k of modeKeys()) {
      const m = p.modes?.[k];
      if (!m) continue;
      if (m.status === 'ranked') {
        ranked++;
        if (/onyx/i.test(m.tier)) isOnyx = true;
        if (!best || m.csr > best.csr) best = { csr: m.csr, who: p.gamertag, mode: label(k), tier: rankName(m.tier, m.subTier) };
      }
      if (m.status === 'placement') placement++;
    }
    if (isOnyx) onyx++;
  }
  const kpi = (k, v, s) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  $('kpis').innerHTML = [
    kpi('Highest CSR', best ? best.csr : '—', best ? `${esc(best.who)} · ${esc(best.mode)}` : 'No ranked data'),
    kpi('Onyx players', onyx, `of ${players.length} tracked`),
    kpi('Ranked entries', ranked, 'Player × playlist ranks'),
    kpi('In placements', placement, placement ? 'Matches still to play' : 'Everyone is placed'),
  ].join('');
}

function renderHeader() {
  const d = state.data;
  const season = $('season');
  const m = /^CsrSeason(\d+)-(\d+)$/.exec(d.csrSeasonId ?? '');
  season.hidden = !d.csrSeasonId;
  season.textContent = m ? `Season ${m[1]} · Split ${m[2]}` : d.csrSeasonId ?? '';
  $('sample').hidden = !d.sample;
  const last = Date.parse(d.lastUpdated);
  $('updated').innerHTML = Number.isFinite(last) ? `Last updated <strong>${esc(fmtWhen(d.lastUpdated))}</strong> (${ago(Date.now() - last)})` : 'Never updated';
  const warn = $('warn');
  const problems = [];
  if (!Number.isFinite(last) || Date.now() - last > STALE_HOURS * 3600e3) problems.push(`Data is over ${STALE_HOURS}h old`);
  if (d.lastAttempt && d.lastAttempt.ok === false) problems.push(`Last fetch failed${d.lastAttempt.at ? ` ${ago(Date.now() - Date.parse(d.lastAttempt.at))}` : ''}${d.lastAttempt.message === 'auth_required' ? ' · run npm run auth' : ''}`);
  warn.hidden = !problems.length || d.sample;
  warn.textContent = problems.join(' · ');
}

// --- Rotation / reset banner ---------------------------------------------------
// Ranked Snipers rotation and CSR reset dates (local time). Update when Halo announces new dates.
const CAL = {
  snipersOut: '2026-11-02',
  reset: '2026-11-03',
  snipersBack: '2027-02-02',
  snipersOut2: '2027-03-01',
};
const day = (iso) => new Date(`${iso}T00:00:00`);
const fmtDay = (iso) => day(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const CONFIG_HINT = 'Set <code>"rotation": { "snipers": %s }</code> in <code>config.json</code>.';

function bannerFor(d, now) {
  const inRot = d.modes?.snipers?.inRotation !== false;
  const t = now.getTime();
  const at = (iso) => day(iso).getTime();
  const DAY = 864e5;
  if (t >= at(CAL.snipersOut2) && inRot)
    return { key: `out2-${CAL.snipersOut2}`, level: 'warn', html: `Ranked Snipers left rotation on ${fmtDay(CAL.snipersOut2)}. ${CONFIG_HINT.replace('%s', 'false')}` };
  if (t >= at(CAL.snipersBack) && t < at(CAL.snipersOut2) && !inRot)
    return { key: `back-${CAL.snipersBack}`, level: 'warn', html: `Ranked Snipers is back in rotation as of ${fmtDay(CAL.snipersBack)}. ${CONFIG_HINT.replace('%s', 'true')}` };
  if (t >= at(CAL.snipersOut) && t < at(CAL.snipersBack) && inRot)
    return { key: `out-${CAL.snipersOut}`, level: 'warn', html: `Ranked Snipers left rotation on ${fmtDay(CAL.snipersOut)}, but this tracker still treats it as live. ${CONFIG_HINT.replace('%s', 'false')}` };
  if (t >= at(CAL.reset) && t < at(CAL.reset) + 7 * DAY)
    return { key: `reset-${CAL.reset}`, level: 'info', html: `New CSR season started ${fmtDay(CAL.reset)}. Expect lots of <strong>Placement</strong> cells for the next few days.` };
  if (t < at(CAL.snipersOut) && t >= at(CAL.snipersOut) - 30 * DAY)
    return { key: `soon-${CAL.snipersOut}`, level: 'info', html: `Heads up: <strong>Ranked Snipers leaves rotation ${fmtDay(CAL.snipersOut)}</strong> and CSR resets ${fmtDay(CAL.reset)}. Everyone goes back to placements after the reset.` };
  return null;
}

function renderBanner() {
  const el = $('banner');
  const test = new URLSearchParams(location.search).get('bannerDate');
  const now = test ? day(test) : new Date();
  const b = bannerFor(state.data, now);
  let dismissed = null;
  try { dismissed = localStorage.getItem('banner-dismissed'); } catch {}
  if (!b || (!test && dismissed === b.key)) { el.hidden = true; return; }
  el.className = `banner banner-${b.level}`;
  $('banner-text').innerHTML = b.html;
  $('banner-close').onclick = () => { try { localStorage.setItem('banner-dismissed', b.key); } catch {} el.hidden = true; };
  el.hidden = false;
}

function renderControls() {
  const player = state.view === 'player';
  $('sort').closest('label').hidden = player;
  $('dir').hidden = player;
  const hasRoster = (state.roster?.players ?? []).length > 0;
  const btn = $('roster-btn');
  btn.hidden = !hasRoster || (!player && !state.lookup);
  btn.textContent = player ? 'Roster' : state.lookup ? `← ${state.lookup.player.gamertag}` : 'Look up';
  const others = state.recent.filter((g) => !state.lookup || !sameTag(g, state.lookup.player.gamertag));
  const recent = $('recent');
  recent.hidden = !others.length;
  recent.innerHTML = others.length ? `<span class="recent-label">Recent</span>${others.map((g) => `<button type="button" class="chip chip-btn" data-player="${esc(g)}">${esc(g)}</button>`).join('')}` : '';
}

function render() {
  if (!state.data) return;
  renderHeader();
  renderBanner();
  renderHead();
  renderRows();
  renderControls();
}

/** Picks what the page shows: the looked-up player, or the daily roster from ranks.json. */
function applyView() {
  const r = state.roster;
  const l = state.lookup;
  if (state.view === 'roster' && r) state.data = r;
  else if (l) {
    state.view = 'player';
    state.data = { ...(r ?? {}), schemaVersion: 1, csrSeasonId: l.csrSeasonId, modes: l.modes, lastUpdated: l.fetchedAt, lastAttempt: null, sample: false, players: [l.player] };
  } else {
    state.view = 'roster';
    state.data = r;
  }
  if (!state.data) return;
  if (!modeKeys().includes(state.sort) && state.sort !== 'gamertag') state.sort = 'arena';
  $('empty').hidden = true;
  $('table').hidden = false;
  $('q').value = state.view === 'player' ? state.lookup.player.gamertag : state.q;
  renderKpis();
  render();
}

function showNoData(msg) {
  $('updated').textContent = 'No data yet';
  $('kpis').innerHTML = '';
  $('table').hidden = true;
  const empty = $('empty');
  empty.hidden = false;
  empty.innerHTML = `<h2>No ranked data yet</h2><p>${msg}</p>`;
}

/** The daily roster (data/ranks.json) is optional now: a missing file just means there is no roster view. */
async function loadRoster() {
  try {
    const res = await fetch('/api/ranks', { cache: 'no-cache', headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.roster = await res.json();
    const accent = state.roster.ui?.accentColor;
    if (accent && /^#[0-9a-f]{3,8}$/i.test(accent)) document.documentElement.style.setProperty('--accent', accent);
    return state.roster;
  } catch (e) {
    return null;
  }
}

function showLookupError(title, msg) {
  $('table').hidden = true;
  $('kpis').innerHTML = '';
  const empty = $('empty');
  empty.hidden = false;
  empty.innerHTML = `<h2>${esc(title)}</h2><p>${esc(msg)}</p>`;
  renderControls();
}

/** Looks one gamertag up through the local server. Resolves true when a player is on screen. */
async function lookupPlayer(raw) {
  const gamertag = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!gamertag || state.busy) return false;
  state.busy = true;
  $('go').disabled = true;
  $('count').textContent = `Looking up ${gamertag}…`;
  try {
    const res = await fetch(`/api/player?gamertag=${encodeURIComponent(gamertag)}`, { headers: { Accept: 'application/json' } });
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      // The hosted preview is static files only, so there is no lookup endpoint behind it.
      state.note = 'Live lookup needs the local app (npm start)';
      if (state.roster) {
        // Nothing to look up against, so the search box just filters the saved roster.
        state.view = 'roster';
        state.q = gamertag;
        writeUrl();
        applyView();
      } else showLookupError('Live lookup isn’t available here', 'This copy only serves saved data. Run the app locally with npm start to look up any player.');
      return false;
    }
    const body = await res.json();
    if (!res.ok) {
      showLookupError(res.status === 404 ? `No player named “${gamertag}”` : 'Couldn’t look that up', body.message ?? `HTTP ${res.status}`);
      return false;
    }
    state.note = '';
    state.lookup = body;
    state.view = 'player';
    remember(body.player.gamertag);
    writeUrl();
    applyView();
    return true;
  } catch (e) {
    showLookupError('Couldn’t look that up', `${e.message}. Is npm start running?`);
    return false;
  } finally {
    state.busy = false;
    $('go').disabled = false;
    renderCount();
  }
}

async function start() {
  await loadRoster();
  if (state.view === 'roster' && state.roster) return applyView();
  if (await lookupPlayer(state.player)) return;
  if (state.roster) {
    state.view = 'roster';
    writeUrl();
    applyView();
  }
}

// --- Events ----------------------------------------------------------------
let t;
// Typing narrows the roster; pressing Enter (or Look up) fetches that exact player.
$('q').addEventListener('input', (e) => {
  if (state.view !== 'roster') return;
  clearTimeout(t);
  t = setTimeout(() => {
    state.q = e.target.value;
    writeUrl();
    renderRows();
  }, 150);
});
$('lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(t); // a pending roster filter must not repaint over the lookup result
  lookupPlayer($('q').value);
});
$('recent').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-player]');
  if (b) lookupPlayer(b.dataset.player);
});
$('roster-btn').addEventListener('click', () => {
  if (state.view === 'player') {
    state.view = 'roster';
  } else if (state.lookup) state.view = 'player';
  else return;
  writeUrl();
  applyView();
});
function setSort(k, toggle) {
  if (toggle && state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  else if (state.sort !== k) state.dir = k === 'gamertag' ? 'asc' : 'desc';
  state.sort = k;
  writeUrl();
  render();
}
$('sort').addEventListener('change', (e) => setSort(e.target.value, false));
$('dir').addEventListener('click', () => {
  state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  writeUrl();
  render();
});
$('head').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]');
  if (b) setSort(b.dataset.sort, true);
});

readUrl();
$('q').value = state.view === 'roster' ? state.q : state.player;
start();
setInterval(async () => {
  if (await loadRoster() && state.view === 'roster') applyView();
}, 5 * 60 * 1000);
setInterval(() => state.data && renderHeader(), 60 * 1000);
