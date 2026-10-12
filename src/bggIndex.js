// BoardGameGeek name → ID index, built from BGG's "boardgames_ranks.csv" data dump.
// Pure functions only (no React / Firebase) so it is easy to test. App.jsx stores the result in
// Firestore (bggIndex/current) and uses createBggMatcher() to resolve scanned game names to real BGG IDs.

export const BGG_INDEX_VERSION = 1
export const BGG_MIN_RATINGS = 500        // only games with at least this many ratings are indexed
export const BGG_MAX_DOC_BYTES = 900_000  // Firestore documents are limited to 1 MiB; keep headroom

export const bggGameUrl   = (id)   => `https://boardgamegeek.com/boardgame/${id}`
export const bggSearchUrl = (name) => `https://boardgamegeek.com/search/boardgame?q=${encodeURIComponent(name)}`

// ── CSV ───────────────────────────────────────────────────────────────────────
// Minimal RFC-4180 parser: quoted fields, "" escapes, CRLF/LF, optional BOM.
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row) }
  return rows
}

const REQUIRED_COLUMNS = ['id', 'name', 'yearpublished', 'average', 'usersrated', 'is_expansion']

// CSV text → { games: [[id, name, year, avgRating, ratingCount], …] sorted by popularity, minRatings, scanned }
export function buildBggIndex(csvText, { minRatings = BGG_MIN_RATINGS } = {}) {
  const [header, ...rows] = parseCsv(csvText)
  const missing = REQUIRED_COLUMNS.filter((c) => !header?.includes(c))
  if (!header || missing.length) {
    throw new Error(`This doesn't look like BGG's boardgames_ranks.csv (missing columns: ${missing.join(', ') || 'header row'}).`)
  }
  const ix = Object.fromEntries(header.map((h, i) => [h, i]))
  const games = []
  for (const r of rows) {
    if (r.length !== header.length) continue
    if (r[ix.is_expansion] === '1') continue
    const ratings = Number(r[ix.usersrated])
    const id = Number(r[ix.id])
    if (!(ratings >= minRatings) || !Number.isInteger(id) || id <= 0 || !r[ix.name]) continue
    games.push([id, r[ix.name], Number(r[ix.yearpublished]) || 0, Math.round(Number(r[ix.average]) * 100) / 100 || 0, ratings])
  }
  if (!games.length) throw new Error(`No games with at least ${minRatings} ratings were found in that file.`)
  games.sort((a, b) => b[4] - a[4])
  const bytes = new TextEncoder().encode(JSON.stringify(games)).length
  if (bytes > BGG_MAX_DOC_BYTES) {
    throw new Error(`Index is ${(bytes / 1024).toFixed(0)} KB, over the Firestore document limit. Raise the minimum ratings.`)
  }
  return { games, minRatings, scanned: rows.length, bytes }
}

// Firestore document payload for an index (games kept as one JSON string: smaller and avoids map-key limits)
export function bggIndexDoc(index, { source = '' } = {}) {
  return {
    version: BGG_INDEX_VERSION,
    minRatings: index.minRatings,
    count: index.games.length,
    source,
    updatedAt: Date.now(),
    games: JSON.stringify(index.games),
  }
}

