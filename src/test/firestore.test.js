import { describe, it, expect, vi } from 'vitest'
import { setDoc, deleteDoc, onSnapshot, doc, collection } from 'firebase/firestore'
import { fsSet, fsDel, subCol } from '../App.jsx'

// A minimal stand-in for a Firestore QuerySnapshot
const snapshotOf = (docs) => ({
  forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })),
})

describe('fsSet / fsDel', () => {
  it('fsSet merge-writes to the right document', async () => {
    await fsSet('games', 'g1', { name: 'Azul' })
    expect(doc).toHaveBeenCalledWith(expect.anything(), 'games', 'g1')
    expect(setDoc).toHaveBeenCalledWith({ col: 'games', id: 'g1' }, { name: 'Azul' }, { merge: true })
  })

  it('fsDel deletes the right document', async () => {
    await fsDel('food', 'f9')
    expect(deleteDoc).toHaveBeenCalledWith({ col: 'food', id: 'f9' })
  })
})

describe('subCol', () => {
  it('subscribes to the named collection and returns the unsubscribe function', () => {
    const unsub = vi.fn()
    onSnapshot.mockReturnValueOnce(unsub)

    const returned = subCol('games', () => {})

    expect(collection).toHaveBeenCalledWith(expect.anything(), 'games')
    expect(returned).toBe(unsub)
  })

  it('turns each snapshot into an {id: data} map for the setter', () => {
    const set = vi.fn()
    subCol('games', set)
    const onNext = onSnapshot.mock.calls.at(-1)[1]

    onNext(snapshotOf({ a: { name: 'Azul' }, b: { name: 'Catan' } }))

    expect(set).toHaveBeenCalledWith({ a: { name: 'Azul' }, b: { name: 'Catan' } })
  })

  it('replaces (not merges) state on each snapshot, so deleted docs disappear', () => {
    const set = vi.fn()
    subCol('games', set)
    const onNext = onSnapshot.mock.calls.at(-1)[1]

    onNext(snapshotOf({ a: { n: 1 }, b: { n: 2 } }))
    onNext(snapshotOf({ b: { n: 2 } }))

    expect(set).toHaveBeenLastCalledWith({ b: { n: 2 } })
  })

  it('handles an empty collection', () => {
    const set = vi.fn()
    subCol('games', set)
    onSnapshot.mock.calls.at(-1)[1](snapshotOf({}))
    expect(set).toHaveBeenCalledWith({})
  })
})
