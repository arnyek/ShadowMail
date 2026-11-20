// SPDX-License-Identifier: GPL-3.0-or-later
// An image stored turned (an Exif Orientation other than 1: a phone photo held upright, a mirrored selfie) turned
// upright in its pixels, so it shows the same everywhere and needs no flag. Pure: 4 bytes a pixel (BGRA as Electron's
// nativeImage.toBitmap gives it; the 4 bytes of a pixel move together and are never read), no file access, no Electron.
//
// Orientation (Exif / TIFF tag 0x0112): how the kept pixels must be transformed to show upright.
//   1 as kept  2 mirrored left-right  3 turned 180  4 mirrored top-bottom
//   5 mirrored across the top-left / bottom-right diagonal (transpose)  6 turned 90 clockwise
//   7 mirrored across the other diagonal (transverse)  8 turned 90 counter-clockwise
// 5..8 swap the width and the height.

export const ORIENTATIONS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8])

/** The upright size of a w x h image kept with `orientation`. */
export function uprightSize(width, height, orientation) {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
}

// the kept pixel that shows at the upright (u, v), as an index into the kept w x h pixels: start + u * du + v * dv
const WALK = {
  1: w => [0, 1, w],
  2: w => [w - 1, -1, w],
  3: (w, h) => [(h - 1) * w + w - 1, -1, -w],
  4: (w, h) => [(h - 1) * w, 1, -w],
  5: w => [0, w, 1],
  6: (w, h) => [(h - 1) * w, -w, 1],
  7: (w, h) => [(h - 1) * w + w - 1, -w, -1],
  8: w => [w - 1, w, -1],
}

/**
 * data: width x height pixels of 4 bytes, row by row -> { data, width, height } upright (a new Buffer; for 1 a copy).
 * Linear in the pixels, one pass, the 4 bytes of a pixel moved as one. An orientation outside 1..8 or a data length
 * that does not fit the size: RangeError.
 */
export function uprightBitmap(data, width, height, orientation) {
  const walk = ORIENTATIONS.includes(orientation) ? WALK[orientation] : null
  if (!walk) throw new RangeError(`orientation ${orientation}`)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) throw new RangeError('bitmap size')
  const size = uprightSize(width, height, orientation)
  // read in place when it sits on a 4-byte boundary (a large Buffer has its own memory from 0), else copied there
  let src
  if (data.byteOffset % 4 === 0) src = new Uint32Array(data.buffer, data.byteOffset, width * height)
  else {
    src = new Uint32Array(width * height)
    new Uint8Array(src.buffer).set(data)
  }
  const dst = new Uint32Array(width * height)
  const [start, du, dv] = walk(width, height)
  let to = 0
  for (let v = 0, row = start; v < size.height; v++, row += dv) {
    for (let u = 0, at = row; u < size.width; u++, at += du) dst[to++] = src[at]
  }
  return { data: Buffer.from(dst.buffer), ...size }
}
