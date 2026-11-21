/**
 * dsh-omni-vision host half.
 *
 * Registers the `eyes_render` tool: the agent sends drawing commands (text,
 * lines, rectangles, circles, ellipses), the browser client renders them on a
 * canvas card in the Web GUI, serializes the canvas to PNG, and POSTs the bytes
 * back to `POST /eyes/render` (matched by the tool-call id). The tool waits for
 * that upload, stores the PNG under `<workspace>/renders/`, commits it through
 * the attachment service, and returns the result. When the resolved model route
 * declares image input, the tool result carries an image content block so the
 * model sees the render; text-only routes (e.g. the DeepSeek adapter) get a
 * path+description envelope instead — never an UNSUPPORTED_CONTENT failure.
 *
 * Companion tools: eyes_ocr (Windows OCR), eyes_analyze (pixel grid),
 * eyes_paste (clipboard image capture), and eyes_lmstudio (a personal
 * extension that calls the owner's local LM Studio server for text/vision).
 *
 * This package is deliberately self-contained (no monorepo imports, mirroring
 * the dshmarket plugin): the tool definition is a plain object in the exact
 * shape `ctx.tools.register` validates structurally, schemas are pre-compiled
 * JSON Schema, and attachment ids are opaque strings (the AttachmentId brand is
 * a type-only identity). Everything runs locally: browser -> loopback HTTP ->
 * host disk. The only outbound leg is the model inference itself.
 */
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, isAbsolute, normalize, sep } from 'node:path'
import { decodePng, analyzePng } from './png.js'
import { callLmstudio, LMSTUDIO_DEFAULTS } from './lmstudio.js'

export const name = 'dsh-omni-vision'

/** Required services: tools/fs/systemPrompt always exist in the web composition. */
export const inject = ['tools', 'fs', 'systemPrompt']

const RENDER_TIMEOUT_MS = 15_000
/** Mermaid first use loads its library (host-local or CDN); allow more time. */
const MERMAID_RENDER_TIMEOUT_MS = 45_000
/** Paste waits on a human pressing Ctrl+V — give it a generous window. */
const PASTE_TIMEOUT_MS = 60_000
const MIN_CANVAS_SIDE = 64
const MAX_CANVAS_SIDE = 2048
/** Upper bound on the decoded PNG payload accepted from the browser. */
const MAX_RENDER_BYTES = 24 * 1024 * 1024

/** callId -> { resolve, reject, timer, onAbort, signal, cwd } for renders awaiting the browser. */
const pending = new Map()

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function isPng(bytes) {
  return bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
}

/** Locate the Windows PowerShell 5.1 executable (hosts the WinRT OCR engine). */
function powershellPath() {
  const root = process.env.SystemRoot
  if (typeof root === 'string' && root.length > 0) {
    return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }
  return 'powershell.exe'
}

/**
 * Run the bundled ocr.ps1 (Windows.Media.Ocr, fully offline) on a PNG file.
 * Resolves with the parsed JSON result object; never rejects for OCR failure.
 */
function runOcr(pngPath, signal) {
  return new Promise((resolve) => {
    const script = fileURLToPath(new URL('./ocr.ps1', import.meta.url))
    execFile(
      powershellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', pngPath],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30_000, signal },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: `OCR process failed: ${error.message}` })
          return
        }
        try {
          resolve(JSON.parse(stdout.trim()))
        } catch {
          resolve({ ok: false, error: `OCR produced non-JSON output: ${String(stdout).slice(0, 200)}` })
        }
      },
    )
  })
}

/**
 * Capture a PNG from the local desktop with the bundled grab.ps1 and parse its
 * JSON result. Resolves `{ ok: false, error }` instead of rejecting so the tool
 * can report the failure inside a normal result.
 */
function runGrab(outPath, options, signal) {
  return new Promise((resolve) => {
    const script = fileURLToPath(new URL('./grab.ps1', import.meta.url))
    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Scope', options.scope]
    if (outPath !== null) argv.push('-Out', outPath)
    if (typeof options.title === 'string' && options.title !== '') argv.push('-Title', options.title)
    if (options.scope === 'region') {
      argv.push('-X', String(options.x ?? 0), '-Y', String(options.y ?? 0), '-W', String(options.w ?? 0), '-H', String(options.h ?? 0))
    }
    execFile(
      powershellPath(),
      argv,
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 20_000, signal },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: `screen capture process failed: ${error.message}` })
          return
        }
        try {
          resolve(JSON.parse(stdout.trim()))
        } catch {
          resolve({ ok: false, error: `screen capture produced non-JSON output: ${String(stdout).slice(0, 200)}` })
        }
      },
    )
  })
}

/** Validate the shared `path` argument (absolute path to a PNG on disk). */
function requireAbsolutePath(args, toolName) {
  const path = typeof args?.path === 'string' ? args.path.trim() : ''
  if (path.length === 0) throw new Error(`${toolName}: "path" is required`)
  if (!isAbsolute(path)) throw new Error(`${toolName}: "path" must be an absolute path, got "${path}"`)
  return path
}

/**
 * Wait for the browser client to POST a pasted clipboard image for this call
 * (matched by `exec.callId`, same pending table as the render upload).
 */
async function waitForPaste(exec) {
  const key = String(exec.callId)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key)
      reject(new Error(`eyes_paste: no image was pasted in the Web GUI for call "${key}" within ${PASTE_TIMEOUT_MS / 1000}s. Ask the user to copy an image (screenshot/photo) and press Ctrl+V while the paste card is active.`))
    }, PASTE_TIMEOUT_MS)
    const onAbort = () => {
      clearTimeout(timer)
      pending.delete(key)
      reject(new Error('eyes_paste: aborted before an image was pasted'))
    }
    if (exec.signal?.aborted === true) {
      onAbort()
      return
    }
    exec.signal?.addEventListener?.('abort', onAbort, { once: true })
    pending.set(key, { resolve, reject, timer, onAbort, signal: exec.signal })
  }).finally(() => {
    const entry = pending.get(key)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener?.('abort', entry.onAbort)
      pending.delete(key)
    }
  })
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Same-origin fence for the render upload (the GUI page posts from its own origin). */
function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a JSON body, capped at `maxBytes` of raw request bytes. */
async function readJsonBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Whether the resolved model route for this call declares image input.
 * Mirrors the gate `read_image` uses; unknown routes degrade to text-only.
 */
async function imageCapableRoute(ctx, exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info?.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

function renderBlocks(args, value) {
  const mermaidSrc = typeof args?.mermaid === 'string' && args.mermaid.trim() !== '' ? args.mermaid : null
  const lines = [
    `<path>${value.path}</path>`,
    '<type>render</type>',
    '<content>',
    mermaidSrc !== null
      ? `Mermaid diagram rendered on a ${value.width}x${value.height} canvas`
      : `${value.commandCount} command${value.commandCount === 1 ? '' : 's'} rendered on a ${value.width}x${value.height} canvas`,
    value.fileSaved ? 'PNG saved to disk' : `PNG not saved to disk${value.fileError ? ` (${value.fileError})` : ''}`,
    value.keptPath ? `permanent copy kept: ${value.keptPath}` : (value.keepError ? `(permanent copy not saved: ${value.keepError})` : ''),
    value.imageIncluded ? '' : '(image not included: the current model route is text-only; the PNG is on disk for the user to open)',
    typeof value.ocrText === 'string' && value.ocrText.trim() !== ''
      ? `OCR read back:\n${value.ocrText.split('\n').map((line) => `  ${line}`).join('\n')}`
      : '',
    typeof value.ocrError === 'string' && value.ocrError !== '' ? `(OCR failed: ${value.ocrError})` : '',
    value.fileDeleted ? 'file deleted after reading (read-and-burn): do not reference the path again' : (value.deleteError ? `cleanup failed: ${value.deleteError}` : ''),
    '</content>',
  ]
  const blocks = [{ type: 'text', text: lines.filter((line) => line !== '').join('\n') }]
  if (value.imageIncluded) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    })
  }
  return blocks
}

/**
 * Resolve a writable workspace root for the saved PNG, most specific first:
 * the session header cwd (same source the model-facing fs tools use), then the
 * fs backend's own default root, then the host process's working directory.
 */
