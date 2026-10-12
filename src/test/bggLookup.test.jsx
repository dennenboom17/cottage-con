import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc, setDoc } from 'firebase/firestore'
import { lookupBGG, resetBggMatcher, GameChest, BggIndexManager } from '../App.jsx'
import { buildBggIndex, bggIndexDoc } from '../bggIndex.js'

// ── fixtures ───────────────────────────────────────────────────────────────────
const HEADER = 'id,name,yearpublished,rank,bayesaverage,average,usersrated,is_expansion'
const CSV = [
  HEADER,
  '266192,Wingspan,2019,32,8.0,8.1,95000,0',
  '13,Catan,1995,625,6.9,7.08989,144815,0',
  '230802,Azul,2017,100,7.7,7.8,80000,0',
  '99999,"Wingspan: European Expansion",2019,0,7,8.2,9000,1',
].join('\n') + '\n'
const indexDoc = () => bggIndexDoc(buildBggIndex(CSV), { source: 'boardgames_ranks.csv' })

const withIndex = () => getDoc.mockResolvedValue({ exists: () => true, data: () => indexDoc() })
const withoutIndex = () => getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) })

const geminiText = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })
// The model "remembers" the wrong id (123) and a slightly different name — it must not win
const WRONG_ID_REPLY = 'NAME: Wingspan (Second Edition)\nMINP: 1\nMAXP: 5\nTIME: 70\nWEIGHT: 2.4\nRATING: 9.9\nYEAR: 1999\nBGG_ID: 123\nDESC: Birds.'
const stubFetch = (impl) => { const f = vi.fn(impl); vi.stubGlobal('fetch', f); return f }
const promptOf = (f, call = 0) => JSON.parse(f.mock.calls[call][1].body).contents[0].parts[0].text

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetBggMatcher()
  withoutIndex()
})
afterEach(() => { resetBggMatcher(); withoutIndex() })

// ── lookupBGG with the index ───────────────────────────────────────────────────
describe('lookupBGG with a published index', () => {
  it('pins an exact match to its real BGG page and takes name/year/rating from BGG, not the model', async () => {
    withIndex()
    const f = stubFetch(async () => geminiText(WRONG_ID_REPLY))

    const r = await lookupBGG('wingspan')

    expect(r).toMatchObject({
      source: 'index', bggId: 266192, bggUrl: 'https://boardgamegeek.com/boardgame/266192',
      name: 'Wingspan', year: '2019', rating: '8.1', candidates: [],
    })
    // details the index lacks still come from the model
    expect(r).toMatchObject({ minPlayers: '1', maxPlayers: '5', weight: '2.4', description: 'Birds.' })
    // and the model is asked about the canonical title + year, which improves its recall
    expect(promptOf(f)).toContain('"Wingspan" (2019)')
  })

  it('still returns the BGG facts when the model call fails', async () => {
    withIndex()
    stubFetch(async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }))
    const r = await lookupBGG('Catan')
    expect(r).toMatchObject({ source: 'index', bggId: 13, name: 'Catan', year: '1995', rating: '7.09', minPlayers: '', description: '' })
  })

  it('does NOT trust the model’s remembered id when there is no exact match; offers close titles and a search link', async () => {
    withIndex()
    stubFetch(async () => geminiText(WRONG_ID_REPLY))

    const r = await lookupBGG('Wingspam')

    expect(r.source).toBe('search')
    expect(r.name).toBe('Wingspam') // the user's spelling is kept, not the model's guess
    expect(r.bggId).toBeNull()
    expect(r.bggUrl).toBe('https://boardgamegeek.com/search/boardgame?q=Wingspam')
    expect(r.bggUrl).not.toContain('123')
    expect(r.candidates.map((c) => c.id)).toContain(266192)
  })

  it('falls back to a search link with no candidates for an unknown game', async () => {
    withIndex()
    stubFetch(async () => geminiText('NAME: Quantum Flapjack Saga\nBGG_ID: 777'))
    const r = await lookupBGG('Quantum Flapjack Saga')
    expect(r).toMatchObject({ source: 'search', bggId: null, candidates: [], name: 'Quantum Flapjack Saga' })
    expect(r.bggUrl).toContain('search/boardgame?q=Quantum%20Flapjack%20Saga')
  })

  it('does not exact-match an expansion', async () => {
    withIndex()
    stubFetch(async () => geminiText('NAME: Wingspan: European Expansion'))
    const r = await lookupBGG('Wingspan: European Expansion')
    expect(r.source).toBe('search')
    expect(r.bggId).toBeNull()
  })

  it('returns null when nothing matches and the model fails too', async () => {
    withIndex()
    stubFetch(async () => ({ ok: false, status: 429, text: async () => '', json: async () => ({}) }))
    await expect(lookupBGG('Quantum Flapjack Saga')).resolves.toBeNull()
  })

  it('loads the index once and reuses it', async () => {
    withIndex()
    stubFetch(async () => geminiText(WRONG_ID_REPLY))
    await lookupBGG('Wingspan'); await lookupBGG('Catan'); await lookupBGG('Azul')
    expect(getDoc).toHaveBeenCalledTimes(1)
  })

  it('skips matching entirely when given a picked candidate', async () => {
    withIndex()
    const f = stubFetch(async () => geminiText('NAME: Azul\nMINP: 2\nMAXP: 4\nWEIGHT: 1.8'))
    const r = await lookupBGG('whatever the user typed', { id: 230802, name: 'Azul', year: 2017, rating: 7.8, ratings: 80000 })
    expect(getDoc).not.toHaveBeenCalled()
    expect(r).toMatchObject({ source: 'index', bggId: 230802, name: 'Azul', bggUrl: 'https://boardgamegeek.com/boardgame/230802', minPlayers: '2' })
    expect(promptOf(f)).toContain('"Azul" (2017)')
  })

  it('returns null for a blank name without touching anything', async () => {
    const f = stubFetch(async () => geminiText('x'))
    await expect(lookupBGG('  ')).resolves.toBeNull()
    expect(f).not.toHaveBeenCalled()
    expect(getDoc).not.toHaveBeenCalled()
  })
})

