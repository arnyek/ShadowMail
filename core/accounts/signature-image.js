// SPDX-License-Identifier: GPL-3.0-or-later
// The signature image of an account: its type from the file's own header (never from the name), its metadata removed
// LOSSLESSLY (the pixels and the color information stay byte for byte), and the limits checked. No resizing and no
// re-encoding. Pure: no file access, no Electron; the decoding check (Electron nativeImage) is passed in by the caller.
//
// Both formats keep a WHITE LIST, everything else carrying no pixels goes (a new metadata kind, e.g. C2PA, cannot slip by):
//   JPEG: every segment up to the first EOI is walked, the ones between the scans too (a progressive file). Kept: the
//         structural segments (SOFn, DHT, DAC, DQT, DNL, DRI, SOS), APP0 only as "JFIF\0", APP2 only as "ICC_PROFILE\0",
//         APP14 only as "Adobe"; every other APPn (Exif, XMP, MPF, JFXX, IPTC, JUMBF/C2PA...) and COM are left out; another
//         marker is refused. The scans' entropy-coded data is copied byte for byte; what follows the first EOI (an
//         appended preview or depth image, with its own Exif) is not the shown image and is left out. An Exif Orientation
//         other than 1 is refused (without the flag the image would show turned).
//   PNG:  the chunks are walked with their CRC. Kept: IHDR, PLTE, IDAT, IEND and the color ones (tRNS, gAMA, cHRM, sRGB,
//         iCCP, sBIT, bKGD) and pHYs, each with its own CRC; every other ancillary chunk (tEXt, eXIf, caBX...) is left
//         out; an unknown critical chunk (an upper-case first letter) is refused, as the decoder could not show the image.
//         An animated PNG (acTL) is refused BEFORE the white list would drop it; an eXIf Orientation other than 1 is
//         refused as in a JPEG (the browser applies it).
// A structure that does not walk cleanly is refused (`unsupported_image`), never an exception of another kind.
import zlib from 'node:zlib'

export const SIGNATURE_LIMITS = Object.freeze({ maxWidth: 800, maxHeight: 400, maxBytes: 150 * 1024 })
export const SIGNATURE_TYPES = Object.freeze(['image/png', 'image/jpeg'])

export class SignatureImageError extends Error {
  constructor(code, info = {}) {
    super(code)
    this.code = code
    this.info = info
  }
}
const unsupported = () => new SignatureImageError('unsupported_image')

/**
 * THE rule for an Exif Orientation other than 1 (the pixels are kept turned and show upright only by the flag), in ONE
 * place for the signature image and a pasted image (the owner's decision): the cleaned image is turned upright in its pixels by
 * the caller's `upright(bytes, type, orientation)` (Electron nativeImage in the app: decoded, turned
 * (core/accounts/orientation.js), encoded again: a JPEG as a JPEG of quality 92, a PNG as a PNG, losslessly) and cleaned
 * again, so it shows the same everywhere and carries no orientation. An image with Orientation 1 (or none) is not
 * touched. A value outside 1..8 shows as 1 in a browser, so it is 1 here too. MEASURED (Electron 45.3.0): nativeImage
 * does not apply an orientation by itself, and its encoders write no metadata (toJPEG: JFIF only; toPNG: IHDR, IDAT,
 * IEND), so a turned image loses its ICC profile; an image that needs no turning keeps it.
 * -> the cleaned image ({ type, bytes, width, height, removed }, with `turned`: the orientation when it was turned)
 */
// the largest image turned upright (decoded, turned, encoded in the main process): 50 megapixels, a 48 MP phone photo
// still is (measured in testing: 1.4 s, 1.24 GB); a 192 MP one took 4.5 s and 4.5 GB. Read from the header,
// BEFORE anything is decoded.
export const UPRIGHT_MAX_PIXELS = 50_000_000

