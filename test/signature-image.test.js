// The signature image: type from the header, lossless metadata removal (JPEG segments, PNG chunks), the limits, the
// rotated JPEG, and a damaged file is always a refusal, never another exception. The PNG files are real (zlib); the JPEG
// files are whole in structure (SOI .. SOF .. SOS .. EOI) with a stand-in scan, which is all the walker reads. The
// pixel check with the real decoder (Electron nativeImage) is in test/e2e/signature-image-e2e.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { imageTypeOf, prepareSignatureImage, SignatureImageError, SIGNATURE_LIMITS } from '../core/accounts/signature-image.js'

// --- PNG ------------------------------------------------------------------------------------------------------------
function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function ihdr(w, h) {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(w, 0)
  b.writeUInt32BE(h, 4)
  b[8] = 8 // bit depth
  b[9] = 2 // RGB
  return chunk('IHDR', b)
}
function pngFile(w, h, { before = [], after = [] } = {}) {
  const rows = Buffer.alloc(h * (1 + w * 3)) // filter 0, black pixels
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr(w, h), ...before, chunk('IDAT', zlib.deflateSync(rows)), ...after, chunk('IEND')])
}
const pngChunks = buf => {
  const out = []
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at)
    out.push({ type: buf.toString('latin1', at + 4, at + 8), crcOk: zlib.crc32(buf.subarray(at + 4, at + 8 + len)) === buf.readUInt32BE(at + 8 + len), bytes: buf.subarray(at, at + 12 + len) })
    at += 12 + len
  }
  return out
}

// --- JPEG -----------------------------------------------------------------------------------------------------------
function seg(marker, data) {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(data.length + 2, 0)
  return Buffer.concat([Buffer.from([0xff, marker]), len, data])
}
// a TIFF block (Exif's structure) with one entry, Orientation, and a GPS-like text after it
function tiffBlock(orientation, order = 'II') {
  const t = Buffer.alloc(8 + 2 + 12 + 4)
  const w16 = (v, o) => (order === 'II' ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o))
  const w32 = (v, o) => (order === 'II' ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o))
  t.write(order, 0, 'latin1')
  w16(42, 2)
  w32(8, 4)
  w16(1, 8) // one entry
  w16(0x0112, 10) // Orientation
  w16(3, 12) // SHORT
  w32(1, 14)
  w16(orientation, 18)
  return Buffer.concat([t, Buffer.from('GPS 47.49N 19.04E', 'latin1')])
}
const exif = (orientation, order = 'II') => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBlock(orientation, order)]))
const JFIF = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))
const ICC = seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile-bytes', 'latin1'))
const XMP = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret</x:xmpmeta>', 'latin1'))
const IPTC = seg(0xed, Buffer.from('Photoshop 3.0\0iptc', 'latin1'))
const COM = seg(0xfe, Buffer.from('a comment with a name', 'latin1'))
const ADOBE = seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1'))
const DQT = seg(0xdb, Buffer.alloc(65, 1))
function sof(w, h) {
  const b = Buffer.alloc(15)
  b[0] = 8
  b.writeUInt16BE(h, 1)
  b.writeUInt16BE(w, 3)
  b[5] = 3
  return seg(0xc0, b)
}
const SCAN = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), Buffer.from([0xff, 0xd9])])
const jpegFile = (w, h, segments) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, DQT, sof(w, h), SCAN])

// the decoder the app gives (nativeImage): here the size the header says
const headerDecode = bytes => {
  if (imageTypeOf(bytes) === 'image/png') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  const at = bytes.indexOf(Buffer.from([0xff, 0xc0]))
  return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) }
}
const prepare = buf => prepareSignatureImage(buf, { decode: headerDecode })
const codeOf = fn => {
  try {
    fn()
    return 'ok'
  } catch (err) {
    assert.ok(err instanceof SignatureImageError, `not a SignatureImageError: ${err && err.stack}`)
    return err.code
  }
}

