'use strict';

const API = 'https://api.deadlock-api.com';

// Pseudo-games at the hero's average win rate mixed into every item, so items with
// small samples can't score far from 0 on noise alone.
const ITEM_SHRINK = 300;
// Enhanced picks are ~1/8 of the data, so they lean harder on their prior
// (normal version + the tier's typical enhanced boost).
const ENHANCED_SHRINK = 600;
const ABILITY_SHRINK = 500;
const LOW_DATA_MATCHES = 600;

// A path step must be taken by at least this share of the previous step's players.
const ABILITY_MIN_SHARE = 0.12;
const ABILITY_MIN_MATCHES = 100;
// Street Brawl hands out ability points in blocks; steps this close in time are one block.
const ABILITY_BLOCK_GAP_S = 45;

const GRADES = [
  { key: 'best', label: 'Best', min: 2 },
  { key: 'good', label: 'Good', min: 0.75 },
  { key: 'mid', label: 'Mid', min: -0.75 },
  { key: 'bad', label: 'Bad', min: -2 },
  { key: 'avoid', label: 'Avoid', min: -Infinity },
];
const SLOTS = { weapon: 'Weapon', vitality: 'Vitality', spirit: 'Spirit' };
const RANK_NAMES = { 71: 'Emissary', 81: 'Oracle', 91: 'Phantom', 101: 'Ascendant' };
// Expert consensus = average within-tier percentile of (high-rank buy rate, published-build count).
const CORE_PCTILE = 0.85;
const COMMON_PCTILE = 0.65;
const CORE_BONUS = 1;
const COMMON_BONUS = 0.5;
// Floors before a signal counts at all, so the "top" of a tier nobody uses (e.g. Street Brawl-only
// Tier 5 items, in a handful of builds) isn't mistaken for expert consensus.
const MIN_BUILD_SHARE = 0.1;  // of the hero's most common build item
const MIN_EXPERT_PICK = 0.02; // share of the hero's high-rank games

// Camera scan: on-device OCR of the item names on the draft screen.
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
const OCR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' -!";
const SCAN_MAX_SIDE = 1600;
// Share of an item name's letters that must match a line of OCR text (short names need more).
const SCAN_MIN_SIMILARITY = 0.7;
const SCAN_MIN_SIMILARITY_SHORT = 0.8;

const PREFS_KEY = 'brawl-advisor-filters';
const UI_KEY = 'brawl-advisor-ui';
// Offers whose scores are closer than this are reported as a toss-up.
const CLOSE_CALL_PTS = 0.5;

const $ = (id) => document.getElementById(id);

const state = {
  heroes: [],
  upgrades: new Map(),
  sbHeroStats: new Map(),
  rankedHeroStats: new Map(),
  hero: null,
  view: null,
  loadToken: 0,
  itemView: 'board',
  boardTier: 'all',
  minGrade: 'all',
  offered: [],
  scanNote: '',
};

const requestCache = new Map();

// ---------- formatting ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
const fmtN = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const signClass = (v) => (v >= 0.75 ? 'pos' : v <= -0.75 ? 'neg' : '');
const gradeFor = (score) => GRADES.find((g) => score >= g.min);

function plainText(html) {
  // DOMParser never runs scripts or event handlers, so it is safe for untrusted markup.
  return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
}

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

// ---------- data access ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const url = `${API}${path}${qs.size ? `?${qs}` : ''}`;
  if (requestCache.has(url)) return requestCache.get(url);

  const request = (async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url);
      if (res.status === 429 && attempt < 2) {
        await sleep((Number(res.headers.get('retry-after')) || 5) * 1000);
        continue;
      }
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
        throw new Error(`${path} → ${res.status} ${msg}`);
      }
      return res.json();
    }
  })();
  requestCache.set(url, request);
  request.catch(() => requestCache.delete(url));
  return request;
}

function filters() {
  const days = Number($('f-days').value);
  // Rounded to the hour so repeat visits reuse cached responses.
  const hour = Math.floor(Date.now() / 3_600_000) * 3600;
  return { since: hour - days * 86400, badge: Number($('f-badge').value), mode: $('f-mode').value };
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const [id, v] of Object.entries(p)) {
      const el = $(id);
      if (el && [...el.options].some((o) => o.value === v)) el.value = v;
    }
    const ui = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    if (ui.itemView === 'board' || ui.itemView === 'list') state.itemView = ui.itemView;
    if (ui.boardTier === 'all' || Number.isInteger(ui.boardTier)) state.boardTier = ui.boardTier;
    if (ui.minGrade in GRADE_FILTERS) state.minGrade = ui.minGrade;
  } catch { /* storage unavailable */ }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ 'f-days': $('f-days').value, 'f-badge': $('f-badge').value, 'f-mode': $('f-mode').value }));
    localStorage.setItem(UI_KEY, JSON.stringify({ itemView: state.itemView, boardTier: state.boardTier, minGrade: state.minGrade }));
  } catch { /* storage unavailable */ }
}

async function loadHeroStats() {
  const f = filters();
  const [sb, ranked] = await Promise.all([
    getJson('/v1/analytics/hero-stats', { game_mode: 'street_brawl', min_unix_timestamp: f.since }),
    f.badge ? getJson('/v1/analytics/hero-stats', { game_mode: 'normal', min_unix_timestamp: f.since, min_average_badge: f.badge }).catch(() => []) : [],
  ]);
  state.sbHeroStats = new Map(sb.map((h) => [h.hero_id, h]));
  state.rankedHeroStats = new Map(ranked.map((h) => [h.hero_id, h]));
}

// ---------- analysis ----------

/**
 * Win rate of each item relative to the hero's baseline, then relative to the
 * average item of the same tier (the draft only offers choices within a tier).
 */
