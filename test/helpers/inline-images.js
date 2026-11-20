// SPDX-License-Identifier: GPL-3.0-or-later
// Small, structurally whole PNG / JPEG files for the pasted-image tests, and a decoder that answers like Electron's
// nativeImage for them (the size the header says), so the main process code runs without Electron.
import zlib from 'node:zlib'

export function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An RGB PNG; `seed` changes the pixels (two images of one size differ); `before` chunks go before IDAT. */
export function pngFile(w, h, { seed = 0, before = [] } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = Buffer.alloc(h * (1 + w * 3))
  for (let i = 0; i < rows.length; i++) rows[i] = (i * 7 + seed) & 0x7f
  for (let y = 0; y < h; y++) rows[y * (1 + w * 3)] = 0 // filter 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...before, chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND')])
}

function seg(marker, data) {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(data.length + 2, 0)
  return Buffer.concat([Buffer.from([0xff, marker]), len, data])
}

/** An Exif APP1 with Orientation and a GPS-like text (what a phone photo carries). */
export function exifSegment(orientation = 1) {
  const t = Buffer.alloc(8 + 2 + 12 + 4)
  t.write('II', 0, 'latin1')
  t.writeUInt16LE(42, 2)
  t.writeUInt32LE(8, 4)
  t.writeUInt16LE(1, 8)
  t.writeUInt16LE(0x0112, 10)
  t.writeUInt16LE(3, 12)
  t.writeUInt32LE(1, 14)
  t.writeUInt16LE(orientation, 18)
  return seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t, Buffer.from('GPS 47.49N 19.04E', 'latin1')]))
}

const JFIF = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))
const DQT = seg(0xdb, Buffer.alloc(65, 1))
function sof(w, h) {
  const b = Buffer.alloc(15)
  b[0] = 8
  b.writeUInt16BE(h, 1)
  b.writeUInt16BE(w, 3)
  b[5] = 3
  return seg(0xc0, b)
}
/** The entropy-coded part of the fake scan (its bytes must come out unchanged). */
export const JPEG_SCAN_DATA = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])
const SCAN = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), JPEG_SCAN_DATA, Buffer.from([0xff, 0xd9])])

/** A JPEG with JFIF; `exif`: an Exif APP1 (with Orientation `exif`) before the frame. */
export function jpegFile(w, h, { exif = null } = {}) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, ...(exif === null ? [] : [exifSegment(exif)]), DQT, sof(w, h), SCAN])
}

/** The size a PNG's IHDR or a JPEG's SOF0 says, as nativeImage.getSize() would give for these files; else null. */
export function headerDecode(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  for (let i = 2; i + 9 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xc0) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
  }
  return null
}