describe('lookupBGG when the index is missing or unreadable', () => {
  it('keeps the legacy behaviour when no index has been published', async () => {
    stubFetch(async () => geminiText('NAME: Wingspan\nBGG_ID: 266192'))
    const r = await lookupBGG('Wingspan')
    expect(r).toMatchObject({ source: 'gemini', bggId: 266192, bggUrl: 'https://boardgamegeek.com/boardgame/266192' })
  })

  it('treats a corrupt index document as missing', async () => {
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({ version: 1, games: '{broken' }) })
    stubFetch(async () => geminiText('NAME: Wingspan\nBGG_ID: 0'))
    const r = await lookupBGG('Wingspan')
    expect(r.source).toBe('gemini')
    expect(r.bggUrl).toContain('search/boardgame')
  })

  it('survives a permission error and retries on the next lookup instead of caching the failure', async () => {
    getDoc.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission-denied' }))
    stubFetch(async () => geminiText(WRONG_ID_REPLY))

    expect((await lookupBGG('Wingspan')).source).toBe('gemini')

    withIndex() // rules fixed / index published
    expect((await lookupBGG('Wingspan')).source).toBe('index')
  })
})

// ── GameChest: "did you mean" ──────────────────────────────────────────────────
describe('GameChest add-game form with the index', () => {
  const mkCtx = () => ({
    games: {}, food: {}, users: {}, authUser: { uid: 'me' }, profile: { gamesPlayed: [] },
    doSaveGame: vi.fn(async () => {}), doDelGame: vi.fn(), doToggleLike: vi.fn(),
    doLogGamePlayed: vi.fn(), doRemoveGamePlayed: vi.fn(), showToast: vi.fn(),
  })
  const openForm = async () => userEvent.click(screen.getByRole('button', { name: /Load Cargo/ }))
  const nameBox = () => screen.getByPlaceholderText('e.g. Wingspan')

  it('fills the real BGG link for an exact name, using BGG’s canonical spelling', async () => {
    withIndex()
    stubFetch(async () => geminiText(WRONG_ID_REPLY))
    const ctx = mkCtx()
    render(<GameChest ctx={ctx} />)
    await openForm()
    await userEvent.type(nameBox(), 'wingspan')
    await userEvent.tab()

    await waitFor(() => expect(nameBox()).toHaveValue('Wingspan'))
    expect(screen.getByDisplayValue('https://boardgamegeek.com/boardgame/266192')).toBeInTheDocument()
    expect(screen.queryByText(/did you mean/i)).not.toBeInTheDocument()
    expect(ctx.showToast).toHaveBeenCalledWith('✓ BGG: Wingspan (8.1/10)')
  })

  it('offers close titles for a misspelling and completes the form when one is picked', async () => {
    withIndex()
    stubFetch(async () => geminiText('NAME: Wingspan\nMINP: 1\nMAXP: 5\nWEIGHT: 2.4\nDESC: Birds.'))
    const ctx = mkCtx()
    render(<GameChest ctx={ctx} />)
    await openForm()
    await userEvent.type(nameBox(), 'Wingspam')
    await userEvent.tab()

    const suggestion = await screen.findByRole('button', { name: 'Wingspan (2019)' })
    expect(screen.getByText(/No exact BGG match — did you mean/)).toBeInTheDocument()
    expect(ctx.showToast).toHaveBeenCalledWith(expect.stringContaining('No exact BGG match for "Wingspam"'))

    await userEvent.click(suggestion)

    await waitFor(() => expect(nameBox()).toHaveValue('Wingspan'))
    expect(screen.getByDisplayValue('https://boardgamegeek.com/boardgame/266192')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Wingspan (2019)' })).not.toBeInTheDocument()
    const [min, max] = screen.getAllByRole('spinbutton')
    expect(min).toHaveValue(1)
    expect(max).toHaveValue(5)
  })

  it('clears the suggestions as soon as the name is edited', async () => {
    withIndex()
    stubFetch(async () => geminiText('NAME: Wingspan'))
    render(<GameChest ctx={mkCtx()} />)
    await openForm()
    await userEvent.type(nameBox(), 'Wingspam')
    await userEvent.tab()
    await screen.findByRole('button', { name: 'Wingspan (2019)' })

    await userEvent.type(nameBox(), 'x')
    expect(screen.queryByRole('button', { name: 'Wingspan (2019)' })).not.toBeInTheDocument()
  })
})

// ── Engine Room: publishing the index ──────────────────────────────────────────
describe('BggIndexManager', () => {
  const ctx = () => ({ showToast: vi.fn() })
  const csvFile = (text = CSV, name = 'boardgames_ranks.csv') => new File([text], name, { type: 'text/csv' })
  const chooser = () => screen.getByLabelText('BGG ranks CSV')

  it('says when no index has been published', async () => {
    render(<BggIndexManager ctx={ctx()} />)
    expect(await screen.findByText('not published')).toBeInTheDocument()
  })

  it('shows the current index details', async () => {
    withIndex()
    render(<BggIndexManager ctx={ctx()} />)
    expect(await screen.findByText('3 games')).toBeInTheDocument() // the status pill
    expect(screen.getByText(/Current index: 3 games with 500\+ ratings · from boardgames_ranks\.csv/)).toBeInTheDocument()
  })

  it('explains a read failure', async () => {
    getDoc.mockRejectedValue(Object.assign(new Error('x'), { code: 'permission-denied' }))
    render(<BggIndexManager ctx={ctx()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission-denied.*Firestore rule/)
  })

  it('previews a chosen CSV (500+ ratings, no expansions) before publishing anything', async () => {
    render(<BggIndexManager ctx={ctx()} />)
    await userEvent.upload(chooser(), csvFile())
    expect(await screen.findByText(/Ready to publish/)).toHaveTextContent('3 games')
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('publishes by fully replacing the index document, then reports success', async () => {
    const c = ctx()
    render(<BggIndexManager ctx={c} />)
    await userEvent.upload(chooser(), csvFile())
    await userEvent.click(await screen.findByRole('button', { name: 'Publish to Firestore' }))

    await waitFor(() => expect(setDoc).toHaveBeenCalledTimes(1))
    const [ref, payload, ...extra] = setDoc.mock.calls[0]
    expect(ref).toEqual({ col: 'bggIndex', id: 'current' })
    expect(extra).toEqual([]) // no { merge: true } — a refresh must replace, not blend
    expect(payload).toMatchObject({ version: 1, minRatings: 500, count: 3, source: 'boardgames_ranks.csv' })
    expect(JSON.parse(payload.games).map((g) => g[1]).sort()).toEqual(['Azul', 'Catan', 'Wingspan'])
    expect(c.showToast).toHaveBeenCalledWith('📚 BGG index published — 3 games')
    expect(screen.queryByText(/Ready to publish/)).not.toBeInTheDocument()
    expect(await screen.findByText(/3 games with 500\+ ratings/)).toBeInTheDocument()
  })

  it('makes lookups use the newly published index straight away', async () => {
    stubFetch(async () => geminiText(WRONG_ID_REPLY))
    expect((await lookupBGG('Wingspan')).source).toBe('gemini') // caches "no index"

    render(<BggIndexManager ctx={ctx()} />)
    await userEvent.upload(chooser(), csvFile())
    await userEvent.click(await screen.findByRole('button', { name: 'Publish to Firestore' }))
    await waitFor(() => expect(setDoc).toHaveBeenCalled())
    withIndex() // what Firestore now serves

    expect((await lookupBGG('Wingspan')).source).toBe('index')
  })

  it('lets you cancel a preview without writing', async () => {
    render(<BggIndexManager ctx={ctx()} />)
    await userEvent.upload(chooser(), csvFile())
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Ready to publish/)).not.toBeInTheDocument()
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('rejects the wrong file with a clear message', async () => {
    render(<BggIndexManager ctx={ctx()} />)
    await userEvent.upload(chooser(), csvFile('a,b\n1,2\n', 'other.csv'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/doesn't look like BGG's boardgames_ranks\.csv/)
  })

  it('tells you to extract the zip', async () => {
    render(<BggIndexManager ctx={ctx()} />)
    // userEvent.upload honours the input's accept filter, so drive the change event directly
    const input = chooser()
    const zip = new File(['PK'], 'boardgames_ranks_2026-10-11.zip', { type: 'application/zip' })
    Object.defineProperty(input, 'files', { value: [zip], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/extract it first/)
  })

  it('explains a permission-denied write and keeps the preview so you can retry', async () => {
    setDoc.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'permission-denied' }))
    render(<BggIndexManager ctx={ctx()} />)
    await userEvent.upload(chooser(), csvFile())
    await userEvent.click(await screen.findByRole('button', { name: 'Publish to Firestore' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/security rule.*bggIndex/)
    expect(screen.getByText(/Ready to publish/)).toBeInTheDocument()
  })
})
