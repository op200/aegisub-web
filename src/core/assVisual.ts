import { rectangleToDrawing } from './spline'

export interface AssVisualOverrides {
  pos?: { x: number; y: number }
  /** \move(x1,y1,x2,y2[,t1,t2])（visual_tool_drag.cpp GetLineMove） */
  move?: { x1: number; y1: number; x2: number; y2: number; t1?: number; t2?: number }
  /** \org(x,y) 旋转原点（visual_tool_rotate*.cpp） */
  org?: { x: number; y: number }
  scaleX: number
  scaleY: number
  rotationZ: number
  rotationX: number
  rotationY: number
  /** \fax/\fay 剪切（visual_tool_rotatexy.cpp 变换网格） */
  fax: number
  fay: number
  clip?: { inverse: boolean; x1: number; y1: number; x2: number; y2: number }
}

function lastMatch(text: string, expression: RegExp): RegExpMatchArray | null {
  let result: RegExpMatchArray | null = null
  for (const block of text.matchAll(/\{[^}]*}/g)) {
    const match = block[0].match(expression)
    if (match) result = match
  }
  return result
}

export function readVisualOverrides(text: string): AssVisualOverrides {
  const pos = lastMatch(text, /\\pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i)
  const move = lastMatch(
    text,
    /\\move\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(\d+)\s*,\s*(\d+)\s*)?\)/i,
  )
  const org = lastMatch(text, /\\org\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i)
  const scaleX = lastMatch(text, /\\fscx(-?[\d.]+)/i)
  const scaleY = lastMatch(text, /\\fscy(-?[\d.]+)/i)
  const rotationZ = lastMatch(text, /\\(?:frz|fr)(-?[\d.]+)/i)
  const rotationX = lastMatch(text, /\\frx(-?[\d.]+)/i)
  const rotationY = lastMatch(text, /\\fry(-?[\d.]+)/i)
  const fax = lastMatch(text, /\\fax(-?[\d.]+)/i)
  const fay = lastMatch(text, /\\fay(-?[\d.]+)/i)
  const clip = lastMatch(
    text,
    /\\(i?clip)\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i,
  )
  return {
    pos: pos ? { x: Number(pos[1]), y: Number(pos[2]) } : undefined,
    move: move
      ? {
          x1: Number(move[1]),
          y1: Number(move[2]),
          x2: Number(move[3]),
          y2: Number(move[4]),
          ...(move[5] && move[6] ? { t1: Number(move[5]), t2: Number(move[6]) } : {}),
        }
      : undefined,
    org: org ? { x: Number(org[1]), y: Number(org[2]) } : undefined,
    scaleX: scaleX ? Number(scaleX[1]) : 100,
    scaleY: scaleY ? Number(scaleY[1]) : 100,
    rotationZ: rotationZ ? Number(rotationZ[1]) : 0,
    rotationX: rotationX ? Number(rotationX[1]) : 0,
    rotationY: rotationY ? Number(rotationY[1]) : 0,
    fax: fax ? Number(fax[1]) : 0,
    fay: fay ? Number(fay[1]) : 0,
    clip: clip
      ? {
          inverse: clip[1].toLowerCase() === 'iclip',
          x1: Number(clip[2]),
          y1: Number(clip[3]),
          x2: Number(clip[4]),
          y2: Number(clip[5]),
        }
      : undefined,
  }
}

export function setOverride(text: string, tag: string, value: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`\\\\${escaped}(?:\\([^)]*\\)|-?[\\d.]+)`, 'gi')
  let replaced = false
  const blocks = text.replace(/\{([^}]*)}/g, (whole, content: string) => {
    if (!expression.test(content)) return whole
    replaced = true
    expression.lastIndex = 0
    return `{${content.replace(expression, `\\${tag}${value}`)}}`
  })
  if (replaced) return blocks
  if (blocks.startsWith('{')) return blocks.replace('{', `{\\${tag}${value}`)
  return `{\\${tag}${value}}${blocks}`
}

export function setPosition(text: string, x: number, y: number): string {
  return setOverride(
    text.replace(/\\move\([^)]*\)/gi, ''),
    'pos',
    `(${Math.round(x)},${Math.round(y)})`,
  )
}

export interface VectorClipInfo {
  inverse: boolean
  scale: number
  drawing: string
}

/**
 * 读取 \clip/\iclip 矢量标签（visual_tool.cpp GetLineVectorClip）：
 * 矩形形式转为可编辑折线；矢量形式带可选 scale 参数。
 */
export function readVectorClip(text: string): VectorClipInfo | null {
  const clip = lastMatch(text, /\\(i?clip)\s*\(([^)]*)\)/i)
  if (!clip) return null
  const inverse = clip[1].toLowerCase() === 'iclip'
  const raw = clip[2].trim()
  const rect = raw.match(/^(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)$/)
  if (rect) {
    const [x1, y1, x2, y2] = rect.slice(1).map(Number)
    return { inverse, scale: 1, drawing: rectangleToDrawing(x1, y1, x2, y2) }
  }
  const scaled = raw.match(/^(\d+)\s*,\s*([\s\S]+)$/)
  if (scaled) {
    const scale = Math.max(1, Number(scaled[1]))
    return { inverse, scale, drawing: scaled[2].trim() }
  }
  return { inverse, scale: 1, drawing: raw }
}

/**
 * 写入 \clip/\iclip 并互删反向标签（visual_tool.cpp SetOverride）。
 */
export function setVectorClip(text: string, inverse: boolean, value: string): string {
  const removeTag = inverse ? 'clip' : 'iclip'
  const removal = new RegExp(`(?<![a-zA-Z])\\\\${removeTag}\\s*\\([^)]*\\)`, 'gi')
  const stripped = text.replace(/\{([^}]*)\}/g, (whole, content: string) => {
    const cleaned = content.replace(removal, '')
    return cleaned.trim() ? `{${cleaned}}` : ''
  })
  return setOverride(stripped, inverse ? 'iclip' : 'clip', value)
}
