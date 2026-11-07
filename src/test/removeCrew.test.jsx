import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setDoc, deleteDoc, getDoc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import App from '../App.jsx'

vi.setConfig({ testTimeout: 20000 })

// Engine Room → Crew Ranks: an admin can remove a crew member, after two confirmations.

const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
const doc = (id, name, over = {}) => ({ id, name, email: `${name.toLowerCase()}@example.com`, onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })
const snapshot = (docs) => ({ forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })), docChanges: () => [] })
const listenerFor = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]
const deletes = () => deleteDoc.mock.calls.map(([ref]) => `${ref.col}/${ref.id}`)
const slotWrites = () => setDoc.mock.calls.filter(([ref]) => ref.col === 'deckHands')
const slot = (id, over = {}) => ({ id, day: 'Nov 26', type: 'prep', task: 'Grocery run', claimedBy: null, claimedByName: '', ...over })

async function openApp(crew) {
  onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
  getDoc.mockResolvedValue({ exists: () => true, data: () => crew.me })
  render(<App />)
  await vi.waitFor(() => expect(listenerFor('users')).toBeTypeOf('function'))
  await screen.findByRole('navigation', { name: 'Main' })
  act(() => listenerFor('users')(snapshot(crew)))
  act(() => listenerFor('deckHands')(snapshot({ s1: slot('s1', { claimedBy: 'b', claimedByName: 'Ben' }), s2: slot('s2', { claimedBy: 'a', claimedByName: 'Ann' }) })))
  const user = userEvent.setup()
  await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Engine Room' }))
  await user.click(await screen.findByRole('button', { name: /crew ranks/i }))
  return user
}
const crew = (meOver = { isAdmin: true }) => ({ me: doc('me', 'Mia', meOver), a: doc('a', 'Ann', { isAdmin: true }), b: doc('b', 'Ben') })
const removeButton = (name) => screen.getByRole('button', { name: new RegExp(`^Remove ${name}$`) })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  setDoc.mockClear()
  deleteDoc.mockClear()
})

describe('removing a crew member', () => {
  it('needs two confirmations, and the second is typing their name', async () => {
    const user = await openApp(crew())
    await user.click(removeButton('Ben'))
    expect(await screen.findByRole('alertdialog', { name: 'Remove Ben' })).toBeInTheDocument()
    expect(deletes()).toEqual([]) // nothing yet

    await user.click(screen.getByRole('button', { name: 'Yes, continue' }))
    const box = await screen.findByRole('textbox', { name: 'Type Ben to confirm' })
    const final = screen.getByRole('button', { name: 'Remove for good' })
    expect(final).toBeDisabled()
    await user.type(box, 'Bob')
    expect(final).toBeDisabled()
    expect(deletes()).toEqual([])

    await user.clear(box)
    await user.type(box, 'ben') // not case sensitive
    expect(final).toBeEnabled()
    await user.click(final)
    await vi.waitFor(() => expect(deletes()).toContain('users/b'))
    expect(await screen.findByText('Ben removed from the crew.')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('can be cancelled at either step without deleting anything', async () => {
    const user = await openApp(crew())
    await user.click(removeButton('Ben'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

    await user.click(removeButton('Ben'))
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }))
    await user.type(await screen.findByRole('textbox', { name: 'Type Ben to confirm' }), 'Ben')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(deletes()).toEqual([])

    // starting again begins from the first question with an empty box
    await user.click(removeButton('Ben'))
    expect(screen.getByRole('button', { name: 'Yes, continue' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }))
    expect(await screen.findByRole('textbox', { name: 'Type Ben to confirm' })).toHaveValue('')
  })

  it('frees their duty sign-ups and clears their score, leaving other people\'s alone', async () => {
    const user = await openApp(crew())
    await user.click(removeButton('Ben'))
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }))
    await user.type(await screen.findByRole('textbox', { name: 'Type Ben to confirm' }), 'Ben')
    await user.click(screen.getByRole('button', { name: 'Remove for good' }))
    await vi.waitFor(() => expect(deletes()).toContain('users/b'))
    expect(deletes()).toContain('suspectScores/b')
    expect(slotWrites().map(([ref, data]) => [ref.id, data.claimedBy])).toEqual([['s1', null]])
    expect(deletes().filter((d) => d.startsWith('users/'))).toEqual(['users/b']) // only Ben
  })

  it('still removes them if the score cannot be deleted', async () => {
    deleteDoc.mockImplementationOnce(async () => { throw new Error('permission-denied') }) // suspectScores comes first
    const user = await openApp(crew())
    await user.click(removeButton('Ben'))
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }))
    await user.type(await screen.findByRole('textbox', { name: 'Type Ben to confirm' }), 'Ben')
    await user.click(screen.getByRole('button', { name: 'Remove for good' }))
    await vi.waitFor(() => expect(deletes()).toContain('users/b'))
  })

  it('keeps the confirmation open and reports it when the delete itself fails', async () => {
    const user = await openApp(crew())
    deleteDoc.mockImplementation(async (ref) => { if (ref.col === 'users') throw new Error('offline') })
    await user.click(removeButton('Ben'))
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }))
    await user.type(await screen.findByRole('textbox', { name: 'Type Ben to confirm' }), 'Ben')
    await user.click(screen.getByRole('button', { name: 'Remove for good' }))
    expect(await screen.findByText(/Couldn't remove that crew member/)).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    deleteDoc.mockImplementation(async () => {})
  })

  it('lets an admin remove another admin, but offers no button for yourself', async () => {
    const user = await openApp(crew())
    expect(screen.queryByRole('button', { name: /^Remove Mia$/ })).not.toBeInTheDocument()
    await user.click(removeButton('Ann'))
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }))
    await user.type(await screen.findByRole('textbox', { name: 'Type Ann to confirm' }), 'Ann')
    await user.click(screen.getByRole('button', { name: 'Remove for good' }))
    await vi.waitFor(() => expect(deletes()).toContain('users/a'))
  })

  it('is not offered to a non-admin, even while the Engine Room is open because nobody is an admin yet', async () => {
    const user = await openApp({ me: doc('me', 'Mia'), a: doc('a', 'Ann'), b: doc('b', 'Ben') })
    expect(screen.getByText(/No admin has been chosen yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(user).toBeTruthy()
  })
})