test('the type comes from the header, never the name: PNG, JPEG, and nothing else', () => {
  assert.equal(imageTypeOf(pngFile(2, 2)), 'image/png')
  assert.equal(imageTypeOf(jpegFile(2, 2, [JFIF])), 'image/jpeg')
  for (const other of [Buffer.alloc(0), Buffer.from('not an image, named logo.png'), Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), Buffer.from('<svg/>'), Buffer.from([0x89, 0x50])]) {
    assert.equal(imageTypeOf(other), null)
    assert.equal(codeOf(() => prepare(other)), 'unsupported_image')
  }
})

test('the limits: 800 x 400 and 150 KB pass; one pixel or one byte over is too_large with the numbers', () => {
  const ok = prepare(pngFile(800, 400))
  assert.deepEqual([ok.type, ok.width, ok.height], ['image/png', 800, 400])
  for (const [w, h] of [[801, 400], [800, 401], [1920, 1080]]) {
    try {
      prepare(pngFile(w, h))
      assert.fail(`${w} x ${h} passed`)
    } catch (err) {
      assert.equal(err.code, 'too_large')
      assert.deepEqual({ ...err.info, bytes: undefined }, { width: w, height: h, bytes: undefined, maxWidth: 800, maxHeight: 400, maxBytes: 150 * 1024 })
    }
  }
  // exactly at the byte limit and one over, with a second (kept) IDAT as the filler (the header decoder: no pixels decoded)
  const base = pngFile(800, 400)
  const sized = n => pngFile(800, 400, { after: [chunk('IDAT', Buffer.alloc(n - base.length - 12))] })
  assert.equal(prepare(sized(SIGNATURE_LIMITS.maxBytes)).bytes.length, SIGNATURE_LIMITS.maxBytes)
  const over = sized(SIGNATURE_LIMITS.maxBytes + 1)
  try {
    prepare(over)
    assert.fail('151 KB passed')
  } catch (err) {
    assert.equal(err.code, 'too_large')
    assert.equal(err.info.bytes, SIGNATURE_LIMITS.maxBytes + 1)
  }
})

test('the byte limit is measured AFTER the metadata is removed', () => {
  const base = pngFile(800, 400)
  const big = pngFile(800, 400, { after: [chunk('tEXt', Buffer.alloc(SIGNATURE_LIMITS.maxBytes - base.length + 100, 0x41))] })
  assert.ok(big.length > SIGNATURE_LIMITS.maxBytes)
  assert.ok(prepare(big).bytes.equals(base))
})

test('PNG without metadata: the stored bytes are the original bytes', () => {
  const f = pngFile(40, 20, { before: [chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])), chunk('sRGB', Buffer.from([0]))] })
  const out = prepare(f)
  assert.ok(out.bytes.equals(f))
  assert.equal(out.removed, 0)
})

test('PNG: tEXt, zTXt, iTXt, eXIf and tIME go; every other chunk stays byte for byte with a valid CRC', () => {
  const meta = [chunk('tEXt', Buffer.from('Author\0Somebody')), chunk('zTXt', Buffer.from('Comment\0\0x')), chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>')), chunk('eXIf', tiffBlock(1, 'MM')), chunk('tIME', Buffer.alloc(7))]
  const keep = [chunk('iCCP', Buffer.from('sRGB\0\0xx')), chunk('pHYs', Buffer.alloc(9)), chunk('cHRM', Buffer.alloc(32))]
  const f = pngFile(40, 20, { before: [...keep, ...meta] })
  assert.ok(f.includes('GPS 47.49N') && f.includes('Author'), 'the control: the metadata is in the original')
  const out = prepare(f)
  assert.equal(out.removed, 5)
  assert.ok(!out.bytes.includes('GPS 47.49N') && !out.bytes.includes('Author') && !out.bytes.includes('xmp'))
  const chunks = pngChunks(out.bytes)
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'iCCP', 'pHYs', 'cHRM', 'IDAT', 'IEND'])
  assert.ok(chunks.every(c => c.crcOk))
  for (const k of keep) assert.ok(out.bytes.includes(k), 'kept chunk byte for byte')
})

