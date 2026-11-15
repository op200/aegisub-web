/**
 * 字幕文件编码检测与保存编码（对应 charset_detect.cpp + text_file_reader/writer）。
 *
 * 浏览器 TextDecoder 支持 WHATWG Encoding 的解码标签，TextEncoder 只支持 UTF-8；
 * 保存到传统编码时按需用 TextDecoder 反向生成码表（单字节编码全量 256 项，
 * 多字节编码扫描合法双字节序列），不做全量 Unicode 双向映射。
 */

export interface CharsetChoice {
  /** 传给 TextDecoder/TextEncoder 的 WHATWG 标签 */
  label: string
  /** 界面显示名（与 iconv 名称习惯一致） */
  name: string
}

/** 编码选择框候选（Aegisub 的 iconv 列表在 Web 上按 TextDecoder 能力收缩） */
export const CHARSET_CHOICES: CharsetChoice[] = [
  { label: 'utf-8', name: 'UTF-8' },
  { label: 'utf-16le', name: 'UTF-16LE' },
  { label: 'utf-16be', name: 'UTF-16BE' },
  { label: 'gb18030', name: 'GB18030' },
  { label: 'big5', name: 'Big5' },
  { label: 'shift_jis', name: 'Shift_JIS' },
  { label: 'euc-kr', name: 'EUC-KR' },
  { label: 'euc-jp', name: 'EUC-JP' },
  { label: 'windows-1252', name: 'Windows-1252' },
  { label: 'windows-1250', name: 'Windows-1250' },
  { label: 'windows-1251', name: 'Windows-1251' },
  { label: 'windows-1253', name: 'Windows-1253' },
  { label: 'windows-1254', name: 'Windows-1254' },
  { label: 'windows-1255', name: 'Windows-1255' },
  { label: 'windows-1256', name: 'Windows-1256' },
  { label: 'windows-1257', name: 'Windows-1257' },
  { label: 'windows-1258', name: 'Windows-1258' },
  { label: 'iso-8859-1', name: 'ISO-8859-1' },
  { label: 'iso-8859-2', name: 'ISO-8859-2' },
  { label: 'iso-8859-5', name: 'ISO-8859-5' },
  { label: 'iso-8859-7', name: 'ISO-8859-7' },
  { label: 'iso-8859-15', name: 'ISO-8859-15' },
  { label: 'koi8-r', name: 'KOI8-R' },
  { label: 'koi8-u', name: 'KOI8-U' },
  { label: 'ibm866', name: 'IBM866' },
  { label: 'macintosh', name: 'Macintosh' },
]

/** 自动检测优先尝试的多字节编码（uchardet 的常见结果子集） */
const MULTIBYTE_CANDIDATES = ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'euc-jp']

export interface DecodeResult {
  text: string
  /** 实际使用的 WHATWG 标签 */
  encoding: string
  /** UTF-8 BOM / UTF-16 BOM 等确定命中；false 表示需要用户确认编码 */
  definite: boolean
  binary: boolean
}

function hasBom(bytes: Uint8Array, bom: number[]): boolean {
  if (bytes.length < bom.length) return false
  return bom.every((value, index) => bytes[index] === value)
}

function isBinary(bytes: Uint8Array): boolean {
  // charset_detect.cpp：控制字符（除 \r\n\t 与常见 0x1B）占比过高按二进制处理
  let control = 0
  const limit = Math.min(bytes.length, 8192)
  for (let index = 0; index < limit; index += 1) {
    const byte = bytes[index]
    if (byte === 0) continue // NUL 在 UTF-16 中合法，单独判断
    if (byte < 0x09 || (byte > 0x0d && byte < 0x1b)) control += 1
  }
  return limit > 0 && control / limit > 0.1
}

function utf16Guess(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return null
  let evenZero = 0
  let oddZero = 0
  const limit = Math.min(bytes.length, 8192)
  for (let index = 0; index + 1 < limit; index += 2) {
    if (bytes[index] === 0) evenZero += 1
    if (bytes[index + 1] === 0) oddZero += 1
  }
  const pairs = Math.floor(limit / 2)
  if (pairs === 0) return null
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return 'utf-16le'
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return 'utf-16be'
  return null
}