function analyzeItems(rows, heroStat, enhancedRows = null) {
  if (!rows || !heroStat?.matches) return null;
  const base = heroStat.wins / heroStat.matches;
  // `priorFor` gives the win rate a small sample is pulled toward, and how hard.
  const toStats = (rowList, priorFor) => {
    const out = new Map();
    for (const r of rowList || []) {
      const item = state.upgrades.get(r.item_id);
      if (!item?.item_tier || !r.matches) continue;
      const wr = r.wins / r.matches;
      const { prior, weight } = priorFor(r);
      const shrunk = (r.wins + weight * prior) / (r.matches + weight);
      out.set(r.item_id, {
        matches: r.matches,
        wr,
        margin: 1.96 * Math.sqrt((wr * (1 - wr)) / r.matches) * 100,
        shrunk,
        delta: (shrunk - base) * 100,
        pick: r.matches / heroStat.matches,
        tier: item.item_tier,
      });
    }
    return out;
  };
  const items = toStats(rows, () => ({ prior: base, weight: ITEM_SHRINK }));

  // Street Brawl enhanced draft picks: same item id, stronger stats. Kept separate so they don't
  // inflate the normal version, and scored against the normal tier baseline so both are comparable.
  // Typical win-rate boost of an enhanced pick over its normal version, per tier:
  const upliftSums = new Map();
  for (const r of enhancedRows || []) {
    const n = items.get(r.item_id);
    if (!n || !r.matches) continue;
    const u = upliftSums.get(n.tier) ?? { sum: 0, matches: 0 };
    u.sum += (r.wins / r.matches - n.wr) * r.matches;
    u.matches += r.matches;
    upliftSums.set(n.tier, u);
  }
  const uplift = new Map([...upliftSums].map(([tier, u]) => [tier, u.sum / u.matches]));
  const enhanced = toStats(enhancedRows, (r) => {
    const n = items.get(r.item_id);
    return n
      ? { prior: Math.min(0.99, Math.max(0.01, n.shrunk + (uplift.get(n.tier) ?? 0))), weight: ENHANCED_SHRINK }
      : { prior: base, weight: ITEM_SHRINK };
  });

  const tierStats = new Map();
  for (const s of items.values()) {
    const t = tierStats.get(s.tier) ?? { weighted: 0, matches: 0, picks: [] };
    t.weighted += s.delta * s.matches;
    t.matches += s.matches;
    t.picks.push(s.pick);
    tierStats.set(s.tier, t);
  }
  for (const t of tierStats.values()) {
    t.mean = t.weighted / t.matches;
    t.picks.sort((a, b) => a - b);
    t.medianPick = t.picks[Math.floor(t.picks.length / 2)];
  }
  for (const s of items.values()) s.rel = s.delta - tierStats.get(s.tier).mean;
  for (const [id, s] of enhanced) {
    if (tierStats.has(s.tier)) s.rel = s.delta - tierStats.get(s.tier).mean;
    else enhanced.delete(id);
  }

  return { base, matches: heroStat.matches, items, enhanced, uplift, tierStats };
}

/** Returns a lookup giving each entry's 1-based rank by `value` (highest first), or null when value is 0. */
function rankWithin(list, value) {
  const order = list.filter((e) => value(e) > 0).sort((a, b) => value(b) - value(a));
  const ranks = new Map(order.map((e, i) => [e, i + 1]));
  return (e) => ranks.get(e) ?? null;
}

const pctileOfRank = (rank, n) => (!rank ? 0 : n > 1 ? 1 - (rank - 1) / (n - 1) : 1);

function buildItemView(hero, sb, ranked, builds, mode) {
  const buildRank = new Map();
  [...(builds || [])].sort((a, b) => b.builds - a.builds).forEach((b, i) => buildRank.set(b.item_id, { count: b.builds, rank: i + 1 }));
  // The API gives per-item build counts but not the hero's total, so the most common item stands in for it.
  const maxBuilds = Math.max(0, ...(builds || []).map((b) => b.builds));

  const entries = [];
  for (const [id, s] of sb.items) {
    const item = state.upgrades.get(id);
    entries.push({
      id,
      item,
      sb: s,
      enh: sb.enhanced.get(id) ?? null,
      rk: ranked?.items.get(id) ?? null,
      build: buildRank.get(id) ?? null,
      draft: hero.item_draft_bucketing?.[item.class_name] ?? null,
    });
  }

  const tiers = new Map();
  for (const e of entries) {
    if (!tiers.has(e.item.item_tier)) tiers.set(e.item.item_tier, []);
    tiers.get(e.item.item_tier).push(e);
  }

  for (const list of tiers.values()) {
    // Ranked win rates are skewed against core items (first big buy vs. luxury buys by players
    // already ahead), so the expert signal is what strong players choose, not how often they win.
    const rkRank = rankWithin(list, (e) => (e.rk?.pick >= MIN_EXPERT_PICK ? e.rk.matches : 0));
    const buildTierRank = rankWithin(list, (e) => (e.build?.count >= MIN_BUILD_SHARE * maxBuilds ? e.build.count : 0));
    const tierHasExpertData = list.some((e) => rkRank(e) || buildTierRank(e));
    for (const e of list) {
      e.rkRank = rkRank(e);
      e.buildTierRank = buildTierRank(e);
      e.noExpertData = !tierHasExpertData;
      const parts = [pctileOfRank(e.buildTierRank, list.length)];
      if (ranked) parts.push(pctileOfRank(e.rkRank, list.length));
      e.consensus = parts.reduce((a, b) => a + b, 0) / parts.length;
      e.core = e.consensus >= CORE_PCTILE;
      const bonus = e.core ? CORE_BONUS : e.consensus >= COMMON_PCTILE ? COMMON_BONUS : 0;
      e.bonus = mode === 'expert' ? bonus : 0;
      e.score = e.sb.rel + e.bonus;
      e.grade = gradeFor(e.score);
      if (e.enh) {
        e.enh.score = e.enh.rel + e.bonus;
        e.enh.grade = gradeFor(e.enh.score);
      }
    }

    list.sort((a, b) => b.score - a.score);
    list.forEach((e, i) => { e.rank = i + 1; e.tierSize = list.length; });
    // Where the enhanced version would land among the normal picks of its tier.
    for (const e of list) if (e.enh) e.enh.rank = 1 + list.filter((o) => o.score > e.enh.score).length;
  }

  // How much this hero gets out of each item category, weighted by how often items are drafted.
  const lean = {};
  for (const slot of Object.keys(SLOTS)) {
    let w = 0, m = 0;
    for (const e of entries) if (e.item.item_slot_type === slot) { w += e.sb.rel * e.sb.matches; m += e.sb.matches; }
    lean[slot] = m ? w / m : 0;
  }

  return {
    entries,
    byId: new Map(entries.map((e) => [e.id, e])),
    tiers: new Map([...tiers].sort((a, b) => a[0] - b[0])),
    lean,
    buildsTotal: builds?.length ?? 0,
  };
}

function abilityPath(tree, mode, rootMatches, rootWr) {
  const children = new Map();
  for (const node of tree) {
    const parent = node.abilities.slice(0, -1).join(',');
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }

  const path = [];
  let key = '';
  let parentMatches = rootMatches;
  let parentWr = rootWr;
  for (;;) {
    const options = (children.get(key) || []).filter((n) => n.matches >= Math.max(ABILITY_MIN_MATCHES, ABILITY_MIN_SHARE * parentMatches));
    if (!options.length) break;
    const prior = parentWr;
    const value = (n) => (mode === 'pop' ? n.matches : (n.wins + ABILITY_SHRINK * prior) / (n.matches + ABILITY_SHRINK));
    const best = options.reduce((a, b) => (value(b) > value(a) ? b : a));
    path.push({ node: best, share: best.matches / parentMatches, alternatives: options.length - 1 });
    key = best.abilities.join(',');
    parentMatches = best.matches;
    parentWr = best.wins / best.matches;
  }
  return path;
}