test('PNG white list: private and unknown ancillary chunks (caBX, meTa) go, sBIT and bKGD stay; an unknown critical chunk is refused', () => {
  const kept = [chunk('sBIT', Buffer.from([8, 8, 8])), chunk('bKGD', Buffer.from([0, 0, 0, 0, 0, 0]))]
  const f = pngFile(40, 20, { before: [...kept, chunk('caBX', Buffer.from('c2pa author Somebody')), chunk('meTa', Buffer.from('a name'))] })
  assert.ok(f.includes('c2pa author') && f.includes('a name'), 'the control')
  const out = prepare(f)
  assert.equal(out.removed, 2)
  assert.ok(!out.bytes.includes('c2pa author') && !out.bytes.includes('a name'))
  assert.deepEqual(pngChunks(out.bytes).map(c => c.type), ['IHDR', 'sBIT', 'bKGD', 'IDAT', 'IEND'])
  for (const k of kept) assert.ok(out.bytes.includes(k))
  assert.equal(codeOf(() => prepare(pngFile(40, 20, { before: [chunk('ABCD', Buffer.from('x'))] }))), 'unsupported_image')
  // the animated PNG is refused before the white list could drop its acTL (else it would become a still image)
  assert.equal(codeOf(() => prepare(pngFile(40, 20, { before: [chunk('acTL', Buffer.alloc(8))] }))), 'unsupported_image')
})

test('PNG: an animated PNG, a broken CRC, a cut file, data after IEND, a missing IHDR: unsupported_image', () => {
  const f = pngFile(10, 10)
  const animated = pngFile(10, 10, { before: [chunk('acTL', Buffer.alloc(8))] })
  const badCrc = Buffer.from(f)
  badCrc[badCrc.length - 20] ^= 0xff // a byte of the IDAT data
  const noIhdr = Buffer.concat([f.subarray(0, 8), f.subarray(8 + 25)])
  for (const bad of [animated, badCrc, f.subarray(0, f.length - 5), Buffer.concat([f, Buffer.from('trailing')]), noIhdr]) {
    assert.equal(codeOf(() => prepare(bad)), 'unsupported_image')
  }
})

test('JPEG: APP1 (Exif, XMP), APP13 and COM go; JFIF, ICC (APP2), Adobe (APP14) and the scan stay byte for byte', () => {
  const f = jpegFile(320, 100, [JFIF, exif(1), XMP, ICC, IPTC, COM, ADOBE])
  assert.ok(f.includes('Exif') && f.includes('GPS 47.49N'), 'the control: the Exif block is in the original')
  const out = prepare(f)
  assert.deepEqual([out.type, out.width, out.height, out.removed], ['image/jpeg', 320, 100, 4])
  for (const gone of ['Exif', 'GPS 47.49N', 'ns.adobe.com/xap', 'Photoshop 3.0', 'a comment with a name']) assert.ok(!out.bytes.includes(gone), gone)
  for (const kept of [JFIF, ICC, ADOBE, DQT, sof(320, 100)]) assert.ok(out.bytes.includes(kept), 'kept segment byte for byte')
  assert.ok(out.bytes.subarray(out.bytes.length - SCAN.length).equals(SCAN), 'the scan from SOS on is unchanged')
})

