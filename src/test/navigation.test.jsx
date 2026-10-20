import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import App, { TAB_IDS, viewFromHash } from '../App.jsx'

vi.setConfig({ testTimeout: 20000 }) // these drive the whole app, so they are slow under load

const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
const profile = { id: 'me', name: 'Mia', email: 'mia@example.com', onboarded: true, crewRank: 'Enlisted', loginHistory: [] }

let authCb
async function openApp() {
  onAuthStateChanged.mockImplementation((_a, cb) => { authCb = cb; cb(me); return () => {} })
  getDoc.mockResolvedValue({ exists: () => true, data: () => profile })
  render(<App />)
  await screen.findByRole('navigation', { name: 'Main' })
  return userEvent.setup()
}
const topNav = () => screen.getByRole('navigation', { name: 'Main' })
const tab = (name) => within(topNav()).getByRole('button', { name })
const onDashboard = () => screen.findByText(/Departure Countdown/)
const onItinerary = () => screen.findByText('Voyage Itinerary')
const onGames = () => screen.findByRole('heading', { name: /cargo hold/i })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  window.scrollTo.mockClear()
})
afterEach(() => { document.body.style.overflow = ''; document.title = 'Cottage Con ⚙' })

describe('viewFromHash', () => {
  it('understands #/tab for every tab', () => {
    for (const id of TAB_IDS) {
      expect(viewFromHash(`#/${id}`)).toBe(id)
      expect(viewFromHash(`#${id}`)).toBe(id)
      expect(viewFromHash(`#/${id}/`)).toBe(id)
    }
  })

  it('ignores anything that is not a tab, including the signed-out screens', () => {
    for (const h of ['', '#', '#/', '#/nope', '#/login', '#/setup', '#/itinerary/extra', '#/../etc', undefined, null]) expect(viewFromHash(h), String(h)).toBeNull()
  })
})

describe('the URL hash follows the page', () => {
  it('lands on the dashboard and records it without adding a history entry', async () => {
    const before = window.history.length
    await openApp()
    await onDashboard()
    expect(window.location.hash).toBe('#/dashboard')
    expect(window.history.length).toBe(before)
  })

  it('puts each tab in the URL as the user moves around, one history entry per page', async () => {
    const user = await openApp()
    const before = window.history.length
    await user.click(tab(/Itinerary/))
    await onItinerary()
    expect(window.location.hash).toBe('#/itinerary')
    expect(window.history.length).toBe(before + 1)
    await user.click(tab(/Cargo Hold/))
    expect(window.location.hash).toBe('#/games')
    expect(window.history.length).toBe(before + 2)
  })

  it('does not stack history entries when the current page is chosen again', async () => {
    const user = await openApp()
    await user.click(tab(/Itinerary/))
    const after = window.history.length
    await user.click(tab(/Itinerary/))
    await user.click(tab(/Itinerary/))
    expect(window.history.length).toBe(after)
  })

  it('goes back and forward through the pages, as the browser Back and Forward buttons do', async () => {
    const user = await openApp()
    await user.click(tab(/Itinerary/))
    await onItinerary()
    await user.click(tab(/Cargo Hold/))
    await onGames()

    act(() => { window.history.back() })
    await onItinerary()
    expect(window.location.hash).toBe('#/itinerary')
    expect(tab(/Itinerary/)).toHaveAttribute('aria-current', 'page')

    act(() => { window.history.back() })
    await onDashboard()
    expect(window.location.hash).toBe('#/dashboard')

    act(() => { window.history.forward() })
    await onItinerary()
  })

  it('opens the page named in the URL after sign-in, so reloads and shared links work', async () => {
    window.history.replaceState(null, '', '#/itinerary')
    await openApp()
    await onItinerary()
    expect(window.location.hash).toBe('#/itinerary')
    expect(screen.queryByText(/Departure Countdown/)).not.toBeInTheDocument()
  })

  it('falls back to the dashboard for a hash that is not a page', async () => {
    window.history.replaceState(null, '', '#/nonsense')
    await openApp()
    await onDashboard()
    expect(window.location.hash).toBe('#/dashboard')
  })

  it('follows a hash edited by hand', async () => {
    await openApp()
    await onDashboard()
    act(() => { window.location.hash = '#/games' })
    await onGames()
    expect(tab(/Cargo Hold/)).toHaveAttribute('aria-current', 'page')
  })

  it('clears the hash on sign-out, and the URL no longer drives the page', async () => {
    const user = await openApp()
    await user.click(tab(/Itinerary/))
    await onItinerary()
    signOut.mockImplementationOnce(async () => { authCb(null) }) // the real signOut tells the auth listener
    await user.click(within(topNav()).getByRole('button', { name: /Disembark/ }))
    await screen.findByText(/Sign In/)
    expect(window.location.hash).toBe('')
    act(() => { window.location.hash = '#/games' })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument()
  })
})

