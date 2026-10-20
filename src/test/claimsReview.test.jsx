import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import { ClaimsReview, EngineRoom, fetchProofPhoto, NARRATIVE_ROLES } from '../App.jsx'

const users = {
  me: { name: 'Mia', narrativeRole: 'rebel_arms_buyer' },
  d: { name: 'Dev', narrativeRole: 'arms_dealer' },
  s: { name: 'Sam', narrativeRole: 'smuggler' },
  h: { name: 'Hal', narrativeRole: 'imperial_arms_hunter' },
  n: { name: 'Nia' },
}
const claim = (over = {}) => ({ id: 'c1', claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], note: '', status: 'pending', createdAt: 100, ...over })
const withPhoto = (photo = 'data:image/jpeg;base64,PROOF') => getDoc.mockResolvedValue({ exists: () => true, data: () => ({ id: 'c1', photo }) })
const noPhoto = () => getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) })

function setup(claims, over = {}) {
  const ctx = { users, missionClaims: claims, suspectScores: {}, doReviewMissionClaim: vi.fn().mockResolvedValue(true), ...over }
  render(<ClaimsReview ctx={ctx} />)
  return ctx
}

describe('fetchProofPhoto', () => {
  it('reads the photo from the claim\'s own proof document', async () => {
    withPhoto('data:image/jpeg;base64,X')
    expect(await fetchProofPhoto('c1')).toBe('data:image/jpeg;base64,X')
    expect(getDoc.mock.calls[0][0]).toEqual({ col: 'missionProofs', id: 'c1' })
  })

  it('returns null when there is no proof document or it has no photo', async () => {
    noPhoto()
    expect(await fetchProofPhoto('c1')).toBeNull()
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({}) })
    expect(await fetchProofPhoto('c1')).toBeNull()
  })
})

