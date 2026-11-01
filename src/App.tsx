import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { site } from './brand.ts'
import CropFrame from './CropFrame.tsx'
import {
  applyEdits,
  cloneModel,
  DEFAULT_EDIT,
  editsActive,
  nearestStroke,
  sameSnapshot,
  type EditableModel,
  type EditSnapshot,
  type Point,
  type Stroke,
} from './image/edits.ts'
import {
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  redoHistory,
  replacePresent,
  undoHistory,
  type History,
} from './image/history.ts'
import { inspectImage } from './image/inspect.ts'
import {
  CLEANUP_BUDGET_MS,
  CLEANUP_TIMEOUT_MESSAGE,
  CleanupTimeoutError,
  DECODE_MESSAGE,
  DEFAULT_CONTROLS,
  EMPTY_MESSAGE,
  FULL_CROP,
  CROP_RESET_MESSAGE,
  NO_LINES_LEFT_MESSAGE,
  NO_LINES_LEFT_UNDO_MESSAGE,
  NO_LINES_MESSAGE,
  REBUILD_CONFIRM_MESSAGE,
  TOO_LARGE_MESSAGE,
  exceedsByteCap,
  type NormalizedCrop,
} from './image/limits.ts'
import { perspectiveKey } from './image/perspective.ts'
import { TraceCancelled, createTraceSession, type TraceSession } from './image/session.ts'

/** Phones, and iPad split view narrower than 768px. Wider screens are side by side. */
const COMPACT_QUERY = '(max-width: 767px)'

const TRACE_TABS = [
  { id: 'photo', label: 'Photo' },
  { id: 'adjust', label: 'Adjust' },
  { id: 'result', label: 'Result' },
] as const

type TraceTab = (typeof TRACE_TABS)[number]['id']
type RebuildLock = 'ask' | 'waiting' | 'allow' | 'block'

function isFullCrop(crop: NormalizedCrop): boolean {
  return crop.x <= 0.005 && crop.y <= 0.005 && crop.width >= 0.99 && crop.height >= 0.99
}

function isSliderKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'
}

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
  const [rawSvg, setRawSvg] = useState<string | null>(null)
  const [base, setBase] = useState<EditableModel | null>(null)
  const [editedSvg, setEditedSvg] = useState<string | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [darkness, setDarkness] = useState(DEFAULT_CONTROLS.darkness)
  const [smoothing, setSmoothing] = useState(DEFAULT_CONTROLS.smoothing)
  const [specks, setSpecks] = useState(DEFAULT_CONTROLS.specks)
  const [cleanup, setCleanup] = useState(DEFAULT_CONTROLS.cleanup)
  const [crop, setCrop] = useState<NormalizedCrop>(FULL_CROP)
  const [eraserOn, setEraserOn] = useState(false)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const [history, setHistory] = useState<History<EditSnapshot>>(() => createHistory(DEFAULT_EDIT))
  const historyRef = useRef(history)
  const gesture = useRef<EditSnapshot | null>(null)
  const cropRef = useRef(crop)
  const rebuildLock = useRef<RebuildLock>('ask')
  const rebuildGesture = useRef(false)
  const pendingRebuild = useRef<(() => void) | null>(null)
  const rebuildOpenRef = useRef(false)
  const confirmRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const edit = history.present

  const updateHistory = useCallback((next: History<EditSnapshot>) => {
    historyRef.current = next
    setHistory(next)
  }, [])

  const publishSvg = useCallback((next: string | null) => {
    if (svgUrlRef.current) URL.revokeObjectURL(svgUrlRef.current)
    const url = next ? URL.createObjectURL(new Blob([next], { type: 'image/svg+xml' })) : null
    svgUrlRef.current = url
    setSvg(next)
    setSvgUrl(url)
  }, [])

  const edited = useMemo(() => (base && editsActive(edit) ? applyEdits(base, edit) : null), [base, edit])
  const displaySvg = editsActive(edit) ? (editedSvg ?? rawSvg) : rawSvg
  const displayHasLines = Boolean(displaySvg && /<path\b/i.test(displaySvg))
  const traceHadLines = Boolean(rawSvg && /<path\b/i.test(rawSvg))
  const statusText =
    notice === CROP_RESET_MESSAGE
      ? CROP_RESET_MESSAGE
      : tracing
        ? 'Tracing…'
        : editsActive(edit) && displaySvg && !displayHasLines
          ? traceHadLines
            ? canUndo(history)
              ? NO_LINES_LEFT_UNDO_MESSAGE
              : NO_LINES_LEFT_MESSAGE
            : NO_LINES_MESSAGE
          : notice === NO_LINES_MESSAGE && displayHasLines
            ? null
            : notice
  const liveStrokes = edited?.strokes ?? base?.strokes ?? []
  const selected = liveStrokes.find((stroke) => stroke.id === edit.selectedId) ?? null
  const perspectiveValue = edit.perspectiveOn ? edit.quad : null
  const perspectiveToken = perspectiveKey(perspectiveValue)

  function beginEditGesture() {
    if (!gesture.current) gesture.current = historyRef.current.present
  }

  function endEditGesture() {
    const baseline = gesture.current
    gesture.current = null
    if (!baseline) return
    const present = historyRef.current.present
    if (sameSnapshot(baseline, present)) return
    updateHistory({
      past: [...historyRef.current.past, baseline].slice(-40),
      present,
      future: [],
    })
  }

  function changeEdit(patch: Partial<EditSnapshot>) {
    const present = historyRef.current.present
    const next = { ...present, ...patch }
    if (gesture.current) {
      updateHistory(replacePresent(historyRef.current, next))
      return
    }
    updateHistory(commitHistory(historyRef.current, next, sameSnapshot))
  }

  function selectStroke(id: number | null) {
    const present = historyRef.current.present
    if (present.selectedId === id) return
    updateHistory(replacePresent(historyRef.current, { ...present, selectedId: id }))
  }

  const clearStrokeEdits = useCallback(() => {
    const history = historyRef.current
    const present = history.present
    const lost =
      history.past.length > 0 ||
      history.future.length > 0 ||
      present.erasers.length > 0 ||
      Object.keys(present.overrides).length > 0 ||
      present.selectedId !== null
    if (!lost) return
    gesture.current = null
    updateHistory(
      createHistory({
        ...present,
        erasers: [],
        overrides: {},
        selectedId: null,
      }),
    )
  }, [updateHistory])

  function editsWouldBeLost(): boolean {
    const history = historyRef.current
    const present = history.present
    return (
      history.past.length > 0 ||
      history.future.length > 0 ||
      present.erasers.length > 0 ||
      Object.keys(present.overrides).length > 0
    )
  }

  function beginRebuildGesture(source: 'pointer' | 'key' = 'pointer') {
    rebuildGesture.current = true
    if (source === 'key' || rebuildLock.current === 'waiting') return
    rebuildLock.current = 'ask'
  }

  function endRebuildGesture() {
    rebuildGesture.current = false
    if (rebuildLock.current !== 'waiting') rebuildLock.current = 'ask'
  }

  function requestRebuild(apply: () => void) {
    if (rebuildLock.current === 'block') return
    if (rebuildLock.current === 'waiting') {
      pendingRebuild.current = apply
      return
    }
    if (rebuildLock.current === 'allow' || !editsWouldBeLost()) {
      clearStrokeEdits()
      apply()
      return
    }
    pendingRebuild.current = apply
    rebuildLock.current = 'waiting'
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    rebuildOpenRef.current = true
    setRebuildOpen(true)
  }

  function closeRebuild(decision: 'allow' | 'block') {
    const apply = decision === 'allow' ? pendingRebuild.current : null
    pendingRebuild.current = null
    rebuildOpenRef.current = false
    rebuildLock.current = rebuildGesture.current ? decision : 'ask'
    setRebuildOpen(false)
    if (decision === 'allow') clearStrokeEdits()
    apply?.()
    returnFocus.current?.focus()
  }

  function resetCropForPerspective() {
    if (isFullCrop(cropRef.current)) return
    cropRef.current = FULL_CROP
    setCrop(FULL_CROP)
    setNotice(CROP_RESET_MESSAGE)
  }

  function undo() {
    gesture.current = null
    updateHistory(undoHistory(historyRef.current))
  }

  function redo() {
    gesture.current = null
    updateHistory(redoHistory(historyRef.current))
  }

  useEffect(() => {
    document.title = site.name
    const prevent = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    const onKey = (event: KeyboardEvent) => {
      if (rebuildOpenRef.current) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target
      if (target instanceof HTMLTextAreaElement) return
      if (target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox') return
      event.preventDefault()
      gesture.current = null
      if (event.shiftKey) updateHistory(redoHistory(historyRef.current))
      else updateHistory(undoHistory(historyRef.current))
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerup', endRebuildGesture)
    window.addEventListener('pointercancel', endRebuildGesture)
    return () => {
      sessionRef.current?.dispose()
      sessionRef.current = null
      if (svgUrlRef.current) URL.revokeObjectURL(svgUrlRef.current)
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerup', endRebuildGesture)
      window.removeEventListener('pointercancel', endRebuildGesture)
    }
  }, [updateHistory])

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl)
    }
  }, [originalUrl])

  useEffect(() => {
    publishSvg(displaySvg)
  }, [displaySvg, publishSvg])

  useEffect(() => {
    if (!rebuildOpen) return
    confirmRef.current?.querySelector<HTMLElement>('[data-confirm="cancel"]')?.focus()
  }, [rebuildOpen])

  useEffect(() => {
    if (!base || !editsActive(edit)) return
    let cancelled = false
    const model = applyEdits(base, edit)
    // The cubic fitter stays out of the first page load and is fetched on the first edit.
    void import('./image/render-edits.ts').then(({ renderEditable }) => {
      if (!cancelled) setEditedSvg(renderEditable(model, smoothing))
    })
    return () => {
      cancelled = true
    }
  }, [base, edit, smoothing])

  useEffect(() => {
    const session = sessionRef.current
    if (!originalUrl || !session) return
    const controls = {
      darkness,
      smoothing,
      specks,
      crop,
      cleanup,
      perspective: edit.perspectiveOn ? edit.quad : null,
    }
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
          clearStrokeEdits()
          setCleanup(false)
          setTracing(false)
        }, CLEANUP_BUDGET_MS)
      }
      session
        .trace(controls)
        .then((next) => {
          if (id !== traceId.current) return
          window.clearTimeout(budgetTimer)
          setRawSvg(next.svg)
          setBase(next.model ? cloneModel(next.model) : null)
          if (!/<path\b/i.test(next.svg)) setNotice(NO_LINES_MESSAGE)
          else if (!timedOutRef.current) {
            setNotice((current) => (current === CROP_RESET_MESSAGE ? current : null))
          }
          setTracing(false)
        })
        .catch((reason: unknown) => {
          if (id !== traceId.current) return
          window.clearTimeout(budgetTimer)
          if (reason instanceof TraceCancelled) return
          if (reason instanceof CleanupTimeoutError) {
            timedOutRef.current = true
            setNotice(CLEANUP_TIMEOUT_MESSAGE)
            clearStrokeEdits()
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
  }, [originalUrl, photoKey, darkness, smoothing, specks, crop, cleanup, perspectiveToken, edit.perspectiveOn, edit.quad, clearStrokeEdits])

  function editPointerDown(event: ReactPointerEvent<HTMLDivElement>, image: HTMLImageElement) {
    if (!base) return
    const point = imagePoint(event, image, base.width, base.height)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (eraserOn) {
      beginEditGesture()
      const present = historyRef.current.present
      updateHistory(
        replacePresent(historyRef.current, {
          ...present,
          erasers: [...present.erasers, { points: [point], radius: eraserRadius(image, base) }],
        }),
      )
      return
    }
    const strokes = editsActive(historyRef.current.present) ? applyEdits(base, historyRef.current.present).strokes : base.strokes
    const bounds = image.getBoundingClientRect()
    const scale = bounds.width === 0 ? 1 : base.width / bounds.width
    selectStroke(nearestStroke(strokes, point, Math.max(8, 14 * scale)))
  }

  function editPointerMove(event: ReactPointerEvent<HTMLDivElement>, image: HTMLImageElement) {
    if (!eraserOn || !gesture.current || !base) return
    const point = imagePoint(event, image, base.width, base.height)
    if (!point) return
    const present = historyRef.current.present
    const marks = present.erasers
    const last = marks[marks.length - 1]
    const previous = last?.points[last.points.length - 1]
    if (!last || (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 1.5)) return
    updateHistory(
      replacePresent(historyRef.current, {
        ...present,
        erasers: [...marks.slice(0, -1), { ...last, points: [...last.points, point] }],
      }),
    )
  }

  function editPointerUp() {
    if (eraserOn) endEditGesture()
  }

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
      setRawSvg(null)
      setBase(null)
      gesture.current = null
      setEraserOn(false)
      updateHistory(createHistory(DEFAULT_EDIT))
      cropRef.current = FULL_CROP
      setCrop(FULL_CROP)
      const preview = new Uint8Array(loaded.preview.byteLength)
      preview.set(loaded.preview)
      setOriginalUrl(URL.createObjectURL(new Blob([preview], { type: 'image/png' })))
      setPhotoKey((value) => value + 1)
      setTab('photo')
    } catch (reason) {
      if (id !== loadId.current) return
      publishSvg(null)
      setRawSvg(null)
      setBase(null)
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

  const preview = (alt: string) => (
    <TracePreview
      alt={alt}
      src={svgUrl}
      model={base}
      strokes={liveStrokes}
      selectedId={selected?.id ?? null}
      eraserOn={eraserOn}
      mark={edit.erasers[edit.erasers.length - 1] ?? null}
      onPointerDown={editPointerDown}
      onPointerMove={editPointerMove}
      onPointerUp={editPointerUp}
    />
  )

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
                  <CropFrame
                    src={originalUrl}
                    crop={crop}
                    onCrop={(next) => {
                      requestRebuild(() => {
                        cropRef.current = next
                        setCrop(next)
                      })
                    }}
                    onCropGesture={(phase) => {
                      if (phase === 'start') beginRebuildGesture('pointer')
                      else endRebuildGesture()
                    }}
                    perspective={perspectiveValue}
                    onPerspective={(quad) => {
                      updateHistory(replacePresent(historyRef.current, { ...historyRef.current.present, quad, perspectiveOn: true }))
                      resetCropForPerspective()
                    }}
                    onPerspectiveGesture={(phase) => {
                      if (phase === 'start') beginEditGesture()
                      else endEditGesture()
                    }}
                  />
                </div>
              </figure>
              <div className="crop-actions">
                <div className="switch-row">
                  <input
                    id="fix-perspective"
                    type="checkbox"
                    checked={edit.perspectiveOn}
                    onChange={(event) => {
                      const enabled = event.currentTarget.checked
                      changeEdit({ perspectiveOn: enabled })
                      if (enabled) resetCropForPerspective()
                    }}
                  />
                  <label htmlFor="fix-perspective">Fix perspective</label>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    if (isFullCrop(cropRef.current)) return
                    requestRebuild(() => {
                      cropRef.current = FULL_CROP
                      setCrop(FULL_CROP)
                    })
                  }}
                >
                  Reset crop
                </button>
              </div>
            </Panel>
            <Panel id="adjust" compact={compact} tab={tab}>
              {compact ? (
                <figure className="live-preview">
                  <figcaption>Preview</figcaption>
                  {preview('Live preview')}
                </figure>
              ) : null}
              <div className="controls">
                <div className="switch-row">
                  <input
                    id="clean-up-lines"
                    type="checkbox"
                    checked={cleanup}
                    onChange={(event) => {
                      const enabled = event.currentTarget.checked
                      requestRebuild(() => {
                        if (enabled) timedOutRef.current = false
                        setCleanup(enabled)
                      })
                    }}
                  />
                  <label htmlFor="clean-up-lines">Clean up lines</label>
                </div>
                <div className="sliders">
                  <Slider
                    id="line-darkness"
                    label="Line darkness"
                    value={darkness}
                    onChange={(value) => {
                      requestRebuild(() => {
                        setDarkness(value)
                      })
                    }}
                    onGestureStart={beginRebuildGesture}
                    onGestureEnd={endRebuildGesture}
                  />
                  <Slider id="smoothing" label="Smoothing" value={smoothing} onChange={setSmoothing} />
                  <Slider
                    id="remove-specks"
                    label="Remove specks"
                    value={specks}
                    onChange={(value) => {
                      requestRebuild(() => {
                        setSpecks(value)
                      })
                    }}
                    onGestureStart={beginRebuildGesture}
                    onGestureEnd={endRebuildGesture}
                  />
                  {edit.straighten ? (
                    <Slider
                      id="straighten-tolerance"
                      label="Straighten tolerance"
                      value={edit.tolerance}
                      onChange={(value) => {
                        changeEdit({ tolerance: value })
                      }}
                      onGestureStart={beginEditGesture}
                      onGestureEnd={endEditGesture}
                    />
                  ) : null}
                  {edit.closeGaps ? (
                    <Slider
                      id="gap-distance"
                      label="Gap size"
                      value={edit.gap}
                      onChange={(value) => {
                        changeEdit({ gap: value })
                      }}
                      onGestureStart={beginEditGesture}
                      onGestureEnd={endEditGesture}
                    />
                  ) : null}
                </div>
                <div className="tool-row">
                  <div className="tool-check">
                    <input
                      id="straighten-shapes"
                      type="checkbox"
                      checked={edit.straighten}
                      onChange={(event) => {
                        changeEdit({ straighten: event.currentTarget.checked })
                      }}
                    />
                    <label htmlFor="straighten-shapes">Straighten shapes</label>
                  </div>
                  <div className="tool-check">
                    <input
                      id="close-gaps"
                      type="checkbox"
                      checked={edit.closeGaps}
                      onChange={(event) => {
                        changeEdit({ closeGaps: event.currentTarget.checked })
                      }}
                    />
                    <label htmlFor="close-gaps">Close gaps</label>
                  </div>
                  <button
                    type="button"
                    aria-pressed={eraserOn}
                    onClick={() => {
                      setEraserOn((value) => !value)
                    }}
                  >
                    Eraser
                  </button>
                  <button type="button" onClick={undo} disabled={!canUndo(history)} aria-keyshortcuts="Control+Z Meta+Z">
                    Undo
                  </button>
                  <button
                    type="button"
                    onClick={redo}
                    disabled={!canRedo(history)}
                    aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
                  >
                    Redo
                  </button>
                </div>
              </div>
            </Panel>
            <Panel id="result" compact={compact} tab={tab}>
              <figure>
                <figcaption>SVG</figcaption>
                <div className="stage">{preview('Traced line art')}</div>
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
                {selected ? (
                  <div className="path-smooth">
                    <Slider
                      id="smooth-this-line"
                      label="Smooth this line"
                      value={edit.overrides[String(selected.id)] ?? smoothing}
                      onChange={(value) => {
                        const present = historyRef.current.present
                        if (present.selectedId === null) return
                        changeEdit({
                          overrides: { ...present.overrides, [String(present.selectedId)]: value },
                        })
                      }}
                      onGestureStart={beginEditGesture}
                      onGestureEnd={endEditGesture}
                    />
                  </div>
                ) : null}
                <p className="status" role="status">
                  {statusText}
                </p>
              </div>
            </Panel>
          </div>
        </section>
      ) : (
        <Dropzone busy={busy} onFile={(file) => void openFile(file)} />
      )}

      {rebuildOpen ? (
        <div className="confirm-backdrop">
          <div
            ref={confirmRef}
            className="confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rebuild-confirm-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeRebuild('block')
                return
              }
              if (event.key !== 'Tab') return
              const items = [...(confirmRef.current?.querySelectorAll<HTMLElement>('button') ?? [])]
              const first = items[0]
              const last = items[items.length - 1]
              if (!first || !last) return
              event.preventDefault()
              const index = items.indexOf(document.activeElement as HTMLElement)
              const delta = event.shiftKey ? -1 : 1
              const next = index < 0 ? (event.shiftKey ? last : first) : items[(index + delta + items.length) % items.length]
              next?.focus()
            }}
          >
            <p id="rebuild-confirm-title">{REBUILD_CONFIRM_MESSAGE}</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => closeRebuild('allow')}>
                Continue
              </button>
              <button type="button" data-confirm="cancel" onClick={() => closeRebuild('block')}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <dl className="facts">
        <div>
          <dt>Input</dt>
          <dd>PNG, JPEG, WebP (HEIC in some browsers)</dd>
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

