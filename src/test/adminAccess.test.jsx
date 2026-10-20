import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setDoc, getDoc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import App, { CrewAssistant, syncLiveProfileFields, resetBggMatcher } from '../App.jsx'

vi.setConfig({ testTimeout: 20000 }) // these drive the whole app, so they are slow under load

const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
const doc = (id, name, over = {}) => ({ id, name, email: `${name.toLowerCase()}@example.com`, onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })
const snapshot = (docs) => ({ forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })), docChanges: () => [] })
const listenerFor = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]
const userWrites = () => setDoc.mock.calls.filter(([ref]) => ref.col === 'users')

// Opens the app as Mia, with the given crew. `profileOver` is what her profile held at sign-in.
async function openApp(crew, profileOver = {}) {
  const mine = crew.me
  onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
  getDoc.mockResolvedValue({ exists: () => true, data: () => ({ ...mine, ...profileOver }) })
  render(<App />)
  await vi.waitFor(() => expect(listenerFor('users')).toBeTypeOf('function'))
  await screen.findByRole('navigation', { name: 'Main' })
  act(() => listenerFor('users')(snapshot(crew)))
  return userEvent.setup()
}
const topNav = () => screen.getByRole('navigation', { name: 'Main' })
const engineTab = () => within(topNav()).queryByRole('button', { name: 'Engine Room' })
const adminBox = (name) => screen.getByRole('checkbox', { name: `Admin: ${name}` })
const openCrewRanks = async (user) => {
  await user.click(engineTab())
  await user.click(await screen.findByRole('button', { name: /crew ranks/i }))
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  setDoc.mockClear()
})

describe('only admins see the Engine Room', () => {
  const crew = (meOver = {}) => ({
    me: doc('me', 'Mia', meOver),
    a: doc('a', 'Ann', { isAdmin: true }),
    b: doc('b', 'Ben'),
  })

  it('offers the tab to an admin and opens it without asking for a password', async () => {
    const user = await openApp(crew({ isAdmin: true }))
    await user.click(engineTab())
    expect(await screen.findByRole('button', { name: /itinerary days/i })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/access code/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/access required/i)).not.toBeInTheDocument()
  })

  it('hides the tab from everyone else, in the nav bar and the mobile menu', async () => {
    const user = await openApp(crew())
    expect(engineTab()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(within(screen.getByRole('navigation', { name: 'Menu' })).queryByRole('button', { name: /Engine Room/ })).not.toBeInTheDocument()
  })

  it('sends a non-admin who follows an Engine Room link to the Bridge', async () => {
    window.history.replaceState(null, '', '#/engineroom')
    await openApp(crew())
    expect(await screen.findByText(/Departure Countdown/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /itinerary days/i })).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#/dashboard')
  })

  it('lets an admin follow an Engine Room link straight in', async () => {
    window.history.replaceState(null, '', '#/engineroom')
    await openApp(crew({ isAdmin: true }))
    expect(await screen.findByRole('button', { name: /itinerary days/i })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/engineroom')
  })

  it('sends a non-admin away if someone types the Engine Room into the address bar', async () => {
    await openApp(crew())
    act(() => { window.location.hash = '#/engineroom' })
    await vi.waitFor(() => expect(window.location.hash).toBe('#/dashboard')) // sent back to the Bridge
    expect(await screen.findByText(/Departure Countdown/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /itinerary days/i })).not.toBeInTheDocument()
  })

  it('follows access being granted while signed in, even though the profile loaded at sign-in says no', async () => {
    await openApp(crew())
    expect(engineTab()).not.toBeInTheDocument()
    act(() => listenerFor('users')(snapshot({ ...crew({ isAdmin: true }) })))
    expect(await within(topNav()).findByRole('button', { name: 'Engine Room' })).toBeInTheDocument()
  })

  it('takes a user out of the Engine Room when their access is removed', async () => {
    const user = await openApp(crew({ isAdmin: true }))
    await user.click(engineTab())
    await screen.findByRole('button', { name: /itinerary days/i })
    act(() => listenerFor('users')(snapshot(crew())))
    expect(await screen.findByText(/Departure Countdown/)).toBeInTheDocument()
    expect(engineTab()).not.toBeInTheDocument()
  })

  it('trusts the profile for an admin until the crew list arrives, so a reload does not bounce them', async () => {
    window.history.replaceState(null, '', '#/engineroom')
    onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
    getDoc.mockResolvedValue({ exists: () => true, data: () => doc('me', 'Mia', { isAdmin: true }) })
    render(<App />)
    expect(await screen.findByRole('button', { name: /itinerary days/i })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/engineroom')
  })
})

