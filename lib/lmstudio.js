/**
 * dsh-omni-vision lmstudio client — the host half of `eyes_lmstudio`.
 *
 * Talks to a local LM Studio server (https://lmstudio.ai) through its
 * OpenAI-compatible REST API. Everything stays on the user's machine: the
 * request is POSTed to `http://127.0.0.1:1234/v1/chat/completions` and no
 * bytes leave the host. This is a personal extension of dsh-omni-vision (only used
 * by the repo owner) and is deliberately NOT part of the published plugin.
 */
import { readFile, stat } from 'node:fs/promises'

export const LMSTUDIO_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:1234',
  model: 'minicpm-v-4.6-thinking',
  maxTokens: 512,
  temperature: 0.2,
  /** Generous window: local inference on a thinking VLM can be slow. */
  timeoutMs: 180_000,
}

/** Upper bound on a single attached image (base64 inflates by ~1.33x). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Call the LM Studio chat-completions endpoint.
 *
 * @param {object} opts
 * @param {string} opts.prompt            User text (the question/instruction).
 * @param {string|null} [opts.imagePath]  Absolute path of a PNG to attach as
 *                                        vision input; omit for text-only.
 * @param {string} [opts.baseUrl]         Server root, e.g. http://127.0.0.1:1234
 * @param {string} [opts.model]           Model id as listed by GET /v1/models.
 * @param {number} [opts.maxTokens]       Max completion tokens.
 * @param {number} [opts.temperature]     Sampling temperature.
 * @param {number} [opts.timeoutMs]       Overall request timeout.
 * @param {AbortSignal} [opts.signal]     Caller cancellation (tool exec signal).
 * @returns {Promise<object>} Resolves with
 *   { ok, text, model, promptTokens, completionTokens, latencyMs, error }
 *   and never rejects for transport/HTTP failures (only for programmer error).
 */
export async function callLmstudio(opts) {
  const baseUrl = String(opts?.baseUrl ?? LMSTUDIO_DEFAULTS.baseUrl).replace(/\/+$/, '')
  const model = String(opts?.model ?? LMSTUDIO_DEFAULTS.model)
  const prompt = String(opts?.prompt ?? '').trim()
  const maxTokens = Number.isFinite(Number(opts?.maxTokens))
    ? Math.max(1, Math.round(Number(opts.maxTokens)))
    : LMSTUDIO_DEFAULTS.maxTokens
  const temperature = Number.isFinite(Number(opts?.temperature))
    ? Number(opts.temperature)
    : LMSTUDIO_DEFAULTS.temperature
  const timeoutMs = Number.isFinite(Number(opts?.timeoutMs))
    ? Math.max(1_000, Math.round(Number(opts.timeoutMs)))
    : LMSTUDIO_DEFAULTS.timeoutMs

  if (prompt.length === 0) {
    return { ok: false, text: '', model, promptTokens: 0, completionTokens: 0, latencyMs: 0, error: 'eyes_lmstudio: "prompt" is required' }
  }

  let imageError = ''
  let content
  if (typeof opts?.imagePath === 'string' && opts.imagePath.trim() !== '') {
    const imagePath = opts.imagePath.trim()
    try {
      const info = await stat(imagePath)
      if (info.size > MAX_IMAGE_BYTES) {
        imageError = `image is ${info.size} bytes, exceeding the ${MAX_IMAGE_BYTES}-byte limit`
      } else {
        const bytes = await readFile(imagePath)
        const b64 = bytes.toString('base64')
        const mediaType = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg' : 'image/png'
        content = [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
        ]
      }
    } catch (error) {
      imageError = `cannot read image "${imagePath}": ${error instanceof Error ? error.message : String(error)}`
    }
    if (imageError !== '') {
      return { ok: false, text: '', model, promptTokens: 0, completionTokens: 0, latencyMs: 0, error: imageError }
    }
  } else {
    content = prompt
  }

  if (typeof fetch !== 'function') {
    return { ok: false, text: '', model, promptTokens: 0, completionTokens: 0, latencyMs: 0, error: 'eyes_lmstudio: this Node runtime has no global fetch' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('lmstudio timeout')), timeoutMs)
  const onAbort = () => controller.abort()
  opts?.signal?.addEventListener?.('abort', onAbort, { once: true })

  const startedAt = Date.now()
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - startedAt
    const raw = await response.text()
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
    if (!response.ok) {
      const detail = body?.error?.message ?? body?.error ?? (raw.length > 0 ? raw.slice(0, 300) : `HTTP ${response.status}`)
      return {
        ok: false,
        text: '',
        model,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs,
        error: `LM Studio returned HTTP ${response.status}: ${String(detail).slice(0, 500)}`,
      }
    }
    const choice = body?.choices?.[0]
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
    const usage = body?.usage ?? {}
    return {
      ok: true,
      text,
      model: body?.model ?? model,
      promptTokens: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : 0,
      completionTokens: Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : 0,
      latencyMs,
      error: '',
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    if (opts?.signal?.aborted === true) {
      return { ok: false, text: '', model, promptTokens: 0, completionTokens: 0, latencyMs, error: 'eyes_lmstudio: aborted before the model replied' }
    }
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = /timeout/i.test(message) || (controller.signal.aborted && message === 'This operation was aborted')
    return {
      ok: false,
      text: '',
      model,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs,
      error: timedOut
        ? `LM Studio did not reply within ${Math.round(timeoutMs / 1000)}s. The local model may be busy, slow to load, or not running. Start LM Studio, open Developer > Local Server, and load the model (Status: Running).`
        : `LM Studio request failed: ${message}. Is the local server running at ${baseUrl} (LM Studio > Developer > Local Server)?`,
    }
  } finally {
    clearTimeout(timer)
    opts?.signal?.removeEventListener?.('abort', onAbort)
  }
}
