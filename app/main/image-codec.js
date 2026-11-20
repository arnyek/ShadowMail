// SPDX-License-Identifier: GPL-3.0-or-later
// The image codec of the main process for the signature image and a pasted image (core/accounts/signature-image.js
// takes these as `decode` and `upright`), on Electron's nativeImage, which is passed in (a test passes its own).
import { uprightBitmap } from '../../core/accounts/orientation.js'

// a turned photo is encoded again at this JPEG quality (the owner asked for a good quality JPEG)
export const UPRIGHT_JPEG_QUALITY = 92

export function imageCodec(nativeImage) {
  return {
    /** decodable at all, and of which size (a check only) -> { width, height } | null */
    decode(bytes) {
      const img = nativeImage.createFromBuffer(bytes)
      return img.isEmpty() ? null : img.getSize()
    },
    /**
     * The image turned upright in its pixels (nativeImage does not apply an orientation by itself, measured), encoded
     * again in its own type: a JPEG at UPRIGHT_JPEG_QUALITY, a PNG losslessly. No metadata in the result (nor an ICC
     * profile: the encoders write none). Throws when the bytes do not decode.
     */
    upright(bytes, type, orientation) {
      const img = nativeImage.createFromBuffer(bytes)
      if (img.isEmpty()) throw new Error('not decodable')
      const { width, height } = img.getSize()
      const turned = uprightBitmap(img.toBitmap(), width, height, orientation)
      const out = nativeImage.createFromBitmap(turned.data, { width: turned.width, height: turned.height })
      return type === 'image/png' ? out.toPNG() : out.toJPEG(UPRIGHT_JPEG_QUALITY)
    },
  }
}
