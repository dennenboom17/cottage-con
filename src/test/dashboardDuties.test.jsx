import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dashboard } from '../App.jsx'

const slot = (id, claimedBy = null, over = {}) => ({ id, day: 'Nov 26', type: 'prep', task: `Task ${id}`, claimedBy, claimedByName: claimedBy ? 'Someone' : '', ...over })
const mkCtx = (deckHands, over = {}) => ({
  games: {}, food: {}, supplies: {}, setView: vi.fn(), doToggleLike: vi.fn(),
  users: { me: { id: 'me', name: 'Mia' }, u2: { id: 'u2', name: 'Bo' } }, authUser: { uid: 'me' }, deckHands, ...over,
})
const tile = () => screen.getByText('Open Duties').parentElement

describe('Bridge: Open Duties card', () => {
  it('counts the duties nobody has claimed yet', () => {
    render(<Dashboard ctx={mkCtx({ a: slot('a'), b: slot('b'), c: slot('c', 'u2'), d: slot('d', 'me') })} />)
    expect(within(tile()).getByText('2')).toBeInTheDocument()
  })

  it('says, in smaller text, how many the current user signed up for', () => {
    render(<Dashboard ctx={mkCtx({ a: slot('a'), b: slot('b', 'me'), c: slot('c', 'me'), d: slot('d', 'u2') })} />)
    const sub = within(tile()).getByText('You signed up for 2')
    expect(sub).toBeInTheDocument()
    const count = within(tile()).getByText('1')
    expect(parseFloat(sub.style.fontSize)).toBeLessThan(parseFloat(count.style.fontSize))
  })

  it("does not count other people's duties as the user's", () => {
    render(<Dashboard ctx={mkCtx({ a: slot('a', 'u2'), b: slot('b', 'u2'), c: slot('c') })} />)
    expect(within(tile()).getByText('You signed up for 0')).toBeInTheDocument()
    expect(within(tile()).getByText('1')).toBeInTheDocument()
  })

  it('shows none outstanding once everything is claimed', () => {
    render(<Dashboard ctx={mkCtx({ a: slot('a', 'me'), b: slot('b', 'u2') })} />)
    expect(within(tile()).getByText('0')).toBeInTheDocument()
    expect(within(tile()).getByText('You signed up for 1')).toBeInTheDocument()
  })

  it('says so when no duties have been set up yet, instead of implying the user signed up for none', () => {
    render(<Dashboard ctx={mkCtx({})} />)
    expect(within(tile()).getByText('0')).toBeInTheDocument()
    expect(within(tile()).getByText('No duties set up yet')).toBeInTheDocument()
    expect(screen.queryByText(/You signed up for/)).not.toBeInTheDocument()
  })

  it('copes with a context that has no duty data at all', () => {
    const ctx = mkCtx(undefined)
    delete ctx.deckHands
    expect(() => render(<Dashboard ctx={ctx} />)).not.toThrow()
    expect(within(tile()).getByText('No duties set up yet')).toBeInTheDocument()
  })

  it('does not credit a signed-out visitor with other people\'s duties', () => {
    render(<Dashboard ctx={mkCtx({ a: slot('a', 'u2'), b: slot('b') }, { authUser: undefined })} />)
    expect(within(tile()).getByText('You signed up for 0')).toBeInTheDocument()
  })

  it('takes the user to Deck Hands when tapped', async () => {
    const ctx = mkCtx({ a: slot('a') })
    render(<Dashboard ctx={ctx} />)
    await userEvent.click(tile())
    expect(ctx.setView).toHaveBeenCalledWith('deckhands', { section: 'duties' })
  })

  it('updates as duties are claimed', () => {
    const slots = { a: slot('a'), b: slot('b') }
    const { rerender } = render(<Dashboard ctx={mkCtx(slots)} />)
    expect(within(tile()).getByText('2')).toBeInTheDocument()
    rerender(<Dashboard ctx={mkCtx({ ...slots, a: slot('a', 'me') })} />)
    expect(within(tile()).getByText('1')).toBeInTheDocument()
    expect(within(tile()).getByText('You signed up for 1')).toBeInTheDocument()
  })
})