// ---------- rendering: picker ----------

function heroImage(hero) {
  const im = hero.images || {};
  return im.icon_image_small_webp || im.icon_image_small || im.icon_hero_card_webp || im.icon_hero_card || '';
}

function renderPicker() {
  const q = $('hero-search').value.trim().toLowerCase();
  const html = state.heroes
    .filter((h) => state.sbHeroStats.has(h.id) && (!q || h.name.toLowerCase().includes(q)))
    .map((h) => {
      const s = state.sbHeroStats.get(h.id);
      return `<button class="hero-card" data-hero="${h.id}">
        <img src="${esc(heroImage(h))}" alt="" loading="lazy">
        <span class="name">${esc(h.name)}</span>
        <span class="wr">${pct(s.wins / s.matches)} · ${fmtN(s.matches)} games</span>
      </button>`;
    })
    .join('');
  $('hero-grid').innerHTML = html || '<p class="status">No heroes match.</p>';
}

// ---------- rendering: hero ----------

function renderHeroHead(hero, sb, ranked, lean) {
  const f = filters();
  const rankName = RANK_NAMES[f.badge];
  const leanRows = Object.entries(SLOTS).map(([slot, label]) => {
    const v = lean[slot];
    const width = Math.min(Math.abs(v) / 3, 1) * 50;
    const pos = v >= 0 ? `left:50%;width:${width}%` : `right:50%;width:${width}%`;
    return `<span>${label}</span><span class="bar"><i style="${pos};background:var(--${slot})"></i></span><span class="${signClass(v)}">${signed(v)}</span>`;
  }).join('');

  $('hero-head').innerHTML = `
    <img src="${esc(heroImage(hero))}" alt="">
    <div>
      <h2>${esc(hero.name)}</h2>
      <div class="meta">Street Brawl: ${pct(sb.base)} win rate over ${fmtN(sb.matches)} games</div>
      ${ranked ? `<div class="meta">${rankName}+ ranked: ${pct(ranked.base)} over ${fmtN(ranked.matches)} games</div>` : ''}
      ${hero.tags?.length ? `<div class="meta">${hero.tags.map(esc).join(' · ')}</div>` : ''}
    </div>
    <div>
      <div class="meta" style="margin-bottom:4px">Item category lean (avg pts vs tier)</div>
      <div class="lean">${leanRows}</div>
    </div>`;
}

/** Comma-separated search terms; a trailing "+" asks for the enhanced version (e.g. "bf+"). */
function searchTerms() {
  return $('item-search').value.split(',')
    .map((raw) => raw.trim().toLowerCase())
    .filter((t) => t.replace(/\+$/, '').trim())
    .map((t) => ({ text: t.replace(/\+$/, '').trim(), enhanced: t.endsWith('+') }));
}

/** How well a search term matches an item name: 0 = no match, higher = better. */
function matchScore(name, term) {
  const n = name.toLowerCase();
  const words = n.split(/[\s-]+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  const compact = term.replace(/[^a-z0-9]/g, '');
  if (n === term) return 100;
  if (compact.length >= 2 && !/\s/.test(term) && words.map((w) => w[0]).join('').startsWith(compact)) return 90; // "bf" → Burst Fire
  if (n.startsWith(term)) return 80;
  if (compact && words.some((w) => w.startsWith(compact))) return 70;
  const tokens = term.split(/\s+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => words.some((w) => w.startsWith(t)))) return 60;
  if (n.includes(term)) return 40;
  return 0;
}

function searchMatcher() {
  const terms = searchTerms();
  return (e) => !terms.length || terms.some((t) => matchScore(e.item.name, t.text) > 0);
}

/** The single best item for each search term, among the given entries. */
function bestMatches(entries, terms) {
  return terms.map((t) => {
    let best = null;
    let bestScore = 0;
    for (const e of entries) {
      const s = matchScore(e.item.name, t.text);
      if (s > bestScore || (s === bestScore && s > 0 && e.score > best.score)) { best = e; bestScore = s; }
    }
    return best && { e: best, enhanced: t.enhanced && !!best.enh };
  }).filter(Boolean);
}

const GRADE_FILTERS = { all: 'All', mid: 'Mid+', good: 'Good+' };
const gradeIndex = (g) => GRADES.findIndex((x) => x.key === g.key);

/**
 * Grade filter for the board, on the normal version only: enhanced versions mostly grade Good+
 * (they're stronger by design), so counting them would keep nearly every tile.
 */
function passesGradeFilter(e) {
  if (state.minGrade === 'all') return true;
  return gradeIndex(e.grade) <= (state.minGrade === 'good' ? 1 : 2);
}

function boardTierList() {
  const v = state.view;
  return state.boardTier === 'all' ? [...v.items.tiers.keys()] : [state.boardTier];
}

const itemImage = (item) => item.shop_image_webp || item.image_webp || item.image || '';