function orientationRule(out, upright) {
  const { orientation, ...image } = out
  if (orientation === 1) return image
  if (image.width * image.height > UPRIGHT_MAX_PIXELS) throw new SignatureImageError('too_large', { width: image.width, height: image.height, maxPixels: UPRIGHT_MAX_PIXELS })
  if (typeof upright !== 'function') throw new TypeError('upright is required')
  let bytes
  try {
    bytes = upright(image.bytes, image.type, orientation)
  } catch {
    throw unsupported()
  }
  const turned = cleanImage(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []))
  const size = orientation >= 5 ? { width: image.height, height: image.width } : { width: image.width, height: image.height }
  if (turned.type !== image.type || turned.orientation !== 1 || turned.width !== size.width || turned.height !== size.height) throw unsupported()
  return { type: turned.type, bytes: turned.bytes, width: turned.width, height: turned.height, removed: image.removed, turned: orientation }
}
// the first orientation found wins; a value outside 1..8 is 1
const firstOrientation = (seen, value) => seen || (Number.isInteger(value) && value >= 1 && value <= 8 ? value : 1)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])
const PNG_KEEP = new Set([...PNG_CRITICAL, 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs'])
// JPEG markers: the structural ones kept (0xc0-0xcf: SOFn, DHT, JPG, DAC; DQT, DNL, DRI; SOS is handled apart), the APPn
// kept only with these identifiers; SOFn (not DHT 0xc4, JPG 0xc8, DAC 0xcc) carry the size
const JPEG_STRUCTURAL = m => (m >= 0xc0 && m <= 0xcf) || m === 0xdb || m === 0xdc || m === 0xdd
const JPEG_APP_KEEP = new Map([[0xe0, 'JFIF\u0000'], [0xe2, 'ICC_PROFILE\u0000'], [0xee, 'Adobe']])
const isApp = m => m >= 0xe0 && m <= 0xef
const isSof = m => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

/** An image the app does not put into a message's text (it goes as an attachment), from the first bytes, or null. */
export function otherImageTypeOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  const ascii = (a, b) => buf.toString('latin1', a, b)
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  }
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (ascii(0, 4) === 'II*\u0000' || ascii(0, 4) === 'MM\u0000*') return 'image/tiff'
  return null
}

/** 'image/png', 'image/jpeg' or null, from the first bytes. */
export function imageTypeOf(buf) {
  if (!Buffer.isBuffer(buf)) return null
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  return null
}

/** PNG -> { bytes, width, height, removed } without the text/time/Exif chunks. */
function stripPng(buf) {
  const keep = [PNG_SIGNATURE]
  let at = 8
  let width = 0
  let height = 0
  let removed = 0
  let first = true
  let ended = false
  let orientation = 0
  while (at < buf.length) {
    if (ended || at + 12 > buf.length) throw unsupported()
    const len = buf.readUInt32BE(at)
    if (len > 0x7fffffff || at + 12 + len > buf.length) throw unsupported()
    const type = buf.toString('latin1', at + 4, at + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) throw unsupported()
    const crc = buf.readUInt32BE(at + 8 + len)
    if (zlib.crc32(buf.subarray(at + 4, at + 8 + len)) !== crc) throw unsupported()
    if (first) {
      if (type !== 'IHDR' || len !== 13) throw unsupported()
      width = buf.readUInt32BE(at + 8)
      height = buf.readUInt32BE(at + 12)
      first = false
    }
    if (type === 'acTL') throw unsupported() // an animated PNG
    if (type === 'eXIf') {
      // the TIFF block itself; some writers put "Exif\0\0" before it
      const data = buf.subarray(at + 8, at + 8 + len)
      orientation = firstOrientation(orientation, data.length >= 6 && data.toString('latin1', 0, 6) === 'Exif\u0000\u0000' ? exifOrientation(data) : tiffOrientation(data))
    }
    if (type === 'IEND') ended = true
    if (PNG_KEEP.has(type)) keep.push(buf.subarray(at, at + 12 + len))
    else if (type.charCodeAt(0) < 0x61) throw unsupported() // an unknown critical chunk
    else removed++
    at += 12 + len
  }
  if (!ended || !width || !height) throw unsupported()
  return { bytes: Buffer.concat(keep), width, height, removed, orientation: orientation || 1 }
}

