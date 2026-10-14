import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MissionCard, NarrativeDossier, NARRATIVE_FACTIONS, NARRATIVE_ROLES } from '../App.jsx'

const users = {
  me: { name: 'Mia', narrativeRole: 'rebel_arms_buyer' },
  d: { name: 'Dev', narrativeRole: 'arms_dealer' },
  s: { name: 'Sam', narrativeRole: 'smuggler' },
  n: { name: 'Nia' },
}
const PHOTO = 'data:image/jpeg;base64,PROOF'
const compress = vi.fn(async () => PHOTO)
const jpeg = (name = 'proof.jpg') => new File(['pixels'], name, { type: 'image/jpeg' })

function setup(over = {}) {
  const props = { roleKey: 'rebel_arms_buyer', uid: 'me', users, claims: {}, scores: {}, onSubmit: vi.fn().mockResolvedValue(true), compress, fac: NARRATIVE_FACTIONS.rebellion, ...over }
  const utils = render(<MissionCard {...props} />)
  return { props, ...utils }
}
const attach = async (file = jpeg()) => {
  fireEvent.change(screen.getByLabelText('Proof photo'), { target: { files: [file] } })
  await screen.findByAltText('Proof preview')
}
const sendBtn = () => screen.getByRole('button', { name: /send claim for review/i })
const pickers = () => screen.getAllByRole('combobox')

describe('MissionCard: the win condition', () => {
  it('shows what the player has to do', () => {
    setup()
    expect(screen.getByText(/Win Condition/)).toBeInTheDocument()
    expect(screen.getByText('Meet the Freelance Arms Dealer and close the deal.')).toBeInTheDocument()
  })

  it('shows nothing for a role with no mission', () => {
    const { container } = setup({ roleKey: 'nope' })
    expect(container).toBeEmptyDOMElement()
  })

  it("offers every other crew member to pick, including someone with no role, but not the player", () => {
    setup()
    const names = within(screen.getByLabelText('The Freelance Arms Dealer')).getAllByRole('option').map(o => o.textContent)
    expect(names).toEqual(['— Choose a crew member —', 'Dev', 'Nia', 'Sam'])
  })

  it('says how many missions are complete across the crew, as a count only', () => {
    const claims = { c1: { claimantId: 'me', status: 'approved' } }
    const { unmount } = setup({ claims: {} })
    expect(screen.getByText('No missions completed yet.')).toBeInTheDocument()
    unmount()
    setup({ claims })
    expect(screen.getByText('🏁 1 mission completed across the crew.')).toBeInTheDocument()
  })
})