async function resolveWorkspaceRoot(ctx, exec) {
  const headerCwd = exec.agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd.length > 0 && isAbsolute(headerCwd)) return normalize(headerCwd)
  try {
    const target = await ctx.fs.resolve('.', { signal: exec.signal })
    const root = target?.displayPath
    if (typeof root === 'string' && root.length > 0 && isAbsolute(root)) return normalize(root)
  } catch {
    // fall through
  }
  const pwd = process.cwd()
  if (typeof pwd === 'string' && pwd.length > 0 && isAbsolute(pwd)) return normalize(pwd)
  return null
}

/**
 * Delete a PNG after the agent has read it ("read-and-burn"): only files under
 * the plugin's own `<workspace>/renders/` directory are removed, so images the
 * user keeps elsewhere (screenshots, photos, scans) are never touched.
 * Returns { deleted, error } so the tool can report the cleanup outcome.
 */
async function deleteAfterRead(ctx, exec, filePath) {
  try {
    const root = await resolveWorkspaceRoot(ctx, exec)
    if (root === null) return { deleted: false, error: 'no workspace root available' }
    const rendersDir = normalize(join(root, 'renders')) + sep
    const normalizedPath = normalize(filePath)
    if (!normalizedPath.startsWith(rendersDir)) {
      return { deleted: false, error: '' }
    }
    await unlink(normalizedPath)
    return { deleted: true, error: '' }
  } catch (error) {
    return { deleted: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Write a permanent copy of a produced PNG under `<workspace>/pics/` (best
 * effort, same containment checks as the renders/ write). The renders/ copy is
 * read-and-burn; this one is meant to survive for the user to keep.
 * Returns { path, error } so the tool can report the outcome.
 */
async function saveDurableCopy(ctx, exec, bytes, name) {
  try {
    const root = await resolveWorkspaceRoot(ctx, exec)
    if (root === null) return { path: null, error: 'no workspace root available' }
    const dir = join(root, 'pics')
    const normalizedRoot = normalize(root) + sep
    if (!normalize(dir).startsWith(normalizedRoot)) {
      return { path: null, error: 'workspace root containment check failed' }
    }
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await writeFile(file, bytes)
    return { path: file, error: '' }
  } catch (error) {
    return { path: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Command properties shared by the parameter schema and validation. */
const BASE_PROPERTIES = {
  op: { type: 'string', description: 'One of: text, line, arrow, rect, circle, ellipse, path, arc, plot, curve, grid, field, stack, table, clear.' },
  // text
  text: { type: 'string', description: 'Text to draw (\\n for hard line breaks).' },
  x: { type: 'number', description: 'X coordinate (text baseline left, or shape origin).' },
  y: { type: 'number', description: 'Y coordinate (for text: the top of the first line\'s glyphs lands exactly here).' },
  size: { type: 'number', description: 'Font size in px for text.' },
  font: { type: 'string', description: 'Font family for text (default sans-serif).' },
  weight: { type: 'string', description: 'Font weight for text (e.g. bold).' },
  align: { type: 'string', description: 'Text align: left | center | right.' },
  maxWidth: { type: 'number', description: 'Optional max line width for text. Longer text wraps onto as many lines as it needs (latin breaks on spaces, CJK anywhere); glyphs are only squeezed when a single unbreakable run is wider than maxWidth.' },
  color: { type: 'string', description: 'Primary color (text fill, line stroke, or clear background).' },
  // line
  x1: { type: 'number', description: 'Line start X.' },
  y1: { type: 'number', description: 'Line start Y.' },
  x2: { type: 'number', description: 'Line end X.' },
  y2: { type: 'number', description: 'Line end Y.' },
  width: { type: 'number', description: 'Stroke width for line.' },
  // rect
  w: { type: 'number', description: 'Rectangle width.' },
  h: { type: 'number', description: 'Rectangle height.' },
  radius: { type: 'number', description: 'Corner radius for rect.' },
  // circle / ellipse
  cx: { type: 'number', description: 'Center X.' },
  cy: { type: 'number', description: 'Center Y.' },
  r: { type: 'number', description: 'Circle radius.' },
  rx: { type: 'number', description: 'Ellipse radius X.' },
  ry: { type: 'number', description: 'Ellipse radius Y.' },
  // fill/stroke
  fill: { type: 'string', description: 'Fill color for shapes.' },
  stroke: { type: 'string', description: 'Stroke color for shapes.' },
  strokeWidth: { type: 'number', description: 'Stroke width for shapes.' },
  // shared paint
  opacity: { type: 'number', description: 'Alpha for the whole command, 0-1 (default 1).' },
  dash: { type: 'array', items: { type: 'number' }, description: 'Dash pattern in px, e.g. [8,6] for a dashed stroke (default solid).' },
  cap: { type: 'string', description: 'Line cap for strokes: butt | round | square.' },
  join: { type: 'string', description: 'Line join for paths: miter | round | bevel.' },
  // arrow
  head: { type: 'number', description: 'Arrow head length in px (default scales with the stroke width).' },
  // path
  points: {
    type: 'array',
    description: 'Path vertices as [x,y] pairs (path op). Consecutive points are joined by lines; with smooth:true they are joined by a curve.',
    items: { type: 'array', items: { type: 'number' } },
  },
  closed: { type: 'boolean', description: 'path op: close the outline back to the first point (default true when fill is set).' },
  smooth: { type: 'boolean', description: 'path op: join vertices with a smooth curve instead of straight segments (default false).' },
  // arc
  start: { type: 'number', description: 'arc op: start angle in degrees (default 0, 0 = 3 o\'clock).' },
  end: { type: 'number', description: 'arc op: end angle in degrees (default 360).' },
  pie: { type: 'boolean', description: 'arc op: draw as a filled wedge from the center (default false: open arc).' },
  ccw: { type: 'boolean', description: 'arc op: sweep counter-clockwise (default false).' },
  // stack / table layout
  gap: { type: 'number', description: 'stack op: vertical gap between children (default 10).' },
  padding: { type: 'number', description: 'stack op: inner padding (default 14); table op: horizontal cell padding (default 12).' },
  rowHeight: { type: 'number', description: 'table op: body row height (default 30).' },
  headerHeight: { type: 'number', description: 'table op: header row height (default = rowHeight).' },
  zebra: { type: 'boolean', description: 'table op: shade alternate body rows (default true).' },
  headerColor: { type: 'string', description: 'table op: header text color (default #64748b).' },
  columns: {
    type: 'array',
    description: 'table op: column definitions, e.g. [{"title":"指标","width":220},{"title":"本周","align":"right"}]. Omitted widths share the remaining space; align defaults to left.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Header cell text.' },
        width: { type: 'number', description: 'Column width in px (optional).' },
        align: { type: 'string', description: 'Cell alignment: left | center | right.' },
      },
    },
  },
  rows: {
    type: 'array',
    description: 'table op: body rows, each an array of cell strings (aligned with columns).',
    items: { type: 'array', items: { type: 'string' } },
  },
  // paint effects
  shadow: { type: 'string', description: 'Any op: drop shadow as "dx dy blur color", e.g. "0 8px 24px rgba(15,23,42,0.18)". Off by default.' },
  filter: { type: 'string', description: 'Any op: CSS filter applied while drawing it, e.g. "blur(12px)", "blur(6px) saturate(1.3) contrast(1.1)" or "grayscale(1)". Off by default.' },
  blend: { type: 'string', description: 'Any op: composite mode, e.g. multiply | screen | overlay | soft-light | lighten | darken | color-dodge. Default source-over.' },
  // field (procedural texture)
  seed: { type: 'number', description: 'field op: noise seed (default 1). Different seeds give different textures.' },
  cell: { type: 'number', description: 'field op: feature size in px — larger = smoother, smaller = busier (default 48).' },
  octaves: { type: 'number', description: 'field op: fBm octaves 1-6 (default 3). More octaves = more fine detail.' },
  warp: { type: 'number', description: 'field op: domain warp strength 0-2 (default 0.6). Warping turns blobs into organic, cloud/marble-like flows.' },
  palette: {
    type: 'array',
    description: 'field op: colors sampled from dark to light by the noise value, e.g. ["#0b1020","#3b2f63","#e8a87c"].',
    items: { type: 'string' },
  },
  // plot (function curve)
  fn: { type: 'string', description: 'plot op: JavaScript expression in x returning the y value, e.g. "0.62*sqrt(max(0,1-(x/0.5)^2))". Math functions (sin, cos, sqrt, pow, abs, min, max, atan2, hypot, PI, E, …) are in scope.' },
  x0: { type: 'number', description: 'plot op: start of the x data range (default -1).' },
  x1: { type: 'number', description: 'plot op: end of the x data range (default 1).' },
  y0: { type: 'number', description: 'plot op: data value mapped to the bottom of the box (default -1).' },
  y1: { type: 'number', description: 'plot op: data value mapped to the top of the box (default 1).' },
  samples: { type: 'number', description: 'plot op: number of samples along x (default 300, max 4000).' },
  from: { type: 'number', description: 'plot op: first x to sample (default = x0). Use a sub-range so several curves share one viewport.' },
  to: { type: 'number', description: 'plot op: last x to sample (default = x1).' },
  // curve (parametric)
  fx: { type: 'string', description: 'curve op: JavaScript expression in t for x, e.g. "0.5*cos(t)". Math functions are in scope.' },
  fy: { type: 'string', description: 'curve op: JavaScript expression in t for y, e.g. "0.5*sin(t)".' },
  t0: { type: 'number', description: 'curve op: first t (default 0).' },
  t1: { type: 'number', description: 'curve op: last t (default 2*PI).' },
  tolerance: { type: 'number', description: 'curve op: flatness tolerance in px — smaller splits more finely (default 0.35).' },
  // grid (coordinate system)
  grid: { type: 'string', description: 'grid op: grid line color (default rgba(148,163,184,0.32)).' },
  gridWidth: { type: 'number', description: 'grid op: grid line width (default 1).' },
  labels: { type: 'boolean', description: 'grid op: draw tick labels (default true).' },
  ticks: { type: 'number', description: 'grid op: target tick count per axis (default auto: about one per 90 px).' },
  stepX: { type: 'number', description: 'grid op: fixed x tick step (default: automatic 1-2-5 step).' },
  stepY: { type: 'number', description: 'grid op: fixed y tick step (default: automatic 1-2-5 step).' },
  arrows: { type: 'boolean', description: 'grid op: arrow heads at the positive ends of the zero axes (default true).' },
}

/** One command. `children` (stack) is one level deep on purpose: a child cannot itself be a stack. */
const COMMAND_PROPERTIES = {
  ...BASE_PROPERTIES,
  children: {
    type: 'array',
    description: 'stack op: child commands drawn top-to-bottom, measured and placed automatically. Inside a stack, x is an offset from the content edge (default 0) and y is ignored. Children do not support nested stacks.',
    items: { type: 'object', additionalProperties: false, properties: JSON.parse(JSON.stringify(BASE_PROPERTIES)) },
  },
}

const COMMANDS_SCHEMA = {
  type: 'array',
  description: 'Drawing commands, applied in order. Each command is an object with an "op" discriminator (text | line | arrow | rect | circle | ellipse | path | arc | plot | curve | grid | stack | table | clear) plus the fields the op needs. `plot` draws y=f(x) and `curve` draws a parametric x(t),y(t) path (both share a data viewport via x0/x1/y0/y1); `grid` draws labeled axes over the same viewport; `stack` lays its children out top-to-bottom and sizes itself to the content, `table` draws a data table from columns/rows.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: COMMAND_PROPERTIES,
  },
}

/** Pre-compiled parameter schema in the exact JSON-Schema form defineTool would emit. */
const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    width: { type: 'number', description: 'Canvas width in px (64-2048, default 800).' },
    height: { type: 'number', description: 'Canvas height in px (64-2048, default 500).' },
    scale: { type: 'number', description: 'Supersampling factor (1-3, default 2). The canvas is painted at width*scale by height*scale, so the PNG is that many times larger and stays sharp when the GUI fits it into the chat column or on a hi-DPI screen. Logical coordinates and font sizes are unchanged.' },
    grain: { type: 'number', description: 'Film-grain overlay strength 0-1 (default 0). Adds fine noise across the whole canvas at low opacity — the cheapest way to make a flat picture feel photographic.' },
    background: { type: 'string', description: 'Background CSS color (default #ffffff).' },
    title: { type: 'string', description: 'Optional card title shown in the GUI.' },
    description: { type: 'string', description: 'Optional note describing what you intend to draw; included for your own reference.' },
    commands: COMMANDS_SCHEMA,
    mermaid: { type: 'string', description: 'Optional Mermaid diagram source (e.g. "graph LR\\n  A[start] --> B[process] --> C[end]"). When present, the browser renders the diagram onto the canvas and this takes precedence over commands — perfect for flowcharts / connection diagrams without hand-computing coordinates. The SVG is rasterized at the canvas resolution (no upscaled bitmap), and when height is omitted the canvas is sized to the diagram\'s aspect ratio. Mermaid is loaded from a host-served local copy when installed, otherwise from CDN (needs browser network on first use).' },
    ocr: { type: 'boolean', description: 'Also run local OCR on the rendered PNG and include the recognized text in the result (default false). This lets you "see" the text you drew on text-only model routes.' },
  },
}

