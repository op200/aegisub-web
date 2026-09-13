export function assColorToCss(value: string, fallback = '#ffffff'): string {
  const hex = value
    .replace(/[^0-9a-f]/gi, '')
    .padStart(8, '0')
    .slice(-8)
  if (!hex) return fallback
  const alpha = 1 - Number.parseInt(hex.slice(0, 2), 16) / 255
  const blue = Number.parseInt(hex.slice(2, 4), 16)
  const green = Number.parseInt(hex.slice(4, 6), 16)
  const red = Number.parseInt(hex.slice(6, 8), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`
}

export function assColorToHex(value: string): string {
  const hex = value
    .replace(/[^0-9a-f]/gi, '')
    .padStart(8, '0')
    .slice(-8)
  return `#${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}`
}

export function hexToAssColor(value: string, previous = '&H00FFFFFF'): string {
  const rgb = value.replace('#', '').padStart(6, '0')
  const alpha = previous
    .replace(/[^0-9a-f]/gi, '')
    .padStart(8, '0')
    .slice(-8, -6)
    .toUpperCase()
  return `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase()
}

/** 'rgb(r,g,b)' / 'rgba(r,g,b,a)' / '#hex' → '#RRGGBB'（供 input[type=color]） */
export function cssColorToHex(value: string, fallback = '#000000'): string {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value)
  if (!match) {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
    return fallback
  }
  const hex = (n: number) => Number(n).toString(16).padStart(2, '0')
  return `#${hex(Number(match[1]))}${hex(Number(match[2]))}${hex(Number(match[3]))}`
}

/** #RRGGBB → 'rgb(r,g,b)'（Colour 选项的存储格式） */
export function hexToCssColor(value: string): string {
  const rgb = value.replace('#', '').padStart(6, '0').slice(0, 6)
  const r = Number.parseInt(rgb.slice(0, 2), 16)
  const g = Number.parseInt(rgb.slice(2, 4), 16)
  const b = Number.parseInt(rgb.slice(4, 6), 16)
  return `rgb(${r},${g},${b})`
}

/**
 * CSS 颜色亮度反转（HSL 上 L → 1-L，色相/饱和度保留），用于 dark 主题适配
 * Aegisub 的亮色向配色（Colour/Subtitle Grid、Colour/Subtitle/Syntax 等）。
 * remap 可对反转后的亮度做线性压缩：min 抬高纯黑（背景色）、max 压低纯白（前景色）。
 */
export function invertLightness(value: string, remap?: { min?: number; max?: number }): string {
  const rgbMatch = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/.exec(value)
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 1
  if (rgbMatch) {
    red = Number(rgbMatch[1])
    green = Number(rgbMatch[2])
    blue = Number(rgbMatch[3])
    if (rgbMatch[4] !== undefined) {
      alpha = rgbMatch[4].endsWith('%')
        ? Number(rgbMatch[4].slice(0, -1)) / 100
        : Number(rgbMatch[4])
    }
  } else {
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(value.trim())
    if (!hexMatch) return value
    const hex = hexMatch[1]
    if (hex.length === 3) {
      red = Number.parseInt(hex[0] + hex[0], 16)
      green = Number.parseInt(hex[1] + hex[1], 16)
      blue = Number.parseInt(hex[2] + hex[2], 16)
    } else {
      red = Number.parseInt(hex.slice(0, 2), 16)
      green = Number.parseInt(hex.slice(2, 4), 16)
      blue = Number.parseInt(hex.slice(4, 6), 16)
    }
  }

  // RGB → HSL
  const rn = red / 255
  const gn = green / 255
  const bn = blue / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) h = ((bn - rn) / d + 2) * 60
    else h = ((rn - gn) / d + 4) * 60
  }
  let lightness = 1 - l
  if (remap) {
    const lo = remap.min ?? 0
    const hi = remap.max ?? 1
    lightness = lo + (hi - lo) * lightness
  }

  // HSL → RGB
  const hueToRgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  let r2: number
  let g2: number
  let b2: number
  if (s === 0) {
    r2 = g2 = b2 = lightness
  } else {
    const q = lightness < 0.5 ? lightness * (1 + s) : lightness + s - lightness * s
    const p = 2 * lightness - q
    r2 = hueToRgb(p, q, h / 360 + 1 / 3)
    g2 = hueToRgb(p, q, h / 360)
    b2 = hueToRgb(p, q, h / 360 - 1 / 3)
  }
  const to255 = (v: number) => Math.round(v * 255)
  if (alpha < 1) return `rgba(${to255(r2)}, ${to255(g2)}, ${to255(b2)}, ${alpha})`
  return `rgb(${to255(r2)}, ${to255(g2)}, ${to255(b2)})`
}
