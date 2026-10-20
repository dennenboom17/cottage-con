import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { getDoc } from 'firebase/firestore'
import App, { GameChest, Manifest, Provisions, canManage } from '../App.jsx'

vi.setConfig({ testTimeout: 20000 })

beforeEach(() => { window.scrollTo.mockClear() })

describe('canManage', () => {
  it('lets the owner and any admin manage an item, and nobody else', () => {
    expect(canManage({ ownerId: 'a' }, 'a', false)).toBe(true)
    expect(canManage({ ownerId: 'a' }, 'b', false)).toBe(false)
    expect(canManage({ ownerId: 'a' }, 'b', true)).toBe(true)
    expect(canManage({}, 'b', false)).toBe(false)
    expect(canManage(undefined, 'b', true)).toBe(true)
    expect(canManage({ ownerId: undefined }, undefined, false)).toBe(false)
  })
})

describe('Cargo Hold', () => {
  const game = (id, name, extra = {}) => ({ id, name, ownerId: 'u2', likes: ['x'], category: 'Medium', minPlayers: '1', maxPlayers: '5', description: `About ${name}`, ...extra })
  const mkCtx = (games, over = {}) => ({
    games, food: {}, users: { u2: { id: 'u2', name: 'Bo Chen' } },
    authUser: { uid: 'me' }, profile: { gamesPlayed: [] },
    doSaveGame: vi.fn(async () => {}), doDelGame: vi.fn(), doToggleLike: vi.fn(),
    doLogGamePlayed: vi.fn(), doRemoveGamePlayed: vi.fn(), showToast: vi.fn(), ...over,
  })
  const openRow = (name) => userEvent.click(screen.getByRole('button', { name: new RegExp(name) }))

  it("gives a normal player no edit or remove on someone else's game", async () => {
    render(<GameChest ctx={mkCtx({ g1: game('g1', 'Wingspan') })} />)
    await openRow('Wingspan')
    expect(screen.queryByTitle('Edit this game entry')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Remove from cargo hold')).not.toBeInTheDocument()
  })

  it("gives an admin edit and remove on someone else's game", async () => {
    const ctx = mkCtx({ g1: game('g1', 'Wingspan') }, { isAdmin: true })
    render(<GameChest ctx={ctx} />)
    await openRow('Wingspan')
    await userEvent.click(screen.getByTitle('Remove from cargo hold'))
    expect(ctx.doDelGame).toHaveBeenCalledWith('g1')
  })

  it("keeps the owner as the owner when an admin edits someone else's game", async () => {
    const ctx = mkCtx({ g1: game('g1', 'Wingspan') }, { isAdmin: true })
    render(<GameChest ctx={ctx} />)
    await openRow('Wingspan')
    await userEvent.click(screen.getByTitle('Edit this game entry'))
    const name = screen.getByDisplayValue('Wingspan')
    await userEvent.clear(name)
    await userEvent.type(name, 'Wingspan Asia')
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(ctx.doSaveGame).toHaveBeenCalledTimes(1)
    const saved = ctx.doSaveGame.mock.calls[0][0]
    expect(saved).toMatchObject({ id: 'g1', name: 'Wingspan Asia', ownerId: 'u2', likes: ['x'] })
  })

  it("lets an admin, but not a player, remove someone else's game request", () => {
    const req = { r1: { id: 'r1', name: 'Gloomhaven', ownerId: 'u2', isRequest: true, likes: [], notes: '' } }
    const { unmount } = render(<GameChest ctx={mkCtx(req)} />)
    expect(screen.queryByTitle('Remove request')).not.toBeInTheDocument()
    unmount()
    const ctx = mkCtx(req, { isAdmin: true })
    render(<GameChest ctx={ctx} />)
    return userEvent.click(screen.getByTitle('Remove request')).then(() => expect(ctx.doDelGame).toHaveBeenCalledWith('r1'))
  })

  it('still lets an owner manage their own game, admin or not', async () => {
    const ctx = mkCtx({ g1: game('g1', 'Home Brew', { ownerId: 'me' }) })
    render(<GameChest ctx={ctx} />)
    await openRow('Home Brew')
    await userEvent.click(screen.getByTitle('Remove from cargo hold'))
    expect(ctx.doDelGame).toHaveBeenCalledWith('g1')
  })
})

describe('Manifest', () => {
  const receipt = { id: 'r1abcdef', desc: 'Groceries', amount: '42.50', ownerId: 'u2', createdAt: 1700000000000 }
  const mkCtx = (over = {}) => ({
    receipts: { r1abcdef: receipt },
    users: { u2: { id: 'u2', name: 'Bo Chen' } },
    authUser: { uid: 'me' }, profile: { name: 'Ann Lee' },
    doSaveReceipt: vi.fn(async () => {}), doDelReceipt: vi.fn(), showToast: vi.fn(),
    ...over,
  })
  const trash = () => document.querySelector('button .ti-trash')?.closest('button')

  it("gives a normal player no edit or delete on someone else's receipt", () => {
    render(<Manifest ctx={mkCtx()} />)
    expect(screen.queryByTitle('Edit')).not.toBeInTheDocument()
    expect(trash()).toBeFalsy()
  })

  it("lets an admin delete someone else's receipt", async () => {
    const ctx = mkCtx({ isAdmin: true })
    render(<Manifest ctx={ctx} />)
    await userEvent.click(trash())
    expect(ctx.doDelReceipt).toHaveBeenCalledWith('r1abcdef')
  })

  it("lets an admin edit someone else's receipt without taking it over", async () => {
    const ctx = mkCtx({ isAdmin: true })
    render(<Manifest ctx={ctx} />)
    await userEvent.click(screen.getByTitle('Edit'))
    const desc = screen.getByPlaceholderText('e.g. Grocery run')
    await userEvent.clear(desc)
    await userEvent.type(desc, 'Groceries and ice')
    await userEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
    expect(ctx.doSaveReceipt).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1abcdef', desc: 'Groceries and ice', ownerId: 'u2' }))
  })
})

describe('Galley', () => {
  const food = { f1: { id: 'f1', name: 'Beef stew', category: 'Mains', serves: '6', notes: 'No nuts', ownerId: 'u2' } }
  const supplies = { s1: { id: 's1', name: 'Camp stove', category: 'Cooking', notes: '2 burner', ownerId: 'u2' } }
  const voyageMenu = { m1: { id: 'm1', day: 'Nov 26', meal: 'Dinner', dish: 'Chili night', notes: 'Spicy', ownerId: 'u2' } }
  const mkCtx = (over = {}) => ({
    food, supplies, voyageMenu, users: { u2: { id: 'u2', name: 'Bo Chen' }, me: { id: 'me', name: 'Ann Lee' } },
    authUser: { uid: 'me' },
    doSaveFood: vi.fn(async () => {}), doDelFood: vi.fn(), doSaveSupply: vi.fn(async () => {}), doDelSupply: vi.fn(),
    doSaveMenuItem: vi.fn(async () => {}), doDelMenuItem: vi.fn(), showToast: vi.fn(), ...over,
  })

  describe('provisions', () => {
    it("shows a normal player no edit or remove on someone else's provision", () => {
      render(<Provisions ctx={mkCtx()} />)
      expect(screen.getByText('Beef stew')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Edit Beef stew' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Remove Beef stew' })).not.toBeInTheDocument()
    })

    it("lets an admin remove someone else's provision", async () => {
      const ctx = mkCtx({ isAdmin: true })
      render(<Provisions ctx={ctx} />)
      await userEvent.click(screen.getByRole('button', { name: 'Remove Beef stew' }))
      expect(ctx.doDelFood).toHaveBeenCalledWith('f1')
    })

    it("lets an admin edit someone else's provision, keeping the owner", async () => {
      const ctx = mkCtx({ isAdmin: true })
      render(<Provisions ctx={ctx} />)
      await userEvent.click(screen.getByRole('button', { name: 'Edit Beef stew' }))
      const name = screen.getByDisplayValue('Beef stew')
      await userEvent.clear(name)
      await userEvent.type(name, 'Beef and barley stew')
      const serves = screen.getByDisplayValue('6')
      await userEvent.clear(serves)
      await userEvent.type(serves, '8')
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(ctx.doSaveFood).toHaveBeenCalledWith({ id: 'f1', name: 'Beef and barley stew', category: 'Mains', serves: '8', notes: 'No nuts', ownerId: 'u2' })
      expect(ctx.showToast).toHaveBeenCalledWith('Provision updated! 🍲')
      expect(screen.queryByDisplayValue('Beef and barley stew')).not.toBeInTheDocument() // back out of edit mode
    })

    it('can be cancelled without saving, and will not save a blank name', async () => {
      const ctx = mkCtx({ isAdmin: true })
      render(<Provisions ctx={ctx} />)
      await userEvent.click(screen.getByRole('button', { name: 'Edit Beef stew' }))
      await userEvent.clear(screen.getByDisplayValue('Beef stew'))
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(ctx.doSaveFood).not.toHaveBeenCalled()
      expect(screen.getByText('Beef stew')).toBeInTheDocument()
    })

    it('still lets owners remove their own, and gives them no edit', async () => {
      const ctx = mkCtx({ food: { f9: { id: 'f9', name: 'My chili', category: 'Mains', ownerId: 'me' } } })
      render(<Provisions ctx={ctx} />)
      expect(screen.queryByRole('button', { name: 'Edit My chili' })).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Remove My chili' }))
      expect(ctx.doDelFood).toHaveBeenCalledWith('f9')
    })
  })

  describe('gear', () => {
    const openGear = () => userEvent.click(screen.getByRole('button', { name: /Gear/ }))

    it("lets an admin, but not a player, change someone else's gear", async () => {
      const { unmount } = render(<Provisions ctx={mkCtx()} />)
      await openGear()
      expect(screen.getByText('Camp stove')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Remove Camp stove' })).not.toBeInTheDocument()
      unmount()

      const ctx = mkCtx({ isAdmin: true })
      render(<Provisions ctx={ctx} />)
      await openGear()
      await userEvent.click(screen.getByRole('button', { name: 'Edit Camp stove' }))
      const name = screen.getByDisplayValue('Camp stove')
      await userEvent.clear(name)
      await userEvent.type(name, 'Camp stove (2 burner)')
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(ctx.doSaveSupply).toHaveBeenCalledWith({ id: 's1', name: 'Camp stove (2 burner)', category: 'Cooking', notes: '2 burner', ownerId: 'u2' })
      expect(ctx.showToast).toHaveBeenCalledWith('Gear updated! ⚙️')
      await userEvent.click(screen.getByRole('button', { name: 'Remove Camp stove' })) // the mocked save doesn't change the data
      expect(ctx.doDelSupply).toHaveBeenCalledWith('s1')
    })
  })

  describe('voyage menu', () => {
    const openMenu = () => userEvent.click(screen.getByRole('button', { name: /Voyage Menu/ }))

    it("shows a normal player no edit or remove on someone else's dish", async () => {
      render(<Provisions ctx={mkCtx()} />)
      await openMenu()
      expect(screen.getByText('Chili night')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Edit Chili night' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Remove Chili night' })).not.toBeInTheDocument()
    })

    it("lets an admin remove someone else's dish", async () => {
      const ctx = mkCtx({ isAdmin: true })
      render(<Provisions ctx={ctx} />)
      await openMenu()
      await userEvent.click(screen.getByRole('button', { name: 'Remove Chili night' }))
      expect(ctx.doDelMenuItem).toHaveBeenCalledWith('m1')
    })

    it("lets an admin edit someone else's dish, keeping the owner, day and meal", async () => {
      const ctx = mkCtx({ isAdmin: true })
      render(<Provisions ctx={ctx} />)
      await openMenu()
      await userEvent.click(screen.getByRole('button', { name: 'Edit Chili night' }))
      const dish = screen.getByDisplayValue('Chili night')
      await userEvent.clear(dish)
      await userEvent.type(dish, 'Chili and cornbread')
      await userEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(ctx.doSaveMenuItem).toHaveBeenCalledWith({ id: 'm1', day: 'Nov 26', meal: 'Dinner', dish: 'Chili and cornbread', notes: 'Spicy', ownerId: 'u2' })
      expect(ctx.showToast).toHaveBeenCalledWith('Dish updated! 🍽️')
    })

    it('still lets owners remove their own dish', async () => {
      const ctx = mkCtx({ voyageMenu: { m2: { id: 'm2', day: 'Nov 26', meal: 'Lunch', dish: 'My soup', notes: '', ownerId: 'me' } } })
      render(<Provisions ctx={ctx} />)
      await openMenu()
      await userEvent.click(screen.getByRole('button', { name: 'Remove My soup' }))
      expect(ctx.doDelMenuItem).toHaveBeenCalledWith('m2')
    })
  })
})

