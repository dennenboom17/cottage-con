import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Dashboard, DeckHands } from '../App.jsx'

const game = (id, ownerId, likes = [], over = {}) => ({ id, name: `Game ${id}`, ownerId, likes, category: 'Medium', ...over })
const games = {
  g1: game('g1', 'me', ['u2']),                       // mine; one vote (not mine)
  g2: game('g2', 'u2', ['me', 'u2']),                 // theirs; I voted
  g3: game('g3', 'u2', []),                           // theirs, no votes
  r1: game('r1', 'me', ['me'], { isRequest: true }),  // my request, which I also voted for (requests are voted on too)
}
const food = { f1: { id: 'f1', name: 'Stew', ownerId: 'me' }, f2: { id: 'f2', name: 'Bread', ownerId: 'u2' } }
const supplies = { s1: { id: 's1', name: 'Stove', ownerId: 'me' }, s2: { id: 's2', name: 'Kettle', ownerId: 'me' }, s3: { id: 's3', name: 'Tent', ownerId: 'u2' } }
const mkCtx = (over = {}) => ({
  games, food, supplies, deckHands: {}, setView: vi.fn(), doToggleLike: vi.fn(),
  users: { me: { id: 'me', name: 'Mia' }, u2: { id: 'u2', name: 'Bo' } }, authUser: { uid: 'me' }, ...over,
})
const tile = (label) => screen.getByText(label).parentElement

describe('Bridge cards show the user\'s own share in smaller text', () => {
  it('Cargo Hold: the total games, and how many the user added', () => {
    render(<Dashboard ctx={mkCtx()} />)
    expect(within(tile('Cargo Hold')).getByText('3')).toBeInTheDocument() // requests are not in the hold
    expect(within(tile('Cargo Hold')).getByText('You added 1')).toBeInTheDocument()
  })

  it('Votes: the total votes, and how many the user cast', () => {
    render(<Dashboard ctx={mkCtx()} />)
    expect(within(tile('Votes')).getByText('4')).toBeInTheDocument()
    expect(within(tile('Votes')).getByText('You cast 2')).toBeInTheDocument()
  })

  it('Provisions: the total, and how many the user added', () => {
    render(<Dashboard ctx={mkCtx()} />)
    expect(within(tile('Provisions')).getByText('2')).toBeInTheDocument()
    expect(within(tile('Provisions')).getByText('You added 1')).toBeInTheDocument()
  })

  it('Gear: the total, and how many the user added', () => {
    render(<Dashboard ctx={mkCtx()} />)
    expect(within(tile('Gear')).getByText('3')).toBeInTheDocument()
    expect(within(tile('Gear')).getByText('You added 2')).toBeInTheDocument()
  })

  it('shows zeros for a user who has contributed nothing', () => {
    render(<Dashboard ctx={mkCtx({ authUser: { uid: 'newbie' } })} />)
    expect(within(tile('Cargo Hold')).getByText('You added 0')).toBeInTheDocument()
    expect(within(tile('Votes')).getByText('You cast 0')).toBeInTheDocument()
    expect(within(tile('Provisions')).getByText('You added 0')).toBeInTheDocument()
    expect(within(tile('Gear')).getByText('You added 0')).toBeInTheDocument()
  })

  it('credits nothing to a signed-out visitor, even for items with no owner', () => {
    const ctx = mkCtx({
      authUser: undefined,
      games: { g9: { id: 'g9', name: 'Orphan', likes: [] } }, food: { f9: { id: 'f9', name: 'Mystery' } }, supplies: { s9: { id: 's9', name: 'Thing' } },
    })
    render(<Dashboard ctx={ctx} />)
    for (const [label, text] of [['Cargo Hold', 'You added 0'], ['Votes', 'You cast 0'], ['Provisions', 'You added 0'], ['Gear', 'You added 0']]) {
      expect(within(tile(label)).getByText(text)).toBeInTheDocument()
    }
  })

  it('is set in smaller type than the total, and the totals themselves are unchanged', () => {
    render(<Dashboard ctx={mkCtx()} />)
    for (const [label, total, sub] of [['Cargo Hold', '3', 'You added 1'], ['Votes', '4', 'You cast 2'], ['Provisions', '2', 'You added 1'], ['Gear', '3', 'You added 2']]) {
      const t = tile(label)
      const big = within(t).getByText(total), small = within(t).getByText(sub)
      expect(parseFloat(small.style.fontSize), label).toBeLessThan(parseFloat(big.style.fontSize))
    }
  })

  it('leaves the Crew card as it was', () => {
    render(<Dashboard ctx={mkCtx()} />)
    expect(within(tile('Crew')).getByText('2')).toBeInTheDocument()
    expect(within(tile('Crew')).queryByText(/^You /)).not.toBeInTheDocument()
  })

  it('updates when the user adds something', () => {
    const { rerender } = render(<Dashboard ctx={mkCtx()} />)
    expect(within(tile('Gear')).getByText('You added 2')).toBeInTheDocument()
    rerender(<Dashboard ctx={mkCtx({ supplies: { ...supplies, s4: { id: 's4', name: 'Lantern', ownerId: 'me' } } })} />)
    expect(within(tile('Gear')).getByText('4')).toBeInTheDocument()
    expect(within(tile('Gear')).getByText('You added 3')).toBeInTheDocument()
  })
})

describe('Deck Hands page order', () => {
  const slot = (id, type, claimedBy = null) => ({ id, day: 'Nov 26', type, task: `${type} job ${id}`, claimedBy, claimedByName: claimedBy ? 'x' : '' })
  const ctx = (deckHands) => ({
    deckHands, users: { me: { id: 'me', name: 'Mia' }, u2: { id: 'u2', name: 'Bo' } }, authUser: { uid: 'me' }, profile: { name: 'Mia' },
    doClaimSlot: vi.fn(), doUnclaimSlot: vi.fn(), doInitDeckHands: vi.fn(async () => {}),
  })
  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('puts the duty assignments above the crew roster', () => {
    render(<DeckHands ctx={ctx({ a: slot('a', 'prep', 'me'), b: slot('b', 'cleanup'), c: slot('c', 'prep') })} />)
    const mine = screen.getByText(/My Duty Assignments/)
    const prep = screen.getByText(/Preparation/)
    const clean = screen.getByText(/Cleanup/)
    const roster = screen.getByText(/Crew Roster/)
    expect(before(mine, prep)).toBe(true)
    expect(before(prep, clean)).toBe(true)
    expect(before(clean, roster)).toBe(true)
    expect(before(mine, roster)).toBe(true)
  })

  it('still lists the crew, with the duties above them even with no assignments of the user\'s own', () => {
    render(<DeckHands ctx={ctx({ a: slot('a', 'prep'), b: slot('b', 'cleanup') })} />)
    expect(screen.queryByText(/My Duty Assignments/)).not.toBeInTheDocument()
    expect(before(screen.getByText(/Preparation/), screen.getByText(/Crew Roster/))).toBe(true)
    expect(screen.getByText('Mia')).toBeInTheDocument()
    expect(screen.getByText('Bo')).toBeInTheDocument()
  })

  it('keeps the day picker with the duties, above the crew', () => {
    render(<DeckHands ctx={ctx({ a: slot('a', 'prep') })} />)
    const day = screen.getByRole('button', { name: /Nov 26/ })
    expect(before(day, screen.getByText(/Crew Roster/))).toBe(true)
  })
})
