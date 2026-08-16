/**
 * dsh-eyes host half.
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

export const name = 'dsh-eyes'

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
const COMMAND_PROPERTIES = {
  op: { type: 'string', description: 'One of: text, line, rect, circle, ellipse, clear.' },
  // text
  text: { type: 'string', description: 'Text to draw (\\n for multiple lines).' },
  x: { type: 'number', description: 'X coordinate (text baseline left, or shape origin).' },
  y: { type: 'number', description: 'Y coordinate (for text: the top of the first line\'s glyphs lands exactly here).' },
  size: { type: 'number', description: 'Font size in px for text.' },
  font: { type: 'string', description: 'Font family for text (default sans-serif).' },
  weight: { type: 'string', description: 'Font weight for text (e.g. bold).' },
  align: { type: 'string', description: 'Text align: left | center | right.' },
  maxWidth: { type: 'number', description: 'Optional max line width for text.' },
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
}

const COMMANDS_SCHEMA = {
  type: 'array',
  description: 'Drawing commands, applied in order. Each command is an object with an "op" discriminator (text | line | rect | circle | ellipse | clear) plus the fields the op needs.',
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
    background: { type: 'string', description: 'Background CSS color (default #ffffff).' },
    title: { type: 'string', description: 'Optional card title shown in the GUI.' },
    description: { type: 'string', description: 'Optional note describing what you intend to draw; included for your own reference.' },
    commands: COMMANDS_SCHEMA,
    mermaid: { type: 'string', description: 'Optional Mermaid diagram source (e.g. "graph LR\\n  A[start] --> B[process] --> C[end]"). When present, the browser renders the diagram onto the canvas and this takes precedence over commands — perfect for flowcharts / connection diagrams without hand-computing coordinates. Mermaid is loaded from a host-served local copy when installed, otherwise from CDN (needs browser network on first use).' },
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
        mediaType: { type: 'string', enum: ['image/png'] },
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
    description: 'Draw text and graphics (lines, rectangles, circles, ellipses) onto a canvas that appears in the Web GUI, then return the rendered PNG. For flowcharts / connection diagrams you do not need to compute coordinates: pass the optional "mermaid" parameter with a Mermaid diagram source (e.g. "graph LR\\n  A[start] --> B[end]") and the browser renders it onto the canvas (mermaid takes precedence over commands). The result reports the PNG file path and dimensions; the rendered PNG is saved twice — a burn-on-read copy under the workspace renders/ directory and a permanent copy under pics/ (keptPath). When the current model supports image input, the rendered image itself is attached. The browser page must be open to render.',
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
        ctx.logger?.warn?.(`[dsh-eyes] could not save rendered PNG: ${fileError}`)
      }

      // Durable copy under pics/: unlike the renders/ file (read-and-burn),
      // this one is kept permanently so the user can find the render later.
      const kept = await saveDurableCopy(ctx, exec, bytes, `eyes-${key}.png`)
      if (kept.path === null && kept.error !== '') {
        ctx.logger?.warn?.(`[dsh-eyes] could not keep rendered PNG: ${kept.error}`)
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

/** Parameter schema for eyes_paste. */
const PASTE_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hint: { type: 'string', description: 'Optional instruction shown on the paste card (what the user should paste).' },
  },
}

/** Output schema for eyes_paste. */
const PASTE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'path', 'width', 'height', 'bytes', 'fileSaved', 'fileError', 'keptPath', 'keepError', 'error'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the pasted image was saved.' },
    path: { type: 'string', description: 'Path of the saved PNG (absolute when saved).' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    fileSaved: { type: 'boolean' },
    fileError: { type: 'string', description: 'Why the PNG was not saved, when it was not (otherwise empty).' },
    keptPath: { type: 'string', description: 'Absolute path of the permanent copy kept under the workspace pics/ directory (empty when it could not be saved).' },
    keepError: { type: 'string', description: 'Why the permanent pics/ copy was not saved, when it was not (otherwise empty).' },
    error: { type: 'string', description: 'Failure reason when ok is false, otherwise empty.' },
  },
}