/** The Exif Orientation of an APP1 segment's data, or 1 (none). Throws on an Exif block that does not walk. */
function exifOrientation(data) {
  if (data.length < 6 || data.toString('latin1', 0, 6) !== 'Exif\u0000\u0000') return 1 // XMP or another APP1
  return tiffOrientation(data.subarray(6))
}

/** The Orientation of a TIFF block (Exif's own structure: the APP1 data after "Exif\0\0", a PNG eXIf chunk), or 1. */
function tiffOrientation(tiff) {
  if (tiff.length < 8) throw unsupported()
  const order = tiff.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') throw unsupported()
  const u16 = o => (order === 'II' ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = o => (order === 'II' ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  if (u16(2) !== 42) throw unsupported()
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) throw unsupported()
  const count = u16(ifd)
  if (ifd + 2 + count * 12 > tiff.length) throw unsupported()
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12
    if (u16(e) === 0x0112) return u16(e + 8) // Orientation, a SHORT in the value field
  }
  return 1
}

/** The end of a scan's entropy-coded data from `at`: the index of the next marker (0xFF and neither 0x00, a fill 0xFF
 * nor RSTn after it). Throws when the file ends first. */
function scanEnd(buf, at) {
  let j = at
  for (;;) {
    j = buf.indexOf(0xff, j)
    if (j < 0 || j + 1 >= buf.length) throw unsupported()
    const next = buf[j + 1]
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) j += 2 // a stuffed 0xFF or a restart marker: still the scan
    else if (next === 0xff) j += 1 // fill before the marker
    else return j
  }
}

/** JPEG -> { bytes, width, height, removed } without APP1/APP13/COM anywhere before the first EOI, and without what
 * follows it; the scans' data copied as it is. */
function stripJpeg(buf) {
  const keep = [buf.subarray(0, 2)]
  let at = 2
  let width = 0
  let height = 0
  let removed = 0
  let scans = 0
  let orientation = 0
  for (;;) {
    if (at + 2 > buf.length || buf[at] !== 0xff) throw unsupported()
    let m = buf[at + 1]
    while (m === 0xff && at + 2 < buf.length) m = buf[++at + 1] // fill bytes before a marker
    if (m === 0xd9) {
      // the first EOI: the shown image ends here; anything after it is another image or trailing data
      if (!scans) throw unsupported()
      keep.push(buf.subarray(at, at + 2))
      if (at + 2 < buf.length) removed++
      break
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || at + 4 > buf.length) throw unsupported()
    const len = buf.readUInt16BE(at + 2)
    if (len < 2 || at + 2 + len > buf.length) throw unsupported()
    const seg = buf.subarray(at, at + 2 + len)
    if (isSof(m)) {
      if (len < 8 || scans) throw unsupported() // one frame: a size after a scan is a second (hierarchical) frame
      height = buf.readUInt16BE(at + 5)
      width = buf.readUInt16BE(at + 7)
    }
    // an APP1 that is not Exif (XMP) has no say
    if (m === 0xe1 && seg.toString('latin1', 4, 10) === 'Exif\u0000\u0000') orientation = firstOrientation(orientation, exifOrientation(seg.subarray(4)))
    if (m === 0xda || JPEG_STRUCTURAL(m)) keep.push(seg)
    else if (isApp(m) && JPEG_APP_KEEP.has(m) && seg.toString('latin1', 4, 4 + JPEG_APP_KEEP.get(m).length) === JPEG_APP_KEEP.get(m)) keep.push(seg)
    else if (isApp(m) || m === 0xfe) removed++
    else throw unsupported() // DHP, EXP, JPGn, a reserved marker: not walked
    at += 2 + len
    if (m === 0xda) {
      // the scan header, then its entropy-coded data up to the next marker, byte for byte
      if (!width || !height) throw unsupported()
      scans++
      const end = scanEnd(buf, at)
      keep.push(buf.subarray(at, end))
      at = end
    }
  }
  return { bytes: Buffer.concat(keep), width, height, removed, orientation: orientation || 1 }
}

