import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { site } from './brand.ts'
import CropFrame from './CropFrame.tsx'
import { samePlan, type AutoPlan } from './image/classify.ts'
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
  type TraceView,
} from './image/limits.ts'
import { perspectiveKey } from './image/perspective.ts'
import { TraceCancelled, createTraceSession, type TraceSession } from './image/session.ts'

const MORE_CONTROLS_KEY = 'linekit.more-controls'
const MODE_VIEWS = ['auto', 'lines', 'full'] as const

type RebuildLock = 'ask' | 'waiting' | 'allow' | 'block'

function isFullCrop(crop: NormalizedCrop): boolean {
  return crop.x <= 0.005 && crop.y <= 0.005 && crop.width >= 0.99 && crop.height >= 0.99
}

function isSliderKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'
}

function viewLabel(view: TraceView): string {
  switch (view) {
    case 'auto':
      return 'Auto'
    case 'lines':
      return 'Lines'
    case 'full':
      return 'Full trace'
    default: {
      const exhaustive: never = view
      return exhaustive
    }
  }
}

function readMoreOpen(): boolean {
  try {
    return localStorage.getItem(MORE_CONTROLS_KEY) === 'open'
  } catch {
    return false
  }
}

export default function App() {
  const sessionRef = useRef<TraceSession | null>(null)
  const svgUrlRef = useRef<string | null>(null)
  const loadId = useRef(0)
  const traceId = useRef(0)
  const timedOutRef = useRef(false)
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
  const [smoothNoise, setSmoothNoise] = useState(DEFAULT_CONTROLS.smoothNoise ?? 0)
  const [edgeDetail, setEdgeDetail] = useState(DEFAULT_CONTROLS.edgeDetail ?? 0)
  const [evenLighting, setEvenLighting] = useState(DEFAULT_CONTROLS.evenLighting === true)
  const [colorCount, setColorCount] = useState(DEFAULT_CONTROLS.colorCount ?? 6)
  const [plan, setPlan] = useState<AutoPlan | null>(null)
  const [moreOpen, setMoreOpen] = useState(readMoreOpen)
  const [outlineFallback, setOutlineFallback] = useState(false)
  const [crop, setCrop] = useState<NormalizedCrop>(FULL_CROP)
  const followAutoRef = useRef(true)
  const planRef = useRef<AutoPlan | null>(null)
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
  const rebuildControl = useRef<HTMLElement | null>(null)
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

  const resolved = edit.view === 'auto' ? (plan?.mode ?? null) : edit.view
  const linesTools = resolved !== 'full'
  const perspectiveValue = edit.perspectiveOn ? edit.quad : null
  const perspectiveToken = perspectiveKey(perspectiveValue)
  const stamp = [
    darkness,
    smoothing,
    specks,
    smoothNoise,
    edgeDetail,
    evenLighting ? 1 : 0,
    colorCount,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    perspectiveToken,
  ].join('|')
  const restored = edit.frozen && edit.frozen.stamp === stamp ? edit.frozen : null
  const viewModel = restored?.model ?? base
  const viewRaw = restored ? restored.rawSvg : rawSvg
  const edited = useMemo(
    () => (viewModel && viewModel.kind === 'stroke' && editsActive(edit) ? applyEdits(viewModel, edit) : null),
    [viewModel, edit],
  )
  const strokeEdits = Boolean(viewModel && viewModel.kind === 'stroke' && editsActive(edit))
  const displaySvg = strokeEdits ? (editedSvg ?? viewRaw) : viewRaw
  const displayHasLines = Boolean(displaySvg && /<path\b/i.test(displaySvg))
  const traceHadLines = Boolean(viewRaw && /<path\b/i.test(viewRaw))
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
  const liveStrokes = edited?.strokes ?? viewModel?.strokes ?? []
  const selected = liveStrokes.find((stroke) => stroke.id === edit.selectedId) ?? null

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
        frozen: null,
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

  function beginRebuildGesture(source: 'pointer' | 'key' = 'pointer', control?: HTMLElement) {
    rebuildGesture.current = true
    if (control) rebuildControl.current = control
    if (source === 'key' || rebuildLock.current === 'waiting') return
    rebuildLock.current = 'ask'
  }

  function endRebuildGesture() {
    rebuildGesture.current = false
    if (rebuildLock.current !== 'waiting') {
      rebuildLock.current = 'ask'
      if (!rebuildOpenRef.current) rebuildControl.current = null
    }
    if (rebuildOpenRef.current) {
      confirmRef.current?.querySelector<HTMLElement>('[data-confirm="cancel"]')?.focus()
    }
  }

  function requestRebuild(apply: () => void) {
    if (rebuildLock.current === 'block') return
    if (rebuildLock.current === 'waiting') {
      pendingRebuild.current = apply
      confirmRef.current?.querySelector<HTMLElement>('[data-confirm="cancel"]')?.focus()
      return
    }
    if (rebuildLock.current === 'allow' || !editsWouldBeLost()) {
      clearStrokeEdits()
      apply()
      return
    }
    pendingRebuild.current = apply
    rebuildLock.current = 'waiting'
    const active =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null
    returnFocus.current = rebuildControl.current ?? active
    if (returnFocus.current && document.activeElement === returnFocus.current) returnFocus.current.blur()
    rebuildOpenRef.current = true
    setRebuildOpen(true)
  }

  function closeRebuild(decision: 'allow' | 'block') {
    const apply = decision === 'allow' ? pendingRebuild.current : null
    const restore = returnFocus.current
    pendingRebuild.current = null
    returnFocus.current = null
    rebuildControl.current = null
    rebuildOpenRef.current = false
    rebuildLock.current = rebuildGesture.current ? decision : 'ask'
    setRebuildOpen(false)
    if (decision === 'allow') clearStrokeEdits()
    apply?.()
    restore?.focus()
  }

  function selectView(next: TraceView) {
    const present = historyRef.current.present
    if (present.view === next) return
    setOutlineFallback(false)
    if (next === 'full') setEraserOn(false)
    const frozenPresent = {
      ...present,
      frozen: { stamp, rawSvg: viewRaw, model: viewModel ? cloneModel(viewModel) : null },
    }
    updateHistory({
      past: [...historyRef.current.past, frozenPresent].slice(-40),
      present: { ...present, view: next, frozen: null },
      future: [],
    })
  }

  function tune(apply: () => void) {
    followAutoRef.current = false
    apply()
  }

  function resetControls() {
    const next = planRef.current
    followAutoRef.current = true
    setDarkness(next?.faintLines ?? DEFAULT_CONTROLS.darkness)
    setSmoothing(next?.smoothing ?? DEFAULT_CONTROLS.smoothing)
    setSpecks(next?.specks ?? DEFAULT_CONTROLS.specks)
    setSmoothNoise(next?.smoothNoise ?? 0)
    setEdgeDetail(next?.edgeDetail ?? 0)
    setEvenLighting(next?.evenLighting ?? false)
    setColorCount(next?.colorCount ?? DEFAULT_CONTROLS.colorCount ?? 6)
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
    const focusCancel = () => {
      confirmRef.current?.querySelector<HTMLElement>('[data-confirm="cancel"]')?.focus()
    }
    focusCancel()
    const frame = window.requestAnimationFrame(focusCancel)
    return () => window.cancelAnimationFrame(frame)
  }, [rebuildOpen])

  useEffect(() => {
    try {
      localStorage.setItem(MORE_CONTROLS_KEY, moreOpen ? 'open' : 'closed')
    } catch {
      // Storage can be blocked. The toggle still works for this visit.
    }
  }, [moreOpen])

  useEffect(() => {
    if (!viewModel || viewModel.kind !== 'stroke' || !editsActive(edit)) return
    let cancelled = false
    const model = applyEdits(viewModel, edit)
    // The cubic fitter stays out of the first page load and is fetched on the first edit.
    void import('./image/render-edits.ts').then(({ renderEditable }) => {
      if (!cancelled) setEditedSvg(renderEditable(model, smoothing))
    })
    return () => {
      cancelled = true
    }
  }, [viewModel, edit, smoothing])

  useEffect(() => {
    const session = sessionRef.current
    if (!originalUrl || !session) return
    if (edit.frozen && edit.frozen.stamp === stamp) return
    const controls = {
      darkness,
      smoothing,
      specks,
      crop,
      cleanup: edit.view === 'full' ? true : !outlineFallback,
      perspective: edit.perspectiveOn ? edit.quad : null,
      view: edit.view,
      smoothNoise,
      edgeDetail,
      evenLighting,
      colorCount,
      followAuto: followAutoRef.current,
    }
    let budgetTimer = 0
    const timer = window.setTimeout(() => {
      const id = ++traceId.current
      setTracing(true)
      if (edit.view === 'lines') {
        budgetTimer = window.setTimeout(() => {
          if (id !== traceId.current) return
          session.cancel()
          timedOutRef.current = true
          setNotice(CLEANUP_TIMEOUT_MESSAGE)
          clearStrokeEdits()
          setOutlineFallback(true)
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
          if (next.plan) {
            planRef.current = next.plan
            if (controls.view === 'auto' && next.plan.mode === 'full') setEraserOn(false)
            setPlan((current) => (samePlan(current, next.plan) ? current : next.plan))
            if (followAutoRef.current) {
              setDarkness((value) => (value === next.plan.faintLines ? value : next.plan.faintLines))
              setSmoothing((value) => (value === next.plan.smoothing ? value : next.plan.smoothing))
              setSpecks((value) => (value === next.plan.specks ? value : next.plan.specks))
              setSmoothNoise((value) => (value === next.plan.smoothNoise ? value : next.plan.smoothNoise))
              setEdgeDetail((value) => (value === next.plan.edgeDetail ? value : next.plan.edgeDetail))
              setEvenLighting((value) => (value === next.plan.evenLighting ? value : next.plan.evenLighting))
              setColorCount((value) => (value === next.plan.colorCount ? value : next.plan.colorCount))
            }
          }
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
            setOutlineFallback(true)
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
  }, [
    originalUrl,
    photoKey,
    darkness,
    smoothing,
    specks,
    smoothNoise,
    edgeDetail,
    evenLighting,
    colorCount,
    crop,
    outlineFallback,
    perspectiveToken,
    edit.perspectiveOn,
    edit.quad,
    edit.view,
    edit.frozen,
    stamp,
    clearStrokeEdits,
  ])

  const erasePointer = useRef<number | null>(null)

  function editPointerDown(event: ReactPointerEvent<HTMLDivElement>, image: HTMLImageElement) {
    if (!viewModel) return
    if (eraserOn) {
      event.preventDefault()
    }
    const point = imagePoint(event, image, viewModel.width, viewModel.height)
    if (!point) return
    if (eraserOn) {
      const surface = event.currentTarget
      if (typeof surface.setPointerCapture === 'function') {
        try {
          surface.setPointerCapture(event.pointerId)
        } catch {
          // Capture can be refused once the pointer has ended. Moves still reach the preview.
        }
      }
    } else {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    if (viewModel.kind !== 'stroke') return
    if (eraserOn) {
      erasePointer.current = event.pointerId
      beginEditGesture()
      const present = historyRef.current.present
      updateHistory(
        replacePresent(historyRef.current, {
          ...present,
          erasers: [...present.erasers, { points: [point], radius: eraserRadius(image, viewModel) }],
        }),
      )
      return
    }
    const strokes = editsActive(historyRef.current.present)
      ? applyEdits(viewModel, historyRef.current.present).strokes
      : viewModel.strokes
    const bounds = image.getBoundingClientRect()
    const scale = bounds.width === 0 ? 1 : viewModel.width / bounds.width
    selectStroke(nearestStroke(strokes, point, Math.max(8, 14 * scale)))
  }

  function editPointerMove(event: ReactPointerEvent<HTMLDivElement>, image: HTMLImageElement) {
    if (!eraserOn || !gesture.current || !viewModel) return
    const point = imagePoint(event, image, viewModel.width, viewModel.height)
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

  function editPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!eraserOn || erasePointer.current !== event.pointerId) return
    erasePointer.current = null
    endEditGesture()
  }

  function discardErase(event: ReactPointerEvent<HTMLDivElement>) {
    if (erasePointer.current !== event.pointerId) return
    erasePointer.current = null
    const baseline = gesture.current
    gesture.current = null
    if (baseline) updateHistory(replacePresent(historyRef.current, baseline))
  }

  async function openFile(file: File) {
    const id = ++loadId.current
    setError(null)
      setNotice(null)
      timedOutRef.current = false
      followAutoRef.current = true
      planRef.current = null
      setPlan(null)
      setOutlineFallback(false)
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
      model={viewModel}
      strokes={liveStrokes}
      selectedId={selected?.id ?? null}
      eraserOn={eraserOn}
      mark={edit.erasers[edit.erasers.length - 1] ?? null}
      onPointerDown={editPointerDown}
      onPointerMove={editPointerMove}
      onPointerUp={editPointerUp}
      onPointerCancel={discardErase}
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
        <section className={moreOpen ? 'workspace more-open' : 'workspace'} aria-label="Trace">
          <div className="trace-main">
            <Dropzone busy={busy} onFile={(file) => void openFile(file)} />
            <ModePicker view={edit.view} onSelect={selectView} />
            <p id="auto-choice" className="auto-note">
              {plan?.summary ?? 'Checking this image on this device.'}
            </p>
            <figure className="result-figure">
              <figcaption>SVG</figcaption>
              <div className="stage">{preview('Traced line art')}</div>
            </figure>
            <div className="actions">
              {svgUrl ? (
                <a href={svgUrl} download="linekit.svg">
                  Export
                </a>
              ) : (
                <span className="action-pending">Export</span>
              )}
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
              <button
                type="button"
                aria-expanded={moreOpen}
                aria-controls="more-controls"
                onClick={() => {
                  setMoreOpen((open) => !open)
                }}
              >
                More controls
              </button>
              {linesTools && selected ? (
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
          </div>
          <div id="more-controls" className="more-controls" hidden={!moreOpen}>
            <div className="controls">
              <button type="button" className="reset-controls" aria-label="Reset controls to Auto" onClick={resetControls}>
                Reset
              </button>
              <div className="sliders">
                <Slider
                  id="smooth-noise"
                  label="Smooth out noise"
                  value={smoothNoise}
                  onChange={(value) => {
                    tune(() => {
                      setSmoothNoise(value)
                    })
                  }}
                />
                <Slider
                  id="edge-detail"
                  label="Edge detail"
                  value={edgeDetail}
                  onChange={(value) => {
                    tune(() => {
                      setEdgeDetail(value)
                    })
                  }}
                />
                {resolved === 'full' ? (
                  <Slider
                    id="number-of-colors"
                    label="Number of colors"
                    min={2}
                    max={16}
                    value={colorCount}
                    onChange={(value) => {
                      tune(() => {
                        setColorCount(value)
                      })
                    }}
                  />
                ) : null}
                <Slider
                  id="smoothing"
                  label="Smoothing"
                  value={smoothing}
                  onChange={(value) => {
                    tune(() => {
                      setSmoothing(value)
                    })
                  }}
                />
                {linesTools ? (
                  <Slider
                    id="faint-lines"
                    label="Pick up faint lines"
                    value={darkness}
                    onChange={(value) => {
                      tune(() => {
                        setDarkness(value)
                      })
                    }}
                  />
                ) : null}
                {linesTools ? (
                  <Slider
                    id="remove-specks"
                    label="Remove specks"
                    value={specks}
                    onChange={(value) => {
                      tune(() => {
                        setSpecks(value)
                      })
                    }}
                  />
                ) : null}
                {linesTools && edit.straighten ? (
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
                {linesTools && edit.closeGaps ? (
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
              <div className="switch-row">
                <input
                  id="even-lighting"
                  type="checkbox"
                  checked={evenLighting}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked
                    tune(() => {
                      setEvenLighting(enabled)
                    })
                  }}
                />
                <label htmlFor="even-lighting">Even out lighting</label>
              </div>
              {linesTools ? (
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
                </div>
              ) : null}
              <button type="button" onClick={() => void copySvg()} disabled={!svg}>
                Copy SVG code
              </button>
            </div>
            <figure>
              <figcaption>Original</figcaption>
              <div className="stage original-stage">
                <CropFrame
                  src={originalUrl}
                  crop={crop}
                  onCrop={(next) => {
                    requestRebuild(() => {
                      cropRef.current = next
                      setCrop(next)
                      if (!isFullCrop(next)) {
                        setNotice((current) => (current === CROP_RESET_MESSAGE ? null : current))
                      }
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
  onPointerCancel,
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
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
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
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onDragStart={(event) => {
        event.preventDefault()
      }}
    >
      {src ? (
        <div className="preview-art">
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            draggable={false}
            onDragStart={(event) => {
              event.preventDefault()
            }}
          />
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

function ModePicker({ view, onSelect }: { view: TraceView; onSelect: (view: TraceView) => void }) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const index = MODE_VIEWS.indexOf(view)
    if (index < 0) return
    let next = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % MODE_VIEWS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + MODE_VIEWS.length) % MODE_VIEWS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = MODE_VIEWS.length - 1
    else return
    event.preventDefault()
    const item = MODE_VIEWS[next]
    if (!item) return
    onSelect(item)
    document.getElementById(`mode-${item}`)?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Trace mode"
      aria-describedby="auto-choice"
      className="mode-picker"
      onKeyDown={onKeyDown}
    >
      {MODE_VIEWS.map((item) => (
        <button
          key={item}
          type="button"
          role="radio"
          id={`mode-${item}`}
          aria-checked={view === item}
          tabIndex={view === item ? 0 : -1}
          onClick={() => {
            onSelect(item)
          }}
        >
          {viewLabel(item)}
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
  min = 0,
  max = 100,
  onChange,
  onGestureStart,
  onGestureEnd,
}: {
  id: string
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  onGestureStart?: (source: 'pointer' | 'key', control?: HTMLElement) => void
  onGestureEnd?: () => void
}) {
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onPointerDown={(event) => {
          onGestureStart?.('pointer', event.currentTarget)
        }}
        onPointerUp={() => {
          onGestureEnd?.()
        }}
        onPointerCancel={() => {
          onGestureEnd?.()
        }}
        onKeyDown={(event) => {
          if (isSliderKey(event.key)) onGestureStart?.('key', event.currentTarget)
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