function renderItems() {
  const board = state.itemView === 'board';
  $('board-view').hidden = !board;
  $('list-view').hidden = board;
  document.querySelectorAll('.view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.itemView));
  if (board) renderBoard();
  else renderTiers();
}

// ---------- rendering: draft board ----------

function renderBoard() {
  const v = state.view;
  const tiers = [...v.items.tiers.keys()];
  if (state.boardTier !== 'all' && !v.items.tiers.has(state.boardTier)) state.boardTier = 'all';
  const tierLabel = (t) => `Tier ${t}`;

  $('tier-tabs').innerHTML = [
    `<button data-tier="all" class="${state.boardTier === 'all' ? 'active' : ''}">All</button>`,
    ...tiers.map((t) => `<button data-tier="${t}" class="${state.boardTier === t ? 'active' : ''}">${tierLabel(t)}</button>`),
  ].join('');

  $('grade-filter').innerHTML = `<span class="lbl">Show</span>` + Object.entries(GRADE_FILTERS)
    .map(([key, label]) => `<button data-grade="${key}" class="${state.minGrade === key ? 'active' : ''}">${label}</button>`).join('');

  const terms = searchTerms();
  const matchesSearch = searchMatcher();
  // Draft offers can mix tiers, so a search looks across every tier regardless of the selected tab.
  const shownTiers = terms.length ? tiers : boardTierList();
  // While searching, the grade filter is ignored so a typed item is always found.
  const matched = shownTiers.flatMap((t) => v.items.tiers.get(t).filter(matchesSearch));
  const visible = new Set(terms.length ? matched : matched.filter(passesGradeFilter));
  const hidden = matched.length - visible.size;
  const topMatches = new Set(bestMatches(matched, terms).map((m) => m.e));

  const html = shownTiers.map((t) => {
    const list = v.items.tiers.get(t).filter((e) => visible.has(e));
    const rows = Object.entries(SLOTS).map(([slot, label]) => {
      const tiles = list.filter((e) => e.item.item_slot_type === slot);
      if (!tiles.length) return '';
      return `<div class="slot-row"><div class="slot-label ${slot}">${label}</div><div class="tiles">${tiles.map((e) => tileHtml(e, topMatches.has(e))).join('')}</div></div>`;
    }).join('');
    if (!rows) return '';
    return `<div class="board-tier">${shownTiers.length > 1 ? `<h3>${tierLabel(t)}</h3>` : ''}${rows}</div>`;
  }).join('');

  const hiddenNote = hidden
    ? `<p class="hint">${hidden} weaker item${hidden === 1 ? '' : 's'} hidden — if a normal offer isn't on the board, it's a weak pick.
        For an enhanced offer, type its name with <kbd>+</kbd> (e.g. <kbd>cs+</kbd>) to check it.</p>`
    : '';
  $('board').innerHTML = hiddenNote + (html || '<p class="status">No items match.</p>');
  renderTray();
}

// Offer keys: "<itemId>" for the normal version, "<itemId>:e" for the enhanced one.
const offerKey = (id, enhanced = false) => `${id}${enhanced ? ':e' : ''}`;

function resolveOffer(key) {
  const [id, variant] = key.split(':');
  const e = state.view.items.byId.get(Number(id));
  if (!e) return null;
  if (variant === 'e') return e.enh ? { key, e, enhanced: true, score: e.enh.score, grade: e.enh.grade } : null;
  return { key, e, enhanced: false, score: e.score, grade: e.grade };
}

function tileHtml(e, isTopMatch = false) {
  const star = e.draft?.bucket === 'Good' ? ' · ★ Valve "Good"' : '';
  const normalKey = offerKey(e.id);
  const enhKey = offerKey(e.id, true);
  const enhStrip = e.enh
    ? `<button class="tile-enh g-${e.enh.grade.key}${state.offered.includes(enhKey) ? ' offered' : ''}" data-key="${enhKey}"
        title="Enhanced ${esc(e.item.name)} · ${e.enh.grade.label} ${signed(e.enh.score)}${e.enh.matches < LOW_DATA_MATCHES ? ' · low data' : ''}">✦ ${e.enh.grade.label}</button>`
    : '';
  return `<div class="tile t-${e.grade.key}${state.offered.includes(normalKey) ? ' offered' : ''}${isTopMatch ? ' top-match' : ''}">
    <button class="tile-main" data-key="${normalKey}" title="${esc(e.item.name)} · ${e.grade.label} ${signed(e.score)}${star}">
      <span class="t-grade">${e.grade.label}</span>
      ${e.core ? '<span class="core-tag">Core</span>' : ''}
      <img src="${esc(itemImage(e.item))}" alt="" loading="lazy">
      <span class="t-name">${esc(e.item.name)}</span>
    </button>
    ${enhStrip}
  </div>`;
}

function shortReason(o) {
  const v = state.view;
  const e = o.e;
  const s = o.enhanced ? e.enh : e.sb;
  const parts = [`won ${pct(s.wr)} vs ${pct(v.sb.base)} avg`];
  if (o.enhanced) parts.push(`would rank #${e.enh.rank}/${e.tierSize} in tier ${e.item.item_tier}`, `normal version: ${e.grade.label}`);
  else parts.push(`#${e.rank}/${e.tierSize} in tier ${e.item.item_tier}`);
  if (e.core) parts.push('Core');
  if (!o.enhanced && e.rkRank) parts.push(`#${e.rkRank} ${RANK_NAMES[filters().badge]}+ buy`);
  if (!o.enhanced && e.draft?.bucket === 'Good') parts.push('★ Valve "Good"');
  if (s.matches < LOW_DATA_MATCHES) parts.push('low data');
  return parts.join(' · ');
}

const offerName = (o) => `${esc(o.e.item.name)}${o.enhanced ? ' <span class="enh-tag">✦ Enhanced</span>' : ''}`;

function renderTray() {
  const v = state.view;
  const offered = state.offered.map(resolveOffer).filter(Boolean).sort((a, b) => b.score - a.score);
  if (!offered.length) {
    $('tray').innerHTML = '';
    return;
  }

  const [top, next] = offered;
  const name = (o) => `<b>${offerName(o)}</b>`;
  let verdict;
  if (!next) verdict = `${name(top)} is <span class="grade g-${top.grade.key}">${top.grade.label}</span> on ${esc(v.hero.name)} — add the other options to compare.`;
  else if (top.score - next.score < CLOSE_CALL_PTS) verdict = `Close call: ${name(top)} or ${name(next)} — pick whichever fits your build.`;
  else verdict = `Take ${name(top)} <span class="pos">${signed(top.score - next.score)} pts</span> over ${offerName(next)}`;

  const offeredTiers = new Set(offered.map((o) => o.e.item.item_tier));
  const mixedNote = offeredTiers.size > 1
    ? `<p class="hint">Mixed tiers (${[...offeredTiers].sort().map((t) => `T${t}`).join(', ')}): each score compares an item with its own tier, so treat this verdict as a rough guide.</p>`
    : '';

  $('tray').innerHTML = `
    <div class="verdict">${verdict}<button class="clear" data-action="clear">Clear (Esc)</button></div>
    ${state.scanNote ? `<p class="hint">📷 ${state.scanNote}</p>` : ''}
    ${mixedNote}
    <div class="offer-list">${offered.map((o, i) => `
      <button class="offer" data-key="${o.key}" title="Remove from offer">
        <span class="rk">${i + 1}</span>
        <img src="${esc(itemImage(o.e.item))}" alt="">
        <span>${offerName(o)}<span class="o-why">${shortReason(o)}</span></span>
        <span class="sc">${signed(o.score)}</span>
        <span class="grade g-${o.grade.key}">${o.grade.label}</span>
      </button>`).join('')}
    </div>`;
}

function toggleOffer(key) {
  state.offered = state.offered.includes(key) ? state.offered.filter((x) => x !== key) : [...state.offered, key];
  renderBoard();
}

function clearOffer() {
  state.offered = [];
  state.scanNote = '';
  if (state.view && state.itemView === 'board') renderBoard();
}

function setBoardTier(tier) {
  state.boardTier = tier;
  savePrefs();
  renderBoard();
}

// ---------- rendering: full list ----------

function renderTiers() {
  const v = state.view;
  const matchesSearch = searchMatcher();

  const cols = [];
  for (const [tier, list] of v.items.tiers) {
    const shown = list.filter(matchesSearch);
    if (!shown.length) continue;
    const rows = shown.map((e) => {
      const slot = e.item.item_slot_type;
      const flags = [
        e.core ? 'core' : '',
        e.sb.matches < LOW_DATA_MATCHES ? 'low data' : '',
        e.draft?.bucket === 'Good' ? '★' : '',
      ].filter(Boolean).join(' ');
      return `<div class="item slot-${esc(slot)}${state.openItem === e.id ? ' open' : ''}" data-item="${e.id}">
        <button class="item-row" title="${esc(SLOTS[slot] || slot)} · click for details">
          <img src="${esc(itemImage(e.item))}" alt="" loading="lazy">
          <span class="nm">${esc(e.item.name)}${flags ? `<span class="flag">${flags}</span>` : ''}</span>
          <span class="sc">${signed(e.score)}</span>
          <span class="grade g-${e.grade.key}">${e.grade.label}</span>
          ${e.enh ? `<span class="grade mini g-${e.enh.grade.key}" title="Enhanced version: ${e.enh.grade.label} ${signed(e.enh.score)}">✦ ${e.enh.grade.label}</span>` : '<span></span>'}
        </button>
        ${state.openItem === e.id ? whyHtml(e) : ''}
      </div>`;
    }).join('');
    cols.push(`<div class="tier"><h3>Tier ${tier}<small>${list.length} items</small></h3>${rows}</div>`);
  }
  $('tiers').innerHTML = cols.join('') || '<p class="status">No items match that filter.</p>';
}

function whyHtml(e) {
  const v = state.view;
  const hero = esc(v.hero.name);
  const s = e.sb;
  const tier = e.item.item_tier;
  const tierStat = v.sb.tierStats.get(tier);
  const reasons = [];

  reasons.push(`Drafted in <b>${fmtN(s.matches)}</b> ${hero} Street Brawl games (${pct(s.pick)}) — won <b>${pct(s.wr)}</b> <span class="moe">(±${s.margin.toFixed(1)})</span> vs ${hero}'s ${pct(v.sb.base)} average.`);
  reasons.push(`Street Brawl: <span class="${signClass(s.rel)}">${signed(s.rel)} pts</span> vs a typical Tier ${tier} pick. Overall #${e.rank} of ${e.tierSize} Tier ${tier} items for ${hero}.`);
  if (s.matches < LOW_DATA_MATCHES) reasons.push(`Small sample — treat this grade as a rough hint.`);

  if (s.pick >= tierStat.medianPick * 2.5) reasons.push(`One of the most-drafted Tier ${tier} items for ${hero}, so players like it when it's offered.`);
  else if (s.pick <= tierStat.medianPick * 0.35) reasons.push(`Rarely drafted on ${hero}.`);

  const rankName = RANK_NAMES[filters().badge];
  if (e.noExpertData) {
    reasons.push(`No Tier ${tier} item shows up meaningfully in ${hero}'s ranked games or published builds${tier === 5 ? ' (Legendary items only exist in Street Brawl)' : ''}, so this grade is Street Brawl results only.`);
  } else {
    if (v.ranked) {
      if (e.rkRank) reasons.push(`${rankName}+ players buy it in ${pct(e.rk.pick)} of their ${hero} games — #${e.rkRank} of ${e.tierSize} Tier ${tier} items.`);
      else if (e.rk) reasons.push(`${rankName}+ players rarely buy it on ${hero} (${pct(e.rk.pick)} of games) — too rare to count as an expert pick.`);
      else reasons.push(`${rankName}+ players almost never buy it on ${hero}.`);
    }
    if (e.buildTierRank) reasons.push(`In ${fmtN(e.build.count)} published ${hero} builds — #${e.buildTierRank} of ${e.tierSize} Tier ${tier} items.`);
    else if (e.build) reasons.push(`Only in ${fmtN(e.build.count)} published ${hero} builds — too few to count.`);
    else if (v.items.buildsTotal) reasons.push(`Not in any published ${hero} builds.`);
  }

  const counted = state.view.mode === 'expert';
  if (e.core) {
    reasons.push(`<span class="core-tag">Core</span> Strong players and builds rely on it${counted ? ` (+${CORE_BONUS} pt to the score)` : ''}.`);
    if (s.rel <= -0.75) reasons.push(`Its Street Brawl results lag behind its reputation: it's not a mistake, but other Tier ${tier} options have been doing better in this mode.`);
  } else if (e.consensus >= COMMON_PCTILE) {
    reasons.push(`Commonly picked by strong players and builds${counted ? ` (+${COMMON_BONUS} pt to the score)` : ''}.`);
  }

  if (e.draft?.bucket === 'Good') reasons.push(`★ The game's own draft table tags it as a "Good" item for ${hero}.`);
  else if (e.draft && e.draft.weight < 1) reasons.push(`The draft table offers it to ${hero} less often than usual.`);

  const slot = e.item.item_slot_type;
  const lean = v.items.lean[slot];
  if (Math.abs(lean) >= 0.5) {
    reasons.push(`${SLOTS[slot]} items as a whole are ${lean > 0 ? 'above' : 'below'} average on ${hero} (<span class="${signClass(lean)}">${signed(lean)}</span>).`);
  }


  const desc = plainText(e.item.description?.desc)
    || (e.item.tooltip_sections || []).flatMap((t) => t.section_attributes || []).map((a) => plainText(a.loc_string)).filter(Boolean).join(' ');

  return `<div class="why">
    <ul>${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
    ${enhancedHtml(e)}
    ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
  </div>`;
}

function enhancedHtml(e) {
  if (!e.enh) return '';
  const v = state.view;
  const x = e.enh;
  const adds = enhancementText(e.item);
  const tier = e.item.item_tier;
  const boost = (v.sb.uplift.get(tier) ?? 0) * 100;
  const expected = e.sb.wr * 100 + boost;
  // Does the observed result stand out from "normal version + usual boost", or is it within noise?
  const gap = x.wr * 100 - expected;
  const noise = Math.hypot(x.margin, e.sb.margin);
  const verdict = Math.abs(gap) <= noise
    ? `That's within noise of what you'd expect (normal ${pct(e.sb.wr)} + the usual Tier ${tier} enhanced boost of ${signed(boost)}), so the grade leans on that expectation.`
    : `That's clearly ${gap > 0 ? 'better' : 'worse'} than expected from the normal version (${pct(e.sb.wr)}) plus the usual Tier ${tier} enhanced boost (${signed(boost)}).`;
  return `<div class="enh-why">
    <span class="enh-tag">✦ Enhanced</span> <span class="grade g-${x.grade.key}">${x.grade.label}</span>
    Drafted ${fmtN(x.matches)} times — won <b>${pct(x.wr)}</b> <span class="moe">(±${x.margin.toFixed(1)})</span>
    → <span class="${signClass(x.rel)}">${signed(x.rel)} pts</span> vs a typical Tier ${tier} pick; would rank #${x.rank} of ${e.tierSize}.
    ${verdict}
    ${adds ? `<div class="enh-adds">Enhancement adds: ${esc(adds)}</div>` : ''}
  </div>`;
}

/** Human-readable list of the stat bonuses an enhanced draft pick gets, from the item's upgrade data. */
function enhancementText(item) {
  const out = [];
  for (const u of item.upgrades || []) {
    for (const p of u.property_upgrades || []) {
      const prop = item.properties?.[p.name] || {};
      const label = prop.label || p.name.replace(/([a-z])([A-Z])/g, '$1 $2');
      const raw = String(p.bonus);
      const num = parseFloat(raw);
      if (!Number.isFinite(num) || num === 0) continue;
      const unit = /[a-z%]$/i.test(raw) ? '' : (prop.postfix || '').trim();
      out.push(`${label} ${num > 0 ? '+' : ''}${raw}${unit}`);
    }
  }
  return out.join(', ');
}

function renderAbilities() {
  const v = state.view;
  const mode = document.querySelector('input[name="ab-mode"]:checked').value;
  const el = $('abilities');
  if (!v.tree?.length) {
    el.innerHTML = '<p class="status">No ability order data for this hero in this period.</p>';
    return;
  }

  const path = abilityPath(v.tree, mode, v.sb.matches, v.sb.base);
  const ability = (id) => v.abilities.get(id) || { name: `Ability ${id}`, image: '' };
  const chip = (id, extra = '') => {
    const a = ability(id);
    return `<span class="ab-chip">${a.image ? `<img src="${esc(a.image)}" alt="">` : ''}${esc(a.name)}${extra}</span>`;
  };

  // Abilities start unlocked in Street Brawl, so every point is an upgrade (n = upgrade number).
  const points = new Map();
  const firstUpgradeOrder = [];
  const lastPointAt = new Map();
  const steps = path.map(({ node, share, alternatives }, i) => {
    const id = node.abilities[node.abilities.length - 1];
    const n = (points.get(id) || 0) + 1;
    points.set(id, n);
    lastPointAt.set(id, i);
    if (n === 1) firstUpgradeOrder.push(id);
    return { id, n, node, share, alternatives };
  });

  // Max priority: most points first, ties broken by which got its last point earliest.
  const priority = [...points.keys()].sort((a, b) => points.get(b) - points.get(a) || lastPointAt.get(a) - lastPointAt.get(b));
  const neverTaken = [...v.abilities.keys()].filter((id) => !points.has(id) && v.signatures.has(id));

  // A path can follow a branch until too few games remain to rank the next step, leaving upgrades
  // out. Fill those in using the order the most popular path takes them.
  const cap = upgradeCap(v.tree);
  const remaining = new Map([...v.signatures].map((id) => [id, cap - (points.get(id) || 0)]));
  const fillOrder = [
    ...abilityPath(v.tree, 'pop', v.sb.matches, v.sb.base).map((p) => p.node.abilities[p.node.abilities.length - 1]),
    ...[...v.signatures].flatMap((id) => Array(cap).fill(id)),
  ];
  const filled = new Map(points);
  const fill = [];
  for (const id of fillOrder) {
    if (!(remaining.get(id) > 0)) continue;
    remaining.set(id, remaining.get(id) - 1);
    filled.set(id, (filled.get(id) || 0) + 1);
    fill.push({ id, n: filled.get(id) });
  }

  const blocks = [];
  for (const s of steps) {
    const last = blocks[blocks.length - 1];
    if (!last || s.node.avg_upgrade_time_s - last.start > ABILITY_BLOCK_GAP_S) blocks.push({ start: s.node.avg_upgrade_time_s, steps: [s] });
    else last.steps.push(s);
  }

  const final = path[path.length - 1]?.node;
  el.innerHTML = `
    <div class="ab-summary"><b>First upgrade order:</b> ${firstUpgradeOrder.map((id) => chip(id)).join('<span class="arrow">→</span>')}</div>
    <div class="ab-summary"><b>Upgrade priority:</b> ${priority.map((id) => chip(id, ` <span class="lvl">(${points.get(id)} upgrade${points.get(id) === 1 ? '' : 's'})</span>`)).join('<span class="arrow">&gt;</span>')}
      ${neverTaken.length ? `<span class="lvl">· no upgrades in data: ${neverTaken.map((id) => esc(ability(id).name)).join(', ')}</span>` : ''}</div>
    <div class="blocks">${blocks.map((b, i) => `
      <div class="block">
        <div class="bt">Point block ${i + 1}</div>
        ${b.steps.map((s) => `<div class="step" title="${pct(s.share)} of players at this point took this; ${s.alternatives} other common option(s)">
          ${ability(s.id).image ? `<img src="${esc(ability(s.id).image)}" alt="">` : ''}
          <span>${esc(ability(s.id).name)} <span class="lvl">upgrade ${s.n}</span></span>
          <span class="swr">${pct(s.node.wins / s.node.matches)}</span>
        </div>`).join('')}
      </div>`).join('')}
      ${fill.length ? `
      <div class="block filler">
        <div class="bt">Remaining upgrades</div>
        ${fill.map((s) => `<div class="step" title="Too few games went this way to rank these; order follows the most popular path">
          ${ability(s.id).image ? `<img src="${esc(ability(s.id).image)}" alt="">` : ''}
          <span>${esc(ability(s.id).name)} <span class="lvl">upgrade ${s.n}</span></span>
          <span class="swr">—</span>
        </div>`).join('')}
      </div>` : ''}
    </div>
    ${final ? `<p class="status">${pct(final.wins / final.matches)} win rate across ${fmtN(final.matches)} games that followed this path.
      ${fill.length ? `After ${path.length} upgrades too few games went this way to rank the next step, so the last ${fill.length} follow the most popular order.` : ''}
      Within a block the game sorts points by ability, so only which abilities you put points into matters, not the order inside the block.</p>` : ''}`;
}

/** Most upgrades any single ability receives anywhere in the order data. */
function upgradeCap(tree) {
  let cap = 0;
  for (const node of tree) {
    const counts = new Map();
    for (const id of node.abilities) counts.set(id, (counts.get(id) || 0) + 1);
    for (const c of counts.values()) cap = Math.max(cap, c);
  }
  return cap;
}

function renderHero() {
  const v = state.view;
  renderHeroHead(v.hero, v.sb, v.ranked, v.items.lean);
  renderItems();
  renderAbilities();
}

// ---------- camera scan ----------

const scan = { stream: null, workerPromise: null, readerReady: false, busy: false };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't download the text reader. Check your connection."));
    document.head.append(s);
  });
}

