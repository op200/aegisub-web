import { describe, expect, it } from 'vitest'

import { createCue, createDocument } from './defaults'
import {
  attachmentBytes,
  exportAss,
  exportSrt,
  formatCueEntryData,
  makeAttachment,
  parseAss,
  parseCueEntryData,
  parseCueEntryLines,
  parseSrt,
} from './format'
import {
  exportEbu,
  exportEncore,
  exportMicrodvd,
  exportTranStation,
  exportTtxt,
  parseMicrodvd,
  parseTtxt,
} from './formatExtra'

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
Last Style Storage: Default

[Aegisub Extradata]
Data: 0,note,ehello

[Custom Section]
foo: bar`

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
    expect(document.extradata).toEqual([{ id: 0, key: 'note', value: 'hello' }])
    expect(document.passthroughSections).toEqual([{ name: 'Custom Section', lines: ['foo: bar'] }])
    expect(exported).toContain('[Aegisub Extradata]')
    expect(exported).toContain('Data: 0,note,ehello')
    expect(exported).toContain('[Custom Section]')
  })

  it('round-trips embedded fonts through UUEncode', () => {
    const document = parseAss(ASS_SAMPLE, 'sample.ass')
    document.attachments = [makeAttachment('font.ttf', new TextEncoder().encode('hello'), 'font')]
    const exported = exportAss(document)
    expect(exported).toContain('[Fonts]')
    expect(exported).toContain('fontname: font_0.ttf')
    const reparsed = parseAss(exported, 'roundtrip.ass')
    expect(reparsed.attachments).toHaveLength(1)
    expect(reparsed.attachments[0].name).toBe('font_0.ttf')
    expect(new TextDecoder().decode(attachmentBytes(reparsed.attachments[0]))).toBe('hello')
  })
})

describe('extra formats', () => {
  const makeDocument = (text: string) => {
    const document = createDocument()
    const cue = createCue(1000, 3000)
    cue.text = text
    document.cues = [cue]
    return document
  }

  it('round-trips MicroDVD with an embedded frame rate', () => {
    const text = exportMicrodvd(makeDocument('Hi\\Nthere'), { fps: 25 })
    expect(text.split('\r\n')[0]).toBe('{1}{1}25.000000')
    // FrameAtTime END 取前一毫秒（vfr.cpp），3000ms → 帧 74
    expect(text).toContain('{25}{74}Hi|there')
    const parsed = parseMicrodvd(text, 'sample.sub')
    // TimeAtFrame START/END 取相邻帧中点（vfr.cpp）
    expect(parsed.cues[0].startMs).toBe(980)
    expect(parsed.cues[0].endMs).toBe(2980)
    expect(parsed.cues[0].text).toBe('Hi\\Nthere')
  })

  it('round-trips TTXT text and newlines', () => {
    const text = exportTtxt(makeDocument('Hi\\Nthere'))
    expect(text).toContain('<TextStream')
    const parsed = parseTtxt(text, 'sample.ttxt')
    expect(parsed.cues[0].text).toBe('Hi\\Nthere')
  })

  it('writes EBU STL as GSI plus 128-byte blocks', () => {
    const bytes = exportEbu(makeDocument('Hi there'))
    expect(bytes.length % 128).toBe(0)
    expect(bytes.length).toBeGreaterThan(1024)
    const gsi = new TextDecoder('ascii').decode(bytes.subarray(3, 11))
    expect(gsi).toBe('STL25.01')
  })

  it('writes TranStation and Encore frame-based lines', () => {
    expect(exportTranStation(makeDocument('Hi'), { fps: 25 })).toContain('SUB[')
    expect(exportEncore(makeDocument('Hi'), { fps: 25 })).toMatch(
      /^\d+ \d{2}:\d{2}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}:\d{2} Hi/m,
    )
  })
})

describe('SRT format', () => {
  it('parses multiline cues and converts ASS tags to SRT styles on export', () => {
    const document = parseSrt(
      '1\n00:00:01,250 --> 00:00:03,000\nFirst line\nSecond line',
      'sample.srt',
    )
    expect(document.cues[0].text).toBe('First line\\NSecond line')
    document.cues[0].text = '{\\b1}Bold{\\b0}\\NNext'
    expect(exportSrt(document)).toContain('<b>Bold</b>\r\nNext')
  })
})

describe('line clipboard', () => {
  it('writes AssDialogue::GetEntryData format', () => {
    const cue = createCue(1200, 4500)
    cue.comment = true
    cue.layer = 2
    cue.style = 'Default,Alt'
    cue.actor = 'A,B'
    cue.marginL = 10
    cue.effect = 'E'
    cue.text = 'Hello,\\Nworld'
    expect(formatCueEntryData(cue)).toBe(
      'Comment: 2,0:00:01.20,0:00:04.50,Default;Alt,A;B,10,0,0,E,Hello,\\Nworld',
    )
  })

  it('parses ASS lines and falls back to null for plain text', () => {
    const parsed = parseCueEntryData(
      'Dialogue: 0,0:00:01.20,0:00:04.50,Default,Speaker,0000,0001,0002,,Hi, there',
    )
    expect(parsed).toMatchObject({
      layer: 0,
      startMs: 1200,
      endMs: 4500,
      style: 'Default',
      actor: 'Speaker',
      marginR: 1,
      marginV: 2,
      text: 'Hi, there',
      comment: false,
    })
    expect(parseCueEntryData('plain text')).toBeNull()
    expect(parseCueEntryData('Dialogue: 0,0:00:01.20')).toBeNull()
  })

  it('accepts SSA Marked= lines and requires every line to parse', () => {
    expect(
      parseCueEntryData('Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,text'),
    ).toMatchObject({ layer: 0, text: 'text' })
    expect(
      parseCueEntryLines(
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,one\r\nComment: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,two',
      ),
    ).toHaveLength(2)
    expect(
      parseCueEntryLines('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,one\r\nplain text'),
    ).toBeNull()
  })
})
