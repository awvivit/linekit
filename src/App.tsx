import { useEffect, useRef, useState } from 'react'
import { site } from './brand.ts'
import CropFrame from './CropFrame.tsx'
import { inspectImage } from './image/inspect.ts'
import {
  CLEANUP_BUDGET_MS,
  CLEANUP_TIMEOUT_MESSAGE,
  CleanupTimeoutError,
  DECODE_MESSAGE,
  DEFAULT_CONTROLS,
  EMPTY_MESSAGE,
  FULL_CROP,
  NO_LINES_MESSAGE,
  TOO_LARGE_MESSAGE,
  exceedsByteCap,
  type NormalizedCrop,
} from './image/limits.ts'
import { TraceCancelled, createTraceSession, type TraceSession } from './image/session.ts'

export default function App() {
  const sessionRef = useRef<TraceSession | null>(null)
  const svgUrlRef = useRef<string | null>(null)
  const loadId = useRef(0)
  const traceId = useRef(0)
  const timedOutRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tracing, setTracing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [svg, setSvg] = useState<string | null>(null)
  const [svgUrl, setSvgUrl] = useState<string | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [darkness, setDarkness] = useState(DEFAULT_CONTROLS.darkness)
  const [smoothing, setSmoothing] = useState(DEFAULT_CONTROLS.smoothing)
  const [specks, setSpecks] = useState(DEFAULT_CONTROLS.specks)
  const [cleanup, setCleanup] = useState(DEFAULT_CONTROLS.cleanup)
  const [crop, setCrop] = useState<NormalizedCrop>(FULL_CROP)

  useEffect(() => {
    document.title = site.name
    const prevent = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      sessionRef.current?.dispose()
      sessionRef.current = null
      if (svgUrlRef.current) URL.revokeObjectURL(svgUrlRef.current)
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl)
    }
  }, [originalUrl])

  function publishSvg(next: string | null) {
    if (svgUrlRef.current) URL.revokeObjectURL(svgUrlRef.current)
    const url = next ? URL.createObjectURL(new Blob([next], { type: 'image/svg+xml' })) : null
    svgUrlRef.current = url
    setSvg(next)
    setSvgUrl(url)
  }

  useEffect(() => {
    const session = sessionRef.current
    if (!originalUrl || !session) return
    const controls = { darkness, smoothing, specks, crop, cleanup }
    let budgetTimer = 0
    const timer = window.setTimeout(() => {
      const id = ++traceId.current
      setTracing(true)
      if (cleanup) {
        budgetTimer = window.setTimeout(() => {
          if (id !== traceId.current) return
          session.cancel()
          timedOutRef.current = true
          setNotice(CLEANUP_TIMEOUT_MESSAGE)
          setCleanup(false)
          setTracing(false)
        }, CLEANUP_BUDGET_MS)
      }
      session
        .trace(controls)
        .then((next) => {
          if (id !== traceId.current) return
          window.clearTimeout(budgetTimer)
          publishSvg(next)
          if (!/<path\b/i.test(next)) setNotice(NO_LINES_MESSAGE)
          else if (!timedOutRef.current) setNotice(null)
          setTracing(false)
        })
        .catch((reason: unknown) => {
          if (id !== traceId.current) return
          window.clearTimeout(budgetTimer)
          if (reason instanceof TraceCancelled) return
          if (reason instanceof CleanupTimeoutError) {
            timedOutRef.current = true
            setNotice(CLEANUP_TIMEOUT_MESSAGE)
            setCleanup(false)
            setTracing(false)
            return
          }
          setError(reason instanceof Error ? reason.message : DECODE_MESSAGE)
          setTracing(false)
        })
    }, 400)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(budgetTimer)
    }
  }, [originalUrl, photoKey, darkness, smoothing, specks, crop, cleanup])

  async function openFile(file: File) {
    const id = ++loadId.current
    setError(null)
    setNotice(null)
    timedOutRef.current = false
    if (file.size === 0) {
      setError(EMPTY_MESSAGE)
      return
    }
    if (exceedsByteCap(file.size)) {
      setError(TOO_LARGE_MESSAGE)
      return
    }
    setBusy(true)
    try {
      const buffer = await file.arrayBuffer()
      const inspection = inspectImage(new Uint8Array(buffer))
      if (id !== loadId.current) return
      if (!inspection.ok) {
        setError(inspection.message)
        return
      }
      const session = sessionRef.current ?? createTraceSession()
      sessionRef.current = session
      const loaded = await session.load(buffer)
      if (id !== loadId.current) return
      publishSvg(null)
      setCrop(FULL_CROP)
      const preview = new Uint8Array(loaded.preview.byteLength)
      preview.set(loaded.preview)
      setOriginalUrl(URL.createObjectURL(new Blob([preview], { type: 'image/png' })))
      setPhotoKey((value) => value + 1)
    } catch (reason) {
      if (id !== loadId.current) return
      publishSvg(null)
      setOriginalUrl(null)
      setError(reason instanceof Error ? reason.message : DECODE_MESSAGE)
    } finally {
      if (id === loadId.current) setBusy(false)
    }
  }

  async function copySvg() {
    if (!svg) return
    try {
      await navigator.clipboard.writeText(svg)
      setNotice('Copied.')
    } catch {
      setNotice("Couldn't copy. Download the SVG instead.")
    }
  }

  return (
    <main className="shell">
      <p className="eyebrow">In the browser</p>
      <h1>{site.name}</h1>
      <p className="lede">Line art to clean SVG.</p>
      <p className="detail">Photograph a drawing on paper. Linekit traces it on this device.</p>

      <section
        className={dragging ? 'dropzone dragging' : 'dropzone'}
        aria-label="Upload"
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files[0]
          if (file) void openFile(file)
        }}
      >
        <label className="picker">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.png,.jpg,.jpeg,.webp,.heic,.heif"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void openFile(file)
            }}
          />
          <span>{busy ? 'Opening photo…' : 'Choose a photo or drop it here'}</span>
          <span className="hint">PNG, JPEG, WebP, or HEIC</span>
        </label>
      </section>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {originalUrl ? (
        <section className="workspace" aria-label="Trace">
          <div className="switch-row">
            <input
              id="clean-up-lines"
              type="checkbox"
              checked={cleanup}
              onChange={(event) => {
                if (event.currentTarget.checked) timedOutRef.current = false
                setCleanup(event.currentTarget.checked)
              }}
            />
            <label htmlFor="clean-up-lines">Clean up lines</label>
          </div>
          <div className="sliders">
            <Slider id="line-darkness" label="Line darkness" value={darkness} onChange={setDarkness} />
            <Slider id="smoothing" label="Smoothing" value={smoothing} onChange={setSmoothing} />
            <Slider id="remove-specks" label="Remove specks" value={specks} onChange={setSpecks} />
          </div>
          <div className="crop-actions">
            <button type="button" className="text-button" onClick={() => setCrop(FULL_CROP)}>
              Reset crop
            </button>
          </div>
          <div className="compare">
            <figure>
              <figcaption>Original</figcaption>
              <CropFrame src={originalUrl} crop={crop} onCrop={setCrop} />
            </figure>
            <figure>
              <figcaption>SVG</figcaption>
              <div className="frame preview-frame">
                {svgUrl ? <img src={svgUrl} alt="Traced line art" /> : <p className="hint">Tracing…</p>}
              </div>
            </figure>
          </div>
          <div className="actions">
            {svgUrl ? (
              <a href={svgUrl} download="linekit.svg">
                Download .svg
              </a>
            ) : (
              <span className="action-pending">Download .svg</span>
            )}
            <button type="button" onClick={() => void copySvg()} disabled={!svg}>
              Copy SVG code
            </button>
          </div>
          <p className="status" role="status">
            {tracing ? 'Tracing…' : notice}
          </p>
        </section>
      ) : null}

      <dl className="facts">
        <div>
          <dt>Input</dt>
          <dd>PNG, JPEG, WebP, HEIC</dd>
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
      <section className="card" aria-label="Privacy">
        <p>
          <strong>Privacy.</strong> Linekit traces images only in your browser.
        </p>
      </section>
      <footer>
        <p>MIT License · Copyright 2026 Apolinario Vivit</p>
      </footer>
    </main>
  )
}

function Slider({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span aria-hidden="true">{value}</span>
    </div>
  )
}