/** Lazily loads Tesseract.js and one reusable worker, set up for scattered UI text. */
function ocrWorker() {
  if (!scan.workerPromise) {
    scan.workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      const worker = await window.Tesseract.createWorker('eng');
      await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: OCR_WHITELIST });
      scan.readerReady = true;
      return worker;
    })();
    scan.workerPromise.catch(() => { scan.workerPromise = null; });
  }
  return scan.workerPromise;
}

function setScanStatus(msg, isError = false) {
  $('scan-status').textContent = msg;
  $('scan-status').classList.toggle('error', isError);
}

function idleScanStatus() {
  if (!scan.readerReady) setScanStatus('Preparing the text reader… (first time downloads about 10 MB)');
  else setScanStatus(scan.stream ? 'Point at the item names on the draft screen and tap Capture.' : 'Tap "Use a photo" to scan a picture or screenshot of the draft.');
}

async function openScanner() {
  if (!state.view) return;
  if (state.itemView !== 'board') {
    state.itemView = 'board';
    renderItems();
  }
  $('scan').hidden = false;
  idleScanStatus();
  ocrWorker().then(() => { if (!scan.busy) idleScanStatus(); }, (err) => setScanStatus(err.message, true));

  const video = $('scan-video');
  // Browsers only expose the camera on https:// (or localhost) pages.
  if (!scan.stream && navigator.mediaDevices?.getUserMedia && window.isSecureContext) {
    try {
      scan.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = scan.stream;
      await video.play();
    } catch (err) {
      scan.stream = null;
      setScanStatus(`Camera unavailable (${err.message}). Use a photo instead.`, true);
    }
  }
  if ($('scan').hidden) return closeScanner(); // closed while the camera was starting
  video.hidden = !scan.stream;
  $('scan-capture').hidden = !scan.stream;
  if (scan.stream && !scan.busy) idleScanStatus();
}

