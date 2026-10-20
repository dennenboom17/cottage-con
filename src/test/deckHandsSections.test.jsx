import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import App, { DeckHands, Dashboard, parseHash, viewFromHash, sectionFromHash, validSection, writeViewHash, VIEW_SECTIONS } from '../App.jsx'

vi.setConfig({ testTimeout: 20000 })

const scrolled = () => Element.prototype.scrollIntoView.mock.contexts.map((el) => el.id)
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  Element.prototype.scrollIntoView.mockClear()
  window.scrollTo.mockClear()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('section links in the URL hash', () => {
  it('reads a page and an optional section', () => {
    expect(parseHash('#/deckhands/crew')).toEqual({ view: 'deckhands', section: 'crew' })
    expect(parseHash('#/deckhands/duties')).toEqual({ view: 'deckhands', section: 'duties' })
    expect(parseHash('#/deckhands')).toEqual({ view: 'deckhands', section: null })
    expect(parseHash('#/deckhands/crew/')).toEqual({ view: 'deckhands', section: 'crew' })
    expect(parseHash('#/itinerary')).toEqual({ view: 'itinerary', section: null })
  })

  it('rejects unknown sections, and sections on pages that have none', () => {
    for (const h of ['#/deckhands/nope', '#/itinerary/crew', '#/dashboard/duties', '#/deckhands/crew/extra', '#/login/crew', '', null, undefined]) {
      expect(parseHash(h), String(h)).toBeNull()
    }
  })

  it('keeps the old view helpers working', () => {
    expect(viewFromHash('#/deckhands/crew')).toBe('deckhands')
    expect(sectionFromHash('#/deckhands/crew')).toBe('crew')
    expect(sectionFromHash('#/deckhands')).toBeNull()
    expect(viewFromHash('#/deckhands/nope')).toBeNull()
  })

  it('knows which sections each page has', () => {
    expect(VIEW_SECTIONS.deckhands).toEqual(['duties', 'crew'])
    expect(validSection('deckhands', 'crew')).toBe('crew')
    expect(validSection('deckhands', 'x')).toBeNull()
    expect(validSection('games', 'crew')).toBeNull()
    expect(validSection('deckhands', null)).toBeNull()
  })

  it('writes the section into the URL, and ignores one the page does not have', () => {
    writeViewHash('deckhands', false, 'crew')
    expect(window.location.hash).toBe('#/deckhands/crew')
    writeViewHash('deckhands', false, 'bogus')
    expect(window.location.hash).toBe('#/deckhands')
    writeViewHash('games', false, 'crew')
    expect(window.location.hash).toBe('#/games')
  })
})

