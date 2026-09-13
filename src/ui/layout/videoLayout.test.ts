import { describe, expect, it } from 'vitest'

import { calculateAttachedVideoLayout } from './videoLayout'

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
})
