import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, renderHook, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Avatar, Btn, Inp, Chip, DietPills, IconBtn, useImageUpload } from '../App.jsx'

describe('Avatar', () => {
  it('shows the picture when there is one', () => {
    render(<Avatar name="Ada Lovelace" picture="data:image/png;base64,AAAA" size={40} />)
    const img = screen.getByRole('img', { name: 'Ada Lovelace' })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA')
  })

  it('falls back to initials on a coloured disc', () => {
    render(<Avatar name="ada lovelace" />)
    expect(screen.getByText('AL')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('still renders a coloured disc for an empty name', () => {
    render(<Avatar name="" />)
    const disc = screen.getByText('?')
    expect(disc.style.background).not.toBe('')
  })
})

describe('Btn', () => {
  it('fires onClick', async () => {
    const onClick = vi.fn()
    render(<Btn onClick={onClick}>Go</Btn>)
    await userEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled', async () => {
    const onClick = vi.fn()
    render(<Btn disabled onClick={onClick}>Go</Btn>)
    const btn = screen.getByRole('button', { name: 'Go' })
    expect(btn).toBeDisabled()
    await userEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('Inp', () => {
  it('renders the label and forwards native props', async () => {
    const onChange = vi.fn()
    render(<Inp label="Email" placeholder="you@x.com" onChange={onChange} />)
    expect(screen.getByText('Email')).toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText('you@x.com'), 'ab')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('shows an error message when given one', () => {
    render(<Inp label="Name" error="Required" />)
    expect(screen.getByText('Required')).toBeInTheDocument()
  })

  it('omits label and error when not provided', () => {
    const { container } = render(<Inp placeholder="bare" />)
    expect(container.querySelectorAll('span')).toHaveLength(0)
  })
})

describe('Chip', () => {
  it('renders its children for any colour, including unknown ones', () => {
    render(<><Chip>plain</Chip><Chip color="amber">brass</Chip><Chip color="nope">odd</Chip></>)
    for (const t of ['plain', 'brass', 'odd']) expect(screen.getByText(t)).toBeInTheDocument()
  })
})

describe('DietPills', () => {
  it('lists every dietary option and reports clicks', async () => {
    const onToggle = vi.fn()
    render(<DietPills selected={['Vegetarian']} onToggle={onToggle} />)
    for (const d of ['Vegetarian', 'Gluten-Free', 'Lactose-Free', 'Pescetarian']) {
      expect(screen.getByRole('button', { name: d })).toBeInTheDocument()
    }
    await userEvent.click(screen.getByRole('button', { name: 'Gluten-Free' }))
    expect(onToggle).toHaveBeenCalledWith('Gluten-Free')
  })
})

describe('IconBtn', () => {
  it('is a button by default and fires onClick', async () => {
    const onClick = vi.fn()
    render(<IconBtn onClick={onClick} title="Vote">♥</IconBtn>)
    await userEvent.click(screen.getByRole('button', { name: /♥/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders an external link when as="a"', () => {
    render(<IconBtn as="a" href="https://boardgamegeek.com/x" title="BGG">BGG</IconBtn>)
    const link = screen.getByRole('link', { name: 'BGG' })
    expect(link).toHaveAttribute('href', 'https://boardgamegeek.com/x')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('does not fire when disabled', async () => {
    const onClick = vi.fn()
    render(<IconBtn disabled onClick={onClick}>x</IconBtn>)
    await userEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('useImageUpload', () => {
  function Harness({ onPick }) {
    const { pickImage, imgErr, Input } = useImageUpload()
    const [n, setN] = useState(0)
    return (
      <>
        <button onClick={() => pickImage(onPick)}>pick</button>
        <button onClick={() => setN(n + 1)}>rerender {n}</button>
        <Input />
        <p role="alert">{imgErr}</p>
      </>
    )
  }
  const fileInput = (container) => container.querySelector('input[type="file"]')

  it('keeps a stable Input component across renders', () => {
    const { result, rerender } = renderHook(() => useImageUpload())
    const first = result.current.Input
    rerender()
    rerender()
    expect(result.current.Input).toBe(first)
  })

  it('does not remount the hidden <input> when the parent re-renders (a pending file pick must survive)', async () => {
    const { container } = render(<Harness onPick={() => {}} />)
    const before = fileInput(container)
    await userEvent.click(screen.getByRole('button', { name: /rerender/ }))
    await userEvent.click(screen.getByRole('button', { name: /rerender/ }))
    expect(fileInput(container)).toBe(before)
  })

  it('hands back a data URL for an acceptable image', async () => {
    const onPick = vi.fn()
    const { container } = render(<Harness onPick={onPick} />)
    await userEvent.click(screen.getByRole('button', { name: 'pick' }))
    await userEvent.upload(fileInput(container), new File(['hello'], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1))
    expect(onPick.mock.calls[0][0]).toMatch(/^data:image\/png;base64,/)
    expect(screen.getByRole('alert')).toHaveTextContent('')
  })

  it('rejects images over 800 KB with a readable error and does not call back', async () => {
    const onPick = vi.fn()
    const { container } = render(<Harness onPick={onPick} />)
    await userEvent.click(screen.getByRole('button', { name: 'pick' }))
    const big = new File([new Uint8Array(900 * 1024)], 'big.png', { type: 'image/png' })
    await userEvent.upload(fileInput(container), big)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Image too large — 900 KB\. Maximum is 800 KB/)
    expect(onPick).not.toHaveBeenCalled()
  })
})