/**
 * The stored form of an uploaded file: { type, bytes, width, height, removed } (+ `turned`, see orientationRule).
 * `decode(bytes)` (the caller's decoder, Electron nativeImage in the app) -> { width, height } or null: it must decode
 * the stored bytes to the size the header says. `upright(bytes, type, orientation)` -> the bytes turned upright (only
 * called for an Orientation other than 1). Errors (SignatureImageError): unsupported_image,
 * too_large { width, height, bytes, maxWidth, maxHeight, maxBytes } (the size AFTER the metadata is removed and the
 * image is turned upright).
 */
export function prepareSignatureImage(buf, { decode, upright } = {}) {
  const kept = cleanImage(buf)
  const { maxWidth, maxHeight, maxBytes } = SIGNATURE_LIMITS
  // the upright size from the header: a too big turned photo is refused before it is decoded and turned
  const up = kept.orientation >= 5 ? { width: kept.height, height: kept.width } : { width: kept.width, height: kept.height }
  if (up.width > maxWidth || up.height > maxHeight) {
    throw new SignatureImageError('too_large', { width: up.width, height: up.height, bytes: kept.bytes.length, maxWidth, maxHeight, maxBytes })
  }
  const out = orientationRule(kept, upright)
  if (out.width > maxWidth || out.height > maxHeight || out.bytes.length > maxBytes) {
    throw new SignatureImageError('too_large', { width: out.width, height: out.height, bytes: out.bytes.length, maxWidth, maxHeight, maxBytes })
  }
  return decoded(out, decode)
}

/** A pasted (or dropped) image: at most this many bytes as it comes, before the metadata is removed. */
export const INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/**
 * A pasted or dropped image for a message's text: { type, bytes, width, height, removed } (+ `turned`), cleaned and
 * turned upright like the signature image (the same white lists, the same orientation rule) but without its size
 * limits. Errors (SignatureImageError): too_large { bytes, maxBytes } (over INLINE_IMAGE_MAX_BYTES as it comes),
 * not_inline { type } (an image the app sends as an attachment: GIF, WebP, HEIC/AVIF, BMP, TIFF), unsupported_image.
 */
export function prepareInlineImage(buf, { decode, upright } = {}) {
  if (!Buffer.isBuffer(buf)) throw unsupported()
  if (buf.length > INLINE_IMAGE_MAX_BYTES) throw new SignatureImageError('too_large', { bytes: buf.length, maxBytes: INLINE_IMAGE_MAX_BYTES })
  const other = imageTypeOf(buf) ? null : otherImageTypeOf(buf)
  if (other) throw new SignatureImageError('not_inline', { type: other })
  return decoded(orientationRule(cleanImage(buf), upright), decode)
}

/** The type and the bytes without the metadata (the white lists above); any damage is unsupported_image. */
function cleanImage(buf) {
  const type = imageTypeOf(buf)
  if (!type) throw unsupported()
  try {
    return { type, ...(type === 'image/png' ? stripPng(buf) : stripJpeg(buf)) }
  } catch (err) {
    if (err instanceof SignatureImageError) throw err
    throw unsupported() // a read past the end of a damaged file: the same refusal
  }
}

/** The cleaned image when the caller's decoder shows it at the size its header says, else unsupported_image. */
function decoded(out, decode) {
  if (typeof decode !== 'function') throw new TypeError('decode is required')
  const seen = decode(out.bytes)
  if (!seen || seen.width !== out.width || seen.height !== out.height) throw unsupported()
  return out
}
