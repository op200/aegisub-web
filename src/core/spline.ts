/**
 * 矢量裁剪样条模型（对应 Aegisub src/spline.cpp、spline_curve.cpp）。
 *
 * 坐标一律使用脚本分辨率坐标（PlayRes）。\clip(scale, ...) 的 scale 按
 * 源码语义换算：脚本坐标 × 2^(scale-1) 为标签内的实际坐标。
 */

export interface Vec2 {
  x: number
  y: number
}

export type CurveType = 'point' | 'line' | 'bicubic'

export interface SplineCurve {
  type: CurveType
  p1: Vec2
  p2: Vec2
  p3: Vec2
  p4: Vec2
}

export function vec(x: number, y: number): Vec2 {
  return { x, y }
}

function pointCurve(p: Vec2): SplineCurve {
  return { type: 'point', p1: p, p2: p, p3: p, p4: p }
}

function lineCurve(p1: Vec2, p2: Vec2): SplineCurve {
  return { type: 'line', p1, p2, p3: p1, p4: p2 }
}

function endPoint(curve: SplineCurve): Vec2 {
  return curve.type === 'line' ? curve.p2 : curve.p4
}

/** float_to_string(x, 2)：两位小数并去尾零（utils.cpp Vector2D::Str） */
function formatCoord(value: number): string {
  const text = value.toFixed(2)
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

export class Spline {
  curves: SplineCurve[] = []
  scale = 1

  /** spline.cpp DecodeFromAss：仅支持 m/l/b（含隐式连续坐标） */
  decode(ass: string): void {
    this.curves = []
    let command = 'm'
    const numbers: number[] = []

    const flush = (count: number, build: (values: number[]) => void) => {
      while (numbers.length >= count) {
        build(numbers.splice(0, count))
      }
    }

    for (const token of ass.trim().split(/\s+/)) {
      if (token.length === 1 && /[a-zA-Z]/.test(token)) {
        command = token.toLowerCase()
        continue
      }
      const value = Number.parseFloat(token)
      if (!Number.isFinite(value)) continue
      numbers.push(value)
      if (command === 'm') {
        flush(2, ([x, y]) => this.curves.push(pointCurve(vec(x, y))))
      } else if (command === 'l') {
        flush(2, ([x, y]) => {
          const start = this.curves.length
            ? endPoint(this.curves[this.curves.length - 1])
            : vec(x, y)
          this.curves.push(lineCurve(start, vec(x, y)))
        })
      } else if (command === 'b') {
        flush(6, ([x2, y2, x3, y3, x4, y4]) => {
          const start = this.curves.length
            ? endPoint(this.curves[this.curves.length - 1])
            : vec(x2, y2)
          this.curves.push({
            type: 'bicubic',
            p1: start,
            p2: vec(x2, y2),
            p3: vec(x3, y3),
            p4: vec(x4, y4),
          })
        })
      }
    }
  }

  /** spline.cpp EncodeToAss：命令字母分组输出，坐标两位小数去尾零 */
  encode(): string {
    const scaleText = this.scale !== 1 ? `${this.scale},` : ''
    const parts: string[] = []
    let lastType: CurveType | null = null
    for (const curve of this.curves) {
      if (curve.type !== lastType) {
        parts.push(curve.type === 'point' ? 'm' : curve.type === 'line' ? 'l' : 'b')
        lastType = curve.type
      }
      if (curve.type === 'point') {
        parts.push(formatCoord(curve.p1.x), formatCoord(curve.p1.y))
      } else if (curve.type === 'line') {
        parts.push(formatCoord(curve.p2.x), formatCoord(curve.p2.y))
      } else {
        parts.push(
          formatCoord(curve.p2.x),
          formatCoord(curve.p2.y),
          formatCoord(curve.p3.x),
          formatCoord(curve.p3.y),
          formatCoord(curve.p4.x),
          formatCoord(curve.p4.y),
        )
      }
    }
    return scaleText + parts.join(' ')
  }

  /** spline.cpp MovePoint：拖动时保持曲线连续（同步相邻端点） */
  movePoint(curveIndex: number, point: number, pos: Vec2): void {
    const curve = this.curves[curveIndex]
    if (!curve) return
    const previous = this.curves[curveIndex - 1]
    const next = this.curves[curveIndex + 1]
    if (point === 0) {
      curve.p1 = pos
      if (curve.type !== 'point' && previous) previous.p4 = pos // p4 对 LINE 类型无意义，但保持简单同步
      if (curve.type === 'point' && next && next.type !== 'point') next.p1 = pos
    } else if (point === 1) {
      curve.p2 = pos
      if (curve.type === 'line' && next) next.p1 = pos
    } else if (point === 2) {
      curve.p3 = pos
    } else if (point === 3) {
      curve.p4 = pos
      if (next) next.p1 = pos
    }
  }

  /** spline_curve.cpp Split：de Casteljau / 线性中点分割 */
  splitCurve(index: number, t: number): void {
    const curve = this.curves[index]
    if (!curve) return
    const lerp = (a: Vec2, b: Vec2, k: number): Vec2 =>
      vec(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k)
    if (curve.type === 'line') {
      const mid = lerp(curve.p1, curve.p2, t)
      this.curves[index] = lineCurve(curve.p1, mid)
      this.curves.splice(index + 1, 0, lineCurve(mid, curve.p2))
      return
    }
    if (curve.type === 'bicubic') {
      const { p1, p2, p3, p4 } = curve
      const p12 = lerp(p1, p2, t)
      const p23 = lerp(p2, p3, t)
      const p34 = lerp(p3, p4, t)
      const p123 = lerp(p12, p23, t)
      const p234 = lerp(p23, p34, t)
      const p1234 = lerp(p123, p234, t)
      this.curves[index] = { type: 'bicubic', p1, p2: p12, p3: p123, p4: p1234 }
      this.curves.splice(index + 1, 0, { type: 'bicubic', p1: p1234, p2: p234, p3: p34, p4 })
    }
  }

  /**
   * spline.cpp GetClosestParametricPoint：返回最近的曲线与参数。
   */
  /** 查找离 pos 最近的曲线与参数（用于 convert/insert 模式） */
  closestParametric(
    pos: Vec2,
    includeClosing = false,
  ): { index: number; t: number; point: Vec2 } | null {
    let best: { index: number; t: number; point: Vec2 } | null = null
    let bestDistance = Infinity

    const consider = (index: number, t: number, point: Vec2) => {
      const distance = (point.x - pos.x) ** 2 + (point.y - pos.y) ** 2
      if (distance < bestDistance) {
        bestDistance = distance
        best = { index, t, point }
      }
    }

    const sample = (index: number, points: Vec2[]) => {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]
        const b = points[i + 1]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const lengthSq = dx * dx + dy * dy
        const t =
          lengthSq === 0
            ? 0
            : Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / lengthSq))
        consider(index, (i + t) / (points.length - 1), vec(a.x + dx * t, a.y + dy * t))
      }
    }

    this.curves.forEach((curve, index) => {
      if (curve.type === 'point') return
      sample(index, curve.type === 'line' ? [curve.p1, curve.p2] : this.sampleBicubic(curve))
    })

    if (includeClosing && this.curves.length > 1) {
      const start = this.curves[0].p1
      const end = endPoint(this.curves[this.curves.length - 1])
      sample(this.curves.length, [end, start]) // index == length 表示闭合边
    }
    return best
  }

  /** bezier 采样折线（GetPoints：len/8 步） */
  sampleBicubic(curve: SplineCurve): Vec2[] {
    const length =
      Math.hypot(curve.p2.x - curve.p1.x, curve.p2.y - curve.p1.y) +
      Math.hypot(curve.p3.x - curve.p2.x, curve.p3.y - curve.p2.y) +
      Math.hypot(curve.p4.x - curve.p3.x, curve.p4.y - curve.p3.y)
    const steps = Math.max(4, Math.round(length / 8))
    const points: Vec2[] = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const mt = 1 - t
      points.push(
        vec(
          mt * mt * mt * curve.p1.x +
            3 * mt * mt * t * curve.p2.x +
            3 * mt * t * t * curve.p3.x +
            t * t * t * curve.p4.x,
          mt * mt * mt * curve.p1.y +
            3 * mt * mt * t * curve.p2.y +
            3 * mt * t * t * curve.p3.y +
            t * t * t * curve.p4.y,
        ),
      )
    }
    return points
  }

  /** spline.cpp Smooth：freehand_smooth 松开时把全部直线转为贝塞尔（smooth = 1.0） */
  smooth(): void {
    if (this.curves.length < 3) return
    const curves = this.curves
    const result: SplineCurve[] = []
    for (let i = 0; i < curves.length; i++) {
      const curve = curves[i]
      if (curve.type !== 'line') {
        result.push(curve)
        continue
      }
      const prev = curves[(i - 1 + curves.length) % curves.length]
      const next = curves[(i + 1) % curves.length]
      const p0 = prev.type === 'point' ? prev.p1 : endPoint(prev)
      const p1 = curve.p1
      const p2 = curve.p2
      const p5 = next.type === 'point' ? next.p1 : next.p1
      const c1 = vec((p0.x + p1.x) / 2, (p0.y + p1.y) / 2)
      const c2 = vec((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
      const c3 = vec((p2.x + p5.x) / 2, (p2.y + p5.y) / 2)
      const len1 = Math.hypot(p1.x - p0.x, p1.y - p0.y)
      const len2 = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      const total = len1 + len2
      const k1 = total > 0 ? len1 / total : 0.5
      const m1 = vec(c1.x + (c2.x - c1.x) * k1, c1.y + (c2.y - c1.y) * k1)
      const m2 = vec(c2.x + (c3.x - c2.x) * (1 - k1), c2.y + (c3.y - c2.y) * (1 - k1))
      const smooth = 1.0
      const ctrl1 = vec(
        m1.x + (c2.x - m1.x) * smooth + p1.x - m1.x,
        m1.y + (c2.y - m1.y) * smooth + p1.y - m1.y,
      )
      const ctrl2 = vec(
        m2.x + (c2.x - m2.x) * smooth + p2.x - m2.x,
        m2.y + (c2.y - m2.y) * smooth + p2.y - m2.y,
      )
      result.push({ type: 'bicubic', p1, p2: ctrl1, p3: ctrl2, p4: p2 })
    }
    this.curves = result
  }
}

/** 矩形 \clip(x1,y1,x2,y2) 转成可编辑折线（visual_tool.cpp GetLineVectorClip） */
export function rectangleToDrawing(x1: number, y1: number, x2: number, y2: number): string {
  const f = (v: number) => formatCoord(v)
  return `m ${f(x1)} ${f(y1)} l ${f(x2)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x1)} ${f(y2)}`
}

/** \clip(scale, ...)：脚本坐标 ↔ 标签坐标换算（factor = 2^(scale-1)） */
export function scaleSpline(spline: Spline, factor: number): Spline {
  const copy = new Spline()
  copy.scale = spline.scale
  const scalePoint = (p: Vec2): Vec2 => vec(p.x * factor, p.y * factor)
  copy.curves = spline.curves.map((curve) => ({
    ...curve,
    p1: scalePoint(curve.p1),
    p2: scalePoint(curve.p2),
    p3: scalePoint(curve.p3),
    p4: scalePoint(curve.p4),
  }))
  return copy
}
