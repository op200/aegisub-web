import { createDefaultStyle, makeId } from './defaults'
import type { SubtitleStyle } from './types'

const STYLE_COLUMNS = [
  'Name',
  'Fontname',
  'Fontsize',
  'PrimaryColour',
  'SecondaryColour',
  'OutlineColour',
  'BackColour',
  'Bold',
  'Italic',
  'Underline',
  'StrikeOut',
  'ScaleX',
  'ScaleY',
  'Spacing',
  'Angle',
  'BorderStyle',
  'Outline',
  'Shadow',
  'Alignment',
  'MarginL',
  'MarginR',
  'MarginV',
  'Encoding',
]

function bool(value: string) {
  return value === '-1' || value === '1' || value.toLowerCase() === 'true'
}

export function parseStyleCatalog(text: string): SubtitleStyle[] {
  const result: SubtitleStyle[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || !line.trimStart().startsWith('Style:')) continue
    const values = line
      .slice(line.indexOf(':') + 1)
      .split(',')
      .map((value) => value.trim())
    const value = (key: string, fallback = '') => values[STYLE_COLUMNS.indexOf(key)] ?? fallback
    result.push({
      ...createDefaultStyle(value('Name', 'Default')),
      id: makeId('style'),
      name: value('Name', 'Default'),
      fontName: value('Fontname', 'Arial'),
      fontSize: Number(value('Fontsize', '48')),
      primaryColor: value('PrimaryColour', '&H00FFFFFF'),
      secondaryColor: value('SecondaryColour', '&H0000FFFF'),
      outlineColor: value('OutlineColour', '&H00000000'),
      backColor: value('BackColour', '&H80000000'),
      bold: bool(value('Bold')),
      italic: bool(value('Italic')),
      underline: bool(value('Underline')),
      strikeout: bool(value('StrikeOut')),
      scaleX: Number(value('ScaleX', '100')),
      scaleY: Number(value('ScaleY', '100')),
      spacing: Number(value('Spacing')),
      angle: Number(value('Angle')),
      borderStyle: Number(value('BorderStyle', '1')),
      outline: Number(value('Outline', '2')),
      shadow: Number(value('Shadow')),
      alignment: Number(value('Alignment', '2')),
      marginL: Number(value('MarginL')),
      marginR: Number(value('MarginR')),
      marginV: Number(value('MarginV')),
      encoding: Number(value('Encoding', '1')),
      values: Object.fromEntries(STYLE_COLUMNS.map((key, index) => [key, values[index] ?? ''])),
    })
  }
  return result
}

export function exportStyleCatalog(styles: SubtitleStyle[]): string {
  return `\uFEFF${styles
    .map((style) => {
      const values = [
        style.name,
        style.fontName,
        style.fontSize,
        style.primaryColor,
        style.secondaryColor,
        style.outlineColor,
        style.backColor,
        style.bold ? -1 : 0,
        style.italic ? -1 : 0,
        style.underline ? -1 : 0,
        style.strikeout ? -1 : 0,
        style.scaleX,
        style.scaleY,
        style.spacing,
        style.angle,
        style.borderStyle,
        style.outline,
        style.shadow,
        style.alignment,
        style.marginL,
        style.marginR,
        style.marginV,
        style.encoding,
      ]
      return `Style: ${values.join(',')}`
    })
    .join('\n')}\n`
}
