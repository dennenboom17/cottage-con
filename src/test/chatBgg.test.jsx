import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import { CrewAssistant, BggLinkText, bggFactsBlock, legacyBggBlock, cleanAskedTitle, resetBggMatcher } from '../App.jsx'
import { buildBggIndex, bggIndexDoc, createBggMatcher } from '../bggIndex.js'

// ── fixtures ───────────────────────────────────────────────────────────────────
const CSV = [
  'id,name,yearpublished,rank,bayesaverage,average,usersrated,is_expansion',
  '230802,Azul,2017,100,7.7,7.8,80000,0',
  '13,Catan,1995,625,6.9,7.08989,144815,0',
  '266192,Wingspan,2019,32,8.0,8.1,95000,0',
  '237182,Root,2018,40,8.0,8.0,50000,0',
].join('\n') + '\n'

const withIndex = () => getDoc.mockResolvedValue({ exists: () => true, data: () => bggIndexDoc(buildBggIndex(CSV)) })
const withoutIndex = () => getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) })

const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })
const stubFetch = (impl) => { const f = vi.fn(impl); vi.stubGlobal('fetch', f); return f }
const bodyOf = (f, call = -1) => JSON.parse(f.mock.calls.at(call)[1].body)
const requestText = (f, call = -1) => bodyOf(f, call).contents.at(-1).parts[0].text
const systemText = (f) => bodyOf(f).system_instruction.parts[0].text

const mkCtx = (over = {}) => ({
  profile: { name: 'Ann Lee' }, authUser: { uid: 'me' }, users: { me: { id: 'me', name: 'Ann Lee' } },
  games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {}, ...over,
})

const ask = async (ctx, question) => {
  render(<CrewAssistant ctx={ctx} />)
  await userEvent.click(screen.getByLabelText('Open crew assistant'))
  await userEvent.type(screen.getByPlaceholderText(/Ask anything/), `${question}{Enter}`)
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetBggMatcher()
  withoutIndex()
})
afterEach(() => { resetBggMatcher(); withoutIndex() })

