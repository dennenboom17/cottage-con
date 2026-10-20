import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setDoc, getDoc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import App from '../App.jsx'

vi.setConfig({ testTimeout: 20000 }) // these drive the whole app, so they are slow under load

// The whole app, with Firebase mocked: a player sends a claim with a photo, and the organiser reviews it.
const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
const profileDoc = (over = {}) => ({ id: 'me', name: 'Mia', email: 'mia@example.com', onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })
const crew = {
  me: profileDoc({ narrativeRole: 'rebel_arms_buyer', isAdmin: true }),
  d: { id: 'd', name: 'Dev', narrativeRole: 'arms_dealer' },
  s: { id: 's', name: 'Sam', narrativeRole: 'smuggler' },
}
const snapshot = (docs) => ({ forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })), docChanges: () => [] })
const listenerFor = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]
const writesTo = (col) => setDoc.mock.calls.filter(([ref]) => ref.col === col)

// jsdom can't decode images or draw on a canvas, so stand in for the browser's bits that shrink a photo
const realGetContext = HTMLCanvasElement.prototype.getContext
const realToDataURL = HTMLCanvasElement.prototype.toDataURL
class FakeImage {
  set src(v) { this.width = 1600; this.height = 1200; queueMicrotask(() => this.onload?.()) }
}

async function openApp({ claims = {} } = {}) {
  onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
  getDoc.mockResolvedValue({ exists: () => true, data: () => crew.me })
  render(<App />)
  await waitFor(() => expect(listenerFor('missionClaims')).toBeTypeOf('function'))
  await screen.findAllByTitle('Personal Log')
  act(() => {
    listenerFor('users')(snapshot(crew))
    listenerFor('missionClaims')(snapshot(claims))
  })
}

describe('App – mission claims end to end', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage)
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage: () => {} })
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,SHRUNK'
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext
    HTMLCanvasElement.prototype.toDataURL = realToDataURL
  })

  const claimFromTheDossier = async (user) => {
    await user.click(screen.getAllByTitle('Personal Log')[0])
    await user.click(await screen.findByRole('button', { name: /open your dossier/i }))
    await user.selectOptions(screen.getByLabelText('The Freelance Gunsmith'), 'd')
    fireEvent.change(screen.getByLabelText('Proof photo'), { target: { files: [new File(['big phone photo'], 'proof.jpg', { type: 'image/jpeg' })] } })
    await screen.findByAltText('Proof preview')
    setDoc.mockClear()
    await user.click(screen.getByRole('button', { name: /send claim for review/i }))
  }

  it('saves the shrunken photo first and the claim second, then tells the player it was sent', async () => {
    await openApp()
    const user = userEvent.setup()
    await claimFromTheDossier(user)

    await waitFor(() => expect(writesTo('missionClaims')).toHaveLength(1))
    const proofs = writesTo('missionProofs')
    expect(proofs).toHaveLength(1)
    expect(proofs[0][1].photo).toBe('data:image/jpeg;base64,SHRUNK') // the shrunken photo, not the original
    const order = setDoc.mock.calls.map(([ref]) => ref.col)
    expect(order.indexOf('missionProofs')).toBeLessThan(order.indexOf('missionClaims'))

    const claim = writesTo('missionClaims')[0][1]
    expect(claim).toMatchObject({ claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], status: 'pending' })
    expect(claim).not.toHaveProperty('photo')
    expect(await screen.findByText(/Claim sent for review/)).toBeInTheDocument()
  })

  it('shows the waiting state once the claim comes back from Firestore', async () => {
    await openApp()
    const user = userEvent.setup()
    await claimFromTheDossier(user)
    const claim = (await waitFor(() => { const w = writesTo('missionClaims'); expect(w).toHaveLength(1); return w[0][1] }))
    act(() => listenerFor('missionClaims')(snapshot({ [claim.id]: claim })))
    expect(await screen.findByText(/Waiting for the organiser to review your proof/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send claim for review/i })).not.toBeInTheDocument()
  })

  it('warns the player, and keeps their entry, when the claim cannot be saved', async () => {
    await openApp()
    const user = userEvent.setup()
    await user.click(screen.getAllByTitle('Personal Log')[0])
    await user.click(await screen.findByRole('button', { name: /open your dossier/i }))
    await user.selectOptions(screen.getByLabelText('The Freelance Gunsmith'), 'd')
    fireEvent.change(screen.getByLabelText('Proof photo'), { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } })
    await screen.findByAltText('Proof preview')

    setDoc.mockRejectedValueOnce(new Error('permission-denied'))
    await user.click(screen.getByRole('button', { name: /send claim for review/i }))
    expect(await screen.findByText(/permission-denied/)).toBeInTheDocument()
    expect(screen.getByLabelText('The Freelance Gunsmith')).toHaveValue('d')
    expect(screen.getByAltText('Proof preview')).toBeInTheDocument()
  })

  it('lets the organiser approve a matching claim from the Engine Room', async () => {
    const pending = { id: 'c1', claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], note: '', status: 'pending', createdAt: 1 }
    await openApp({ claims: { c1: pending } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /engine room/i }))
    await user.click(await screen.findByRole('button', { name: /mission claims \(1\)/i }))
    setDoc.mockClear()
    await user.click(await screen.findByRole('button', { name: /approve/i }))

    await waitFor(() => expect(writesTo('missionClaims')).toHaveLength(1))
    expect(writesTo('missionClaims')[0][0]).toEqual({ col: 'missionClaims', id: 'c1' })
    expect(writesTo('missionClaims')[0][1]).toMatchObject({ status: 'approved', reviewedBy: 'me' })
    expect(await screen.findByText(/Claim approved/)).toBeInTheDocument()
  })

  it('lets the organiser reject a claim', async () => {
    const pending = { id: 'c1', claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['s'], note: '', status: 'pending', createdAt: 1 }
    await openApp({ claims: { c1: pending } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /engine room/i }))
    await user.click(await screen.findByRole('button', { name: /mission claims/i }))
    await user.type(await screen.findByLabelText('Note to the player'), 'Wrong person')
    setDoc.mockClear()
    await user.click(screen.getByRole('button', { name: /reject/i }))

    await waitFor(() => expect(writesTo('missionClaims')).toHaveLength(1))
    expect(writesTo('missionClaims')[0][1]).toMatchObject({ status: 'rejected', reviewNote: 'Wrong person' })
    expect(await screen.findByText(/Claim rejected/)).toBeInTheDocument()
  })
})
