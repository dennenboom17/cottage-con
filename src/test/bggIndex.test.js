import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import {
  parseCsv, buildBggIndex, bggIndexDoc, parseBggIndexDoc, normalizeName, createBggMatcher,
  bggGameUrl, bggSearchUrl, BGG_MAX_DOC_BYTES,
} from '../bggIndex.js'

const HEADER = 'id,name,yearpublished,rank,bayesaverage,average,usersrated,is_expansion,abstracts_rank'
const csv = (...rows) => [HEADER, ...rows].join('\n') + '\n'

const SAMPLE = csv(
  '13,Catan,1995,625,6.9,7.08989,144815,0,',
  '266192,Wingspan,2019,32,8.0,8.1,95000,0,',
  '152959,"The Settlers of Catan",2008,0,5.9,7.03596,1513,0,',
  '36218,Dominion,2008,300,7.5,7.6,97548,0,',
  '64777,Dominion,2004,0,5.5,6.0,78,0,',
  '99999,"Wingspan: European Expansion",2019,0,7,8.2,9000,1,',
  '11111,"Obscure, Tiny Game",2020,0,5,6,499,0,',
  '22222,"He said ""hi"" game",2021,0,6,7,600,0,',
  '33333,Pokémon Trading Card Game,1996,0,6,7,800,0,',
)

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes, CRLF and a BOM', () => {
    const text = '\uFEFFa,b,c\r\n1,"x, y","say ""hi"""\r\n2,,\r\n'
    expect(parseCsv(text)).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', '', '']])
  })
  it('handles a final row with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('keeps newlines that are inside quotes', () => {
    expect(parseCsv('a\n"two\nlines"\n')).toEqual([['a'], ['two\nlines']])
  })
})

describe('buildBggIndex', () => {
  it('keeps only non-expansion games at or above the rating cutoff, most popular first', () => {
    const { games } = buildBggIndex(SAMPLE, { minRatings: 500 })
    expect(games.map((g) => g[0])).toEqual([13, 36218, 266192, 152959, 33333, 22222].sort((a, b) => {
      const n = (id) => games.find((g) => g[0] === id)[4]
      return n(b) - n(a)
    }))
    expect(games.some((g) => g[0] === 99999)).toBe(false) // expansion
    expect(games.some((g) => g[0] === 11111)).toBe(false) // 499 ratings
    expect(games.some((g) => g[0] === 64777)).toBe(false) // 78 ratings
  })

  it('defaults to the 500-rating cutoff', () => {
    expect(buildBggIndex(SAMPLE).minRatings).toBe(500)
  })

  it('stores [id, name, year, rating rounded to 2dp, ratings]', () => {
    const catan = buildBggIndex(SAMPLE).games.find((g) => g[0] === 13)
    expect(catan).toEqual([13, 'Catan', 1995, 7.09, 144815])
  })

  it('preserves names with quotes and accents', () => {
    const names = buildBggIndex(SAMPLE).games.map((g) => g[1])
    expect(names).toContain('He said "hi" game')
    expect(names).toContain('Pokémon Trading Card Game')
  })

  it('rejects a file that is not the BGG ranks dump', () => {
    expect(() => buildBggIndex('foo,bar\n1,2\n')).toThrow(/doesn't look like BGG's boardgames_ranks\.csv/)
    expect(() => buildBggIndex('')).toThrow(/doesn't look like/)
  })

  it('rejects a dump with nothing above the cutoff', () => {
    expect(() => buildBggIndex(SAMPLE, { minRatings: 10_000_000 })).toThrow(/No games with at least 10000000 ratings/)
  })

  it('ignores malformed rows instead of failing', () => {
    const { games } = buildBggIndex(csv('13,Catan,1995,1,1,7,1000,0,', 'garbage', '14,Broken'))
    expect(games).toHaveLength(1)
  })

  it('refuses an index that would not fit in a Firestore document', () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => `${i + 1},Game number ${i + 1} with a long name,2000,1,1,7,${1000 + i},0,`)
    expect(() => buildBggIndex(csv(...rows))).toThrow(/over the Firestore document limit/)
    expect(BGG_MAX_DOC_BYTES).toBeLessThan(1_048_576)
  })
})

describe('index document round-trip', () => {
  it('serialises and parses back to the same games', () => {
    const index = buildBggIndex(SAMPLE)
    const doc = bggIndexDoc(index, { source: 'boardgames_ranks.csv' })
    expect(doc).toMatchObject({ version: 1, minRatings: 500, count: index.games.length, source: 'boardgames_ranks.csv' })
    expect(doc.updatedAt).toEqual(expect.any(Number))
    expect(parseBggIndexDoc(doc)).toEqual(index.games)
  })

  it.each([
    ['missing doc', undefined],
    ['wrong version', { version: 99, games: '[]' }],
    ['games not a string', { version: 1, games: [] }],
    ['invalid JSON', { version: 1, games: '{nope' }],
    ['not an array', { version: 1, games: '{"a":1}' }],
    ['no valid rows', { version: 1, games: '[["x"]]' }],
  ])('returns null for %s', (_label, data) => {
    expect(parseBggIndexDoc(data)).toBeNull()
  })
})