// ── with a published index ─────────────────────────────────────────────────────
describe('chat game questions with the BGG index', () => {
  it('answers from the index with ONE model call, giving the model a verified link, year and rating', async () => {
    withIndex()
    const f = stubFetch(async () => reply('Azul is rated 7.8.'))
    await ask(mkCtx(), "What's the rating of Azul?")

    await screen.findByText('Azul is rated 7.8.')
    expect(f).toHaveBeenCalledTimes(1) // previously a second call guessed details from memory
    const req = requestText(f)
    expect(req).toContain('=== BOARDGAMEGEEK: "Azul" (verified in BGG\'s database) ===')
    expect(req).toContain('Year: 2017 | BGG average rating: 7.8/10 from 80,000 ratings')
    expect(req).toContain('BGG link: https://boardgamegeek.com/boardgame/230802')
    expect(req).not.toContain('undefined')
  })

  it('gives the model every game mentioned in one question', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    await ask(mkCtx(), 'Compare Catan and Azul for 4 players')
    await waitFor(() => expect(f).toHaveBeenCalled())
    const req = requestText(f)
    expect(req).toContain('https://boardgamegeek.com/boardgame/13')
    expect(req).toContain('https://boardgamegeek.com/boardgame/230802')
  })

  it('recognises an indexed game that is not in the Cargo Hold and has no "rules for…" phrasing', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    await ask(mkCtx(), 'Who published Wingspan?')
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(requestText(f)).toContain('BGG link: https://boardgamegeek.com/boardgame/266192')
  })

  it('does not attach BGG data to questions that are not about games, even if a word is also a title', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    await ask(mkCtx(), 'Can someone grab a root beer?') // "Root" is a game, but this is not a game question
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(requestText(f)).not.toContain('BOARDGAMEGEEK')
  })

  it('matches Cargo Hold games as whole words only', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    const ctx = mkCtx({ games: { g1: { id: 'g1', name: 'Go', ownerId: 'me' } } })
    await ask(ctx, 'Is anyone going to the store?')
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(requestText(f)).not.toContain('BOARDGAMEGEEK')
  })

  it('still recognises a short Cargo Hold name used as a whole word, and offers only a search link when it is not indexed', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    const ctx = mkCtx({ games: { g1: { id: 'g1', name: 'Go', ownerId: 'me' } } })
    await ask(ctx, 'Can we play Go tonight?')
    await waitFor(() => expect(f).toHaveBeenCalled())
    const req = requestText(f)
    expect(req).toContain('"Go" was not found in BGG')
    expect(req).toContain('https://boardgamegeek.com/search/boardgame?q=Go')
  })

  it('passes close matches as unconfirmed suggestions for a misspelled name, with no verified link', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    await ask(mkCtx(), 'Tell me about Wingspam')
    await waitFor(() => expect(f).toHaveBeenCalled())
    const req = requestText(f)
    expect(req).toContain('no exact match for "Wingspam"')
    expect(req).toContain('Wingspan (2019) https://boardgamegeek.com/boardgame/266192')
    expect(req).toContain('There is no verified link for "Wingspam"')
  })

  it('never hands the model a direct link for a game the index does not know', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    await ask(mkCtx(), 'Explain the rules for Quantum Flapjack Saga')
    await waitFor(() => expect(f).toHaveBeenCalled())
    const req = requestText(f)
    expect(req).toContain('Do not invent a BGG URL')
    expect(req).toContain('search/boardgame?q=Quantum%20Flapjack%20Saga')
    expect(req).not.toMatch(/boardgamegeek\.com\/boardgame\/\d/)
  })

  it('annotates Cargo Hold games with verified year, rating and link; leaves unindexed games unannotated', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    const ctx = mkCtx({ games: {
      g1: { id: 'g1', name: 'Wingspan', category: 'Medium', minPlayers: '1', maxPlayers: '5', ownerId: 'me' },
      g2: { id: 'g2', name: 'Homebrew Prototype', ownerId: 'me' },
    } })
    render(<CrewAssistant ctx={ctx} />)
    await userEvent.click(screen.getByLabelText('Open crew assistant'))
    await userEvent.click(screen.getByRole('button', { name: "What's the checkout time?" }))
    await waitFor(() => expect(f).toHaveBeenCalled())

    const req = requestText(f)
    expect(req).toMatch(/Wingspan \| Medium \| 1-5 players \| 2019 \| BGG rating 8\.1\/10 \| BGG link: https:\/\/boardgamegeek\.com\/boardgame\/266192 \| brought by Ann Lee/)
    const homebrew = req.split('\n').find((l) => l.startsWith('Homebrew Prototype'))
    expect(homebrew).toBe('Homebrew Prototype | brought by Ann Lee')
  })

  it('instructs the model to use only verified links and facts', async () => {
    withIndex()
    const f = stubFetch(async () => reply('ok'))
    await ask(mkCtx(), 'Tell me about Azul')
    await waitFor(() => expect(f).toHaveBeenCalled())
    const sys = systemText(f)
    expect(sys).toContain('Never invent, guess or alter a BoardGameGeek URL or ID')
    expect(sys).toContain('include that exact link')
    expect(sys).toContain('Tip: Do Not Trust Huss!') // existing rule must survive
  })

  it('shows BoardGameGeek links in replies as clickable links', async () => {
    withIndex()
    stubFetch(async () => reply('Azul is great! https://boardgamegeek.com/boardgame/230802'))
    await ask(mkCtx(), 'Tell me about Azul')
    const link = await screen.findByRole('link', { name: 'https://boardgamegeek.com/boardgame/230802' })
    expect(link).toHaveAttribute('href', 'https://boardgamegeek.com/boardgame/230802')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })
})