function pasteBlocks(value) {
  const lines = [
    '<type>paste</type>',
    `<path>${value.path}</path>`,
    '<content>',
    value.ok
      ? [
          `Pasted image saved (${value.width}x${value.height}, ${value.bytes} bytes). Read it with eyes_ocr for text or eyes_analyze for pixels.`,
          value.keptPath ? `permanent copy kept: ${value.keptPath}` : (value.keepError ? `(permanent copy not saved: ${value.keepError})` : ''),
        ].join('\n')
      : `paste failed: ${value.error}`,
    '</content>',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

function registerPasteTool(ctx) {
  ctx.tools.register({
    name: 'eyes_paste',
    description: 'Ask the user to bring an image into the Web GUI: they can drag an image file anywhere onto the page, or copy an image and press Ctrl+V while the capture card is active. The browser captures it, normalizes it to PNG, and the host saves it in the workspace. This is how a user-provided image (screenshot, photo, scan) enters the conversation on text-only model routes — the DSH composer itself cannot receive images. The saved PNG is duplicated: a burn-on-read copy under the workspace renders/ directory and a permanent copy under pics/ (keptPath). After it returns, read the saved PNG with eyes_ocr (text) or eyes_analyze (pixels). The browser page must be open (15s+60s timeout for the user to deliver the image).',
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
        ctx.logger?.warn?.(`[dsh-eyes] could not save pasted PNG: ${fileError}`)
      }
      // Durable copy under pics/: keep the pasted image even after the renders/
      // copy is burned on read.
      const kept = await saveDurableCopy(ctx, exec, bytes, `paste-${String(exec.callId)}.png`)
      if (kept.path === null && kept.error !== '') {
        ctx.logger?.warn?.(`[dsh-eyes] could not keep pasted PNG: ${kept.error}`)
      }
      return {
        ok: storedPath !== null,
        path: storedPath ?? `renders/paste-${String(exec.callId)}.png`,
        width: uploaded.width ?? 0,
        height: uploaded.height ?? 0,
        bytes: bytes.length,
        fileSaved: storedPath !== null,
        fileError,
        keptPath: kept.path ?? '',
        keepError: kept.error,
        error: fileError,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: typeof args.hint === 'string' && args.hint !== '' ? args.hint : 'Paste an image', kind: 'other' }
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
  })
  ctx.inject(['webServer'], (hostCtx) => {
    ctx.effect(() => {
      const cleanups = [
        mountUploadRoute(hostCtx, '/eyes/render'),
        mountUploadRoute(hostCtx, '/eyes/paste'),
        mountMermaidRoute(hostCtx),
      ]
      return () => cleanups.forEach((dispose) => dispose?.())
    }, 'dsh-eyes: /eyes/render + /eyes/paste + /eyes/mermaid.min.js routes')
  })
  ctx.systemPrompt.section({
    name: 'tool:eyes',
    order: 102,
    text: 'You have four perception tools. eyes_render: draw text and shapes on a canvas that appears in the Web GUI, or pass the "mermaid" parameter with a Mermaid diagram source (e.g. "graph LR\\n  A[start] --> B[end]") to draw flowcharts / connection diagrams without hand-computing coordinates; the result reports the PNG path and, when your model supports image input, shows you the image — but on a text-only route (like DeepSeek) you only get the path, so use the other tools to actually "see". eyes_paste: ask the user to paste an image (Ctrl+V) so it enters the conversation as a PNG in the workspace — this is how user-provided images (screenshots, photos) get in, since the DSH composer cannot receive images; then read the returned path with eyes_ocr/eyes_analyze. eyes_ocr: read text from any PNG via the local Windows OCR engine (fully offline) — pass the absolute path and recognized lines come back as text you can quote (useful to read back node labels from a mermaid diagram). eyes_analyze: inspect a PNG as pixel data (color grid, dominant colors, content bounding box) to perceive shapes, colors and layout without vision. Every PNG the plugin produces (render or paste) is saved twice: a copy under the workspace renders/ directory that is deleted automatically after being read (read-and-burn, the result reports fileDeleted), and a permanent copy under the workspace pics/ directory (the result reports keptPath) that survives for the user to keep. Use these tools whenever you need to produce, receive, or verify visual output.',
  })
}
