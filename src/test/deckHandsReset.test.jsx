import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setDoc, getDoc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import App from '../App.jsx'

vi.setConfig({ testTimeout: 20000 })

// Regression: opening Deck Hands before the server had answered (a reload on #/deckhands, a restored tab, a shared link) made
// the page think there were no duty slots, and it wrote all 40 defaults over everyone's sign-ups.

const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
const profile = (over = {}) => ({ id: 'me', name: 'Mia', email: 'mia@example.com', onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })
const snapshot = (docs, metadata) => ({ forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })), docChanges: () => [], metadata })
const listener = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]
const deckWrites = () => setDoc.mock.calls.filter(([ref]) => ref.col === 'deckHands')
const annsSlot = { id: 'prep_Nov260', day: 'Nov 26', type: 'prep', task: 'Grocery run', claimedBy: 'ann', claimedByName: 'Ann' }
const bensSlot = { id: 'clean_Nov261', day: 'Nov 26', type: 'cleanup', task: 'Common area tidy', claimedBy: 'ben', claimedByName: 'Ben' }

async function openApp(profileOver = {}) {
  onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
  getDoc.mockResolvedValue({ exists: () => true, data: () => profile(profileOver) })
  render(<App />)
  await screen.findByRole('navigation', { name: 'Main' })
  await vi.waitFor(() => expect(listener('deckHands')).toBeTypeOf('function'))
  return userEvent.setup()
}
const deliver = (name, docs, metadata) => act(() => listener(name)(snapshot(docs, metadata)))
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  setDoc.mockClear()
})

describe('Deck Hands before the server has answered', () => {
  it('waits, and writes nothing, instead of setting up defaults over existing sign-ups', async () => {
    window.history.replaceState(null, '', '#/deckhands')
    await openApp()
    await settle()
    expect(await screen.findByText('Loading the roster…')).toBeInTheDocument()
    expect(deckWrites()).toHaveLength(0)
    expect(screen.queryByText(/Preparation/)).not.toBeInTheDocument()
  })

  it('keeps everyone\'s sign-ups when the real data arrives', async () => {
    window.history.replaceState(null, '', '#/deckhands')
    await openApp()
    await settle()
    deliver('deckHands', { [annsSlot.id]: annsSlot, [bensSlot.id]: bensSlot })
    expect(await screen.findByText(/Preparation/)).toBeInTheDocument()
    expect(screen.getByText('Ann')).toBeInTheDocument()
    expect(screen.getByText('Grocery run')).toBeInTheDocument()
    await settle()
    expect(deckWrites()).toHaveLength(0) // nothing was reset
  })

  it('does not take an empty answer from the local cache as "no slots"', async () => {
    window.history.replaceState(null, '', '#/deckhands')
    await openApp()
    deliver('deckHands', {}, { fromCache: true }) // e.g. offline, or before the server has replied
    await settle()
    expect(screen.getByText('Loading the roster…')).toBeInTheDocument()
    expect(deckWrites()).toHaveLength(0)
    deliver('deckHands', { [annsSlot.id]: annsSlot }, { fromCache: false })
    expect(await screen.findByText('Ann')).toBeInTheDocument()
    await settle()
    expect(deckWrites()).toHaveLength(0)
  })

  it('does nothing either when the user arrives from the Bridge before the data has loaded', async () => {
    const user = await openApp()
    await screen.findByText(/Departure Countdown/)
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Deck Hands/ }))
    await settle()
    expect(screen.getByText('Loading the roster…')).toBeInTheDocument()
    expect(deckWrites()).toHaveLength(0)
  })
})

describe('Deck Hands after the server has answered', () => {
  it('sets up the defaults only when the server says there are no slots at all', async () => {
    window.history.replaceState(null, '', '#/deckhands')
    await openApp()
    await settle()
    expect(deckWrites()).toHaveLength(0)
    deliver('deckHands', {}) // genuinely empty
    await vi.waitFor(() => expect(deckWrites()).toHaveLength(40))
    const ids = new Set(deckWrites().map(([ref]) => ref.id))
    expect(ids.size).toBe(40)
    expect(ids.has('prep_Nov260')).toBe(true)
    expect(ids.has('clean_Nov294')).toBe(true)
  })

  it('writes defaults that carry no sign-up fields, so they can never wipe one', async () => {
    window.history.replaceState(null, '', '#/deckhands')
    await openApp()
    deliver('deckHands', {})
    await vi.waitFor(() => expect(deckWrites()).toHaveLength(40))
    for (const [, data, opts] of deckWrites()) {
      expect(Object.keys(data).sort()).toEqual(['day', 'id', 'task', 'type'])
      expect(opts).toEqual({ merge: true })
    }
  })

  it('does nothing when the user simply opens Deck Hands once the data is there', async () => {
    const user = await openApp()
    deliver('deckHands', { [annsSlot.id]: annsSlot })
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: /Deck Hands/ }))
    expect(await screen.findByText('Ann')).toBeInTheDocument()
    await settle()
    expect(deckWrites()).toHaveLength(0)
  })
})

describe('Engine Room: Restore Defaults', () => {
  const openRestore = async (user) => {
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Engine Room' }))
    await user.click(await screen.findByRole('button', { name: /Deck Hand Slots/ }))
    return screen.findByRole('button', { name: /Restore Defaults/ })
  }

  it('only adds the slots that are missing and never touches an existing sign-up', async () => {
    const user = await openApp({ isAdmin: true })
    deliver('deckHands', { [annsSlot.id]: annsSlot, [bensSlot.id]: bensSlot })
    await user.click(await openRestore(user))
    await vi.waitFor(() => expect(deckWrites()).toHaveLength(38))
    const ids = deckWrites().map(([ref]) => ref.id)
    expect(ids).not.toContain('prep_Nov260')
    expect(ids).not.toContain('clean_Nov261')
    for (const [, data] of deckWrites()) expect(data).not.toHaveProperty('claimedBy')
    expect(await screen.findByText('Default slots restored!')).toBeInTheDocument()
  })

  it('does nothing before the server has said which slots exist', async () => {
    const user = await openApp({ isAdmin: true })
    await user.click(await openRestore(user)) // the duty list has not loaded yet
    await settle()
    expect(deckWrites()).toHaveLength(0)
  })
})