function closeScanner() {
  $('scan').hidden = true;
  if (scan.stream) {
    for (const track of scan.stream.getTracks()) track.stop();
    scan.stream = null;
  }
  $('scan-video').srcObject = null;
}

/** Draws the source scaled down to SCAN_MAX_SIDE and converted to greyscale, which reads better. */
function prepareScanCanvas(source, width, height) {
  const scale = Math.min(1, SCAN_MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function captureFrame() {
  const video = $('scan-video');
  if (!video.videoWidth) return;
  runScan(prepareScanCanvas(video, video.videoWidth, video.videoHeight));
}

async function scanImageFile(file) {
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file);
    await runScan(prepareScanCanvas(bitmap, bitmap.width, bitmap.height));
  } catch (err) {
    setScanStatus(`Couldn't open that image (${err.message}).`, true);
  }
}

async function runScan(canvas) {
  if (scan.busy) return;
  scan.busy = true;
  $('scan-capture').disabled = true;
  try {
    setScanStatus(scan.readerReady ? 'Reading…' : 'Preparing the text reader, then reading…');
    const worker = await ocrWorker();
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const lines = (data.blocks || [])
      .flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
      .map((l) => ({ text: l.text.trim(), box: l.bbox }))
      .filter((l) => l.text);
    const found = matchOfferLines(lines);
    if (!found.length) {
      const read = lines.map((l) => l.text).filter((t) => t.length > 2).join(' | ');
      setScanStatus(`No item names recognised${read ? ` (read: "${read}")` : ''}. Get the names in frame, hold steady and try again.`, true);
      return;
    }
    state.offered = found.map((f) => offerKey(f.e.id, f.enhanced));
    state.scanNote = `Scanned: ${found.map((f) => f.e.item.name + (f.enhanced ? ' (enhanced)' : '')).join(', ')} — wrong? tap to remove, or type to add.`;
    closeScanner();
    renderBoard();
  } catch (err) {
    setScanStatus(`Scan failed: ${err.message}`, true);
  } finally {
    scan.busy = false;
    $('scan-capture').disabled = false;
  }
}