// ── without an index ───────────────────────────────────────────────────────────
describe('chat game questions when no index is published', () => {
  it('falls back to the model’s recollection, flags it as unverified and offers only a search link', async () => {
    const f = stubFetch(async () => reply(f.mock.calls.length === 1
      ? 'NAME: Azul\nMINP: 2\nMAXP: 4\nTIME: 45\nWEIGHT: 1.8\nRATING: 7.8\nYEAR: 2017\nBGG_ID: 99999\nDESC: Tile laying.'
      : 'Azul is a tile-laying game.'))
    await ask(mkCtx(), 'Explain the rules for Azul')

    await screen.findByText('Azul is a tile-laying game.')
    expect(f).toHaveBeenCalledTimes(2) // detail lookup + answer
    const req = requestText(f, 1)
    expect(req).toContain('(unverified, from model memory)')
    expect(req).toContain('Players: 2–4 | Playtime: 45 min | BGG rating: 7.8/10 | Complexity: 1.8/5 | Year: 2017')
    expect(req).toContain('BGG search link (the only BGG link to give): https://boardgamegeek.com/search/boardgame?q=Azul')
    expect(req).not.toContain('99999') // the model's remembered id is never passed along
    expect(req).not.toContain('undefined')
  })
})

// ── pure helpers ───────────────────────────────────────────────────────────────
describe('bggFactsBlock / legacyBggBlock', () => {
  const m = createBggMatcher(buildBggIndex(CSV).games)

  it('formats a verified block for an exact match', () => {
    const block = bggFactsBlock(m.find('catan'), 'catan')
    expect(block).toContain('"Catan" (verified in BGG\'s database)')
    expect(block).toContain('144,815 ratings')
    expect(block).toContain('BGG link: https://boardgamegeek.com/boardgame/13')
  })

  it('omits missing fields from the legacy block instead of printing "undefined"', () => {
    const block = legacyBggBlock({ minPlayers: '', maxPlayers: '', description: '', rating: '' }, 'Some Game')
    expect(block).not.toContain('undefined')
    expect(block).toContain('search/boardgame?q=Some%20Game')
  })
})

describe('BggLinkText', () => {
  const html = (text) => render(<p data-testid="t"><BggLinkText text={text} /></p>).container

  it('links a BGG URL and keeps trailing punctuation outside the link', () => {
    const c = html('See (https://boardgamegeek.com/boardgame/13). Enjoy!')
    const a = c.querySelector('a')
    expect(a).toHaveAttribute('href', 'https://boardgamegeek.com/boardgame/13')
    expect(c.textContent).toBe('See (https://boardgamegeek.com/boardgame/13). Enjoy!')
  })

  it('links several URLs, including www and search links', () => {
    const c = html('A https://www.boardgamegeek.com/boardgame/13 B https://boardgamegeek.com/search/boardgame?q=Azul%20Duel C')
    expect([...c.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://www.boardgamegeek.com/boardgame/13',
      'https://boardgamegeek.com/search/boardgame?q=Azul%20Duel',
    ])
  })

  it('leaves non-BGG URLs and look-alike domains as plain text', () => {
    const c = html('Visit https://evil.example.com/x or https://boardgamegeek.com.evil.io/boardgame/1 or javascript:alert(1)')
    expect(c.querySelectorAll('a')).toHaveLength(0)
    expect(c.textContent).toContain('https://evil.example.com/x')
  })

  it('renders plain text and empty input safely', () => {
    expect(html('no links here').textContent).toBe('no links here')
    expect(() => render(<BggLinkText text={undefined} />)).not.toThrow()
  })
})

describe('cleanAskedTitle', () => {
  it.each([
    ['the rules for Azul', 'Azul'],
    ['rules of Ticket to Ride', 'Ticket to Ride'],
    ['how to play Catan', 'Catan'],
    ['The Rules For Wingspan', 'Wingspan'],
    ['details on Root', 'Root'],
    ['the game Azul', 'Azul'],
    ['Azul', 'Azul'],
    ['The Castles of Burgundy', 'The Castles of Burgundy'], // a real leading "The" is part of the title
    ['Play Doh Party', 'Doh Party'],                          // known trade-off: a leading "Play" is treated as a lead-in word
    ['', ''],
  ])('%j → %j', (input, expected) => expect(cleanAskedTitle(input)).toBe(expected))
})