test('PNG: an eXIf Orientation other than 1 is refused (rotated_image) as in a JPEG, with or without "Exif\\0\\0"; 1 passes', () => {
  for (const order of ['II', 'MM']) {
    for (const prefix of [Buffer.alloc(0), Buffer.from('Exif\0\0', 'latin1')]) {
      for (const o of [3, 6, 8]) {
        const err = (() => {
          try {
            prepare(pngFile(40, 20, { before: [chunk('eXIf', Buffer.concat([prefix, tiffBlock(o, order)]))] }))
          } catch (e) {
            return e
          }
        })()
        assert.equal(err?.code, 'rotated_image', `orientation ${o} ${order}`)
        assert.equal(err.info.orientation, o)
      }
      assert.equal(prepare(pngFile(40, 20, { before: [chunk('eXIf', Buffer.concat([prefix, tiffBlock(1, order)]))] })).removed, 1)
    }
  }
  assert.equal(codeOf(() => prepare(pngFile(40, 20, { before: [chunk('eXIf', Buffer.from('MM\0*Exif-gps'))] }))), 'unsupported_image', 'an eXIf that does not walk')
})

test('JPEG: what follows the first EOI (an appended image with its own Exif and comment) is left out', () => {
  const first = jpegFile(320, 100, [JFIF, ICC])
  const second = jpegFile(64, 64, [exif(1), COM])
  const f = Buffer.concat([first, second])
  assert.ok(f.includes('GPS 47.49N') && f.includes('a comment with a name'), 'the control: the metadata is in the original')
  const out = prepare(f)
  assert.deepEqual([out.width, out.height, out.removed], [320, 100, 1])
  assert.ok(out.bytes.equals(first), 'exactly the first image, byte for byte')
  // the appended image's turned Exif does not matter either: it is not the shown image
  assert.ok(prepare(Buffer.concat([first, jpegFile(64, 64, [exif(6)])])).bytes.equals(first))
})

test('JPEG: between the scans (a progressive file) APP1, APP13 and COM go too, DHT stays; a turned Exif there is refused', () => {
  const scan2 = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x77, 0xff, 0x00, 0x88])])
  const DHT = seg(0xc4, Buffer.alloc(20, 2))
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, DQT, sof(200, 100)])
  const scan1 = SCAN.subarray(0, SCAN.length - 2) // the first scan without the EOI
  const f = Buffer.concat([head, scan1, exif(1), COM, IPTC, DHT, scan2, Buffer.from([0xff, 0xd9])])
  assert.ok(f.includes('GPS 47.49N') && f.includes('a comment with a name'), 'the control')
  const out = prepare(f)
  assert.equal(out.removed, 3)
  for (const gone of ['Exif', 'GPS 47.49N', 'a comment with a name', 'Photoshop 3.0']) assert.ok(!out.bytes.includes(gone), gone)
  assert.ok(out.bytes.equals(Buffer.concat([head, scan1, DHT, scan2, Buffer.from([0xff, 0xd9])])), 'the scans and the DHT byte for byte')
  assert.equal(codeOf(() => prepare(Buffer.concat([head, scan1, exif(6), scan2, Buffer.from([0xff, 0xd9])]))), 'rotated_image')
  // a second frame (a size after a scan) is not walked
  assert.equal(codeOf(() => prepare(Buffer.concat([head, scan1, sof(10, 10), scan2, Buffer.from([0xff, 0xd9])]))), 'unsupported_image')
})

test('JPEG white list: APP11 (JUMBF / C2PA), APP3, APP2 MPF and APP0 JFXX go; JFIF, ICC and Adobe stay; an unknown marker is refused', () => {
  const APP11 = seg(0xeb, Buffer.from('JP\0\x01jumb c2pa author Somebody', 'latin1'))
  const APP3 = seg(0xe3, Buffer.from('META\0a name', 'latin1'))
  const MPF = seg(0xe2, Buffer.from('MPF\0MM\0*index', 'latin1'))
  const JFXX = seg(0xe0, Buffer.from('JFXX\0\x10thumb', 'latin1'))
  const f = jpegFile(64, 64, [JFIF, ICC, ADOBE, APP11, APP3, MPF, JFXX])
  assert.ok(f.includes('c2pa author') && f.includes('a name'), 'the control')
  const out = prepare(f)
  assert.equal(out.removed, 4)
  for (const gone of ['c2pa author', 'a name', 'MPF\0', 'JFXX', 'thumb']) assert.ok(!out.bytes.includes(gone), gone)
  assert.ok(out.bytes.equals(jpegFile(64, 64, [JFIF, ICC, ADOBE])), 'exactly the white-listed segments and the scan')
  assert.equal(codeOf(() => prepare(jpegFile(64, 64, [JFIF, seg(0xf0, Buffer.from('jpg0', 'latin1'))]))), 'unsupported_image')
})