function TracePreview({
  alt,
  src,
  model,
  strokes,
  selectedId,
  eraserOn,
  mark,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  alt: string
  src: string | null
  model: EditableModel | null
  strokes: Stroke[]
  selectedId: number | null
  eraserOn: boolean
  mark: { points: Point[]; radius: number } | null
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, image: HTMLImageElement) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>, image: HTMLImageElement) => void
  onPointerUp: () => void
}) {
  const imageRef = useRef<HTMLImageElement>(null)
  const selectedStroke = strokes.find((stroke) => stroke.id === selectedId) ?? null
  return (
    <div
      className={eraserOn ? 'frame preview-frame erasing' : 'frame preview-frame'}
      onPointerDown={(event) => {
        if (imageRef.current) onPointerDown(event, imageRef.current)
      }}
      onPointerMove={(event) => {
        if (imageRef.current) onPointerMove(event, imageRef.current)
      }}
      onPointerUp={onPointerUp}
    >
      {src ? (
        <div className="preview-art">
          <img ref={imageRef} src={src} alt={alt} />
          {model ? (
            <svg className="edit-layer" viewBox={`0 0 ${model.width} ${model.height}`} preserveAspectRatio="none">
              {selectedStroke ? (
                <polyline
                  className="selected-stroke"
                  points={pointList(selectedStroke.points, selectedStroke.closed)}
                  strokeWidth={Math.max(model.penWidth * 0.45, 1.25)}
                />
              ) : null}
              {mark && mark.points.length > 0 ? (
                <polyline className="eraser-stroke" points={pointList(mark.points, false)} strokeWidth={mark.radius * 2} />
              ) : null}
            </svg>
          ) : null}
        </div>
      ) : (
        <p className="hint">Tracing…</p>
      )}
    </div>
  )
}