const lettersOnly = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

/** Edit distance between `needle` and its best-matching stretch of `hay` (hay may hold extra text). */
function substringDistance(needle, hay) {
  let prev = new Array(hay.length + 1).fill(0);
  for (let i = 1; i <= needle.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hay.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(...prev);
}

/**
 * Turns OCR lines into offered items: each line is fuzzy-matched against this hero's draft items
 * (tolerating clipped or misread letters), and an "Enhanced" label marks the nearest item.
 */
function matchOfferLines(lines) {
  const candidates = state.view.items.entries.map((e) => ({ e, letters: lettersOnly(e.item.name) }));
  const center = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  const found = new Map();
  const enhancedMarks = [];

  for (const line of lines) {
    const text = lettersOnly(line.text);
    if (text.length >= 6 && substringDistance('enhanced', text) <= 2) enhancedMarks.push(center(line.box));
    if (text.length < 4) continue;

    let best = null;
    for (const c of candidates) {
      if (text.length < c.letters.length * 0.6) continue;
      const sim = 1 - substringDistance(c.letters, text) / c.letters.length;
      if (!best || sim > best.sim) best = { e: c.e, sim };
    }
    const needed = best && best.e.item.name.length <= 8 ? SCAN_MIN_SIMILARITY_SHORT : SCAN_MIN_SIMILARITY;
    if (best && best.sim >= needed && !(found.get(best.e.id)?.sim >= best.sim)) {
      found.set(best.e.id, { e: best.e, sim: best.sim, at: center(line.box), enhanced: false });
    }
  }

  const items = [...found.values()];
  for (const mark of enhancedMarks) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const f of items) {
      const d = Math.hypot(f.at.x - mark.x, f.at.y - mark.y);
      if (d < nearestDist) { nearest = f; nearestDist = d; }
    }
    if (nearest?.e.enh) nearest.enhanced = true;
  }
  return items.sort((a, b) => a.at.x - b.at.x);
}

// ---------- navigation ----------