// Firestore document data → games array, or null if missing/corrupt/unknown version
export function parseBggIndexDoc(data) {
  if (!data || data.version !== BGG_INDEX_VERSION || typeof data.games !== 'string') return null
  try {
    const rows = JSON.parse(data.games)
    if (!Array.isArray(rows)) return null
    const valid = rows.filter((r) => Array.isArray(r) && r.length >= 5 && Number.isInteger(r[0]) && typeof r[1] === 'string')
    return valid.length ? valid : null
  } catch {
    return null
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────
// Lower-case, strip accents and apostrophes, "&" → "and", other punctuation → space.
export function normalizeName(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'for', 'to', 'in'])
const contentTokens = (key) => {
  const all = key.split(' ').filter(Boolean)
  const content = all.filter((t) => !STOP.has(t))
  return new Set(content.length ? content : all)
}

// 0..1 similarity from edit distance (cheap early-out when lengths differ a lot)
function editSimilarity(a, b) {
  const max = Math.max(a.length, b.length)
  if (!max) return 1
  if (Math.abs(a.length - b.length) > 3) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[b.length] / max
}

function tokenScore(q, c) {
  let inter = 0
  for (const t of q) if (c.has(t)) inter++
  if (!inter) return 0
  const jaccard = inter / (q.size + c.size - inter)
  const containment = inter / Math.min(q.size, c.size)
  return 0.5 * jaccard + 0.5 * containment
}

// Single words that are also game titles but far more often just English — never treated as a game on their own
const COMMON_SINGLE_WORDS = new Set(['game', 'games', 'play', 'life', 'time', 'word', 'words', 'card', 'cards', 'dice', 'party', 'what', 'this', 'that', 'have', 'from', 'with', 'about', 'rule', 'rules', 'tonight', 'today'])
const MAX_TITLE_TOKENS = 8

const FUZZY_MIN_SCORE = 0.6
const TYPO_MIN_SIMILARITY = 0.75

// rows: the `games` array from buildBggIndex / parseBggIndexDoc
// find(name) → { status: 'exact'|'fuzzy'|'none', match, candidates }
//   exact : the normalised name equals a BGG name (ties → the game with most ratings)
//   fuzzy : no exact name, but up to `limit` plausible titles — show them, never auto-pick
//   none  : nothing close
export function createBggMatcher(rows) {
  const byKey = new Map()
  const entries = []
  for (const [id, name, year, rating, ratings] of rows) {
    const g = { id, name, year, rating, ratings }
    const key = normalizeName(name)
    if (!key) continue
    const cur = byKey.get(key)
    if (!cur || g.ratings > cur.ratings) byKey.set(key, g)
    entries.push({ g, key, tokens: contentTokens(key) })
  }

  // Exact title lookup (case/punctuation-insensitive; a leading "The" is optional). No fuzzy scan, so it is cheap.
  const exactLookup = (name) => {
    const key = normalizeName(name)
    if (!key) return null
    for (const k of [key, key.replace(/^the /, ''), `the ${key}`]) {
      const hit = byKey.get(k)
      if (hit) return hit
    }
    return null
  }

  return {
    size: entries.length,
    exact: exactLookup,

    // Finds game titles mentioned inside free text (e.g. "what's the rating of Azul?"), in the order they appear.
    // Longest title wins and matches never overlap, so "Ticket to Ride Europe" isn't also read as "Ticket to Ride".
    // Single-word titles must be 4+ letters and not an everyday word. Returns up to `limit` games.
    findInText(text, limit = 3) {
      const tokens = normalizeName(text).split(' ').filter(Boolean)
      const taken = new Array(tokens.length).fill(false)
      const hits = []
      for (let n = Math.min(MAX_TITLE_TOKENS, tokens.length); n >= 1; n--) {
        for (let i = 0; i + n <= tokens.length; i++) {
          if (taken.slice(i, i + n).some(Boolean)) continue
          const phrase = tokens.slice(i, i + n).join(' ')
          if (n === 1 && (phrase.length < 4 || STOP.has(phrase) || COMMON_SINGLE_WORDS.has(phrase))) continue
          const game = byKey.get(phrase) || (n > 1 ? byKey.get(`the ${phrase}`) : undefined)
          if (!game) continue
          for (let k = i; k < i + n; k++) taken[k] = true
          hits.push({ game, at: i })
        }
      }
      const seen = new Set()
      return hits
        .sort((a, b) => a.at - b.at)
        .map((h) => h.game)
        .filter((g) => !seen.has(g.id) && seen.add(g.id))
        .slice(0, limit)
    },

    find(name, limit = 3) {
      const key = normalizeName(name)
      if (!key) return { status: 'none', match: null, candidates: [] }

      const hit = exactLookup(name)
      if (hit) return { status: 'exact', match: hit, candidates: [] }

      const q = contentTokens(key)
      const scored = new Map()
      for (const e of entries) {
        let score = tokenScore(q, e.tokens)
        const typoSim = key.length >= 4 ? editSimilarity(key, e.key) : 0
        if (typoSim >= TYPO_MIN_SIMILARITY) score = Math.max(score, typoSim)
        if (score < FUZZY_MIN_SCORE) continue
        const prev = scored.get(e.g.id)
        if (!prev || score > prev.score) scored.set(e.g.id, { game: e.g, score })
      }
      const candidates = [...scored.values()]
        .sort((a, b) => b.score - a.score || b.game.ratings - a.game.ratings)
        .slice(0, limit)
        .map((c) => c.game)
      return { status: candidates.length ? 'fuzzy' : 'none', match: null, candidates }
    },
  }
}
