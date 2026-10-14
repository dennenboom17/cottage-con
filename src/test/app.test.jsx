import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { onAuthStateChanged } from 'firebase/auth'
import { getDoc, setDoc, onSnapshot } from 'firebase/firestore'
import App from '../App.jsx'

const COLLECTIONS = ['users', 'games', 'food', 'supplies', 'voyageMenu', 'deckHands', 'receipts', 'itinerary', 'suspectScores', 'missionClaims', 'settings', 'notifications']

const user = { uid: 'me', email: 'ann@example.com', emailVerified: true, displayName: 'Ann Lee' }
const profileDoc = (over = {}) => ({ id: 'me', name: 'Ann Lee', email: 'ann@example.com', onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })

// Pretend Firebase Auth reports `u` as soon as App subscribes
const signInAs = (u, profile = profileDoc()) => {
  onAuthStateChanged.mockImplementation((_auth, cb) => { cb(u); return () => {} })
  getDoc.mockResolvedValue(u && profile ? { exists: () => true, data: () => profile } : { exists: () => false, data: () => ({}) })
}

// QuerySnapshot stand-in: `docs` for forEach, `added` for docChanges
const snapshot = ({ docs = {}, added = [] } = {}) => ({
  forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })),
  docChanges: () => added.map((data) => ({ type: 'added', doc: { data: () => data } })),
})
const listenerFor = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('App – signed out', () => {
  it('shows the login form and opens no Firestore listeners', async () => {
    signInAs(null)
    render(<App />)
    expect(await screen.findByPlaceholderText('captain@airship.com')).toBeInTheDocument()
    expect(onSnapshot).not.toHaveBeenCalled()
  })
})

describe('App – browser without the Notification API (regression: iOS Safari crashed at startup)', () => {
  it('renders instead of throwing a ReferenceError', async () => {
    expect(typeof Notification).toBe('undefined') // jsdom has no Notification, like iOS Safari outside a PWA
    signInAs(null)
    expect(() => render(<App />)).not.toThrow()
    expect(await screen.findByPlaceholderText('captain@airship.com')).toBeInTheDocument()
  })
})

describe('App – signed in', () => {
  it('subscribes to every collection exactly once', async () => {
    signInAs(user)
    render(<App />)
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(COLLECTIONS.length))
    expect(onSnapshot.mock.calls.map(([ref]) => ref.name).sort()).toEqual([...COLLECTIONS].sort())
  })

  it('unsubscribes from every listener on unmount', async () => {
    const unsub = vi.fn()
    onSnapshot.mockImplementation(() => unsub)
    signInAs(user)
    const { unmount } = render(<App />)
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(COLLECTIONS.length))
    unmount()
    expect(unsub).toHaveBeenCalledTimes(COLLECTIONS.length)
  })

  it('records the login time, device and history on sign-in using a merge write', async () => {
    signInAs(user, profileDoc({ loginHistory: [{ ts: 1, os: 'Linux', browser: 'Firefox', deviceType: 'Desktop' }] }))
    render(<App />)
    await waitFor(() => expect(setDoc).toHaveBeenCalled())

    const [ref, data, opts] = setDoc.mock.calls[0]
    expect(ref).toEqual({ col: 'users', id: 'me' })
    expect(opts).toEqual({ merge: true })
    expect(data.lastLogin).toEqual(expect.any(Number))
    expect(data.lastDevice).toMatchObject({ os: expect.any(String), browser: expect.any(String), deviceType: expect.any(String) })
    expect(data.loginHistory).toHaveLength(2)
    expect(data.loginHistory[0].ts).toBe(data.lastLogin) // newest first
  })

  it('keeps only the 10 most recent logins', async () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ ts: i, os: 'x', browser: 'y', deviceType: 'z' }))
    signInAs(user, profileDoc({ loginHistory: history }))
    render(<App />)
    await waitFor(() => expect(setDoc).toHaveBeenCalled())
    expect(setDoc.mock.calls[0][1].loginHistory).toHaveLength(10)
  })

  it('sends a user without a profile document to account setup', async () => {
    onAuthStateChanged.mockImplementation((_a, cb) => { cb(user); return () => {} })
    getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) })
    render(<App />)
    await waitFor(() => expect(onSnapshot).toHaveBeenCalled())
    expect(setDoc).not.toHaveBeenCalled() // nothing is written until they finish setup
  })
})

describe('App – in-app notification toasts', () => {
  const open = async () => {
    signInAs(user)
    render(<App />)
    await waitFor(() => expect(listenerFor('notifications')).toBeTypeOf('function'))
    return listenerFor('notifications')
  }

  it('does not replay notification history that already existed at login (regression)', async () => {
    const onNotifications = await open()
    act(() => onNotifications(snapshot({ added: [{ title: 'Ancient news', body: 'old', sentBy: 'other' }] })))
    await act(() => sleep(900)) // longer than the app's 500 ms toast delay
    expect(screen.queryByText(/Ancient news/)).not.toBeInTheDocument()
  })

  it('toasts a notification that arrives after login', async () => {
    const onNotifications = await open()
    act(() => onNotifications(snapshot())) // initial (empty) history
    act(() => onNotifications(snapshot({ added: [{ title: 'Fresh alert', body: 'hello', sentBy: 'other' }] })))
    expect(await screen.findByText(/Fresh alert/, {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('does not toast your own notifications or ones without a title', async () => {
    const onNotifications = await open()
    act(() => onNotifications(snapshot()))
    act(() => onNotifications(snapshot({ added: [
      { title: 'My own broadcast', sentBy: 'me' },
      { body: 'no title here', sentBy: 'other' },
    ] })))
    await act(() => sleep(900))
    expect(screen.queryByText(/My own broadcast/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no title here/)).not.toBeInTheDocument()
  })
})
