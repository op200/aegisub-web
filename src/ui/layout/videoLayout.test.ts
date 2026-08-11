import { describe, expect, it } from 'vitest';
import { calculateAttachedVideoLayout, initialVideoZoom } from './videoLayout';

describe('attached video layout', () => {
  it('uses source size at 100 percent', () => {
    expect(calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1, 16 / 9)).toMatchObject({
      displayWidth: 1280,
      displayHeight: 720,
      panelWidth: 1311,
      panelHeight: 776,
    });
  });

  it('keeps overridden aspect ratio without collapsing the requested zoom', () => {
    const layout = calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1, 4 / 3);
    expect(layout.displayWidth / layout.displayHeight).toBeCloseTo(4 / 3, 2);
  });

  it('changes the panel size for every zoom step', () => {
    const at100 = calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1, 16 / 9);
    const at112_5 = calculateAttachedVideoLayout({ width: 1280, height: 720 }, 1.125, 16 / 9);
    expect(at112_5.panelWidth).toBeGreaterThan(at100.panelWidth);
    expect(at112_5.panelHeight).toBeGreaterThan(at100.panelHeight);
  });

  it('reduces an oversized video when first opened', () => {
    expect(initialVideoZoom({ width: 1920, height: 1080 }, 1, { width: 1000, height: 700 })).toBe(0.25);
  });
});
