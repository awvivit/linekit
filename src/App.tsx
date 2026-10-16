import { useEffect } from 'react'
import { site } from './brand.ts'

export default function App() {
  useEffect(() => {
    document.title = site.name
  }, [])

  return (
    <main className="shell">
      <p className="eyebrow">In the browser</p>
      <h1>{site.name}</h1>
      <p className="lede">Line art to clean SVG.</p>
      <p className="detail">
        PNG, JPG, and WebP become clean outlines. Tracing arrives in a later release.
      </p>
      <dl className="facts">
        <div>
          <dt>Input</dt>
          <dd>PNG, JPG, WebP</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>SVG</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>Your browser</dd>
        </div>
      </dl>
      <section className="card" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">Privacy</h2>
        <p>
          {site.name} is intended to process images on your device: images never leave your
          browser. That is the product intent, and it is not a verified claim. This preview is a
          scaffold.
        </p>
      </section>
      <footer>
        <p>MIT License · Copyright 2026 Apolinario Vivit</p>
      </footer>
    </main>
  )
}