describe('MissionCard: making a claim', () => {
  it('cannot be sent until someone is picked and a photo is attached, and says which is missing', async () => {
    const user = userEvent.setup()
    setup()
    expect(sendBtn()).toBeDisabled()
    expect(screen.getByText('Choose a different crew member for each part.')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('The Freelance Arms Dealer'), 'd')
    expect(sendBtn()).toBeDisabled()
    expect(screen.getByText('Add a proof photo to send your claim.')).toBeInTheDocument()

    await attach()
    expect(sendBtn()).toBeEnabled()
  })

  it('shrinks the chosen photo, previews it, and lets the player remove or change it', async () => {
    const user = userEvent.setup()
    setup()
    await attach()
    expect(compress).toHaveBeenCalled()
    expect(screen.getByAltText('Proof preview')).toHaveAttribute('src', PHOTO)
    expect(screen.getByText(/photo of you with the person you met/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^remove$/i }))
    expect(screen.queryByAltText('Proof preview')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add proof photo/i })).toBeInTheDocument()
  })

  it('explains a photo it cannot use instead of silently ignoring it', async () => {
    setup()
    fireEvent.change(screen.getByLabelText('Proof photo'), { target: { files: [new File(['x'], 'notes.pdf', { type: 'application/pdf' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/choose an image/i)
    expect(screen.queryByAltText('Proof preview')).not.toBeInTheDocument()
  })

  it('sends the picks, note and photo, then clears the form', async () => {
    const user = userEvent.setup()
    const { props } = setup()
    await user.selectOptions(screen.getByLabelText('The Freelance Arms Dealer'), 'd')
    await user.type(screen.getByLabelText('Where and when'), 'by the fire')
    await attach()
    await user.click(sendBtn())
    expect(props.onSubmit).toHaveBeenCalledWith({ picks: ['d'], note: 'by the fire', photo: PHOTO })
    await waitFor(() => expect(screen.queryByAltText('Proof preview')).not.toBeInTheDocument())
    expect(screen.getByLabelText('The Freelance Arms Dealer')).toHaveValue('')
  })

  it('keeps what the player entered if the claim could not be sent', async () => {
    const user = userEvent.setup()
    setup({ onSubmit: vi.fn().mockResolvedValue(false) })
    await user.selectOptions(screen.getByLabelText('The Freelance Arms Dealer'), 'd')
    await attach()
    await user.click(sendBtn())
    await waitFor(() => expect(sendBtn()).toBeEnabled())
    expect(screen.getByLabelText('The Freelance Arms Dealer')).toHaveValue('d')
    expect(screen.getByAltText('Proof preview')).toBeInTheDocument()
  })

  it("never says whether the picks were right: that is the organiser's call", async () => {
    const user = userEvent.setup()
    setup()
    await user.selectOptions(screen.getByLabelText('The Freelance Arms Dealer'), 's') // the wrong person
    await attach()
    await user.click(sendBtn())
    expect(screen.queryByText(/correct|wrong|incorrect|right person/i)).not.toBeInTheDocument()
    expect(screen.getByText(/won't be told straight away/i)).toBeInTheDocument()
  })

  it('needs a different person for each part of a two-part mission', async () => {
    const user = userEvent.setup()
    setup({ roleKey: 'imperial_arms_hunter', uid: 'h', users: { ...users, h: { name: 'Hal', narrativeRole: 'imperial_arms_hunter' } }, fac: NARRATIVE_FACTIONS.empire })
    expect(screen.getByText('Identify both the Freelance Arms Dealer and the Rebel buyer.')).toBeInTheDocument()
    const [first, second] = pickers()
    await user.selectOptions(first, 'd')
    expect(within(second).getByRole('option', { name: 'Dev' })).toBeDisabled() // already named in the first part
    await attach()
    expect(sendBtn()).toBeDisabled() // second part still empty
    await user.selectOptions(second, 'me')
    expect(sendBtn()).toBeEnabled()
    expect(screen.getByText(/photo of the people you are naming/i)).toBeInTheDocument()
  })
})

describe('MissionCard: where a claim stands', () => {
  it('shows a waiting claim and hides the form', () => {
    setup({ claims: { c1: { claimantId: 'me', status: 'pending' } } })
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the organiser to review your proof')
    expect(screen.queryByRole('button', { name: /send claim/i })).not.toBeInTheDocument()
  })

  it('celebrates an approved claim, with the organiser\'s note', () => {
    setup({ claims: { c1: { claimantId: 'me', status: 'approved', reviewNote: 'Great photo' } } })
    expect(screen.getByRole('status')).toHaveTextContent('Mission accomplished')
    expect(screen.getByText(/Organiser's note: Great photo/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send claim/i })).not.toBeInTheDocument()
  })

  it('shows why a claim was turned down and lets the player try again', () => {
    setup({ claims: { c1: { claimantId: 'me', status: 'rejected', reviewNote: 'Too blurry', reviewedAt: 1 } } })
    expect(screen.getByText(/Your last claim wasn't approved\. Organiser's note: Too blurry/)).toBeInTheDocument()
    expect(sendBtn()).toBeInTheDocument()
  })

  it("only reflects the player's own claims", () => {
    setup({ claims: { c1: { claimantId: 'someone-else', status: 'approved' } } })
    expect(screen.queryByText(/Mission accomplished/)).not.toBeInTheDocument()
    expect(sendBtn()).toBeInTheDocument()
  })
})

describe('MissionCard: a board mission', () => {
  const broker = { roleKey: 'information_broker', uid: 'b', users: { ...users, b: { name: 'Bea', narrativeRole: 'information_broker' } }, fac: NARRATIVE_FACTIONS.independent }

  it('is judged automatically, so there is no claim form', () => {
    setup(broker)
    expect(screen.getByText('Reach 60% correct on the Crew Suspect Board.')).toBeInTheDocument()
    expect(screen.getByText(/You need 60% or better/)).toBeInTheDocument()
    expect(screen.getByText(/haven't checked your guesses yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send claim/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('shows progress, and celebrates once the best check is good enough', () => {
    const { unmount } = setup({ ...broker, scores: { b: { bestCorrect: 2, bestTotal: 5 } } })
    expect(screen.getByText(/Your best so far is 40%/)).toBeInTheDocument()
    expect(screen.queryByText(/Mission accomplished/)).not.toBeInTheDocument()
    unmount()
    setup({ ...broker, scores: { b: { bestCorrect: 4, bestTotal: 5 } } })
    expect(screen.getByRole('status')).toHaveTextContent('Mission accomplished')
  })
})

describe('inside the unlocked dossier', () => {
  const open = async (ctxOver = {}) => {
    const user = userEvent.setup()
    const doSubmitMissionClaim = vi.fn().mockResolvedValue(true)
    render(<NarrativeDossier ctx={{ authUser: { uid: 'me' }, profile: {}, users, missionClaims: {}, suspectScores: {}, doSubmitMissionClaim, proofCompress: compress, ...ctxOver }} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    return { user, doSubmitMissionClaim }
  }

  it('keeps the win condition out of sight until the dossier is opened', () => {
    render(<NarrativeDossier ctx={{ authUser: { uid: 'me' }, profile: {}, users, missionClaims: {}, suspectScores: {} }} />)
    expect(screen.queryByText(/Win Condition/)).not.toBeInTheDocument()
  })

  it("shows the player's own win condition and passes a claim up to the app", async () => {
    const { user, doSubmitMissionClaim } = await open()
    expect(screen.getByText('Meet the Freelance Arms Dealer and close the deal.')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('The Freelance Arms Dealer'), 'd')
    await attach()
    await user.click(sendBtn())
    expect(doSubmitMissionClaim).toHaveBeenCalledWith({ picks: ['d'], note: '', photo: PHOTO })
  })

  it("never shows another player's win condition", async () => {
    await open()
    expect(screen.queryByText(NARRATIVE_ROLES.smuggler.win.text)).not.toBeInTheDocument()
    expect(screen.queryByText(NARRATIVE_ROLES.arms_dealer.win.text)).not.toBeInTheDocument()
  })
})
