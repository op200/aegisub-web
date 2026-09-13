import type { SubtitleCue, SubtitleDocument, SubtitleStyle } from './types'

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function createDefaultStyle(name = 'Default'): SubtitleStyle {
  return {
    id: makeId('style'),
    name,
    fontName: 'Arial',
    fontSize: 48,
    primaryColor: '&H00FFFFFF',
    secondaryColor: '&H0000FFFF',
    outlineColor: '&H00000000',
    backColor: '&H80000000',
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    scaleX: 100,
    scaleY: 100,
    spacing: 0,
    angle: 0,
    borderStyle: 1,
    outline: 2,
    shadow: 0,
    alignment: 2,
    marginL: 10,
    marginR: 10,
    marginV: 24,
    encoding: 1,
    values: {},
  }
}

export function createCue(startMs = 0, endMs = 5000): SubtitleCue {
  return {
    id: makeId('cue'),
    layer: 0,
    startMs,
    endMs,
    style: 'Default',
    actor: '',
    marginL: 0,
    marginR: 0,
    marginV: 0,
    effect: '',
    text: '',
    comment: false,
    extra: {},
  }
}

/**
 * 新建文档（subtitle.cpp NewSubtitles）。
 * 分辨率来自 Preferences 的 Subtitle/Default Resolution（Auto 时由 App 传入视频分辨率）。
 */
export function createDocument(
  sourceName = 'untitled.ass',
  resolution: { width: number; height: number } = { width: 1280, height: 720 },
): SubtitleDocument {
  const cue = createCue()
  cue.text = 'Welcome to Aegisub Web'
  return {
    format: 'ass',
    sourceName,
    revision: 0,
    scriptInfo: {
      ScriptType: 'v4.00+',
      PlayResX: String(Math.max(1, Math.round(resolution.width))),
      PlayResY: String(Math.max(1, Math.round(resolution.height))),
      WrapStyle: '0',
      ScaledBorderAndShadow: 'yes',
      'YCbCr Matrix': 'TV.709',
    },
    styles: [createDefaultStyle()],
    cues: [cue],
    passthroughSections: [],
  }
}