/** Pre-compiled output schema (assertSupportedJsonSchema-compatible subset: object-level required). */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'commandCount', 'width', 'height', 'imageIncluded', 'image', 'fileSaved', 'fileError', 'keptPath', 'keepError', 'ocrText', 'ocrError', 'fileDeleted', 'deleteError'],
  properties: {
    path: { type: 'string', description: 'Path of the rendered PNG (absolute when saved, relative hint otherwise).' },
    commandCount: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    imageIncluded: { type: 'boolean', description: 'Whether the result carries the image block (false on text-only model routes).' },
    fileSaved: { type: 'boolean', description: 'Whether a user-openable PNG was written to the workspace renders/ directory.' },
    fileError: { type: 'string', description: 'Why the PNG was not saved, when it was not (otherwise empty).' },
    keptPath: { type: 'string', description: 'Absolute path of the permanent copy kept under the workspace pics/ directory (empty when it could not be saved).' },
    keepError: { type: 'string', description: 'Why the permanent pics/ copy was not saved, when it was not (otherwise empty).' },
    ocrText: { type: 'string', description: 'Text recognized by local OCR when the ocr parameter was true (empty otherwise).' },
    ocrError: { type: 'string', description: 'Why OCR failed, when it did (empty otherwise).' },
    fileDeleted: { type: 'boolean', description: 'Whether the rendered PNG was deleted after OCR read it back (read-and-burn cleanup, only when ocr was true and succeeded).' },
    deleteError: { type: 'string', description: 'Why cleanup failed, when it did (otherwise empty).' },
    image: {
      type: 'object',
      additionalProperties: false,
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string', enum: ['image/png', 'image/webp', 'image/jpeg'] },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        name: { type: 'string' },
      },
    },
  },
}

/** Light argument validation (defineTool normally does this; we stay dependency-free). */
function validateArgsShape(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('invalid arguments: expected an object')
  }
  if (args.commands !== undefined && !Array.isArray(args.commands)) {
    throw new Error('invalid arguments: "commands" must be an array')
  }
}