function pointList(points: Point[], closed: boolean): string {
  const first = points[0]
  const list = points.map((point) => `${point.x},${point.y}`)
  if (closed && first) list.push(`${first.x},${first.y}`)
  return list.join(' ')
}

function imagePoint(
  event: ReactPointerEvent<HTMLElement>,
  image: HTMLImageElement,
  width: number,
  height: number,
): Point | null {
  const bounds = image.getBoundingClientRect()
  if (bounds.width === 0 || bounds.height === 0) return null
  const x = ((event.clientX - bounds.left) / bounds.width) * width
  const y = ((event.clientY - bounds.top) / bounds.height) * height
  if (x < -1 || y < -1 || x > width + 1 || y > height + 1) return null
  return { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) }
}

function eraserRadius(image: HTMLImageElement, model: EditableModel): number {
  const bounds = image.getBoundingClientRect()
  const scale = bounds.width === 0 ? 1 : model.width / bounds.width
  return Math.max(model.penWidth, 12 * scale)
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
      aria-label="Open a photo"
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
        <span className="hint">PNG, JPEG or WebP. HEIC works in some browsers.</span>
      </label>
    </section>
  )
}

function Slider({
  id,
  label,
  value,
  onChange,
  onGestureStart,
  onGestureEnd,
}: {
  id: string
  label: string
  value: number
  onChange: (value: number) => void
  onGestureStart?: (source: 'pointer' | 'key') => void
  onGestureEnd?: () => void
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
        onPointerDown={() => {
          onGestureStart?.('pointer')
        }}
        onPointerUp={() => {
          onGestureEnd?.()
        }}
        onPointerCancel={() => {
          onGestureEnd?.()
        }}
        onKeyDown={(event) => {
          if (isSliderKey(event.key)) onGestureStart?.('key')
        }}
        onKeyUp={(event) => {
          if (isSliderKey(event.key)) onGestureEnd?.()
        }}
        onChange={(event) => {
          onChange(Number(event.currentTarget.value))
        }}
      />
      <span aria-hidden="true">{value}</span>
    </div>
  )
}
