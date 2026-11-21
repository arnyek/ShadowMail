// SPDX-License-Identifier: GPL-3.0-or-later
// A pasted image, the pure part (core/accounts/signature-image.js prepareInlineImage): PNG and JPEG are taken, cleaned
// like the signature image (an Exif-GPS block goes, the pixels stay byte for byte), turned upright by the same rule; at most
// 50 MP by the header (turned or not), 10 MB as it comes; GIF / WebP / HEIC / BMP / TIFF are for the attachments (not_inline); an animated
// PNG, an SVG and a damaged file are refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareInlineImage, prepareSignatureImage, otherImageTypeOf, INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_MAX_PIXELS, SignatureImageError } from '../core/accounts/signature-image.js'
import { pngFile, jpegFile, chunk, headerDecode, JPEG_SCAN_DATA } from './helpers/inline-images.js'
import { hu } from '../app/renderer/i18n/hu.js'
import { en } from '../app/renderer/i18n/en.js'

const prep = (buf, decode = headerDecode) => prepareInlineImage(buf, { decode })
// the app's upright-turner stands in: a clean image of the turned size
const fakeUpright = (bytes, type, orientation) => {
  const { width, height } = headerDecode(bytes)
  return type === 'image/png' ? pngFile(orientation >= 5 ? height : width, orientation >= 5 ? width : height) : jpegFile(orientation >= 5 ? height : width, orientation >= 5 ? width : height)
}
// a PNG whose header says w x h with a token IDAT: only the header matters before decoding (pngFile would build every row)
const pngHeader = (w, h) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([pngFile(1, 1).subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND')])
}
const code = (fn, want, info) => assert.throws(fn, err => err instanceof SignatureImageError && err.code === want && (!info || Object.entries(info).every(([k, v]) => err.info[k] === v)))

test('PNG and JPEG are taken with their size; no signature limit (a 1600 px wide image too)', () => {
  const p = prep(pngFile(1600, 40))
  assert.deepEqual([p.type, p.width, p.height], ['image/png', 1600, 40])
  const j = prep(jpegFile(640, 480))
  assert.deepEqual([j.type, j.width, j.height], ['image/jpeg', 640, 480])
})

test('an Exif-GPS JPEG: the GPS block goes byte for byte, the scan (the pixels) stays byte for byte', () => {
  const src = jpegFile(320, 200, { exif: 1 })
  assert.ok(src.includes(Buffer.from('GPS 47.49N', 'latin1')))
  const out = prep(src)
  assert.ok(!out.bytes.includes(Buffer.from('GPS', 'latin1')), 'no GPS text left')
  assert.ok(!out.bytes.includes(Buffer.from('Exif', 'latin1')), 'no Exif block left')
  assert.ok(out.bytes.includes(JPEG_SCAN_DATA), 'the scan data unchanged')
  assert.ok(out.bytes.equals(jpegFile(320, 200)), 'exactly the file without the Exif block')
  assert.equal(out.removed, 1)
})

test('a PNG text chunk goes; the image data stays', () => {
  const out = prep(pngFile(50, 20, { before: [chunk('tEXt', Buffer.from('Author\0Kovacs Arpad', 'latin1'))] }))
  assert.ok(out.bytes.equals(pngFile(50, 20)))
})

test('a turned photo (Exif Orientation 6): turned upright, the same rule as the signature image, no size limit', () => {
  const out = prepareInlineImage(jpegFile(3200, 2000, { exif: 6 }), { decode: headerDecode, upright: fakeUpright })
  assert.deepEqual([out.type, out.width, out.height, out.turned], ['image/jpeg', 2000, 3200, 6])
  assert.ok(!out.bytes.includes(Buffer.from('GPS', 'latin1')))
})

test('turning has a pixel limit read from the header: over 50 MP refused before the turner runs; a 48 MP photo turns', () => {
  let calls = 0
  const counting = (...a) => (calls++, fakeUpright(...a))
  assert.throws(() => prepareInlineImage(jpegFile(16000, 12000, { exif: 6 }), { decode: headerDecode, upright: counting }), err => err instanceof SignatureImageError && err.code === 'too_large' && err.info.maxPixels === 50_000_000 && err.info.width === 16000 && err.info.turned === true)
  assert.equal(calls, 0, 'never decoded, never turned')
  assert.equal(prepareInlineImage(jpegFile(8000, 6000, { exif: 6 }), { decode: headerDecode, upright: counting }).turned, 6)
  assert.equal(calls, 1)
})

test('an image that needs no turning has the same pixel limit, read from the header BEFORE the decoder runs (PNG and JPEG)', () => {
  assert.equal(INLINE_IMAGE_MAX_PIXELS, 50_000_000)
  let decodes = 0
  const counting = buf => (decodes++, headerDecode(buf))
  const big = [jpegFile(16000, 12000), pngHeader(16000, 12000), jpegFile(10000, 5001), pngHeader(50_000_001, 1)]
  for (const buf of big) {
    assert.throws(() => prepareInlineImage(buf, { decode: counting }), err => err instanceof SignatureImageError && err.code === 'too_large' && err.info.maxPixels === 50_000_000 && err.info.turned === false && err.info.width * err.info.height > 50_000_000)
  }
  assert.equal(decodes, 0, 'never decoded')
  // exactly at the limit: taken (the limit is "at most"), the decoder runs once each
  assert.equal(prepareInlineImage(jpegFile(10000, 5000), { decode: counting }).width, 10000)
  assert.equal(prepareInlineImage(pngHeader(10000, 5000), { decode: counting }).height, 5000)
  assert.equal(decodes, 2)
  // a turned photo carrying Orientation 1 is not "turned": the plain message
  assert.throws(() => prepareInlineImage(jpegFile(16000, 12000, { exif: 1 }), { decode: counting }), err => err.code === 'too_large' && err.info.turned === false)
})

test('the pixel-limit message: a turned photo keeps its turning text, an unturned image gets its own (both languages)', () => {
  for (const dict of [hu, en]) {
    const d = { width: 16000, height: 12000, maxPixels: 50_000_000 }
    const turned = dict.composeImageError('too_large', { ...d, turned: true })
    const plain = dict.composeImageError('too_large', { ...d, turned: false })
    assert.notEqual(turned, plain)
    for (const text of [turned, plain]) assert.ok(text.includes('192') && text.includes('50'), text)
    assert.ok(dict === hu ? turned.includes('elforgatott') && !plain.includes('elforgatott') : turned.includes('turned') && !plain.includes('turned'), plain)
  }
})

test('the signature image keeps its own limits (800 x 400 before anything else), untouched by the inline pixel limit', () => {
  const sig = (buf, upright) => prepareSignatureImage(buf, { decode: headerDecode, upright })
  assert.throws(() => sig(jpegFile(16000, 12000)), err => err.code === 'too_large' && err.info.maxWidth === 800 && err.info.maxPixels === undefined)
  assert.equal(sig(pngFile(800, 400)).width, 800)
})

test('refused: an animated PNG, an SVG, a damaged file, a size the decoder does not confirm', () => {
  code(() => prep(pngFile(20, 20, { before: [chunk('acTL', Buffer.alloc(8))] })), 'unsupported_image')
  code(() => prep(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>')), 'unsupported_image')
  const png = pngFile(20, 20)
  code(() => prep(png.subarray(0, png.length - 5)), 'unsupported_image')
  code(() => prep(png, () => ({ width: 19, height: 20 })), 'unsupported_image')
  code(() => prep(png, () => null), 'unsupported_image')
  assert.throws(() => prepareInlineImage(png), TypeError, 'a decoder is required')
})

test('GIF, WebP, HEIC, AVIF, BMP, TIFF: not_inline with the type (the editor attaches them)', () => {
  const pad = b => Buffer.concat([Buffer.from(b, 'latin1'), Buffer.alloc(32)])
  const cases = [
    [pad('GIF89a'), 'image/gif'],
    [pad('GIF87a'), 'image/gif'],
    [pad('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    [pad('\0\0\0\x18ftypheic'), 'image/heic'],
    [pad('\0\0\0\x18ftypmif1'), 'image/heic'],
    [pad('\0\0\0\x18ftypavif'), 'image/avif'],
    [pad('BM'), 'image/bmp'],
    [pad('II*\0'), 'image/tiff'],
  ]
  for (const [buf, type] of cases) {
    assert.equal(otherImageTypeOf(buf), type)
    code(() => prep(buf), 'not_inline', { type })
  }
  assert.equal(otherImageTypeOf(pngFile(5, 5)), null)
})

test('10 MB as it comes: 10 MB + 1 byte is too_large before any parsing', () => {
  const big = Buffer.concat([pngFile(5, 5), Buffer.alloc(INLINE_IMAGE_MAX_BYTES)]).subarray(0, INLINE_IMAGE_MAX_BYTES + 1)
  code(() => prep(big), 'too_large', { bytes: INLINE_IMAGE_MAX_BYTES + 1, maxBytes: INLINE_IMAGE_MAX_BYTES })
  assert.equal(INLINE_IMAGE_MAX_BYTES, 10 * 1024 * 1024)
})