describe('ClaimsReview', () => {
  it('says so when there is nothing to review', () => {
    setup({})
    expect(screen.getByText('Waiting for review (0)')).toBeInTheDocument()
    expect(screen.getByText('No claims waiting.')).toBeInTheDocument()
    expect(screen.queryByText(/Reviewed \(/)).not.toBeInTheDocument()
  })

  it("shows who is claiming, in what role, what they say they did, and whether each pick matches", () => {
    setup({ c1: claim({ note: 'by the fire' }) })
    expect(screen.getByText('Mia')).toBeInTheDocument()
    expect(screen.getByText(`${NARRATIVE_ROLES.rebel_arms_buyer.icon} ${NARRATIVE_ROLES.rebel_arms_buyer.title}`)).toBeInTheDocument()
    expect(screen.getByText('Meet the Freelance Gunsmith and close the deal.')).toBeInTheDocument()
    const slot = screen.getByTestId('claim-slot')
    expect(slot).toHaveTextContent('✓')
    expect(slot).toHaveTextContent('The Freelance Gunsmith:')
    expect(slot).toHaveTextContent('Dev')
    expect(slot).toHaveTextContent('matches')
    expect(screen.getByText('"by the fire"')).toBeInTheDocument()
  })

  it('tells the organiser what a wrong pick actually is, and blocks approving it', () => {
    setup({ c1: claim({ picks: ['s'] }) })
    expect(screen.getByTestId('claim-slot')).toHaveTextContent('✗')
    expect(screen.getByTestId('claim-slot')).toHaveTextContent('actually Aether Smuggler')
    expect(screen.getByText(/This doesn't match the assigned roles/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /reject/i })).toBeEnabled()
  })

  it('says "no role" when the person picked was never given one', () => {
    setup({ c1: claim({ picks: ['n'] }) })
    expect(screen.getByTestId('claim-slot')).toHaveTextContent('actually no role')
  })

  it('checks every part of a two-part claim on its own', () => {
    setup({ c1: claim({ claimantId: 'h', roleKey: 'imperial_arms_hunter', picks: ['d', 's'] }) })
    const slots = screen.getAllByTestId('claim-slot')
    expect(slots[0]).toHaveTextContent('✓')
    expect(slots[1]).toHaveTextContent('✗')
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled()
  })

  it('only fetches the photo when asked, then shows it', async () => {
    withPhoto()
    const user = userEvent.setup()
    setup({ c1: claim() })
    expect(getDoc).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /view photo/i }))
    expect(await screen.findByAltText('Proof photo')).toHaveAttribute('src', 'data:image/jpeg;base64,PROOF')
    expect(getDoc).toHaveBeenCalledTimes(1)
  })

  it('says when the photo is missing, and will not approve without one', async () => {
    noPhoto()
    const user = userEvent.setup()
    setup({ c1: claim() })
    await user.click(screen.getByRole('button', { name: /view photo/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No proof photo was found')
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled()
  })

  it('copes with the photo failing to load', async () => {
    getDoc.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    setup({ c1: claim() })
    await user.click(screen.getByRole('button', { name: /view photo/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('approves a matching claim, passing the organiser\'s note', async () => {
    const user = userEvent.setup()
    const ctx = setup({ c1: claim() })
    await user.type(screen.getByLabelText('Note to the player'), 'Lovely photo')
    await user.click(screen.getByRole('button', { name: /approve/i }))
    expect(ctx.doReviewMissionClaim).toHaveBeenCalledTimes(1)
    expect(ctx.doReviewMissionClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'approved', 'Lovely photo', false)
  })

  it('rejects a claim, even a matching one, with a reason', async () => {
    const user = userEvent.setup()
    const ctx = setup({ c1: claim() })
    await user.type(screen.getByLabelText('Note to the player'), 'Too blurry')
    await user.click(screen.getByRole('button', { name: /reject/i }))
    expect(ctx.doReviewMissionClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'rejected', 'Too blurry', false)
  })

  it('lists the oldest claim first', () => {
    setup({ c2: claim({ id: 'c2', claimantId: 'h', roleKey: 'imperial_arms_hunter', picks: ['d', 'me'], createdAt: 200 }), c1: claim({ createdAt: 100 }) })
    const buyer = screen.getByText(`${NARRATIVE_ROLES.rebel_arms_buyer.icon} ${NARRATIVE_ROLES.rebel_arms_buyer.title}`)
    const hunter = screen.getByText(`${NARRATIVE_ROLES.imperial_arms_hunter.icon} ${NARRATIVE_ROLES.imperial_arms_hunter.title}`)
    expect(buyer.compareDocumentPosition(hunter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy() // Mia's older claim comes first
    expect(screen.getByText('Waiting for review (2)')).toBeInTheDocument()
  })

  it('moves a decided claim to a reviewed list, newest first, with the outcome and note', () => {
    setup({
      c1: claim({ status: 'approved', reviewedAt: 5, reviewNote: 'Great' }),
      c2: claim({ id: 'c2', claimantId: 'h', roleKey: 'imperial_arms_hunter', picks: ['s'], status: 'rejected', reviewedAt: 9, reviewNote: 'Blurry' }),
    })
    expect(screen.getByText('No claims waiting.')).toBeInTheDocument()
    expect(screen.getByText('Reviewed (2)')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
    const outcomes = screen.getAllByText(/^[✓✗] (Approved|Rejected)$/).map(e => e.textContent)
    expect(outcomes).toEqual(['✗ Rejected', '✓ Approved'])
    expect(screen.getByText('"Blurry"')).toBeInTheDocument()
    expect(screen.getByText('"Great"')).toBeInTheDocument()
  })

  it('copes with a claimant who has left the crew', () => {
    setup({ c1: claim({ claimantId: 'gone' }) })
    expect(screen.getByText('Former crew member')).toBeInTheDocument()
  })

  it('counts completed missions', () => {
    setup({ c1: claim({ status: 'approved', reviewedAt: 1 }) })
    expect(screen.getByText(/1 mission complete so far/)).toBeInTheDocument()
  })
})

describe('Engine Room', () => {
  const baseCtx = (claims) => ({
    users, missionClaims: claims, suspectScores: {}, doReviewMissionClaim: vi.fn(),
    itinerary: {}, itinMeta: {}, doSaveItinDay: vi.fn(), doDelItinDay: vi.fn(), doSaveItinMeta: vi.fn(), showToast: vi.fn(), doResetOnboarding: vi.fn(),
  })
  const unlock = async (ctx) => {
    const user = userEvent.setup()
    render(<EngineRoom ctx={ctx} />)
    return user
  }

  it('shows how many claims are waiting on the tab, and opens the review', async () => {
    const user = await unlock(baseCtx({ c1: claim(), c2: claim({ id: 'c2', status: 'approved' }) }))
    const tab = await screen.findByRole('button', { name: /mission claims \(1\)/i })
    await user.click(tab)
    expect(screen.getByText('Waiting for review (1)')).toBeInTheDocument()
  })

  it('shows no count when nothing is waiting', async () => {
    await unlock(baseCtx({}))
    const tab = await screen.findByRole('button', { name: /mission claims/i })
    expect(within(tab).queryByText(/\(\d+\)/)).not.toBeInTheDocument()
    expect(tab).toHaveTextContent(/^📸 Mission Claims$/)
  })
})
