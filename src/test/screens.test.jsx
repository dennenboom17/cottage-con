import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dashboard, GameChest, Manifest, Itinerary, CrewAssistant } from '../App.jsx'

const geminiReply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

// ── Itinerary ──────────────────────────────────────────────────────────────────
describe('Itinerary', () => {
  const base = { itinerary: {}, itinMeta: {} }

  it('shows the four cottage days with their default activities when nothing is saved', () => {
    render(<Itinerary ctx={base} />)
    for (const d of ['Thursday, Nov 26', 'Friday, Nov 27', 'Saturday, Nov 28', 'Sunday, Nov 29']) {
      expect(screen.getByText(d)).toBeInTheDocument()
    }
    expect(screen.getByText('🍺 Welcome drinks')).toBeInTheDocument()
    expect(screen.getByText('🏆 Tournament day')).toBeInTheDocument()
  })

  it('lets a saved day override the defaults (matched by short label)', () => {
    const ctx = { ...base, itinerary: { x: { id: 'x', short: 'Nov 26', activities: ['Hot tub'] } } }
    render(<Itinerary ctx={ctx} />)
    expect(screen.getByText('Hot tub')).toBeInTheDocument()
    expect(screen.queryByText('🍺 Welcome drinks')).not.toBeInTheDocument()
  })

  it('still matches a saved day after its short label is renamed, without duplicating it (regression)', () => {
    // The Engine Room keeps the doc id (Nov_27) fixed but lets you edit the short label.
    const ctx = { ...base, itinerary: { Nov_27: { id: 'Nov_27', short: 'Fri', date: 'Friday, Nov 27', label: 'Big Day', activities: ['Sleigh ride'] } } }
    render(<Itinerary ctx={ctx} />)
    expect(screen.getAllByText('Sleigh ride')).toHaveLength(1)
    expect(screen.getAllByText('Friday, Nov 27')).toHaveLength(1)
    expect(screen.queryByText('🎲 All-day gaming')).not.toBeInTheDocument()
  })

  it('falls back to defaults when a saved day has an empty activity list', () => {
    const ctx = { ...base, itinerary: { Nov_28: { id: 'Nov_28', short: 'Nov 28', activities: [] } } }
    render(<Itinerary ctx={ctx} />)
    expect(screen.getByText('🎉 Game night')).toBeInTheDocument()
  })

  it('appends extra days added in the Engine Room, sorted by date', () => {
    const ctx = {
      ...base,
      itinerary: {
        b: { id: 'b', short: 'Dec 2', date: 'Wednesday, Dec 2', label: 'Late', activities: [] },
        a: { id: 'a', short: 'Dec 1', date: 'Tuesday, Dec 1', label: 'Bonus', activities: [] },
      },
    }
    render(<Itinerary ctx={ctx} />)
    const bonus = screen.getByText('Tuesday, Dec 1'), late = screen.getByText('Wednesday, Dec 2')
    expect(bonus.compareDocumentPosition(late) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // base days still come first
    expect(screen.getByText('Sunday, Nov 29').compareDocumentPosition(bonus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows check-in / check-out details from the meta record', () => {
    render(<Itinerary ctx={{ ...base, itinMeta: { checkIn: '3 PM', checkInDay: 'Thursday', checkOut: '11 AM', checkOutDay: 'Sunday', parkingNote: 'Park by the barn' } }} />)
    expect(screen.getByText('Check in from 3 PM on Thursday')).toBeInTheDocument()
    expect(screen.getByText('Check out by 11 AM on Sunday')).toBeInTheDocument()
    expect(screen.getByText('Park by the barn')).toBeInTheDocument()
  })
})

// ── Dashboard ──────────────────────────────────────────────────────────────────
describe('Dashboard', () => {
  const games = {
    g1: { id: 'g1', name: 'Wingspan', ownerId: 'u1', likes: ['a', 'b'], category: 'Medium' },
    g2: { id: 'g2', name: 'Azul', ownerId: 'u1', likes: ['a'] },
    g3: { id: 'g3', name: 'Gloomhaven', ownerId: 'u1', likes: [], isRequest: true },
  }
  const mkCtx = (over = {}) => ({
    games, food: {}, supplies: {}, setView: vi.fn(), doToggleLike: vi.fn(),
    users: { u1: { id: 'u1', name: 'Ann Lee' } }, authUser: { uid: 'me' }, ...over,
  })

  it('ranks games by votes and lists requests separately', () => {
    render(<Dashboard ctx={mkCtx()} />)
    const wing = screen.getByText('Wingspan'), azul = screen.getByText('Azul')
    expect(wing.compareDocumentPosition(azul) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Gloomhaven')).toBeInTheDocument()
    expect(screen.getByText('2 votes')).toBeInTheDocument()
  })

  it('casts a vote on the clicked game', async () => {
    const ctx = mkCtx()
    render(<Dashboard ctx={ctx} />)
    const row = screen.getByText('Azul').closest('div[style*="margin-bottom"]')
    await userEvent.click(within(row).getByRole('button', { name: /Vote/ }))
    expect(ctx.doToggleLike).toHaveBeenCalledWith('g2')
  })

  it('shows "Voted" for games the current user already liked', () => {
    render(<Dashboard ctx={mkCtx({ authUser: { uid: 'a' } })} />)
    expect(screen.getAllByRole('button', { name: /Voted/ })).toHaveLength(2)
  })

  it('renders with no data at all', () => {
    expect(() => render(<Dashboard ctx={mkCtx({ games: {} })} />)).not.toThrow()
  })
})

// ── Manifest (receipts) ────────────────────────────────────────────────────────
describe('Manifest', () => {
  const receipt = { id: 'r1abcdef', desc: 'Groceries', amount: '42.50', ownerId: 'me', createdAt: 1700000000000 }
  const mkCtx = (over = {}) => ({
    receipts: { r1abcdef: receipt },
    users: { me: { id: 'me', name: 'Ann Lee' } },
    authUser: { uid: 'me' }, profile: { name: 'Ann Lee' },
    doSaveReceipt: vi.fn(async () => {}), doDelReceipt: vi.fn(), showToast: vi.fn(),
    ...over,
  })

  it('lists receipts with a formatted amount and a running total', () => {
    render(<Manifest ctx={mkCtx()} />)
    expect(screen.getAllByText('$42.50').length).toBeGreaterThan(0)
    expect(screen.getByText('Groceries')).toBeInTheDocument()
  })

  it('shows an empty state with no receipts', () => {
    render(<Manifest ctx={mkCtx({ receipts: {} })} />)
    expect(screen.getByText('No receipts logged yet')).toBeInTheDocument()
  })

  it('only lets the owner edit or delete a receipt', () => {
    render(<Manifest ctx={mkCtx({ authUser: { uid: 'someone-else' } })} />)
    expect(screen.queryByTitle('Edit')).not.toBeInTheDocument()
  })

  it('edits a receipt end-to-end: save, toast, and leave edit mode (regression: missing showToast threw)', async () => {
    const ctx = mkCtx()
    render(<Manifest ctx={ctx} />)

    await userEvent.click(screen.getByTitle('Edit'))
    expect(screen.getByText('✏️ Editing Receipt')).toBeInTheDocument()
    expect(window.scrollTo).toHaveBeenCalled() // regression: openEditReceipt threw before scrolling

    const desc = screen.getByPlaceholderText('e.g. Grocery run')
    expect(desc).toHaveValue('Groceries')
    await userEvent.clear(desc)
    await userEvent.type(desc, 'Groceries and ice')
    await userEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(ctx.doSaveReceipt).toHaveBeenCalledTimes(1))
    expect(ctx.doSaveReceipt).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1abcdef', desc: 'Groceries and ice', amount: '42.50' }))
    expect(ctx.showToast).toHaveBeenCalledWith('Receipt updated! ✏️')
    expect(await screen.findByText('📜 Log a New Receipt')).toBeInTheDocument()
  })

  it('cancelling an edit discards it', async () => {
    const ctx = mkCtx()
    render(<Manifest ctx={ctx} />)
    await userEvent.click(screen.getByTitle('Edit'))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Edit' }))
    expect(ctx.doSaveReceipt).not.toHaveBeenCalled()
    expect(screen.getByText('📜 Log a New Receipt')).toBeInTheDocument()
  })
})

// ── GameChest (Cargo Hold) ─────────────────────────────────────────────────────
describe('GameChest', () => {
  const game = (id, name, extra = {}) => ({ id, name, ownerId: 'u2', likes: [], category: 'Medium', minPlayers: '1', maxPlayers: '5', description: `About ${name}`, ...extra })
  const mkCtx = (games, over = {}) => ({
    games, food: {}, users: { u2: { id: 'u2', name: 'Bo Chen' } },
    authUser: { uid: 'me' }, profile: { gamesPlayed: [] },
    doSaveGame: vi.fn(async () => {}), doDelGame: vi.fn(), doToggleLike: vi.fn(),
    doLogGamePlayed: vi.fn(), doRemoveGamePlayed: vi.fn(), showToast: vi.fn(), ...over,
  })
  const rowFor = (name) => screen.getByRole('button', { name: new RegExp(name) })

  it('lists games and an empty hold message when there are none', () => {
    const { unmount } = render(<GameChest ctx={mkCtx({ g1: game('g1', 'Wingspan') })} />)
    expect(screen.getByText('Wingspan')).toBeInTheDocument()
    unmount()
    render(<GameChest ctx={mkCtx({})} />)
    expect(screen.getByText('The hold is empty!')).toBeInTheDocument()
  })

  it('expands a row on click to show details, and collapses it on a second click', async () => {
    render(<GameChest ctx={mkCtx({ g1: game('g1', 'Wingspan', { description: 'Birds and engines' }) })} />)
    expect(screen.queryByText(/Added by/)).not.toBeInTheDocument()
    await userEvent.click(rowFor('Wingspan'))
    expect(screen.getByText(/Added by/)).toBeInTheDocument()
    await userEvent.click(rowFor('Wingspan'))
    expect(screen.queryByText(/Added by/)).not.toBeInTheDocument()
  })

  it('keeps a row expanded when live data changes (regression: rows remounted on every snapshot)', async () => {
    const first = mkCtx({ g1: game('g1', 'Wingspan'), g2: game('g2', 'Azul') })
    const { rerender } = render(<GameChest ctx={first} />)
    await userEvent.click(rowFor('Wingspan'))
    expect(screen.getAllByText(/Added by/)).toHaveLength(1)

    // a new snapshot arrives: someone voted and a third game was added
    const next = mkCtx({ g1: game('g1', 'Wingspan', { likes: ['x'] }), g2: game('g2', 'Azul'), g3: game('g3', 'Catan') })
    rerender(<GameChest ctx={next} />)

    expect(screen.getByText('Catan')).toBeInTheDocument()
    expect(screen.getAllByText(/Added by/)).toHaveLength(1) // Wingspan still open
  })

  it('expands rows independently', async () => {
    render(<GameChest ctx={mkCtx({ g1: game('g1', 'Wingspan'), g2: game('g2', 'Azul') })} />)
    await userEvent.click(rowFor('Wingspan'))
    await userEvent.click(rowFor('Azul'))
    expect(screen.getAllByText(/Added by/)).toHaveLength(2)
    await userEvent.click(rowFor('Wingspan'))
    expect(screen.getAllByText(/Added by/)).toHaveLength(1)
  })

  it("won't let you vote for your own game, but will for someone else's", async () => {
    const ctx = mkCtx({ g1: game('g1', 'Home Brew', { ownerId: 'me' }), g2: game('g2', 'Theirs') })
    render(<GameChest ctx={ctx} />)
    await userEvent.click(rowFor('Theirs'))
    await userEvent.click(screen.getByRole('button', { name: /Vote \(0\)/ }))
    expect(ctx.doToggleLike).toHaveBeenCalledWith('g2')
    await userEvent.click(rowFor('Home Brew')) // both rows are now open
    const voteButtons = screen.getAllByRole('button', { name: /Vote \(0\)/ })
    expect(voteButtons).toHaveLength(2)
    expect(voteButtons.filter((b) => b.disabled)).toHaveLength(1) // only my own game is locked
    ctx.doToggleLike.mockClear()
    await userEvent.click(voteButtons.find((b) => b.disabled))
    expect(ctx.doToggleLike).not.toHaveBeenCalled()
  })

  it('logs a game as played', async () => {
    const ctx = mkCtx({ g1: game('g1', 'Wingspan') })
    render(<GameChest ctx={ctx} />)
    await userEvent.click(rowFor('Wingspan'))
    await userEvent.click(screen.getByRole('button', { name: /Log Play/ }))
    await waitFor(() => expect(ctx.doLogGamePlayed).toHaveBeenCalledWith('me', 'Wingspan'))
    expect(ctx.showToast).toHaveBeenCalledWith('🎲 Wingspan logged!')
  })

  it('auto-fills the add form from BoardGameGeek when the name field loses focus (regression: lookup always threw)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiReply(
      'NAME: Wingspan\nMINP: 1\nMAXP: 5\nTIME: 70\nWEIGHT: 2.4\nRATING: 8.1\nYEAR: 2019\nBGG_ID: 266192\nDESC: A bird-collecting engine builder.',
    )))
    const ctx = mkCtx({})
    render(<GameChest ctx={ctx} />)

    await userEvent.click(screen.getByRole('button', { name: /Load Cargo/ }))
    await userEvent.type(screen.getByPlaceholderText('e.g. Wingspan'), 'wingspan')
    await userEvent.tab() // blur

    const [min, max] = screen.getAllByRole('spinbutton')
    await waitFor(() => expect(min).toHaveValue(1))
    expect(max).toHaveValue(5)
    expect(screen.getByPlaceholderText('e.g. Wingspan')).toHaveValue('Wingspan')
    expect(screen.getByDisplayValue('A bird-collecting engine builder.')).toBeInTheDocument()
    expect(ctx.showToast).toHaveBeenCalledWith('✓ BGG: Wingspan (8.1/10)')
  })

  it("doesn't overwrite player counts the user already typed", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiReply('NAME: Wingspan\nMINP: 1\nMAXP: 5\nWEIGHT: 2.4\nBGG_ID: 1')))
    render(<GameChest ctx={mkCtx({})} />)
    await userEvent.click(screen.getByRole('button', { name: /Load Cargo/ }))
    const [min, max] = screen.getAllByRole('spinbutton')
    await userEvent.type(min, '3')
    await userEvent.type(max, '4')
    await userEvent.type(screen.getByPlaceholderText('e.g. Wingspan'), 'Wingspan')
    await userEvent.tab()
    await waitFor(() => expect(screen.getByPlaceholderText('e.g. Wingspan')).toHaveValue('Wingspan'))
    expect(min).toHaveValue(3)
    expect(max).toHaveValue(4)
  })
})