function registerEyesTool(ctx) {
  ctx.tools.register({
    name: 'eyes_render',
    description: 'Draw text and graphics onto a canvas that appears in the Web GUI, then return the rendered PNG. Primitive ops: text (with \\n, align, maxWidth, weight, font, color), line, arrow (x1,y1 -> x2,y2 with a head), rect (optional radius), circle, ellipse, path (points list, optional smooth curve, closed or open), arc (degrees, optional pie wedge), plot (y=f(x) from an expression), curve (parametric x(t),y(t) — loops and closed shapes), grid (labeled coordinate axes over the same viewport as plot/curve), field (procedural noise texture), stack (children laid out top-to-bottom with automatic height), table (columns + rows, data-driven), clear. plot/curve/grid share a data viewport (x,y,w,h plus x0,x1,y0,y1); curve subdivides adaptively, so round or looping shapes stay smooth. Every op accepts opacity, dash: [len,gap] and shadow: "dx dy blur color"; strokes take color/stroke, width/strokeWidth, cap and join; fill/stroke also accept CSS gradients like "linear-gradient(90deg,#a,#b)" or "radial-gradient(#a,#b)". For flowcharts / connection diagrams you do not need to compute coordinates: pass the optional "mermaid" parameter with a Mermaid diagram source (e.g. "graph LR\\n  A[start] --> B[end]") and the browser renders it onto the canvas (mermaid takes precedence over commands). Coordinates and font sizes are LOGICAL pixels: the PNG is width*scale by height*scale (scale defaults to 2) so it stays crisp when the GUI fits it into a narrower column. maxWidth wraps text onto new lines instead of squeezing it, axis-aligned 1 px strokes snap to the device grid, smooth paths pass through every point, and a mermaid diagram sizes the canvas to its own aspect ratio when height is omitted. The result reports the PNG file path and dimensions; the rendered PNG is saved twice — a burn-on-read copy under the workspace renders/ directory and a permanent copy under pics/ (keptPath). When the current model supports image input, the rendered image itself is attached so you see what you drew. The browser page must be open to render.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => renderBlocks(args, value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      validateArgsShape(args)
      const width = clampInt(args.width, MIN_CANVAS_SIDE, MAX_CANVAS_SIDE, 800)
      const height = clampInt(args.height, MIN_CANVAS_SIDE, MAX_CANVAS_SIDE, 500)
      const commands = Array.isArray(args.commands)
        ? args.commands.filter((cmd) => cmd !== null && typeof cmd === 'object' && typeof cmd.op === 'string')
        : []
      const key = String(exec.callId)

      // Mermaid renders load a ~3MB library on first use (host-local or CDN),
      // so give them a more generous upload window than plain canvas draws.
      const isMermaid = typeof args.mermaid === 'string' && args.mermaid.trim() !== ''
      const renderTimeoutMs = isMermaid ? MERMAID_RENDER_TIMEOUT_MS : RENDER_TIMEOUT_MS

      const uploaded = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key)
          reject(new Error(`eyes_render: the Web GUI did not render${isMermaid ? ' the mermaid diagram' : ' canvas'} for call "${key}" within ${renderTimeoutMs / 1000}s. The browser page must be open and connected to render; ${isMermaid ? 'on first use mermaid downloads its library, which can take a few seconds' : 'the drawing commands were accepted but no PNG was produced'}.`))
        }, renderTimeoutMs)
        const onAbort = () => {
          clearTimeout(timer)
          pending.delete(key)
          reject(new Error('eyes_render: aborted before the browser rendered the canvas'))
        }
        if (exec.signal?.aborted === true) {
          onAbort()
          return
        }
        exec.signal?.addEventListener?.('abort', onAbort, { once: true })
        pending.set(key, { resolve, reject, timer, onAbort, signal: exec.signal })      }).finally(() => {
        const entry = pending.get(key)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          entry.signal?.removeEventListener?.('abort', entry.onAbort)
          pending.delete(key)
        }
      })

      const bytes = uploaded.bytes
      const imageCapable = await imageCapableRoute(ctx, exec)

      // Byte cap mirrors read_image: the smaller of the per-image and per-message limits.
      const byteCap = Math.min(ctx.attachments.imageLimits.maxImageBytes, ctx.attachments.imageLimits.maxMessageImageBytes)
      if (bytes.length > byteCap) {
        throw new Error(`eyes_render: rendered PNG is ${bytes.length} bytes, exceeding the ${byteCap}-byte image limit; draw a smaller canvas`)
      }

      // Store a user-openable copy under the workspace renders/ directory (best effort).
      let storedPath = null
      let fileError = ''
      try {
        const root = await resolveWorkspaceRoot(ctx, exec)
        if (root === null) {
          fileError = 'no workspace root available'
        } else {
          const dir = join(root, 'renders')
          const normalizedRoot = normalize(root) + sep
          if (!normalize(dir).startsWith(normalizedRoot)) {
            fileError = 'workspace root containment check failed'
          } else {
            await mkdir(dir, { recursive: true })
            const file = join(dir, `eyes-${key}.png`)
            await writeFile(file, bytes)
            storedPath = file
          }
        }
      } catch (error) {
        fileError = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[dsh-omni-vision] could not save rendered PNG: ${fileError}`)
      }

      // Durable copy under pics/: unlike the renders/ file (read-and-burn),
      // this one is kept permanently so the user can find the render later.
      const kept = await saveDurableCopy(ctx, exec, bytes, `eyes-${key}.png`)
      if (kept.path === null && kept.error !== '') {
        ctx.logger?.warn?.(`[dsh-omni-vision] could not keep rendered PNG: ${kept.error}`)
      }

      // Report the ACTUAL PNG dimensions (decoded from the attachment), not the
      // requested ones: they are equal now that the client renders 1:1, but the
      // decoded values stay truthful even if a stale client uploads a mismatch.
      const ref = await ctx.attachments.saveImage({
        data: bytes,
        mediaType: 'image/png',
        name: `eyes-${key}.png`,
      })
      const pngWidth = Number.isFinite(ref.width) ? ref.width : (uploaded.width ?? width)
      const pngHeight = Number.isFinite(ref.height) ? ref.height : (uploaded.height ?? height)

      // Optional local OCR: read back the text we just drew so the agent can "see" it.
      let ocrText = ''
      let ocrError = ''
      let ocrReadBack = false
      if (args.ocr === true && storedPath !== null) {
        const ocrResult = await runOcr(storedPath, exec.signal)
        if (ocrResult.ok === true && Array.isArray(ocrResult.lines)) {
          ocrText = ocrResult.lines.map((line) => String(line?.text ?? '')).join('\n')
          ocrReadBack = true
        } else {
          ocrError = typeof ocrResult.error === 'string' ? ocrResult.error : 'OCR failed'
        }
      } else if (args.ocr === true && storedPath === null) {
        ocrError = 'PNG was not saved to disk, so OCR could not run'
      }

      // Read-and-burn: the render was meant for the agent's own eyes; once OCR
      // has read it back there is no reason to keep the file on disk.
      const cleanup = ocrReadBack && storedPath !== null
        ? await deleteAfterRead(ctx, exec, storedPath)
        : { deleted: false, error: '' }

      return {
        path: storedPath ?? `renders/eyes-${key}.png`,
        commandCount: commands.length,
        width: pngWidth,
        height: pngHeight,
        imageIncluded: imageCapable,
        fileSaved: storedPath !== null,
        fileError,
        keptPath: kept.path ?? '',
        keepError: kept.error,
        ocrText,
        ocrError,
        fileDeleted: cleanup.deleted,
        deleteError: cleanup.error,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: typeof args.title === 'string' && args.title !== '' ? args.title : 'Draw on eyes canvas',
        kind: 'other',
      }
    },
  })
}

/** Parameter schema for eyes_ocr. */
const OCR_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', description: 'Absolute path of the PNG to read (e.g. the path returned by eyes_render).' },
  },
}

/** Output schema for eyes_ocr (text a text-only model can genuinely read). */
const OCR_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'path', 'text', 'lines', 'language', 'fileExists', 'sizeBytes', 'error', 'fileDeleted', 'deleteError'],
  properties: {
    ok: { type: 'boolean', description: 'Whether OCR succeeded.' },
    path: { type: 'string' },
    text: { type: 'string', description: 'All recognized text joined with newlines (empty when nothing was recognized).' },
    lines: {
      type: 'array',
      description: 'Recognized text lines in reading order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
    },
    language: { type: 'string', description: 'OCR language tag actually used (e.g. zh-Hans-CN).' },
    fileExists: { type: 'boolean' },
    sizeBytes: { type: 'integer' },
    error: { type: 'string', description: 'Failure reason when ok is false, otherwise empty.' },
    fileDeleted: { type: 'boolean', description: 'Whether the source PNG (when it lived under the workspace renders/ directory) was deleted after reading — read-and-burn cleanup.' },
    deleteError: { type: 'string', description: 'Why cleanup failed, when it did (otherwise empty).' },
  },
}

function ocrBlocks(value) {
  const lines = [
    '<type>ocr</type>',
    `<path>${value.path}</path>`,
    `<language>${value.language || '(unknown)'}</language>`,
    '<content>',
    value.ok
      ? (value.text !== ''
          ? `OCR recognized ${value.lines.length} line(s):\n${value.text.split('\n').map((line) => `  ${line}`).join('\n')}`
          : 'OCR ran but recognized no text (the image may contain no readable text, or use a script without an installed language pack).')
      : `OCR failed: ${value.error}`,
    value.fileDeleted ? 'file deleted after reading (read-and-burn): do not reference the path again' : (value.deleteError ? `cleanup failed: ${value.deleteError}` : ''),
    '</content>',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

function registerOcrTool(ctx) {
  ctx.tools.register({
    name: 'eyes_ocr',
    description: 'Read text from a PNG image using the local Windows OCR engine (Windows.Media.Ocr, fully offline, no upload). Pass the absolute path of a PNG — e.g. the path returned by eyes_render, or any image saved on disk (screenshots, scans). This is how you "see" text without a vision model: recognized lines come back as text you can quote. Chinese (zh-Hans) and other installed language packs are supported. Files under the workspace renders/ directory are deleted automatically after being read (read-and-burn); images kept elsewhere are left untouched.',
    parameters: OCR_PARAMETERS_SCHEMA,
    output: { schema: OCR_OUTPUT_SCHEMA, render: (_args, value) => ocrBlocks(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = requireAbsolutePath(args, 'eyes_ocr')
      let fileExists = false
      let sizeBytes = 0
      try {
        const info = await stat(path)
        fileExists = true
        sizeBytes = info.size
      } catch {
        fileExists = false
      }
      if (!fileExists) {
        return { ok: false, path, text: '', lines: [], language: '', fileExists, sizeBytes: 0, error: 'file does not exist or is not readable', fileDeleted: false, deleteError: '' }
      }
      const result = await runOcr(path, exec.signal)
      const ok = result.ok === true
      const lines = Array.isArray(result.lines) ? result.lines.map((line) => ({ text: String(line?.text ?? '') })) : []
      const cleanup = ok ? await deleteAfterRead(ctx, exec, path) : { deleted: false, error: '' }
      return {
        ok,
        path,
        text: ok ? lines.map((line) => line.text).join('\n') : '',
        lines,
        language: typeof result.language === 'string' ? result.language : '',
        fileExists,
        sizeBytes,
        error: ok ? '' : (typeof result.error === 'string' ? result.error : 'OCR failed'),
        fileDeleted: cleanup.deleted,
        deleteError: cleanup.error,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: 'Read text from image (OCR)', kind: 'other' }
    },
  })
}

/** Parameter schema for eyes_analyze. */
const ANALYZE_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', description: 'Absolute path of the PNG to inspect.' },
    grid: { type: 'number', description: 'Sampling grid NxN cells (2-32, default 8).' },
    maxColors: { type: 'number', description: 'Top dominant colors to report (1-16, default 6).' },
  },
}

/** Output schema for eyes_analyze (graphics "seen" as structured data). */
const ANALYZE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'path', 'width', 'height', 'gridCells', 'dominantColors', 'contentBox', 'error', 'fileDeleted', 'deleteError'],
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    gridCells: {
      type: 'array',
      description: 'Average color of each cell of the NxN sampling grid (row 0 = top, col 0 = left).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['col', 'row', 'r', 'g', 'b', 'hex', 'alpha'],
        properties: {
          col: { type: 'integer' },
          row: { type: 'integer' },
          r: { type: 'integer' },
          g: { type: 'integer' },
          b: { type: 'integer' },
          hex: { type: 'string' },
          alpha: { type: 'integer' },
        },
      },
    },
    dominantColors: {
      type: 'array',
      description: 'Most frequent colors (5-bit quantized), most common first, with share of total pixels.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hex', 'share', 'count'],
        properties: {
          hex: { type: 'string' },
          share: { type: 'number' },
          count: { type: 'integer' },
        },
      },
    },
    contentBox: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'w', 'h'],
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        w: { type: 'integer' },
        h: { type: 'integer' },
      },
    },
    error: { type: 'string', description: 'Failure reason when ok is false, otherwise empty.' },
    fileDeleted: { type: 'boolean', description: 'Whether the source PNG (when it lived under the workspace renders/ directory) was deleted after reading — read-and-burn cleanup.' },
    deleteError: { type: 'string', description: 'Why cleanup failed, when it did (otherwise empty).' },
  },
}

function analyzeBlocks(value) {
  const lines = [
    '<type>analyze</type>',
    `<path>${value.path}</path>`,
    '<content>',
    value.ok
      ? [
          `${value.width}x${value.height}px image`,
          `content box: x=${value.contentBox.x} y=${value.contentBox.y} w=${value.contentBox.w} h=${value.contentBox.h}`,
          `dominant colors: ${value.dominantColors.map((c) => `${c.hex} (${Math.round(c.share * 100)}%)`).join(', ')}`,
          `grid ${Math.round(Math.sqrt(value.gridCells.length))}x${Math.round(Math.sqrt(value.gridCells.length))}:`,
          ...value.gridCells.map((cell) => `  [${cell.col},${cell.row}] ${cell.hex} rgb(${cell.r},${cell.g},${cell.b})`),
        ].join('\n')
      : `analysis failed: ${value.error}`,
    value.fileDeleted ? 'file deleted after reading (read-and-burn): do not reference the path again' : (value.deleteError ? `cleanup failed: ${value.deleteError}` : ''),
    '</content>',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

function registerAnalyzeTool(ctx) {
  ctx.tools.register({
    name: 'eyes_analyze',
    description: 'Inspect a PNG image as structured pixel data — average color per cell of an NxN grid, dominant colors with shares, and the bounding box of content against the background. This is how you "see" graphics (shapes, colors, layout) without a vision model. Pass the absolute path of a PNG, e.g. the path returned by eyes_render. Files under the workspace renders/ directory are deleted automatically after being read (read-and-burn); images kept elsewhere are left untouched.',
    parameters: ANALYZE_PARAMETERS_SCHEMA,
    output: { schema: ANALYZE_OUTPUT_SCHEMA, render: (_args, value) => analyzeBlocks(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = requireAbsolutePath(args, 'eyes_analyze')
      const grid = Number.isFinite(Number(args.grid)) ? Math.round(Number(args.grid)) : undefined
      const maxColors = Number.isFinite(Number(args.maxColors)) ? Math.round(Number(args.maxColors)) : undefined
      let bytes
      try {
        bytes = await readFile(path)
      } catch {
        return { ok: false, path, width: 0, height: 0, gridCells: [], dominantColors: [], contentBox: { x: 0, y: 0, w: 0, h: 0 }, error: 'file does not exist or is not readable', fileDeleted: false, deleteError: '' }
      }
      let image
      try {
        image = decodePng(bytes)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, path, width: 0, height: 0, gridCells: [], dominantColors: [], contentBox: { x: 0, y: 0, w: 0, h: 0 }, error: message, fileDeleted: false, deleteError: '' }
      }
      const analysis = analyzePng(image, { grid, maxColors })
      const cleanup = await deleteAfterRead(ctx, exec, path)
      return {
        ok: true,
        path,
        width: analysis.width,
        height: analysis.height,
        gridCells: analysis.gridCells,
        dominantColors: analysis.dominantColors,
        contentBox: analysis.contentBox,
        error: '',
        fileDeleted: cleanup.deleted,
        deleteError: cleanup.error,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: 'Inspect image pixels', kind: 'other' }
    },
  })
}

/**
 * Parameter schema for eyes_lmstudio. This tool is a personal extension of
 * dsh-omni-vision: it talks to the owner's local LM Studio server (OpenAI-compatible
 * REST API) for text chat and — when a PNG path is given — vision input. It is
 * deliberately NOT part of the published plugin.
 */
const LMSTUDIO_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The question or instruction for the local model, e.g. "描述这张图片的内容" or "读出图中所有文字".' },
    path: { type: 'string', description: 'Optional absolute path of a PNG to attach as vision input (base64, stays on this machine). Omit for a text-only chat.' },
    model: { type: 'string', description: `LM Studio model id as listed by GET /v1/models (default "${LMSTUDIO_DEFAULTS.model}").` },
    baseUrl: { type: 'string', description: `LM Studio server root (default "${LMSTUDIO_DEFAULTS.baseUrl}").` },
    maxTokens: { type: 'number', description: `Max completion tokens (default ${LMSTUDIO_DEFAULTS.maxTokens}); thinking models consume tokens on reasoning first, keep this generous.` },
    temperature: { type: 'number', description: `Sampling temperature (default ${LMSTUDIO_DEFAULTS.temperature}).` },
    timeoutMs: { type: 'number', description: `Request timeout in ms (default ${LMSTUDIO_DEFAULTS.timeoutMs}).` },
  },
}

/** Output schema for eyes_lmstudio. */
const LMSTUDIO_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'text', 'model', 'promptTokens', 'completionTokens', 'latencyMs', 'error', 'fileExists', 'fileDeleted', 'deleteError'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the local model replied successfully.' },
    text: { type: 'string', description: 'The model reply text (empty when ok is false).' },
    model: { type: 'string', description: 'Model id that served the reply.' },
    promptTokens: { type: 'integer' },
    completionTokens: { type: 'integer' },
    latencyMs: { type: 'integer', description: 'Round-trip time of the LM Studio call.' },
    error: { type: 'string', description: 'Failure reason when ok is false, otherwise empty.' },
    fileExists: { type: 'boolean', description: 'Whether the source PNG existed when a path was given.' },
    fileDeleted: { type: 'boolean', description: 'Whether the source PNG (when it lived under the workspace renders/ directory) was deleted after reading — read-and-burn cleanup.' },
    deleteError: { type: 'string', description: 'Why cleanup failed, when it did (otherwise empty).' },
  },
}

function lmstudioBlocks(value) {
  const lines = [
    '<type>lmstudio</type>',
    `<model>${value.model}</model>`,
    '<content>',
    value.ok
      ? [
          `local LM Studio reply (${value.promptTokens} in / ${value.completionTokens} out tokens, ${value.latencyMs} ms):`,
          value.text.split('\n').map((line) => `  ${line}`).join('\n'),
        ].join('\n')
      : `LM Studio call failed: ${value.error}`,
    value.fileDeleted ? 'file deleted after reading (read-and-burn): do not reference the path again' : (value.deleteError ? `cleanup failed: ${value.deleteError}` : ''),
    '</content>',
  ]
  return [{ type: 'text', text: lines.filter((line) => line !== '').join('\n') }]
}

function registerLmstudioTool(ctx) {
  ctx.tools.register({
    name: 'eyes_lmstudio',
    description: 'Call the owner\'s local LM Studio server (OpenAI-compatible REST API at http://127.0.0.1:1234 by default) with a text prompt and optionally a PNG image (absolute path) as vision input. Everything stays on this machine — the image is base64-inlined into the request and nothing is uploaded. Use it to describe images, read text off screenshots, or reason about visuals with a local vision-language model (e.g. minicpm-v-4.6-thinking) when you need richer understanding than eyes_ocr (text lines) or eyes_analyze (pixels) provide. This is a personal extension of dsh-omni-vision and is NOT part of the published plugin. Files under the workspace renders/ directory are deleted after being read (read-and-burn); images kept elsewhere are left untouched.',
    parameters: LMSTUDIO_PARAMETERS_SCHEMA,
    output: { schema: LMSTUDIO_OUTPUT_SCHEMA, render: (_args, value) => lmstudioBlocks(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) {
        return { ok: false, text: '', model: LMSTUDIO_DEFAULTS.model, promptTokens: 0, completionTokens: 0, latencyMs: 0, error: 'eyes_lmstudio: "prompt" is required', fileExists: false, fileDeleted: false, deleteError: '' }
      }
      let path = ''
      if (typeof args?.path === 'string' && args.path.trim() !== '') {
        path = requireAbsolutePath(args, 'eyes_lmstudio')
      }
      const result = await callLmstudio({
        prompt,
        imagePath: path.length > 0 ? path : null,
        baseUrl: typeof args?.baseUrl === 'string' && args.baseUrl.trim() !== '' ? args.baseUrl : undefined,
        model: typeof args?.model === 'string' && args.model.trim() !== '' ? args.model : undefined,
        maxTokens: typeof args?.maxTokens === 'number' ? args.maxTokens : undefined,
        temperature: typeof args?.temperature === 'number' ? args.temperature : undefined,
        timeoutMs: typeof args?.timeoutMs === 'number' ? args.timeoutMs : undefined,
        signal: exec.signal,
      })
      let fileExists = false
      if (path.length > 0) {
        try {
          await stat(path)
          fileExists = true
        } catch {
          fileExists = false
        }
      }
      const cleanup = (result.ok === true && path.length > 0) ? await deleteAfterRead(ctx, exec, path) : { deleted: false, error: '' }
      return {
        ok: result.ok === true,
        text: result.text ?? '',
        model: result.model ?? LMSTUDIO_DEFAULTS.model,
        promptTokens: result.promptTokens ?? 0,
        completionTokens: result.completionTokens ?? 0,
        latencyMs: result.latencyMs ?? 0,
        error: result.error ?? '',
        fileExists,
        fileDeleted: cleanup.deleted,
        deleteError: cleanup.error,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: typeof args?.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt.trim().slice(0, 60) : 'Local LM Studio call', kind: 'other' }
    },
  })
}

/** Parameter schema for eyes_paste. */
const PASTE_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hint: { type: 'string', description: 'Optional instruction shown on the paste card (what the user should paste).' },
  },
}

/** The image-block payload shared by every tool that hands a picture back. */
const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/webp', 'image/jpeg'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

/** Placeholder image payload for results that carry no image block. */
const EMPTY_IMAGE = { attachmentId: '', mediaType: 'image/png', bytes: 0, width: 0, height: 0 }

/** Output schema for eyes_paste. */
const PASTE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'path', 'width', 'height', 'bytes', 'fileSaved', 'fileError', 'imageIncluded', 'image', 'error'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the pasted image arrived: attached to the result, or saved to disk on a text-only route.' },
    path: { type: 'string', description: 'Path of the PNG on disk; empty once the temporary file was deleted right after the image was attached.' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    fileSaved: { type: 'boolean' },
    fileError: { type: 'string', description: 'Why the PNG was not saved, when it was not (otherwise empty).' },
    imageIncluded: { type: 'boolean', description: 'Whether the result carries the pasted image as an image block (false on text-only model routes).' },
    image: IMAGE_SCHEMA,
    error: { type: 'string', description: 'Failure reason when ok is false, otherwise empty.' },
  },
}

function pasteBlocks(value) {
  const lines = [
    '<type>paste</type>',
    value.path !== '' ? `<path>${value.path}</path>` : '',
    '<content>',
    value.ok
      ? (value.imageIncluded
        ? `Pasted image attached (${value.width}x${value.height}, ${value.bytes} bytes) — you are looking at it now; the temporary PNG was deleted, nothing left on disk.`
        : `Pasted image saved (${value.width}x${value.height}, ${value.bytes} bytes). Read it with eyes_ocr for text or eyes_analyze for pixels; the file under renders/ is deleted after being read (read-and-burn, no permanent copy).`)
      : `paste failed: ${value.error}`,
    '</content>',
  ]
  const blocks = [{ type: 'text', text: lines.filter((line) => line !== '').join('\n') }]
  if (value.imageIncluded === true && typeof value.image?.attachmentId === 'string' && value.image.attachmentId !== '') {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    })
  }
  return blocks
}

function registerPasteTool(ctx) {
  ctx.tools.register({
    name: 'eyes_paste',
    description: 'Ask the user to bring an image into the Web GUI through a capture card (drag an image file onto the page, or Ctrl+V while the card is active) when they want to hand you a file that is neither on screen nor on disk. The DSH composer accepts images itself, so prefer it when the user is attaching a picture anyway; this tool stays for when an explicit paste prompt helps. The PNG is attached to the result and the temporary file is deleted immediately, leaving nothing on disk; on a text-only route the file stays under the workspace renders/ so eyes_ocr / eyes_analyze can read it. The browser page must be open (15s+60s timeout for the user to deliver the image).',
    parameters: PASTE_PARAMETERS_SCHEMA,
    output: { schema: PASTE_OUTPUT_SCHEMA, render: (_args, value) => pasteBlocks(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const uploaded = await waitForPaste(exec)
      const bytes = uploaded.bytes
      let storedPath = null
      let fileError = ''
      try {
        const root = await resolveWorkspaceRoot(ctx, exec)
        if (root === null) {
          fileError = 'no workspace root available'
        } else {
          const dir = join(root, 'renders')
          const normalizedRoot = normalize(root) + sep
          if (!normalize(dir).startsWith(normalizedRoot)) {
            fileError = 'workspace root containment check failed'
          } else {
            await mkdir(dir, { recursive: true })
            const file = join(dir, `paste-${String(exec.callId)}.png`)
            await writeFile(file, bytes)
            storedPath = file
          }
        }
      } catch (error) {
        fileError = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[dsh-omni-vision] could not save pasted PNG: ${fileError}`)
      }
      // Hand the pasted image to the model the same way eyes_grab does: attach
      // it, then drop the temporary PNG so nothing is left on disk. On a
      // text-only route the file stays, because eyes_ocr / eyes_analyze still
      // need a path to read.
      const imageCapable = await imageCapableRoute(ctx, exec)
      let ref = null
      if (imageCapable) {
        try {
          ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: `paste-${String(exec.callId)}.png` })
        } catch (error) {
          ctx.logger?.warn?.(`[dsh-omni-vision] could not attach the pasted PNG: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const imageIncluded = ref !== null
      const cleanup = imageIncluded && storedPath !== null
        ? await deleteAfterRead(ctx, exec, storedPath)
        : { deleted: false, error: '' }
      return {
        ok: imageIncluded || storedPath !== null,
        path: cleanup.deleted ? '' : (storedPath ?? `renders/paste-${String(exec.callId)}.png`),
        width: ref !== null && Number.isFinite(ref.width) && ref.width > 0 ? ref.width : (uploaded.width ?? 0),
        height: ref !== null && Number.isFinite(ref.height) && ref.height > 0 ? ref.height : (uploaded.height ?? 0),
        bytes: bytes.length,
        fileSaved: storedPath !== null,
        fileError,
        imageIncluded,
        image: ref === null
          ? EMPTY_IMAGE
          : {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          },
        error: fileError,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: typeof args.hint === 'string' && args.hint !== '' ? args.hint : 'Paste an image', kind: 'other' }
    },
  })
}

/** Parameter schema for eyes_grab. */
const GRAB_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: {
      type: 'string',
      enum: ['window', 'screen', 'region', 'list'],
      description: 'What to capture. "window" (default) — the foreground window, or the first visible window whose title contains "title". "screen" — the whole virtual screen (all monitors). "region" — the explicit x/y/w/h rectangle. "list" — no capture; returns the visible top-level windows so you can pick one.',
    },
    title: { type: 'string', description: 'Window scope only: case-insensitive substring of the window title to capture (e.g. "DeepSeek Harness"). Omit to capture whatever window is in the foreground.' },
    x: { type: 'number', description: 'Region left edge (physical pixels, region scope only).' },
    y: { type: 'number', description: 'Region top edge (physical pixels, region scope only).' },
    w: { type: 'number', description: 'Region width (physical pixels, region scope only, > 0).' },
    h: { type: 'number', description: 'Region height (physical pixels, region scope only, > 0).' },
    keep: { type: 'boolean', description: 'Also keep a permanent copy under the workspace pics/ directory (default false: the screenshot lives only inside the tool result and the temporary PNG is deleted immediately).' },
  },
}

/** Output schema for eyes_grab. */
const GRAB_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'scope', 'path', 'width', 'height', 'title', 'process', 'bounds', 'windows', 'imageIncluded', 'image', 'error', 'keptPath', 'keepError'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the capture succeeded (list scope: whether windows could be enumerated).' },
    scope: { type: 'string', description: 'Scope actually used: window | screen | region | list.' },
    path: { type: 'string', description: 'Absolute path of the captured PNG: empty for list scope, and empty once the temporary file was deleted right after the image was attached.' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    title: { type: 'string', description: 'Title of the captured window (empty for screen/region/list).' },
    process: { type: 'string', description: 'Process name of the captured window (empty when unknown).' },
    bounds: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'w', 'h'],
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        w: { type: 'integer' },
        h: { type: 'integer' },
      },
    },
    windows: {
      type: 'array',
      description: 'Visible top-level windows (always populated; the list scope returns only these).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'process', 'pid', 'x', 'y', 'w', 'h'],
        properties: {
          title: { type: 'string' },
          process: { type: 'string' },
          pid: { type: 'integer' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          w: { type: 'integer' },
          h: { type: 'integer' },
        },
      },
    },
    imageIncluded: { type: 'boolean', description: 'Whether the result carries the screenshot as an image block (false on text-only model routes and for list scope).' },
    image: IMAGE_SCHEMA,
    error: { type: 'string', description: 'Failure reason when ok is false, otherwise empty.' },
    keptPath: { type: 'string', description: 'Absolute path of the permanent pics/ copy when keep was true (empty otherwise).' },
    keepError: { type: 'string', description: 'Why the permanent copy was not saved, when it was not (otherwise empty).' },
  },
}

/** Normalize the raw grab.ps1 window list into the output schema shape. */
function normalizeWindows(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    out.push({
      title: String(entry.title ?? ''),
      process: String(entry.process ?? ''),
      pid: Number.isFinite(Number(entry.pid)) ? Math.round(Number(entry.pid)) : 0,
      x: Number.isFinite(Number(entry.x)) ? Math.round(Number(entry.x)) : 0,
      y: Number.isFinite(Number(entry.y)) ? Math.round(Number(entry.y)) : 0,
      w: Number.isFinite(Number(entry.w)) ? Math.round(Number(entry.w)) : 0,
      h: Number.isFinite(Number(entry.h)) ? Math.round(Number(entry.h)) : 0,
    })
  }
  return out
}

function grabBlocks(value) {
  const head = ['<type>grab</type>', `<scope>${value.scope}</scope>`]
  const lines = []
  if (value.ok !== true) {
    lines.push(`screen capture failed: ${value.error}`)
  } else if (value.scope === 'list') {
    lines.push(`visible windows (${value.windows.length}):`)
    for (const win of value.windows) {
      lines.push(`  ${win.title} — ${win.process} pid=${win.pid} at ${win.x},${win.y} ${win.w}x${win.h}`)
    }
    lines.push('pick one with scope:"window" and title:"<substring>", or omit title to capture the foreground window')
  } else {
    lines.push(`captured ${value.width}x${value.height} from ${value.title !== '' ? value.title : value.scope}`)
    if (value.imageIncluded === true) {
      lines.push(value.path === ''
        ? 'the screenshot is attached — you are looking at it now, and the temporary PNG was deleted (nothing left on disk)'
        : `the screenshot is attached — you are looking at it now; the temporary PNG is still on disk at ${value.path}`)
    } else {
      lines.push(`PNG saved to ${value.path}`)
      lines.push('(image not included: this model route is text-only; read the PNG with eyes_ocr for its text)')
    }
    if (value.keptPath !== '') lines.push(`permanent copy kept: ${value.keptPath}`)
    else if (value.keepError !== '') lines.push(`(permanent copy not saved: ${value.keepError})`)
  }
  const blocks = [{ type: 'text', text: [...head, '<content>', ...lines, '</content>'].join('\n') }]
  // The image block is what actually delivers the pixels; without it the text
  // above would claim an attachment that never arrives.
  if (value.imageIncluded === true && typeof value.image?.attachmentId === 'string' && value.image.attachmentId !== '') {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    })
  }
  return blocks
}

function registerGrabTool(ctx) {
  ctx.tools.register({
    name: 'eyes_grab',
    description: 'Capture the local desktop and hand the picture to you: the foreground window by default, a window matched by title, the whole virtual screen, or an explicit region. Use it when the user says "look at this" without attaching an image (the Web GUI, a dialog, an error in another app) or when you need to see the result of something you just did. Pass scope:"list" first to see which windows exist, then scope:"window" with a title (or no title for the foreground window). The PNG is not kept: with image input the screenshot is attached to the result and the temporary file is deleted immediately, leaving nothing on disk (pass keep:true for a permanent pics/ copy). On a text-only route the PNG stays under the workspace renders/ directory so eyes_ocr can read it. Capturing is a screen recording of whatever is visible: use it only when the task actually needs to see the screen.',
    parameters: GRAB_PARAMETERS_SCHEMA,
    output: { schema: GRAB_OUTPUT_SCHEMA, render: (_args, value) => grabBlocks(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const scope = typeof args?.scope === 'string' ? args.scope : 'window'
      if (!['window', 'screen', 'region', 'list'].includes(scope)) {
        throw new Error(`eyes_grab: "scope" must be one of window, screen, region, list (got "${scope}")`)
      }

      if (scope === 'list') {
        const listed = await runGrab(null, { scope: 'list' }, exec.signal)
        return {
          ok: listed.ok === true,
          scope: 'list',
          path: '',
          width: 0,
          height: 0,
          title: '',
          process: '',
          bounds: { x: 0, y: 0, w: 0, h: 0 },
          windows: normalizeWindows(listed.windows),
          imageIncluded: false,
          image: EMPTY_IMAGE,
          error: typeof listed.error === 'string' ? listed.error : '',
          keptPath: '',
          keepError: '',
        }
      }

      const root = await resolveWorkspaceRoot(ctx, exec)
      if (root === null) throw new Error('eyes_grab: no workspace root available')
      const dir = join(root, 'renders')
      const normalizedRoot = normalize(root) + sep
      if (!normalize(dir).startsWith(normalizedRoot)) throw new Error('eyes_grab: workspace root containment check failed')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `grab-${String(exec.callId)}.png`)

      const captured = await runGrab(
        file,
        { scope, title: typeof args?.title === 'string' ? args.title : '', x: args?.x, y: args?.y, w: args?.w, h: args?.h },
        exec.signal,
      )
      if (captured.ok !== true) {
        throw new Error(`eyes_grab: ${typeof captured.error === 'string' && captured.error !== '' ? captured.error : 'capture failed'}`)
      }

      let bytes
      try {
        bytes = await readFile(file)
      } catch (error) {
        throw new Error(`eyes_grab: the capture reported success but the PNG is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!isPng(bytes)) throw new Error('eyes_grab: the capture did not produce a valid PNG')

      const byteCap = Math.min(ctx.attachments.imageLimits.maxImageBytes, ctx.attachments.imageLimits.maxMessageImageBytes)
      if (bytes.length > byteCap) {
        throw new Error(`eyes_grab: captured PNG is ${bytes.length} bytes, exceeding the ${byteCap}-byte image limit; capture a smaller region`)
      }

      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: `grab-${String(exec.callId)}.png` })
      const imageCapable = await imageCapableRoute(ctx, exec)

      let keptPath = ''
      let keepError = ''
      if (args?.keep === true) {
        const kept = await saveDurableCopy(ctx, exec, bytes, `grab-${String(exec.callId)}.png`)
        keptPath = kept.path ?? ''
        keepError = kept.error
      }

      // The screenshot reaches the model through the attachment, so the PNG
      // under renders/ is only a courier between grab.ps1 and that attachment.
      // Once the image is attached there is nothing left to read on disk, so
      // delete the courier right away instead of leaving a burn-on-read file
      // behind. On a text-only route the file stays, because eyes_ocr /
      // eyes_analyze still need a path to work from.
      const cleanup = imageCapable
        ? await deleteAfterRead(ctx, exec, file)
        : { deleted: false, error: '' }

      return {
        ok: true,
        scope,
        path: cleanup.deleted ? '' : file,
        width: Number.isFinite(ref.width) && ref.width > 0 ? ref.width : (captured.width ?? 0),
        height: Number.isFinite(ref.height) && ref.height > 0 ? ref.height : (captured.height ?? 0),
        title: typeof captured.title === 'string' ? captured.title : '',
        process: typeof captured.process === 'string' ? captured.process : '',
        bounds: {
          x: Number(captured.bounds?.x ?? 0),
          y: Number(captured.bounds?.y ?? 0),
          w: Number(captured.bounds?.w ?? 0),
          h: Number(captured.bounds?.h ?? 0),
        },
        windows: normalizeWindows(captured.windows),
        imageIncluded: imageCapable,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
        error: '',
        keptPath,
        keepError,
      }
    },
    presentCall(args) {
      const scope = typeof args?.scope === 'string' ? args.scope : 'window'
      return { card: 'generic', title: scope === 'list' ? 'List windows' : `Capture ${scope}`, kind: 'other' }
    },
  })
}

