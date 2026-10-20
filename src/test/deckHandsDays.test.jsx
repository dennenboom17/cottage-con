import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeckHands } from '../App.jsx'

const slot = (id, day, type = 'prep', claimedBy = null) => ({ id, day, type, task: `${day} ${type} ${id}`, claimedBy, claimedByName: claimedBy ? 'x' : '' })
const slots = (...list) => Object.fromEntries(list.map((s) => [s.id, s]))
const mkCtx = (deckHands) => ({
  deckHands, users: { me: { id: 'me', name: 'Mia' } }, authUser: { uid: 'me' }, profile: { name: 'Mia' },
  doClaimSlot: vi.fn(), doUnclaimSlot: vi.fn(), doInitDeckHands: vi.fn(async () => {}),
})
const dayTab = (short) => screen.queryByRole('button', { name: new RegExp(short) })

describe('Deck Hands day tabs', () => {
  it('only offers days that have duties', () => {
    render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26'), slot('b', 'Nov 28', 'cleanup')))} />)
    expect(dayTab('Nov 26')).toBeInTheDocument()
    expect(dayTab('Nov 28')).toBeInTheDocument()
    expect(dayTab('Nov 27')).not.toBeInTheDocument()
    expect(dayTab('Nov 29')).not.toBeInTheDocument()
  })

  it('counts a day that has only prep, or only cleanup, as having duties', () => {
    render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 27', 'prep'), slot('b', 'Nov 29', 'cleanup')))} />)
    expect(dayTab('Nov 27')).toBeInTheDocument()
    expect(dayTab('Nov 29')).toBeInTheDocument()
    expect(dayTab('Nov 26')).not.toBeInTheDocument()
    expect(dayTab('Nov 28')).not.toBeInTheDocument()
  })

  it('shows every day when each has duties', () => {
    render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26'), slot('b', 'Nov 27'), slot('c', 'Nov 28'), slot('d', 'Nov 29')))} />)
    for (const d of ['Nov 26', 'Nov 27', 'Nov 28', 'Nov 29']) expect(dayTab(d)).toBeInTheDocument()
  })

  it('starts on the first day that has duties when the usual first day has none', () => {
    render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 27'), slot('b', 'Nov 29')))} />)
    expect(screen.getByText('Nov 27 prep a')).toBeInTheDocument()
    expect(screen.queryByText('Nov 29 prep b')).not.toBeInTheDocument()
    expect(dayTab('Nov 26')).not.toBeInTheDocument()
  })

  it('switches day when a tab is chosen', async () => {
    render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 27'), slot('b', 'Nov 29')))} />)
    await userEvent.click(dayTab('Nov 29'))
    expect(screen.getByText('Nov 29 prep b')).toBeInTheDocument()
    expect(screen.queryByText('Nov 27 prep a')).not.toBeInTheDocument()
  })

  it('moves to another day if the day being viewed loses all its duties', async () => {
    const both = slots(slot('a', 'Nov 26'), slot('b', 'Nov 27'))
    const { rerender } = render(<DeckHands ctx={mkCtx(both)} />)
    await userEvent.click(dayTab('Nov 27'))
    expect(screen.getByText('Nov 27 prep b')).toBeInTheDocument()
    rerender(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26')))} />)
    expect(dayTab('Nov 27')).not.toBeInTheDocument()
    expect(screen.getByText('Nov 26 prep a')).toBeInTheDocument()
  })

  it('brings a day back when it gets duties', () => {
    const { rerender } = render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26')))} />)
    expect(dayTab('Nov 28')).not.toBeInTheDocument()
    rerender(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26'), slot('c', 'Nov 28')))} />)
    expect(dayTab('Nov 28')).toBeInTheDocument()
  })

  it('keeps the chosen day when other days change', async () => {
    const { rerender } = render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26'), slot('b', 'Nov 28')))} />)
    await userEvent.click(dayTab('Nov 28'))
    rerender(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26'), slot('b', 'Nov 28'), slot('c', 'Nov 29')))} />)
    expect(screen.getByText('Nov 28 prep b')).toBeInTheDocument()
  })

  it('ignores duties on a day that is not one of the cottage days', () => {
    render(<DeckHands ctx={mkCtx(slots(slot('a', 'Nov 26'), slot('z', 'Dec 5')))} />)
    expect(dayTab('Dec 5')).not.toBeInTheDocument()
    expect(dayTab('Nov 26')).toBeInTheDocument()
  })

  it('shows no day tabs at all when there are no duties, and does not crash', () => {
    render(<DeckHands ctx={mkCtx(slots(slot('z', 'Dec 5')))} />)
    for (const d of ['Nov 26', 'Nov 27', 'Nov 28', 'Nov 29']) expect(dayTab(d)).not.toBeInTheDocument()
    expect(screen.getByText(/Crew Roster/)).toBeInTheDocument()
  })

  it('still lets the user claim a duty on the day shown', async () => {
    const ctx = mkCtx(slots(slot('a', 'Nov 27')))
    render(<DeckHands ctx={ctx} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign Up' }))
    expect(ctx.doClaimSlot).toHaveBeenCalledWith('a', 'me', 'Mia')
  })
})
