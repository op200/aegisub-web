import { describe, expect, it } from 'vitest'

import { exportAss, exportSrt, parseAss, parseSrt } from './format'

const ASS_SAMPLE = `[Script Info]
Title: Test project
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,52,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,0010,0010,0020,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:04.50,Default,Speaker,0000,0000,0000,,Hello,{\\i1}world{\\i0}, again

[Aegisub Project Garbage]
Last Style Storage: Default`

describe('ASS format', () => {
  it('preserves document fields and override text through export', () => {
    const document = parseAss(ASS_SAMPLE, 'sample.ass')
    expect(document.scriptInfo.Title).toBe('Test project')
    expect(document.styles[0].fontName).toBe('Noto Sans')
    expect(document.styles[0].bold).toBe(true)
    expect(document.cues[0].startMs).toBe(1200)
    expect(document.cues[0].text).toBe('Hello,{\\i1}world{\\i0}, again')
    const exported = exportAss(document)
    expect(exported).toContain('Dialogue: 0,0:00:01.20,0:00:04.50')
    expect(exported).toContain('{\\i1}world{\\i0}, again')
    expect(exported).toContain('[Aegisub Project Garbage]')
  })
})

describe('SRT format', () => {
  it('parses multiline cues and strips ASS tags during export', () => {
    const document = parseSrt(
      '1\n00:00:01,250 --> 00:00:03,000\nFirst line\nSecond line',
      'sample.srt',
    )
    expect(document.cues[0].text).toBe('First line\\NSecond line')
    document.cues[0].text = '{\\b1}Bold{\\b0}\\NNext'
    expect(exportSrt(document)).toContain('Bold\r\nNext')
  })
})