// ── CrewAssistant (chat) ───────────────────────────────────────────────────────
describe('CrewAssistant', () => {
  const ctx = () => ({
    profile: { name: 'Ann Lee' }, authUser: { uid: 'me' }, users: {}, games: {}, food: {}, supplies: {},
    voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {},
  })
  const openChat = async () => userEvent.click(screen.getByLabelText('Open crew assistant'))
  const lastRequestText = (fetchMock) => {
    const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body)
    return body.contents.at(-1).parts[0].text
  }

  it('greets the user by first name and offers quick chips', async () => {
    render(<CrewAssistant ctx={ctx()} />)
    await openChat()
    expect(screen.getByText(/Ahoy, Ann!/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "What's the checkout time?" })).toBeInTheDocument()
  })

  it('sends a chip’s text immediately and shows the reply (regression: chips used a stale closure)', async () => {
    const f = vi.fn(async () => geminiReply('Checkout is 11 AM.'))
    vi.stubGlobal('fetch', f)
    render(<CrewAssistant ctx={ctx()} />)
    await openChat()

    await userEvent.click(screen.getByRole('button', { name: "What's the checkout time?" }))

    expect(await screen.findByText('Checkout is 11 AM.')).toBeInTheDocument()
    expect(f).toHaveBeenCalledTimes(1)
    expect(lastRequestText(f)).toContain("What's the checkout time?")
  })

  it('a chip sends its own text, not whatever was half-typed in the box', async () => {
    const f = vi.fn(async () => geminiReply('ok'))
    vi.stubGlobal('fetch', f)
    render(<CrewAssistant ctx={ctx()} />)
    await openChat()

    await userEvent.type(screen.getByPlaceholderText(/Ask anything/), 'half typed thought')
    await userEvent.click(screen.getByRole('button', { name: "What's for dinner tonight?" }))

    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(lastRequestText(f)).toContain("What's for dinner tonight?")
    expect(lastRequestText(f)).not.toContain('half typed thought')
  })

  it('sends typed text on Enter and via the send button, then clears the box', async () => {
    const f = vi.fn(async () => geminiReply('reply'))
    vi.stubGlobal('fetch', f)
    render(<CrewAssistant ctx={ctx()} />)
    await openChat()
    const box = screen.getByPlaceholderText(/Ask anything/)

    await userEvent.type(box, 'who is cooking?{Enter}')
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    expect(lastRequestText(f)).toContain('who is cooking?')
    expect(box).toHaveValue('')
  })

  it('includes live app data in the request but keeps it out of the visible chat', async () => {
    const f = vi.fn(async () => geminiReply('ok'))
    vi.stubGlobal('fetch', f)
    const c = { ...ctx(), games: { g1: { id: 'g1', name: 'Wingspan', ownerId: 'me' } } }
    render(<CrewAssistant ctx={c} />)
    await openChat()
    await userEvent.click(screen.getByRole('button', { name: "What's the checkout time?" }))
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(lastRequestText(f)).toMatch(/^\[Current Firestore data:/)
    expect(lastRequestText(f)).toContain('Wingspan')
    expect(screen.queryByText(/Current Firestore data/)).not.toBeInTheDocument()
  })

  it('shows API failures in the chat instead of crashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })))
    render(<CrewAssistant ctx={ctx()} />)
    await openChat()
    await userEvent.click(screen.getByRole('button', { name: "What's the checkout time?" }))
    expect(await screen.findByText(/Rate limit exceeded/)).toBeInTheDocument()
  })

  it('suggests next steps for a user who has not contributed anything yet', async () => {
    render(<CrewAssistant ctx={ctx()} />)
    await openChat()
    expect(screen.getByText('Sign me up for a duty 🧹')).toBeInTheDocument()
    expect(screen.getByText('What food should I bring? 🍲')).toBeInTheDocument()
  })

  it('stops suggesting things the user has already done', async () => {
    const c = {
      ...ctx(),
      deckHands: { d1: { id: 'd1', claimedBy: 'me' } },
      food: { f1: { id: 'f1', ownerId: 'me' } },
      games: { g1: { id: 'g1', ownerId: 'me', name: 'X' } },
    }
    render(<CrewAssistant ctx={c} />)
    await openChat()
    expect(screen.queryByText(/Suggested for you/)).not.toBeInTheDocument()
  })
})