function decodeWith(label: string, bytes: Uint8Array): string {
  return new TextDecoder(label).decode(bytes)
}

function validUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 替换字符与控制字符比例越低越可信；含 CJK 等非 ASCII 文字加分 */
function scoreDecoded(text: string): number {
  if (!text) return 0
  let bad = 0
  let useful = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0xfffd) bad += 1
    else if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) bad += 1
    else if (code >= 0x80) useful += 1
  }
  return bad * 10 - useful * 0.05
}

/** 自动检测编码（charset_detect.cpp Detect 的 Web 近似实现） */
export function detectEncoding(bytes: Uint8Array): DecodeResult {
  if (hasBom(bytes, [0xef, 0xbb, 0xbf])) {
    return { text: decodeWith('utf-8', bytes), encoding: 'utf-8', definite: true, binary: false }
  }
  if (hasBom(bytes, [0xff, 0xfe])) {
    return {
      text: decodeWith('utf-16le', bytes),
      encoding: 'utf-16le',
      definite: true,
      binary: false,
    }
  }
  if (hasBom(bytes, [0xfe, 0xff])) {
    return {
      text: decodeWith('utf-16be', bytes),
      encoding: 'utf-16be',
      definite: true,
      binary: false,
    }
  }
  if (isBinary(bytes)) {
    return { text: '', encoding: 'utf-8', definite: true, binary: true }
  }
  const utf8 = validUtf8(bytes)
  if (utf8 !== null) {
    const text = utf8.replace(/^\uFEFF/, '')
    // UTF-16 文本（含大量 NUL）也可能碰巧通过 UTF-8 校验
    if (text.includes('\u0000')) {
      const guess = utf16Guess(bytes)
      if (guess) {
        return {
          text: decodeWith(guess, bytes).replace(/^\uFEFF/, ''),
          encoding: guess,
          definite: true,
          binary: false,
        }
      }
    }
    return { text, encoding: 'utf-8', definite: true, binary: false }
  }

  const guess16 = utf16Guess(bytes)
  if (guess16) {
    return {
      text: decodeWith(guess16, bytes).replace(/^\uFEFF/, ''),
      encoding: guess16,
      definite: true,
      binary: false,
    }
  }

  let bestLabel = 'windows-1252'
  let bestText = decodeWith(bestLabel, bytes)
  let bestScore = scoreDecoded(bestText)
  for (const label of MULTIBYTE_CANDIDATES) {
    const text = decodeWith(label, bytes)
    const score = scoreDecoded(text)
    if (score < bestScore) {
      bestLabel = label
      bestText = text
      bestScore = score
    }
  }
  // 无替换且命中多字节候选时视为可靠；否则交给用户确认（Aegisub 无 uchardet 时默认 UTF-8）
  const definite = bestLabel !== 'windows-1252' && !bestText.includes('\uFFFD')
  return {
    text: bestText.replace(/^\uFEFF/, ''),
    encoding: bestLabel,
    definite,
    binary: false,
  }
}

/** 指定编码解码（非法字节替换为 U+FFFD） */
export function decodeWithEncoding(bytes: Uint8Array, encoding: string): DecodeResult {
  if (!encoding) return detectEncoding(bytes)
  const label = normalizeLabel(encoding)
  return {
    text: decodeWith(label, bytes).replace(/^\uFEFF/, ''),
    encoding: label,
    definite: true,
    binary: false,
  }
}

export function normalizeLabel(encoding: string): string {
  const trimmed = encoding.trim()
  if (!trimmed) return 'utf-8'
  const lower = trimmed.toLowerCase()
  if (lower === 'utf8') return 'utf-8'
  if (lower === 'utf16' || lower === 'utf-16') return 'utf-16le'
  const found = CHARSET_CHOICES.find(
    (choice) => choice.label === lower || choice.name.toLowerCase() === lower,
  )
  return found?.label ?? lower
}

export function charsetName(label: string): string {
  return CHARSET_CHOICES.find((choice) => choice.label === label)?.name ?? label
}

// ---------------------------------------------------------------------------
// 编码（保存）
// ---------------------------------------------------------------------------

