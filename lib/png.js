/**
 * dsh-eyes: minimal PNG decoder + analyzer (fully local, zero dependencies).
 *
 * decodePng supports 8-bit RGB/RGBA, non-interlaced PNGs — exactly what the
 * canvas renderer produces and what typical screenshots use. analyzePng turns
 * the pixels into structured data (color grid, dominant colors, content
 * bounding box) so a text-only model can "see" graphics.
 */
import { inflateSync } from 'node:zlib'

export class PngUnsupportedError extends Error {}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function decodePng(buffer) {
  if (!(buffer instanceof Uint8Array)) buffer = new Uint8Array(buffer)
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) throw new PngUnsupportedError('not a PNG file')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let seenIhdr = false
  const idat = []

  const readU32 = (o) =>
    ((buffer[o] << 24) | (buffer[o + 1] << 16) | (buffer[o + 2] << 8) | buffer[o + 3]) >>> 0

  while (offset + 8 <= buffer.length) {
    const length = readU32(offset)
    const type = String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7])
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new PngUnsupportedError('truncated PNG chunk')
    if (type === 'IHDR') {
      if (length < 13) throw new PngUnsupportedError('bad IHDR chunk')
      width = readU32(dataStart)
      height = readU32(dataStart + 4)
      bitDepth = buffer[dataStart + 8]
      colorType = buffer[dataStart + 9]
      const compression = buffer[dataStart + 10]
      const filter = buffer[dataStart + 11]
      interlace = buffer[dataStart + 12]
      if (compression !== 0 || filter !== 0) throw new PngUnsupportedError('unsupported PNG compression/filter method')
      seenIhdr = true
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4 // skip CRC
  }
  if (!seenIhdr) throw new PngUnsupportedError('missing IHDR chunk')
  if (bitDepth !== 8) throw new PngUnsupportedError(`unsupported bit depth ${bitDepth} (only 8-bit)`)
  if (colorType === 6) {
    // RGBA
  } else if (colorType === 2) {
    // RGB
  } else {
    throw new PngUnsupportedError(`unsupported color type ${colorType} (only RGB/RGBA)`)
  }
  if (interlace !== 0) throw new PngUnsupportedError('interlaced PNG not supported')
  if (width === 0 || height === 0) throw new PngUnsupportedError('empty PNG dimensions')

  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const expected = (stride + 1) * height
  if (raw.length !== expected) {
    throw new PngUnsupportedError(`bad scanline data (${raw.length} bytes, expected ${expected})`)
  }

  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }

  for (let row = 0; row < height; row++) {
    const filterType = raw[row * (stride + 1)]
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    const cur = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const x = line[i]
      const left = i >= channels ? cur[i - channels] : 0
      const up = prev[i]
      const upLeft = i >= channels ? prev[i - channels] : 0
      let v
      switch (filterType) {
        case 0: v = x; break
        case 1: v = x + left; break
        case 2: v = x + up; break
        case 3: v = x + ((left + up) >> 1); break
        case 4: v = x + paeth(left, up, upLeft); break
        default: throw new PngUnsupportedError(`unknown filter type ${filterType}`)
      }
      cur[i] = v & 0xff
    }
    for (let i = 0; i < stride; i += channels) {
      const o = (row * width + (i / channels)) * 4
      out[o] = cur[i]
      out[o + 1] = cur[i + 1]
      out[o + 2] = cur[i + 2]
      out[o + 3] = channels === 4 ? cur[i + 3] : 255
    }
    prev = cur
  }

  return { width, height, rgba: out }
}

function hex8(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * Turn decoded pixels into structured data a text-only model can reason about.
 * Options: grid (NxN sampling grid, 2-32, default 8), maxColors (1-16, default 6).
 */
export function analyzePng(image, options = {}) {
  const grid = Math.max(2, Math.min(32, Math.round(options.grid ?? 8)))
  const maxColors = Math.max(1, Math.min(16, Math.round(options.maxColors ?? 6)))
  const { width, height, rgba } = image

  const gridCells = []
  for (let gx = 0; gx < grid; gx++) {
    for (let gy = 0; gy < grid; gy++) {
      const x0 = Math.floor((gx / grid) * width)
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / grid) * width))
      const y0 = Math.floor((gy / grid) * height)
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / grid) * height))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * width + x) * 4
          r += rgba[o]
          g += rgba[o + 1]
          b += rgba[o + 2]
          a += rgba[o + 3]
          n++
        }
      }
      if (n === 0) continue
      r = Math.round(r / n)
      g = Math.round(g / n)
      b = Math.round(b / n)
      gridCells.push({ col: gx, row: gy, r, g, b, hex: hex8(r, g, b), alpha: Math.round(a / n) })
    }
  }

  const hist = new Map()
  const total = width * height
  for (let i = 0; i < total; i++) {
    const o = i * 4
    if (rgba[o + 3] < 128) continue // skip transparent pixels
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3)
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }
  const dominantColors = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxColors)
    .map(([key, count]) => {
      const r = (key >> 10) & 31
      const g = (key >> 5) & 31
      const b = key & 31
      const r8 = (r << 3) | (r >> 2)
      const g8 = (g << 3) | (g >> 2)
      const b8 = (b << 3) | (b >> 2)
      return { hex: hex8(r8, g8, b8), share: Math.round((count / total) * 1000) / 1000, count }
    })

  // Bounding box of pixels that differ from the top-left background color.
  const bg = { r: rgba[0], g: rgba[1], b: rgba[2] }
  const TOL = 24
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (
        Math.abs(rgba[o] - bg.r) > TOL ||
        Math.abs(rgba[o + 1] - bg.g) > TOL ||
        Math.abs(rgba[o + 2] - bg.b) > TOL
      ) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const contentBox =
    maxX >= minX ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : { x: 0, y: 0, w: 0, h: 0 }

  return { width, height, gridCells, dominantColors, contentBox }
}
