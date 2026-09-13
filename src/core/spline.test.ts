import { describe, expect, it } from 'vitest'

import { Spline, rectangleToDrawing, scaleSpline } from './spline'

describe('Spline（spline.cpp 语义）', () => {
  it('DecodeFromAss 解析 m/l/b 与隐式连续坐标', () => {
    const spline = new Spline()
    spline.decode('m 10 20 l 30 40 50 60 b 1 2 3 4 5 6')
    expect(spline.curves).toHaveLength(4)
    expect(spline.curves[0].type).toBe('point')
    expect(spline.curves[1].type).toBe('line')
    // 隐式连续坐标：线段首尾相接
    expect(spline.curves[1].p1).toEqual({ x: 10, y: 20 })
    expect(spline.curves[1].p2).toEqual({ x: 30, y: 40 })
    expect(spline.curves[2].type).toBe('line')
    expect(spline.curves[2].p1).toEqual({ x: 30, y: 40 })
    expect(spline.curves[2].p2).toEqual({ x: 50, y: 60 })
    expect(spline.curves[3].type).toBe('bicubic')
    expect(spline.curves[3].p4).toEqual({ x: 5, y: 6 })
  })

  it('EncodeToAss：命令字母分组、两位小数去尾零', () => {
    const spline = new Spline()
    spline.decode('m 10.00 20.50 l 30.00 40')
    expect(spline.encode()).toBe('m 10 20.5 l 30 40')
  })

  it('scale ≠ 1 时编码带前缀（scaleSpline 换算）', () => {
    const spline = new Spline()
    spline.decode('m 1 1 l 3 1')
    spline.scale = 2
    const scaled = scaleSpline(spline, 2 ** (2 - 1))
    expect(scaled.encode()).toBe('2,m 2 2 l 6 2')
  })

  it('MovePoint：直线端点同步下一段起点', () => {
    const spline = new Spline()
    spline.decode('m 0 0 l 10 0 l 20 0')
    spline.movePoint(1, 1, { x: 15, y: 5 })
    expect(spline.curves[1].p2).toEqual({ x: 15, y: 5 })
    expect(spline.curves[2].p1).toEqual({ x: 15, y: 5 })
  })

  it('SplitCurve：直线中点分割', () => {
    const spline = new Spline()
    spline.decode('m 0 0 l 10 0')
    spline.splitCurve(1, 0.5)
    expect(spline.curves).toHaveLength(3)
    expect(spline.curves[1].p2).toEqual({ x: 5, y: 0 })
    expect(spline.curves[2].p1).toEqual({ x: 5, y: 0 })
  })

  it('closestParametric：找到最近线段与参数', () => {
    const spline = new Spline()
    spline.decode('m 0 0 l 100 0')
    const closest = spline.closestParametric({ x: 80, y: 3 })
    expect(closest).not.toBeNull()
    expect(closest!.index).toBe(1)
    expect(closest!.point.x).toBeCloseTo(80, 0)
  })

  it('矩形 clip 转折线', () => {
    expect(rectangleToDrawing(0, 0, 100, 50)).toBe('m 0 0 l 100 0 100 50 0 50')
  })
})