describe('admin rights come from the admin flag, in the whole app', () => {
  const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
  const doc = (id, name, over = {}) => ({ id, name, email: `${name.toLowerCase()}@example.com`, onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })
  const snapshot = (docs) => ({ forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })), docChanges: () => [] })
  const listenerFor = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]

  async function openGalley(crew) {
    onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
    getDoc.mockResolvedValue({ exists: () => true, data: () => crew.me })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    render(<App />)
    await vi.waitFor(() => expect(listenerFor('food')).toBeTypeOf('function'))
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    act(() => {
      listenerFor('users')(snapshot(crew))
      listenerFor('food')(snapshot({ f1: { id: 'f1', name: 'Beef stew', category: 'Mains', ownerId: 'a' } }))
    })
    await userEvent.click(within(nav).getByRole('button', { name: /Galley/ }))
    await screen.findByText('Beef stew')
  }

  it('shows an admin edit and remove on a crew mate\'s provision', async () => {
    await openGalley({ me: doc('me', 'Mia', { isAdmin: true }), a: doc('a', 'Ann') })
    expect(screen.getByRole('button', { name: 'Edit Beef stew' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Beef stew' })).toBeInTheDocument()
  })

  it('shows a player neither', async () => {
    await openGalley({ me: doc('me', 'Mia'), a: doc('a', 'Ann', { isAdmin: true }) })
    expect(screen.queryByRole('button', { name: 'Edit Beef stew' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Beef stew' })).not.toBeInTheDocument()
  })

  it('does not give edit rights to the first person in before any admin is chosen', async () => {
    await openGalley({ me: doc('me', 'Mia'), a: doc('a', 'Ann') })
    expect(screen.queryByRole('button', { name: 'Edit Beef stew' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Beef stew' })).not.toBeInTheDocument()
  })
})
