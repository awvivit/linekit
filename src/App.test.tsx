import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'
import { site } from './brand.ts'

describe('App', () => {
  it('shows the product name and the privacy intent', () => {
    render(<App />)

    expect(screen.getByRole('heading', { level: 1, name: site.name })).toBeInTheDocument()
    expect(screen.getByText(/images never leave your browser/i)).toBeInTheDocument()
    expect(screen.getByText(/not a verified claim/i)).toBeInTheDocument()
    expect(document.title).toBe(site.name)
  })
})