test('JPEG without metadata: the stored bytes are the original bytes', () => {
  const f = jpegFile(64, 64, [JFIF, ICC])
  assert.ok(prepare(f).bytes.equals(f))
})

test('JPEG: an Exif Orientation other than 1 is refused (rotated_image), in both byte orders; 1 passes', () => {
  for (const order of ['II', 'MM']) {
    for (const o of [3, 6, 8]) {
      try {
        prepare(jpegFile(64, 64, [JFIF, exif(o, order)]))
        assert.fail(`orientation ${o} passed`)
      } catch (err) {
        assert.equal(err.code, 'rotated_image')
        assert.equal(err.info.orientation, o)
      }
    }
    assert.equal(prepare(jpegFile(64, 64, [JFIF, exif(1, order)])).width, 64)
  }
})

test('JPEG: no EOI, no SOF, a segment longer than the file, an Exif block that does not walk: unsupported_image', () => {
  const f = jpegFile(64, 64, [JFIF])
  const noSof = Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, DQT, SCAN])
  const longSeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), Buffer.alloc(10)])
  const badExif = jpegFile(64, 64, [seg(0xe1, Buffer.from('Exif\0\0XX\0\0', 'latin1'))])
  for (const bad of [f.subarray(0, f.length - 2), noSof, longSeg, badExif]) assert.equal(codeOf(() => prepare(bad)), 'unsupported_image')
})

test('the decoder decides last: a file it cannot decode, or decodes to another size, is unsupported_image', () => {
  const f = pngFile(40, 20)
  assert.equal(codeOf(() => prepareSignatureImage(f, { decode: () => null })), 'unsupported_image')
  assert.equal(codeOf(() => prepareSignatureImage(f, { decode: () => ({ width: 40, height: 21 }) })), 'unsupported_image')
  assert.throws(() => prepareSignatureImage(f), TypeError, 'without a decoder nothing is stored')
})

test('every cut and every flipped byte of a valid file ends in a code, never another exception', () => {
  const files = [pngFile(30, 10, { before: [chunk('tEXt', Buffer.from('a\0b'))] }), jpegFile(30, 10, [JFIF, exif(1), ICC, COM])]
  for (const f of files) {
    for (let n = 0; n < f.length; n++) codeOf(() => prepare(f.subarray(0, n)))
    for (let i = 0; i < f.length; i++) {
      const g = Buffer.from(f)
      g[i] ^= 0x5a
      codeOf(() => prepare(g))
    }
  }
})

test('the scan walk stays linear: 10 MB of stuffed bytes, fill bytes, restart markers or 200 000 scans in under 1 s each', () => {
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), DQT, sof(200, 100), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]))])
  const bodies = [
    Buffer.alloc(10 * 1024 * 1024).fill(Buffer.from([0xff, 0x00])),
    Buffer.alloc(10 * 1024 * 1024, 0xff),
    Buffer.alloc(10 * 1024 * 1024).fill(Buffer.from([0xff, 0xd0])),
    Buffer.concat(Array.from({ length: 200000 }, () => Buffer.concat([Buffer.from([1, 2, 3]), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]))]))),
  ]
  for (const body of bodies) {
    const t = performance.now()
    assert.equal(codeOf(() => prepare(Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]))), 'too_large')
    assert.ok(performance.now() - t < 1000, `${Math.round(performance.now() - t)} ms`)
  }
})
