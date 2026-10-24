import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
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

/** Phones, and iPad split view narrower than 768px. Wider screens are side by side. */
const COMPACT_QUERY = '(max-width: 767px)'

const TRACE_TABS = [
  { id: 'photo', label: 'Photo' },
  { id: 'adjust', label: 'Adjust' },
  { id: 'result', label: 'Result' },
] as const

type TraceTab = (typeof TRACE_TABS)[number]['id']

function useCompact(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof window.matchMedia !== 'function') return false
    return window.matchMedia(COMPACT_QUERY).matches
  })

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(COMPACT_QUERY)
    const onChange = () => {
      setCompact(media.matches)
    }
    onChange()
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  }, [])

  return compact
}

export default function App() {
  const sessionRef = useRef<TraceSession | null>(null)
  const svgUrlRef = useRef<string | null>(null)
  const loadId = useRef(0)
  const traceId = useRef(0)
  const timedOutRef = useRef(false)
  const compact = useCompact()
  const [tab, setTab] = useState<TraceTab>('photo')
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
      setTab('photo')
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
    <main className={originalUrl ? 'shell editing' : 'shell'}>
      <header className="masthead">
        <p className="eyebrow">In the browser</p>
        <h1>{site.name}</h1>
        <p className="lede">Line art to clean SVG.</p>
        <p className="detail">Photograph a drawing on paper. Linekit traces it on this device.</p>
      </header>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {originalUrl ? (
        <section className="workspace" aria-label="Trace">
          {compact ? <TraceTabs tab={tab} onSelect={setTab} /> : null}
          <div className="panels">
            <Panel id="photo" compact={compact} tab={tab}>
              <Dropzone busy={busy} onFile={(file) => void openFile(file)} />
              <figure>
                <figcaption>Original</figcaption>
                <div className="stage">
                  <CropFrame src={originalUrl} crop={crop} onCrop={setCrop} />
                </div>
              </figure>
              <div className="crop-actions">
                <button type="button" className="text-button" onClick={() => setCrop(FULL_CROP)}>
                  Reset crop
                </button>
              </div>
            </Panel>
            <Panel id="adjust" compact={compact} tab={tab}>
              {compact ? (
                <figure className="live-preview">
                  <figcaption>Preview</figcaption>
                  <div className="frame preview-frame">
                    {svgUrl ? <img src={svgUrl} alt="Live preview" /> : <p className="hint">Tracing…</p>}
                  </div>
                </figure>
              ) : null}
              <div className="controls">
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
              </div>
            </Panel>
            <Panel id="result" compact={compact} tab={tab}>
              <figure>
                <figcaption>SVG</figcaption>
                <div className="stage">
                  <div className="frame preview-frame">
                    {svgUrl ? <img src={svgUrl} alt="Traced line art" /> : <p className="hint">Tracing…</p>}
                  </div>
                </div>
              </figure>
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
                <p className="status" role="status">
                  {tracing ? 'Tracing…' : notice}
                </p>
              </div>
            </Panel>
          </div>
        </section>
      ) : (
        <Dropzone busy={busy} onFile={(file) => void openFile(file)} />
      )}

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

function Panel({
  id,
  compact,
  tab,
  children,
}: {
  id: TraceTab
  compact: boolean
  tab: TraceTab
  children: ReactNode
}) {
  return (
    <div
      id={`panel-${id}`}
      className={`panel panel-${id}`}
      role={compact ? 'tabpanel' : undefined}
      aria-labelledby={compact ? `tab-${id}` : undefined}
      hidden={compact ? tab !== id : undefined}
    >
      {children}
    </div>
  )
}

function TraceTabs({ tab, onSelect }: { tab: TraceTab; onSelect: (tab: TraceTab) => void }) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const targetId = event.target instanceof HTMLElement ? event.target.id : ''
    const focused = TRACE_TABS.findIndex((item) => `tab-${item.id}` === targetId)
    const index = focused >= 0 ? focused : TRACE_TABS.findIndex((item) => item.id === tab)
    if (index < 0) return
    let next = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TRACE_TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + TRACE_TABS.length) % TRACE_TABS.length
    } else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TRACE_TABS.length - 1
    else return
    event.preventDefault()
    const item = TRACE_TABS[next]
    if (!item) return
    onSelect(item.id)
    document.getElementById(`tab-${item.id}`)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="Trace"
      aria-orientation="horizontal"
      className="tabbar"
      onKeyDown={onKeyDown}
    >
      {TRACE_TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`tab-${item.id}`}
          aria-selected={tab === item.id}
          aria-controls={`panel-${item.id}`}
          tabIndex={tab === item.id ? 0 : -1}
          onClick={() => {
            onSelect(item.id)
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function Dropzone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false)

  function takeFile(file: File | undefined) {
    if (file) onFile(file)
  }

  return (
    <section
      className={dragging ? 'dropzone dragging' : 'dropzone'}
      aria-label="Upload"
      onDragEnter={(event: ReactDragEvent<HTMLElement>) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragOver={(event: ReactDragEvent<HTMLElement>) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event: ReactDragEvent<HTMLElement>) => {
        event.preventDefault()
        setDragging(false)
      }}
      onDrop={(event: ReactDragEvent<HTMLElement>) => {
        event.preventDefault()
        setDragging(false)
        takeFile(event.dataTransfer.files[0])
      }}
    >
      <label className="picker">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.png,.jpg,.jpeg,.webp,.heic,.heif"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            takeFile(file)
          }}
        />
        <span>{busy ? 'Opening photo…' : 'Choose a photo or drop it here'}</span>
        <span className="hint">PNG, JPEG, WebP, or HEIC</span>
      </label>
    </section>
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
        onChange={(event) => {
          onChange(Number(event.currentTarget.value))
        }}
      />
      <span aria-hidden="true">{value}</span>
    </div>
  )
}
