import { describe, expect, it } from 'vitest'

import { calculateAttachedVideoLayout, fitWindowZoomToVideo } from './videoLayout'

describe('window zoom on video open', () => {
  // frame_main.cpp FrameMain::OnVideoOpen
  it('halves the zoom when the video is wider than two thirds of the window', () => {
    expect(fitWindowZoomToVideo({ width: 1920, height: 1080 }, 1, 1920, 1080)).toBe(0.5)
  })

  it('quarters the zoom when the video is wider than the window', () => {
    expect(fitWindowZoomToVideo({ width: 3840, height: 2160 }, 1, 1920, 1080)).toBe(0.25)
  })

  it('keeps the zoom when the video fits', () => {
    expect(fitWindowZoomToVideo({ width: 1280, height: 720 }, 1, 1920, 1080)).toBe(1)
  })

  it('applies the reduction to the current zoom and clamps at 12.5 percent', () => {
    expect(fitWindowZoomToVideo({ width: 3840, height: 2160 }, 0.5, 1920, 1080)).toBe(0.25)
    expect(fitWindowZoomToVideo({ width: 3840, height: 2160 }, 0.25, 1280, 720)).toBe(0.125)
  })
})

describe('attached video layout', () => {
  it('uses source size at 100 percent', () => {
    expect(calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1, 16 / 9)).toMatchObject({
      displayWidth: 1280,
      displayHeight: 720,
      panelWidth: 1311,
      panelHeight: 776,
    })
  })

  it('keeps overridden aspect ratio without collapsing the requested zoom', () => {
    const layout = calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1, 4 / 3)
    expect(layout.displayWidth / layout.displayHeight).toBeCloseTo(4 / 3, 2)
  })

  it('changes the panel size for every zoom step', () => {
    const at100 = calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1, 16 / 9)
    const at112_5 = calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1.125, 16 / 9)
    expect(at112_5.panelWidth).toBeGreaterThan(at100.panelWidth)
    expect(at112_5.panelHeight).toBeGreaterThan(at100.panelHeight)
  })

  it('divides display size by device pixel ratio so 100% zoom stays point-to-point', () => {
    // video_display.cpp：viewport = video × zoom 是物理像素，客户区 = 物理 / scale_factor
    expect(calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1, 16 / 9, 2)).toMatchObject({
      displayWidth: 640,
      displayHeight: 360,
      panelWidth: 671,
      panelHeight: 416,
    })
  })
})