describe('the Admin checkbox under Crew Ranks', () => {
  const crew = () => ({ me: doc('me', 'Mia', { isAdmin: true }), a: doc('a', 'Ann'), b: doc('b', 'Ben', { isAdmin: true }) })

  it('shows one checkbox per crew member, ticked for the admins', async () => {
    const user = await openApp(crew())
    await openCrewRanks(user)
    expect(adminBox('Mia')).toBeChecked()
    expect(adminBox('Ann')).not.toBeChecked()
    expect(adminBox('Ben')).toBeChecked()
  })

  it('makes someone an admin, writing only that field', async () => {
    const user = await openApp(crew())
    await openCrewRanks(user)
    setDoc.mockClear()
    await user.click(adminBox('Ann'))
    expect(userWrites()).toHaveLength(1)
    const [ref, data, opts] = userWrites()[0]
    expect(ref.id).toBe('a')
    expect(data).toEqual({ isAdmin: true })
    expect(opts).toEqual({ merge: true })
  })

  it('removes admin access', async () => {
    const user = await openApp(crew())
    await openCrewRanks(user)
    setDoc.mockClear()
    await user.click(adminBox('Ben'))
    expect(userWrites()[0][1]).toEqual({ isAdmin: false })
  })

  it('will not remove the last admin', async () => {
    const only = { me: doc('me', 'Mia', { isAdmin: true }), a: doc('a', 'Ann') }
    const user = await openApp(only)
    await openCrewRanks(user)
    setDoc.mockClear()
    await user.click(adminBox('Mia'))
    expect(userWrites()).toHaveLength(0)
    expect(await screen.findByText('There must be at least one admin.')).toBeInTheDocument()
  })

  it('does not show up anywhere else: not on the Bridge, in the Personal Log or the crew', async () => {
    const user = await openApp(crew())
    expect(screen.queryByRole('checkbox', { name: /^Admin/ })).not.toBeInTheDocument()
    await user.click(within(topNav()).getAllByRole('button', { name: 'Personal Log' })[0])
    await vi.waitFor(() => expect(window.location.hash).toBe('#/profile'))
    expect(screen.queryByRole('checkbox', { name: /^Admin/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/^Admin$/)).not.toBeInTheDocument()
  })
})

describe('before any admin exists', () => {
  const crew = () => ({ me: doc('me', 'Mia'), a: doc('a', 'Ann'), b: doc('b', 'Ben') })

  it('opens the Engine Room to the first person in, with a note saying why', async () => {
    const user = await openApp(crew())
    await openCrewRanks(user)
    expect(screen.getByText(/No admin has been chosen yet/)).toBeInTheDocument()
  })

  it('lets them tick themselves, but not anyone else first', async () => {
    const user = await openApp(crew())
    await openCrewRanks(user)
    expect(adminBox('Ann')).toBeDisabled()
    expect(adminBox('Ben')).toBeDisabled()
    expect(adminBox('Mia')).not.toBeDisabled()
    setDoc.mockClear()
    await user.click(adminBox('Mia'))
    expect(userWrites()).toHaveLength(1)
    expect(userWrites()[0][0].id).toBe('me')
    expect(userWrites()[0][1]).toEqual({ isAdmin: true })
  })

  it('shuts the door behind the first admin', async () => {
    const user = await openApp(crew())
    await openCrewRanks(user)
    act(() => listenerFor('users')(snapshot({ ...crew(), a: doc('a', 'Ann', { isAdmin: true }) })))
    // Mia is not the admin who was ticked, so the Engine Room closes on her
    expect(await screen.findByText(/Departure Countdown/)).toBeInTheDocument()
    expect(engineTab()).not.toBeInTheDocument()
  })

  it('refuses to make someone else the first admin even if the box were clicked', async () => {
    const user = await openApp(crew())
    await openCrewRanks(user)
    setDoc.mockClear()
    // disabled boxes cannot be clicked, so go through the same action by re-enabling the input
    const box = adminBox('Ann')
    box.removeAttribute('disabled')
    await user.click(box)
    expect(userWrites()).toHaveLength(0)
    expect(await screen.findByText('No admin yet: tick yourself first.')).toBeInTheDocument()
  })
})

describe('admin status stays private', () => {
  const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })

  beforeEach(() => { resetBggMatcher(); getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) }) })
  afterEach(() => { resetBggMatcher(); vi.unstubAllGlobals() })

  it('is not handed to the chat assistant, and the Engine Room password is gone from its instructions', async () => {
    const f = vi.fn(async () => reply('ok'))
    vi.stubGlobal('fetch', f)
    const users = { me: doc('me', 'Mia'), a: doc('a', 'Ann', { isAdmin: true }) }
    const user = userEvent.setup()
    render(<CrewAssistant ctx={{ profile: { name: 'Mia' }, authUser: { uid: 'me' }, users, games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {}, itinMeta: {} }} />)
    await user.click(screen.getByLabelText('Open crew assistant'))
    await user.type(screen.getByPlaceholderText(/Ask anything/), 'How do I get into the engine room?{Enter}')
    await screen.findByText('ok')
    const req = JSON.parse(f.mock.calls.at(-1)[1].body).contents.at(-1).parts[0].text
    expect(req).not.toContain('isAdmin')
    expect(req).not.toMatch(/Ann[^\n]*admin/i)
    expect(req).not.toMatch(/cottage con\.|password is/i)
    expect(req).toMatch(/ENGINE ROOM \(admins only/)
  })
})

describe('syncLiveProfileFields', () => {
  it('carries a changed admin flag into the profile, so saving the profile cannot undo it', () => {
    expect(syncLiveProfileFields({ id: 'me', name: 'Mia' }, { isAdmin: true })).toEqual({ id: 'me', name: 'Mia', isAdmin: true })
    expect(syncLiveProfileFields({ id: 'me', isAdmin: true }, { isAdmin: false })).toEqual({ id: 'me', isAdmin: false })
  })
})