describe('Deck Hands scrolls to a linked section', () => {
  const slot = (id, type) => ({ id, day: 'Nov 26', type, task: `${type} ${id}`, claimedBy: null, claimedByName: '' })
  const mkCtx = (over = {}) => ({
    deckHands: { a: slot('a', 'prep'), b: slot('b', 'cleanup') }, users: { me: { id: 'me', name: 'Mia' } }, authUser: { uid: 'me' }, profile: { name: 'Mia' },
    doClaimSlot: vi.fn(), doUnclaimSlot: vi.fn(), doInitDeckHands: vi.fn(async () => {}), ...over,
  })

  it('has a section for the duties and one for the crew roster', () => {
    const { container } = render(<DeckHands ctx={mkCtx()} />)
    const duties = container.querySelector('#section-duties'), crew = container.querySelector('#section-crew')
    expect(duties).toBeTruthy()
    expect(crew).toBeTruthy()
    expect(within(duties).getByText(/Preparation/)).toBeInTheDocument()
    expect(within(crew).getByText(/Crew Roster/)).toBeInTheDocument()
    expect(duties.compareDocumentPosition(crew) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('scrolls to the crew roster for "crew"', () => {
    render(<DeckHands ctx={mkCtx({ viewSection: 'crew' })} />)
    expect(scrolled()).toEqual(['section-crew'])
  })

  it('scrolls to the duties for "duties"', () => {
    render(<DeckHands ctx={mkCtx({ viewSection: 'duties' })} />)
    expect(scrolled()).toEqual(['section-duties'])
  })

  it('does not scroll when no section was asked for', () => {
    render(<DeckHands ctx={mkCtx()} />)
    expect(scrolled()).toEqual([])
  })

  it('does not scroll, or crash, for a section the page does not have', () => {
    render(<DeckHands ctx={mkCtx({ viewSection: 'bogus' })} />)
    expect(scrolled()).toEqual([])
  })

  it('scrolls smoothly, or at once for someone who prefers reduced motion', () => {
    render(<DeckHands ctx={mkCtx({ viewSection: 'crew' })} />)
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' })
    Element.prototype.scrollIntoView.mockClear()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    render(<DeckHands ctx={mkCtx({ viewSection: 'duties' })} />)
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'start' })
  })

  it('waits for the roster to be set up before scrolling', async () => {
    let finish
    const doInitDeckHands = vi.fn(() => new Promise((r) => { finish = r }))
    render(<DeckHands ctx={mkCtx({ deckHands: {}, doInitDeckHands, viewSection: 'crew' })} />)
    expect(scrolled()).toEqual([]) // still preparing the roster
    await act(async () => { finish() })
    expect(scrolled()).toContain('section-crew')
  })

  it('scrolls again when a different section is linked while on the page', () => {
    const { rerender } = render(<DeckHands ctx={mkCtx({ viewSection: 'crew' })} />)
    rerender(<DeckHands ctx={mkCtx({ viewSection: 'duties' })} />)
    expect(scrolled()).toEqual(['section-crew', 'section-duties'])
  })
})

describe('the Bridge links to the right section', () => {
  const ctx = () => ({
    games: {}, food: {}, supplies: {}, setView: vi.fn(), doToggleLike: vi.fn(), deckHands: { a: { id: 'a', day: 'Nov 26', type: 'prep', task: 't' } },
    users: { me: { id: 'me', name: 'Mia' } }, authUser: { uid: 'me' },
  })

  it('Crew goes to the crew roster', async () => {
    const c = ctx()
    render(<Dashboard ctx={c} />)
    await userEvent.click(screen.getByText('Crew').parentElement)
    expect(c.setView).toHaveBeenCalledWith('deckhands', { section: 'crew' })
  })

  it('Open Duties goes to the duties', async () => {
    const c = ctx()
    render(<Dashboard ctx={c} />)
    await userEvent.click(screen.getByText('Open Duties').parentElement)
    expect(c.setView).toHaveBeenCalledWith('deckhands', { section: 'duties' })
  })

  it('the Crew Roster card further down goes to the crew roster too', async () => {
    const c = ctx()
    render(<Dashboard ctx={c} />)
    await userEvent.click(screen.getByText(/view deck hands/i))
    expect(c.setView).toHaveBeenCalledWith('deckhands', { section: 'crew' })
  })

  it('the other cards still go where they did, with no section', async () => {
    const c = ctx()
    render(<Dashboard ctx={c} />)
    await userEvent.click(screen.getByText('Cargo Hold').parentElement)
    await userEvent.click(screen.getByText('Provisions').parentElement)
    expect(c.setView.mock.calls).toEqual([['games'], ['potluck']])
  })
})

describe('end to end in the app', () => {
  const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
  const profile = { id: 'me', name: 'Mia', email: 'mia@example.com', onboarded: true, crewRank: 'Enlisted', loginHistory: [] }

  async function openApp() {
    onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
    getDoc.mockResolvedValue({ exists: () => true, data: () => profile })
    render(<App />)
    await screen.findByRole('navigation', { name: 'Main' })
    return userEvent.setup()
  }
  const tile = (label) => screen.getByText(label).parentElement

  it('tapping Crew opens Deck Hands at the crew roster, in a linkable URL', async () => {
    const user = await openApp()
    await screen.findByText(/Departure Countdown/)
    window.scrollTo.mockClear()
    await user.click(tile('Crew'))
    await vi.waitFor(() => expect(scrolled()).toContain('section-crew'))
    expect(window.location.hash).toBe('#/deckhands/crew')
    expect(window.scrollTo).not.toHaveBeenCalledWith(0, 0) // not thrown back to the top
  })

  it('tapping Open Duties opens Deck Hands at the duties', async () => {
    const user = await openApp()
    await screen.findByText(/Departure Countdown/)
    await user.click(tile('Open Duties'))
    await vi.waitFor(() => expect(scrolled()).toContain('section-duties'))
    expect(scrolled()).not.toContain('section-crew')
    expect(window.location.hash).toBe('#/deckhands/duties')
  })

  it('choosing Deck Hands from the nav bar still starts at the top, with no section', async () => {
    const user = await openApp()
    await screen.findByText(/Departure Countdown/)
    await user.click(tile('Crew'))
    await vi.waitFor(() => expect(window.location.hash).toBe('#/deckhands/crew'))
    window.scrollTo.mockClear(); Element.prototype.scrollIntoView.mockClear()
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Deck Hands/ }))
    expect(window.location.hash).toBe('#/deckhands')
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
    expect(scrolled()).toEqual([])
  })

  it('Back from a section returns to the Bridge, at the top', async () => {
    const user = await openApp()
    await screen.findByText(/Departure Countdown/)
    await user.click(tile('Crew'))
    await vi.waitFor(() => expect(window.location.hash).toBe('#/deckhands/crew'))
    window.scrollTo.mockClear()
    act(() => { window.history.back() })
    expect(await screen.findByText(/Departure Countdown/)).toBeInTheDocument()
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('a link to a section opens at that section after a reload or from a shared link', async () => {
    window.history.replaceState(null, '', '#/deckhands/crew')
    await openApp()
    await vi.waitFor(() => expect(scrolled()).toContain('section-crew'))
    expect(window.location.hash).toBe('#/deckhands/crew')
  })

  it('follows a hand-edited hash from one section to another', async () => {
    window.history.replaceState(null, '', '#/deckhands/crew')
    await openApp()
    await vi.waitFor(() => expect(scrolled()).toContain('section-crew'))
    Element.prototype.scrollIntoView.mockClear()
    act(() => { window.location.hash = '#/deckhands/duties' })
    await vi.waitFor(() => expect(scrolled()).toContain('section-duties'))
  })

  it('treats an unknown section as a bad link and lands on the Bridge', async () => {
    window.history.replaceState(null, '', '#/deckhands/bogus')
    await openApp()
    expect(await screen.findByText(/Departure Countdown/)).toBeInTheDocument()
    expect(window.location.hash).toBe('#/dashboard')
  })
})