/**
 * POST upload route — receives the browser-delivered PNG (canvas render or
 * clipboard paste) and resolves the waiting tool call by call id.
 */
function mountUploadRoute(ctx, path) {
  return ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request, MAX_RENDER_BYTES)
      } catch {
        sendJson(response, 400, { error: 'invalid or oversized request body' })
        return
      }
      const callId = typeof body?.callId === 'string' ? body.callId : null
      const entry = callId !== null ? pending.get(callId) : undefined
      if (entry === undefined) {
        sendJson(response, 404, { error: 'unknown or expired tool call' })
        return
      }
      // Client-side failure (e.g. mermaid could not load/render): fail the tool
      // call with the browser's message instead of waiting out the timeout.
      const clientError = typeof body?.error === 'string' && body.error.trim() !== '' ? body.error.trim() : null
      if (clientError !== null) {
        pending.delete(callId)
        clearTimeout(entry.timer)
        entry.signal?.removeEventListener?.('abort', entry.onAbort)
        entry.reject(new Error(clientError))
        sendJson(response, 200, { ok: true })
        return
      }
      const b64 = typeof body?.pngBase64 === 'string' ? body.pngBase64 : ''
      if (b64.length === 0) {
        sendJson(response, 400, { error: 'missing pngBase64' })
        return
      }
      const bytes = Buffer.from(b64, 'base64')
      if (bytes.length === 0 || !isPng(bytes)) {
        sendJson(response, 400, { error: 'invalid PNG data' })
        return
      }
      if (bytes.length > MAX_RENDER_BYTES) {
        sendJson(response, 413, { error: 'rendered PNG too large' })
        return
      }
      pending.delete(callId)
      clearTimeout(entry.timer)
      entry.signal?.removeEventListener?.('abort', entry.onAbort)
      entry.resolve({
        bytes,
        width: Number.isFinite(Number(body?.width)) ? Math.round(Number(body.width)) : undefined,
        height: Number.isFinite(Number(body?.height)) ? Math.round(Number(body.height)) : undefined,
      })
      sendJson(response, 200, { ok: true })
    },
  })
}