const SINGLE_BYTE_LABELS = new Set(
  CHARSET_CHOICES.filter(
    (choice) =>
      ![
        'utf-8',
        'utf-16le',
        'utf-16be',
        'gb18030',
        'big5',
        'shift_jis',
        'euc-kr',
        'euc-jp',
      ].includes(choice.label),
  ).map((choice) => choice.label),
)

/** 多字节编码的合法首/尾字节范围（只覆盖常用双字节区，GB18030 四字节区除外） */
const MULTIBYTE_RANGES: Record<string, { lead: number[]; trail: number[] }[]> = {
  gb18030: [{ lead: range(0x81, 0xfe), trail: range(0x40, 0xfe).filter((b) => b !== 0x7f) }],
  big5: [{ lead: range(0x81, 0xfe), trail: [...range(0x40, 0x7e), ...range(0xa1, 0xfe)] }],
  shift_jis: [
    {
      lead: [...range(0x81, 0x9f), ...range(0xe0, 0xfc)],
      trail: [...range(0x40, 0x7e), ...range(0x80, 0xfc)],
    },
  ],
  'euc-kr': [{ lead: range(0xa1, 0xfe), trail: range(0xa1, 0xfe) }],
  'euc-jp': [
    { lead: range(0xa1, 0xfe), trail: range(0xa1, 0xfe) },
    { lead: [0x8e], trail: range(0xa1, 0xdf) },
  ],
}

const encodeCache = new Map<string, Map<string, number[]>>()

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let value = from; value <= to; value += 1) out.push(value)
  return out
}

function buildEncodeMap(label: string): Map<string, number[]> {
  const cached = encodeCache.get(label)
  if (cached) return cached
  const map = new Map<string, number[]>()
  if (SINGLE_BYTE_LABELS.has(label)) {
    const decoder = new TextDecoder(label)
    for (let byte = 0x20; byte <= 0xff; byte += 1) {
      const char = decoder.decode(new Uint8Array([byte]))
      if (char.length === 1 && char !== '\uFFFD' && !map.has(char)) map.set(char, [byte])
    }
  } else {
    const decoder = new TextDecoder(label)
    const ranges = MULTIBYTE_RANGES[label] ?? []
    for (const { lead, trail } of ranges) {
      for (const first of lead) {
        for (const second of trail) {
          const bytes = new Uint8Array([first, second])
          const char = decoder.decode(bytes)
          // 只有解码为单个非替换字符才是合法序列
          if (char.length === 1 && char !== '\uFFFD' && !map.has(char))
            map.set(char, [first, second])
        }
      }
    }
  }
  encodeCache.set(label, map)
  return map
}

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const out: number[] = littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]
  for (const char of text) {
    let code = char.codePointAt(0) ?? 0
    const push = (value: number) => {
      if (littleEndian) out.push(value & 0xff, (value >> 8) & 0xff)
      else out.push((value >> 8) & 0xff, value & 0xff)
    }
    if (code > 0xffff) {
      code -= 0x10000
      push(0xd800 + (code >> 10))
      push(0xdc00 + (code & 0x3ff))
    } else {
      push(code)
    }
  }
  return new Uint8Array(out)
}

/**
 * 按指定编码编码文本（TextFileWriter 构造时总是写 BOM）。
 * 目标编码无法表示某字符时抛错，与 iconv ConversionFailure 中断保存一致。
 */
export function encodeText(text: string, encoding: string): Uint8Array {
  const label = normalizeLabel(encoding)
  if (label === 'utf-8') {
    const body = new TextEncoder().encode(text)
    const out = new Uint8Array(body.length + 3)
    out.set([0xef, 0xbb, 0xbf], 0)
    out.set(body, 3)
    return out
  }
  if (label === 'utf-16le') return encodeUtf16(text, true)
  if (label === 'utf-16be') return encodeUtf16(text, false)

  const map = buildEncodeMap(label)
  const out: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e)) {
      out.push(code)
      continue
    }
    if (code === 0xfeff) {
      // BOM 在非 Unicode 编码中按 U+FEFF 编码（如果目标编码能表示）
      const mapped = map.get(char)
      if (mapped) out.push(...mapped)
      continue
    }
    const mapped = map.get(char)
    if (!mapped) throw new Error(`Character "${char}" cannot be encoded as ${label}`)
    out.push(...mapped)
  }
  return new Uint8Array(out)
}