async function openHero(heroId) {
  const hero = state.heroes.find((h) => h.id === heroId);
  if (!hero) return showPicker();

  state.hero = hero;
  state.openItem = null;
  state.offered = [];
  $('picker').hidden = true;
  $('hero-view').hidden = true;
  $('back').hidden = false;
  document.title = `${hero.name} · Brawl Draft Advisor`;

  const token = ++state.loadToken;
  const f = filters();
  setStatus(`Loading ${hero.name}…`);

  try {
    const sbParams = { hero_id: hero.id, game_mode: 'street_brawl', min_unix_timestamp: f.since };
    const [sbRows, enhancedRows, rankedRows, builds, tree, heroItems] = await Promise.all([
      getJson('/v1/analytics/item-stats', { ...sbParams, enhanced_items: 'exclude' }),
      getJson('/v1/analytics/item-stats', { ...sbParams, enhanced_items: 'only' }).catch(() => null),
      f.badge ? getJson('/v1/analytics/item-stats', { hero_id: hero.id, game_mode: 'normal', min_unix_timestamp: f.since, min_average_badge: f.badge }).catch(() => null) : null,
      getJson('/v1/analytics/build-item-stats', { hero_id: hero.id }).catch(() => null),
      getJson('/v1/analytics/ability-order-tree', { ...sbParams, min_matches: ABILITY_MIN_MATCHES }).catch(() => null),
      getJson(`/v1/assets/items/by-hero-id/${hero.id}`).catch(() => []),
    ]);
    if (token !== state.loadToken) return;

    const sb = analyzeItems(sbRows, state.sbHeroStats.get(hero.id), enhancedRows);
    if (!sb) throw new Error(`No Street Brawl data for ${hero.name} in this period.`);
    const ranked = analyzeItems(rankedRows, state.rankedHeroStats.get(hero.id));

    const signatures = new Set();
    const sigClasses = new Set(['signature1', 'signature2', 'signature3', 'signature4'].map((k) => hero.items?.[k]).filter(Boolean));
    const abilities = new Map();
    for (const a of heroItems) {
      if (a.type !== 'ability') continue;
      abilities.set(a.id, { name: a.name, image: a.image_webp || a.image });
      if (sigClasses.has(a.class_name)) signatures.add(a.id);
    }

    state.view = { hero, sb, ranked, tree, abilities, signatures, mode: f.mode, items: buildItemView(hero, sb, ranked, builds, f.mode) };
    renderHero();
    $('hero-view').hidden = false;
    const missing = [!enhancedRows ? 'enhanced-item stats' : '', f.badge && !ranked ? 'expert-rank data' : '', !builds ? 'published builds' : '', !tree ? 'ability orders' : ''].filter(Boolean);
    setStatus(missing.length ? `Loaded, but couldn't fetch: ${missing.join(', ')}.` : '');
  } catch (err) {
    if (token !== state.loadToken) return;
    setStatus(err.message, true);
  }
}

function showPicker() {
  state.hero = null;
  state.view = null;
  state.loadToken++;
  $('picker').hidden = false;
  $('hero-view').hidden = true;
  $('back').hidden = true;
  document.title = 'Brawl Draft Advisor';
  setStatus('');
  renderPicker();
}

function route() {
  const m = location.hash.match(/hero=(\d+)/);
  if (m) openHero(Number(m[1]));
  else showPicker();
}

async function onFiltersChanged() {
  savePrefs();
  setStatus('Reloading stats…');
  try {
    await loadHeroStats();
    route();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function init() {
  loadPrefs();
  setStatus('Loading heroes and items…');

  $('hero-search').addEventListener('input', renderPicker);
  $('hero-grid').addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-hero]');
    if (card) location.hash = `hero=${card.dataset.hero}`;
  });
  $('back').addEventListener('click', () => { location.hash = ''; });
  $('item-search').addEventListener('input', () => state.view && renderItems());
  $('item-search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && state.view && state.itemView === 'board') {
      const pool = state.view.items.entries;
      for (const m of bestMatches(pool, searchTerms())) {
        const key = offerKey(m.e.id, m.enhanced);
        if (!state.offered.includes(key)) state.offered.push(key);
      }
      ev.target.value = '';
      renderBoard();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (ev.target.value) ev.target.value = '';
      else clearOffer();
      ev.target.blur();
      if (state.view) renderItems();
    }
  });
  document.querySelector('.view-tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-view]');
    if (!btn || !state.view) return;
    state.itemView = btn.dataset.view;
    savePrefs();
    renderItems();
  });
  $('tier-tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-tier]');
    if (btn) setBoardTier(btn.dataset.tier === 'all' ? 'all' : Number(btn.dataset.tier));
  });
  $('grade-filter').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-grade]');
    if (!btn) return;
    state.minGrade = btn.dataset.grade;
    savePrefs();
    renderBoard();
  });
  $('board').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-key]');
    if (btn) toggleOffer(btn.dataset.key);
  });
  $('tray').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-action="clear"]')) return clearOffer();
    const offer = ev.target.closest('.offer');
    if (offer) toggleOffer(offer.dataset.key);
  });
  $('scan-btn').addEventListener('click', openScanner);
  $('scan-close').addEventListener('click', closeScanner);
  $('scan-capture').addEventListener('click', captureFrame);
  $('scan-file').addEventListener('change', (ev) => {
    scanImageFile(ev.target.files[0]);
    ev.target.value = ''; // allow picking the same file again
  });

  document.addEventListener('keydown', (ev) => {
    if (!$('scan').hidden) {
      if (ev.key === 'Escape') closeScanner();
      return;
    }
    if (!state.view || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target instanceof Element && ev.target.closest('input, select, textarea')) return;
    if (state.itemView === 'board' && /^[0-9]$/.test(ev.key)) {
      const tier = Number(ev.key);
      if (tier === 0) setBoardTier('all');
      else if (state.view.items.tiers.has(tier)) setBoardTier(tier);
    } else if (ev.key === 'Escape') {
      clearOffer();
    } else if (/^[a-z]$/i.test(ev.key)) {
      // Focusing here lets this keystroke land in the search box.
      $('item-search').focus();
    }
  });
  $('tiers').addEventListener('click', (ev) => {
    const row = ev.target.closest('.item-row');
    if (!row) return;
    const id = Number(row.parentElement.dataset.item);
    state.openItem = state.openItem === id ? null : id;
    renderTiers();
  });
  document.querySelectorAll('input[name="ab-mode"]').forEach((r) => r.addEventListener('change', () => state.view && renderAbilities()));
  ['f-days', 'f-badge', 'f-mode'].forEach((id) => $(id).addEventListener('change', onFiltersChanged));
  window.addEventListener('hashchange', route);

  try {
    const [heroes, upgrades] = await Promise.all([
      getJson('/v1/assets/heroes', { only_active: true }),
      getJson('/v1/assets/items/by-type/upgrade'),
      loadHeroStats(),
    ]);
    for (const u of upgrades) state.upgrades.set(u.id, u);
    state.heroes = heroes.filter((h) => h.player_selectable !== false && !h.disabled).sort((a, b) => a.name.localeCompare(b.name));
    setStatus('');
    route();
  } catch (err) {
    setStatus(`Couldn't load data from deadlock-api.com: ${err.message}`, true);
  }
}

init();