describe('the menu is announced and reachable', () => {
  it('labels the navigation regions and marks the current page', async () => {
    const user = await openApp()
    expect(tab(/^Bridge$/)).toHaveAttribute('aria-current', 'page')
    expect(tab(/Itinerary/)).not.toHaveAttribute('aria-current')
    await user.click(tab(/Itinerary/))
    expect(tab(/Itinerary/)).toHaveAttribute('aria-current', 'page')
    expect(tab(/^Bridge$/)).not.toHaveAttribute('aria-current')
  })

  it('gives every icon-only control a name', async () => {
    await openApp()
    expect(screen.getAllByRole('button', { name: 'Personal Log' }).length).toBeGreaterThan(0)
    expect(within(topNav()).getByRole('button', { name: /Disembark/ })).toBeInTheDocument()
    expect(within(topNav()).getByRole('button', { name: /return to the Bridge/ })).toBeInTheDocument()
    expect(within(topNav()).getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('tells assistive tech when the menu is open, and what it controls', async () => {
    const user = await openApp()
    await user.click(screen.getByRole('button', { name: 'Open menu' }))
    const btn = screen.getByRole('button', { name: 'Close menu' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('navigation', { name: 'Menu' })
    expect(btn).toHaveAttribute('aria-controls', menu.id)
    expect(within(menu).getByRole('button', { name: /Bridge/ })).toHaveAttribute('aria-current', 'page')
  })
})

describe('the mobile menu', () => {
  const open = async (user) => { await user.click(screen.getByRole('button', { name: 'Open menu' })); return screen.getByRole('navigation', { name: 'Menu' }) }

  it('moves focus into the menu, onto the current page', async () => {
    const user = await openApp()
    const menu = await open(user)
    expect(within(menu).getByRole('button', { name: /Bridge/ })).toHaveFocus()
  })

  it('closes on Escape and gives focus back to the menu button', async () => {
    const user = await openApp()
    await open(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('navigation', { name: 'Menu' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus()
  })

  it('closes when the area outside it is tapped', async () => {
    const user = await openApp()
    await open(user)
    await user.click(document.querySelector('.cc-menu-scrim'))
    expect(screen.queryByRole('navigation', { name: 'Menu' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus()
  })

  it('keeps the page behind it from scrolling, and lets go again', async () => {
    const user = await openApp()
    expect(document.body.style.overflow).toBe('')
    await open(user)
    expect(document.body.style.overflow).toBe('hidden')
    await user.keyboard('{Escape}')
    expect(document.body.style.overflow).toBe('')
  })

  it('takes the user to the chosen page, closes, and puts focus on the new content', async () => {
    const user = await openApp()
    const menu = await open(user)
    await user.click(within(menu).getByRole('button', { name: /Itinerary/ }))
    await onItinerary()
    expect(screen.queryByRole('navigation', { name: 'Menu' })).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#/itinerary')
    expect(screen.getByRole('main')).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('closes if the window grows to the desktop layout', async () => {
    let listener
    const real = window.matchMedia
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: (_t, fn) => { listener = fn }, removeEventListener: vi.fn() }))
    try {
      const user = await openApp()
      await open(user)
      expect(listener).toBeTypeOf('function')
      act(() => listener({ matches: false })) // still a phone-sized window: stays open
      expect(screen.getByRole('navigation', { name: 'Menu' })).toBeInTheDocument()
      act(() => listener({ matches: true }))
      expect(screen.queryByRole('navigation', { name: 'Menu' })).not.toBeInTheDocument()
    } finally { window.matchMedia = real }
  })

  it('copes with a browser that has no matchMedia', async () => {
    const real = window.matchMedia
    delete window.matchMedia
    try {
      const user = await openApp()
      await open(user)
      expect(screen.getByRole('navigation', { name: 'Menu' })).toBeInTheDocument()
    } finally { window.matchMedia = real }
  })
})

describe('changing page', () => {
  it('scrolls to the top, but not on the first page shown', async () => {
    const user = await openApp()
    await onDashboard()
    expect(window.scrollTo).not.toHaveBeenCalled()
    await user.click(tab(/Itinerary/))
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('names the page in the tab title', async () => {
    const user = await openApp()
    await vi.waitFor(() => expect(document.title).toBe('Bridge · Cottage Con ⚙')) // the first render may be a beat ahead of the landing page
    await user.click(tab(/Itinerary/))
    expect(document.title).toBe('Itinerary · Cottage Con ⚙')
  })

  it('leaves focus on the nav bar when the user is tabbing along it', async () => {
    const user = await openApp()
    await user.click(tab(/Itinerary/))
    await onItinerary()
    expect(tab(/Itinerary/)).toHaveFocus()
  })

  it('puts focus on the new content after Back', async () => {
    const user = await openApp()
    await user.click(tab(/Itinerary/))
    await onItinerary()
    act(() => { document.activeElement?.blur() })
    act(() => { window.history.back() })
    await onDashboard()
    expect(screen.getByRole('main')).toHaveFocus()
  })
})
