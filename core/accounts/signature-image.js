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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])
const PNG_KEEP = new Set([...PNG_CRITICAL, 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs'])
// JPEG markers: the structural ones kept (0xc0-0xcf: SOFn, DHT, JPG, DAC; DQT, DNL, DRI; SOS is handled apart), the APPn
// kept only with these identifiers; SOFn (not DHT 0xc4, JPG 0xc8, DAC 0xcc) carry the size
const JPEG_STRUCTURAL = m => (m >= 0xc0 && m <= 0xcf) || m === 0xdb || m === 0xdc || m === 0xdd
const JPEG_APP_KEEP = new Map([[0xe0, 'JFIF\u0000'], [0xe2, 'ICC_PROFILE\u0000'], [0xee, 'Adobe']])
const isApp = m => m >= 0xe0 && m <= 0xef
const isSof = m => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

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
      const orientation = data.length >= 6 && data.toString('latin1', 0, 6) === 'Exif\u0000\u0000' ? exifOrientation(data) : tiffOrientation(data)
      if (orientation !== 1) throw new SignatureImageError('rotated_image', { orientation })
    }
    if (type === 'IEND') ended = true
    if (PNG_KEEP.has(type)) keep.push(buf.subarray(at, at + 12 + len))
    else if (type.charCodeAt(0) < 0x61) throw unsupported() // an unknown critical chunk
    else removed++
    at += 12 + len
  }
  if (!ended || !width || !height) throw unsupported()
  return { bytes: Buffer.concat(keep), width, height, removed }
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
    if (m === 0xe1) {
      const orientation = exifOrientation(seg.subarray(4))
      if (orientation !== 1) throw new SignatureImageError('rotated_image', { orientation })
    }
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
  return { bytes: Buffer.concat(keep), width, height, removed }
}

/**
 * The stored form of an uploaded file: { type, bytes, width, height, removed }. `decode(bytes)` (the caller's
 * decoder, Electron nativeImage in the app) -> { width, height } or null: it must decode the stored bytes to the size the
 * header says. Errors (SignatureImageError): unsupported_image, rotated_image { orientation },
 * too_large { width, height, bytes, maxWidth, maxHeight, maxBytes } (the size AFTER the metadata is removed).
 */
export function prepareSignatureImage(buf, { decode } = {}) {
  const type = imageTypeOf(buf)
  if (!type) throw unsupported()
  let out
  try {
    out = type === 'image/png' ? stripPng(buf) : stripJpeg(buf)
  } catch (err) {
    if (err instanceof SignatureImageError) throw err
    throw unsupported() // a read past the end of a damaged file: the same refusal
  }
  const { maxWidth, maxHeight, maxBytes } = SIGNATURE_LIMITS
  if (out.width > maxWidth || out.height > maxHeight || out.bytes.length > maxBytes) {
    throw new SignatureImageError('too_large', { width: out.width, height: out.height, bytes: out.bytes.length, maxWidth, maxHeight, maxBytes })
  }
  if (typeof decode !== 'function') throw new TypeError('decode is required')
  const seen = decode(out.bytes)
  if (!seen || seen.width !== out.width || seen.height !== out.height) throw unsupported()
  return { type, ...out }
}