/**
 * Serve a locally installed mermaid.min.js (e.g. `npm i mermaid@11` inside the
 * plugin dir) so mermaid diagrams can render fully offline. When absent the
 * route 404s and the browser client falls back to the CDN.
 */
function mountMermaidRoute(ctx) {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/eyes/mermaid.min.js',
    handler: async (_request, response) => {
      try {
        const candidates = [
          fileURLToPath(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url)),
          fileURLToPath(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url)),
        ]
        let served = false
        for (const file of candidates) {
          try {
            const data = await readFile(file)
            response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' })
            response.end(data)
            served = true
            break
          } catch {
            // try the next candidate
          }
        }
        if (!served) {
          response.writeHead(404)
          response.end()
        }
      } catch {
        response.writeHead(500)
        response.end()
      }
    },
  })
}

export function apply(ctx) {
  ctx.inject(['attachments'], (imageCtx) => {
    registerEyesTool(imageCtx)
    registerOcrTool(imageCtx)
    registerAnalyzeTool(imageCtx)
    registerPasteTool(imageCtx)
    registerGrabTool(imageCtx)
    registerLmstudioTool(imageCtx)
  })
  ctx.inject(['webServer'], (hostCtx) => {
    ctx.effect(() => {
      const cleanups = [
        mountUploadRoute(hostCtx, '/eyes/render'),
        mountUploadRoute(hostCtx, '/eyes/paste'),
        mountMermaidRoute(hostCtx),
      ]
      return () => cleanups.forEach((dispose) => dispose?.())
    }, 'dsh-omni-vision: /eyes/render + /eyes/paste + /eyes/mermaid.min.js routes')
  })
  ctx.systemPrompt.section({
    name: 'tool:eyes',
    order: 102,
    text: "You have six perception tools, and the current model can see images directly — reach for that before working around it. eyes_grab: capture the local desktop — the foreground window by default, a window matched by title, the whole virtual screen, or an explicit region; run scope:\"list\" first when you do not know which window matters. It is the answer to \"look at this\" with no attachment (the Web GUI, a dialog, an error in another app), and to checking the result of something you just did; when the model accepts image input the screenshot comes back attached, so you see it in the same turn. eyes_render: draw text and shapes (text, line, arrow, rect, circle, ellipse, path, arc, clear, or a mermaid source for flowcharts) on a canvas card in the Web GUI and return the PNG. Drawing is how you show the user something; with image input you also see your own output in the same turn, so you can correct it. eyes_paste: ask the user to drag or Ctrl+V an image into the page when they want to hand you a file that is neither on screen nor on disk (the composer takes images itself, so this is mostly for an explicit paste card); the PNG is attached, not left on disk. eyes_ocr: local Windows OCR (offline) — the cheap path when you only need the text of an image to quote or search, rather than looking at the whole picture. eyes_analyze: pixel grid, dominant colors and content box — an offline fallback for when no vision route is available or you genuinely need numbers about pixels. eyes_lmstudio: the owner's local LM Studio server (default http://127.0.0.1:1234) for fully offline vision. File life: only eyes_render leaves something behind — a permanent copy under pics/ (reported as keptPath). eyes_grab and eyes_paste attach the picture and delete their temporary PNG right away, so a screenshot or a paste leaves no file behind; pass keep:true on eyes_grab for a permanent pics/ copy. Use these tools whenever the task needs to look at, produce, or talk about an image.",
  })
}
