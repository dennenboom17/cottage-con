import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setDoc, getDoc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import App, { EngineRoom, WelcomeTourManager, resetOnboardingForAll, syncLiveProfileFields } from '../App.jsx'

describe('resetOnboardingForAll', () => {
  it('merge-writes onboarded:false to every user, and nothing else', async () => {
    const out = await resetOnboardingForAll(['a', 'b', 'c'])
    expect(setDoc).toHaveBeenCalledTimes(3)
    for (const [ref, data, opts] of setDoc.mock.calls) {
      expect(['a', 'b', 'c']).toContain(ref.id)
      expect(ref.col).toBe('users')
      expect(data).toEqual({ onboarded: false })
      expect(opts).toEqual({ merge: true })
    }
    expect(out).toEqual({ total: 3, done: 3, failed: [] })
  })

  it('does nothing for an empty crew', async () => {
    expect(await resetOnboardingForAll([])).toEqual({ total: 0, done: 0, failed: [] })
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('keeps going when a write fails, and reports exactly which users did not reset', async () => {
    setDoc.mockImplementation(async (ref) => { if (ref.id === 'b') throw new Error('permission-denied') })
    const out = await resetOnboardingForAll(['a', 'b', 'c'])
    expect(setDoc).toHaveBeenCalledTimes(3)
    expect(out).toEqual({ total: 3, done: 2, failed: ['b'] })
  })
})

describe('syncLiveProfileFields', () => {
  const profile = { id: 'u1', name: 'Ann', dietary: ['vegan'], onboarded: true, crewRank: 'Enlisted', deposit: false }

  it('returns the very same object when nothing an admin controls has changed', () => {
    const live = { ...profile, dietary: ['vegan'], lastLogin: 99 }
    expect(syncLiveProfileFields(profile, live)).toBe(profile)
  })

  it('picks up a tour reset, role, deposit and rank changed by an admin', () => {
    const next = syncLiveProfileFields(profile, { onboarded: false, narrativeRole: 'smuggler', deposit: true, crewRank: 'Officer' })
    expect(next).toMatchObject({ onboarded: false, narrativeRole: 'smuggler', deposit: true, crewRank: 'Officer' })
    expect(next).not.toBe(profile)
  })

  it("leaves the player's own edits alone", () => {
    const next = syncLiveProfileFields(profile, { name: 'Someone Else', dietary: ['nuts'], picture: 'x', onboarded: false })
    expect(next.name).toBe('Ann')
    expect(next.dietary).toEqual(['vegan'])
    expect(next.picture).toBeUndefined()
    expect(next.onboarded).toBe(false)
  })

  it('can clear a role', () => {
    expect(syncLiveProfileFields({ ...profile, narrativeRole: 'smuggler' }, { narrativeRole: null }).narrativeRole).toBeNull()
  })

  it('copes with a missing profile or user record', () => {
    expect(syncLiveProfileFields(null, { onboarded: false })).toBeNull()
    expect(syncLiveProfileFields(profile, undefined)).toBe(profile)
  })
})

describe('WelcomeTourManager', () => {
  const users = { a: { id: 'a', name: 'Ann', onboarded: true }, b: { id: 'b', name: 'Ben', onboarded: false }, c: { id: 'c', name: 'Cleo' } }
  const setup = (over = {}) => {
    const ctx = { users, doResetOnboarding: vi.fn().mockResolvedValue({ total: 3, done: 3, failed: [] }), ...over }
    render(<WelcomeTourManager ctx={ctx} />)
    return ctx
  }
  const resetBtn = () => screen.getByRole('button', { name: /reset for everyone/i })

  it('says how many crew already have the tour waiting', () => {
    setup()
    expect(screen.getByText('1 of 3 crew have the tour waiting.')).toBeInTheDocument()
  })

  it('says so when nobody is waiting, and when nobody has joined', () => {
    const { unmount } = render(<WelcomeTourManager ctx={{ users: { a: { onboarded: true } }, doResetOnboarding: vi.fn() }} />)
    expect(screen.getByText(/No one is waiting to see the tour \(1 crew\)\./)).toBeInTheDocument()
    unmount()
    render(<WelcomeTourManager ctx={{ users: {}, doResetOnboarding: vi.fn() }} />)
    expect(screen.getByText('No crew have joined yet.')).toBeInTheDocument()
    expect(resetBtn()).toBeDisabled()
  })

  it('asks for confirmation first and does nothing on the first click', async () => {
    const ctx = setup()
    await userEvent.setup().click(resetBtn())
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Replay the tour for all 3 crew members?')
    expect(ctx.doResetOnboarding).not.toHaveBeenCalled()
  })

  it('cancelling backs out without resetting anyone', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    await user.click(resetBtn())
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(ctx.doResetOnboarding).not.toHaveBeenCalled()
  })

  it('resets once confirmed, and reports success', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    await user.click(resetBtn())
    await user.click(screen.getByRole('button', { name: /yes, reset everyone/i }))
    expect(ctx.doResetOnboarding).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('status')).toHaveTextContent('Reset for 3 crew')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('reports a partial failure and lets the admin retry', async () => {
    const user = userEvent.setup()
    setup({ doResetOnboarding: vi.fn().mockResolvedValue({ total: 3, done: 2, failed: ['b'] }) })
    await user.click(resetBtn())
    await user.click(screen.getByRole('button', { name: /yes, reset everyone/i }))
    expect(await screen.findByRole('status')).toHaveTextContent('Reset 2 of 3 crew')
    expect(resetBtn()).toBeEnabled()
  })

  it('reports a failure when the whole action throws', async () => {
    const user = userEvent.setup()
    setup({ doResetOnboarding: vi.fn().mockRejectedValue(new Error('offline')) })
    await user.click(resetBtn())
    await user.click(screen.getByRole('button', { name: /yes, reset everyone/i }))
    expect(await screen.findByRole('status')).toHaveTextContent('Reset 0 of 3 crew')
  })
})

describe('Engine Room', () => {
  it('offers the Welcome Tour tab once unlocked', async () => {
    const user = userEvent.setup()
    const ctx = {
      users: { a: { id: 'a', name: 'Ann', onboarded: false } }, doResetOnboarding: vi.fn(),
      itinerary: {}, itinMeta: {}, doSaveItinDay: vi.fn(), doDelItinDay: vi.fn(), doSaveItinMeta: vi.fn(), showToast: vi.fn(),
    }
    render(<EngineRoom ctx={ctx} />)
    await user.click(await screen.findByRole('button', { name: /welcome tour/i }))
    expect(screen.getByText('1 of 1 crew have the tour waiting.')).toBeInTheDocument()
  })
})

// ── the whole app: a reset must survive someone saving their profile ─────────────
describe('App – tour reset vs. a signed-in player', () => {
  const me = { uid: 'me', email: 'ann@example.com', emailVerified: true, displayName: 'Ann Lee' }
  const profileDoc = (over = {}) => ({ id: 'me', name: 'Ann Lee', email: 'ann@example.com', onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })
  const snapshot = (docs) => ({ forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })), docChanges: () => [] })
  const listenerFor = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]

  it("does not write the player's old onboarded:true back over an admin's reset when they save their profile (regression)", async () => {
    onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
    getDoc.mockResolvedValue({ exists: () => true, data: () => profileDoc() })
    render(<App />)
    await waitFor(() => expect(listenerFor('users')).toBeTypeOf('function'))
    await screen.findAllByTitle('Personal Log')

    // The admin resets the tour (and marks the deposit paid) while Ann is signed in.
    act(() => listenerFor('users')(snapshot({ me: profileDoc({ onboarded: false, deposit: true }) })))

    const user = userEvent.setup()
    await user.click(screen.getAllByTitle('Personal Log')[0])
    expect(await screen.findByText('PAID')).toBeInTheDocument() // profile follows the live record

    setDoc.mockClear()
    await user.click(screen.getByRole('button', { name: /update ship's log/i }))
    await waitFor(() => expect(setDoc).toHaveBeenCalled())
    const saved = setDoc.mock.calls.at(-1)[1]
    expect(saved.onboarded).toBe(false) // not the stale true from sign-in
    expect(saved.deposit).toBe(true)
  })
})