describe('normalizeName', () => {
  it.each([
    ['Wingspan', 'wingspan'],
    ['  Ticket  to Ride! ', 'ticket to ride'],
    ['Pokémon', 'pokemon'],
    ["Don't Mess with Cthulhu", 'dont mess with cthulhu'],
    ['Dungeons & Dragons', 'dungeons and dragons'],
    ['Sushi Go!', 'sushi go'],
    ['7 Wonders: Duel', '7 wonders duel'],
  ])('%j → %j', (input, expected) => expect(normalizeName(input)).toBe(expected))
  it('is safe on empty input', () => {
    expect(normalizeName()).toBe('')
    expect(normalizeName(null)).toBe('null')
  })
})

describe('createBggMatcher', () => {
  const matcher = createBggMatcher(buildBggIndex(SAMPLE).games)

  it('matches exact names regardless of case, punctuation and accents', () => {
    for (const q of ['Wingspan', 'wingspan', ' WINGSPAN! ']) {
      expect(matcher.find(q)).toMatchObject({ status: 'exact', match: { id: 266192 } })
    }
    expect(matcher.find('pokemon trading card game').match.id).toBe(33333)
  })

  it('picks the most-rated game when several share a name', () => {
    expect(matcher.find('Dominion').match.id).toBe(36218)
  })

  it('picks the most-rated game among same-name games even when the rows are not pre-sorted', () => {
    const unsorted = createBggMatcher([[64777, 'Dominion', 2004, 6.0, 78], [36218, 'Dominion', 2008, 7.6, 97548]])
    expect(unsorted.find('Dominion').match.id).toBe(36218)
    const reversed = createBggMatcher([[36218, 'Dominion', 2008, 7.6, 97548], [64777, 'Dominion', 2004, 6.0, 78]])
    expect(reversed.find('Dominion').match.id).toBe(36218)
  })

  it('treats a leading "The" as optional in either direction', () => {
    expect(matcher.find('The Settlers of Catan').match.id).toBe(152959) // exact BGG entry
    expect(matcher.find('Settlers of Catan').match.id).toBe(152959)     // BGG name has "The"
  })

  it('does not exact-match an expansion or an under-cutoff game', () => {
    expect(matcher.find('Wingspan: European Expansion').status).not.toBe('exact')
    expect(matcher.find('Obscure, Tiny Game').status).not.toBe('exact')
  })

  it('suggests close titles for typos instead of guessing', () => {
    const r = matcher.find('Wingspam')
    expect(r.status).toBe('fuzzy')
    expect(r.match).toBeNull()
    expect(r.candidates[0].id).toBe(266192)
  })

  it('suggests the base game for a name that contains it', () => {
    const r = matcher.find('Catan: Das Spiel des Jahres')
    expect(r.status).toBe('fuzzy')
    expect(r.candidates.map((c) => c.id)).toContain(13)
  })

  it('returns none for unrelated or empty names', () => {
    expect(matcher.find('Quantum Flapjack Saga')).toEqual({ status: 'none', match: null, candidates: [] })
    expect(matcher.find('')).toEqual({ status: 'none', match: null, candidates: [] })
    expect(matcher.find('???').status).toBe('none')
  })

  it('limits and de-duplicates candidates', () => {
    const many = createBggMatcher(Array.from({ length: 20 }, (_, i) => [i + 1, `Dragon Quest ${i}`, 2000, 7, 1000 + i]))
    const r = many.find('Dragon Quest')
    expect(r.candidates.length).toBeLessThanOrEqual(3)
    expect(new Set(r.candidates.map((c) => c.id)).size).toBe(r.candidates.length)
  })
})

describe('urls', () => {
  it('builds direct and search URLs', () => {
    expect(bggGameUrl(266192)).toBe('https://boardgamegeek.com/boardgame/266192')
    expect(bggSearchUrl('Ticket to Ride')).toBe('https://boardgamegeek.com/search/boardgame?q=Ticket%20to%20Ride')
  })
})

// Real-data check. Only runs when you point BGG_RANKS_CSV at your downloaded dump:
//   $env:BGG_RANKS_CSV="C:\path\boardgames_ranks.csv"; npm test
const REAL = process.env.BGG_RANKS_CSV
describe.skipIf(!REAL || !fs.existsSync(REAL ?? ''))('real BGG dump', () => {
  it('builds a Firestore-sized index that resolves well-known games to their real IDs', () => {
    const index = buildBggIndex(fs.readFileSync(REAL, 'utf8'))
    expect(index.games.length).toBeGreaterThan(5000)
    expect(index.bytes).toBeLessThan(BGG_MAX_DOC_BYTES)
    const m = createBggMatcher(index.games)
    const truth = { Wingspan: 266192, Catan: 13, Azul: 230802, 'Ticket to Ride': 9209, Codenames: 178900, Gloomhaven: 174430,
      'Terraforming Mars': 167791, Splendor: 148228, 'Exploding Kittens': 172225, Pandemic: 30549, Carcassonne: 822, Cascadia: 295947 }
    for (const [name, id] of Object.entries(truth)) expect(m.find(name).match?.id, name).toBe(id)
  })
})
