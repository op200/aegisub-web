// src/colorspace.cpp 的 web 移植：RGB/HSL/HSV 互转（0..255 的整数量化与源码一致）

const clip = (value: number) => Math.max(0, Math.min(255, Math.trunc(value)))

export type Rgb = [number, number, number]

/** hsl_to_rgb：H/S/L 均为 0..255 */
export function hslToRgb(H: number, S: number, L: number): Rgb {
  if (S === 0) return [L, L, L]

  if (L === 128 && S === 255) {
    switch (H) {
      case 0:
      case 255:
        return [255, 0, 0]
      case 43:
        return [255, 255, 0]
      case 85:
        return [0, 255, 0]
      case 128:
        return [0, 255, 255]
      case 171:
        return [0, 0, 255]
      case 213:
        return [255, 0, 255]
    }
  }

  const h = H / 255
  const s = S / 255
  const l = L / 255
  const temp2 = l < 0.5 ? l * (1 + s) : l + s - l * s
  const temp1 = 2 * l - temp2

  const channel = (input: number) => {
    let temp3 = input
    if (temp3 > 1) temp3 -= 1
    if (temp3 < 0) temp3 += 1
    if (6 * temp3 < 1) return temp1 + (temp2 - temp1) * 6 * temp3
    if (2 * temp3 < 1) return temp2
    if (3 * temp3 < 2) return temp1 + (temp2 - temp1) * (2 / 3 - temp3) * 6
    return temp1
  }

  return [clip(channel(h + 1 / 3) * 255), clip(channel(h) * 255), clip(channel(h - 1 / 3) * 255)]
}

/** hsv_to_rgb：H/S/V 均为 0..255 */
export function hsvToRgb(H: number, S: number, V: number): Rgb {
  if (S === 255) {
    switch (H) {
      case 0:
      case 255:
        return [V, 0, 0]
      case 43:
        return [V, V, 0]
      case 85:
        return [0, V, 0]
      case 128:
        return [0, V, V]
      case 171:
        return [0, 0, V]
      case 213:
        return [V, 0, V]
    }
  }

  if (S === 0) return [V, V, V]

  const h = H * 360
  const s = clip(S) * 256
  const v = clip(V) * 256
  const hi = Math.floor(h / 60 / 256)
  const f = h / 60 - hi * 256
  const p = Math.floor((v * (65535 - s)) / 65536)
  const q = Math.floor((v * (65535 - Math.floor((f * s) / 256))) / 65536)
  const t = Math.floor((v * (65535 - Math.floor(((255 - f) * s) / 256))) / 65536)

  let r: number
  let g: number
  let b: number
  switch (hi) {
    case 0:
      r = v
      g = t
      b = p
      break
    case 1:
      r = q
      g = v
      b = p
      break
    case 2:
      r = p
      g = v
      b = t
      break
    case 3:
      r = p
      g = q
      b = v
      break
    case 4:
      r = t
      g = p
      b = v
      break
    default:
      r = v
      g = p
      b = q
      break
  }
  return [clip(r / 256), clip(g / 256), clip(b / 256)]
}

/** rgb_to_hsl */
export function rgbToHsl(R: number, G: number, B: number): Rgb {
  const r = R / 255
  const g = G / 255
  const b = B / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (min + max) / 2
  let h = 0
  let s = 0
  if (min !== max) {
    s = l < 0.5 ? (max - min) / (max + min) : (max - min) / (2 - max - min)
    if (r === max) h = (g - b) / (max - min)
    else if (g === max) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
  }
  if (h < 0) h += 6
  if (h >= 6) h -= 6
  return [clip((h * 256) / 6), clip(s * 255), clip(l * 255)]
}

/** rgb_to_hsv */
export function rgbToHsv(R: number, G: number, B: number): Rgb {
  const r = R / 255
  const g = G / 255
  const b = B / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const v = max
  const s = max < 0.001 ? 1 : (max - min) / max
  let h = 0
  if (min !== max) {
    if (max === r) h = (g - b) / (max - min)
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
  }
  if (h < 0) h += 6
  if (h >= 6) h -= 6
  return [clip((h * 256) / 6), clip(s * 255), clip(v * 255)]
}
