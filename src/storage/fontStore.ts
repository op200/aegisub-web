/**
 * 字体缓存（Web 版"已安装字体"库）。
 *
 * 浏览器里拿不到系统字体文件字节（Local Font Access 仅 Chromium 有），Firefox
 * 下的等价通道是把字体文件交给页面：拖入窗口 / 导入按钮 → 解析名字 → 连同文件
 * 一起存 IndexedDB。之后 assRenderer 的字体供给按名字从缓存取字节注册进 libass，
 * 与 queryLocalFonts 路径共用同一条递交链。
 *
 * 元数据：ttf/otf/ttc 直接解析 sfnt name 表。名字收录对齐 fontconfig/DirectWrite
 * 的字体索引语义——nameID 1（家族）/16（首选家族）/4（全名）/6（PostScript 名）
 * 的**全部**记录（Windows/Mac 平台 × 全语言）都收进候选集并去重：ASS 引用名可能
 * 命中其中任意一条（如思源黑体的中文名只存在于 zh-CN 记录、FZ 字体的中文名在
 * fullName），只存第一条会导致按其他名字引用时匹配失败。解码按微软 name record
 * 规范的 platform/encoding 矩阵（与 fontTools toUnicode 同语义），遗留代码页
 * （Shift-JIS/GBK/Big5/EUC-KR）不能按 UTF-16BE 硬解。woff/woff2/fon 的表结构
 * 不同（woff2 还是 brotli 压缩），无依赖可解——退回用文件名（去扩展名）作匹配
 * 提示，字节交给 libass 后仍按字体真名注册，不影响渲染。
 */
import { openMainDatabase } from './db'

export interface FontFaceRecord {
  /** name 表全部家族名（nameID 1 + 16，全平台全语言去重） */
  families: string[]
  /** 全名（nameID 4，全记录去重） */
  fullNames: string[]
  /** PostScript 名（nameID 6，全记录去重） */
  postscriptNames: string[]
  style: string
  /** 来源文件名（woff/woff2/fon 的匹配兜底提示） */
  fileName: string
  size: number
  addedAt: number
  /** 字体文件本体（File 可结构化克隆，libass 只认字节） */
  data: Blob
}

const STORE = 'fonts'

/** 缓存内容版本：导入/清除时递增，供给器据此失效内存索引 */
let cacheVersion = 0
let faceCache: FontFaceRecord[] | null = null

export function fontCacheVersion(): number {
  return cacheVersion
}

function invalidateCache(): void {
  cacheVersion += 1
  faceCache = null
}

// ---------------------------------------------------------------------------
// sfnt name 表解析
// ---------------------------------------------------------------------------

interface SfntFace {
  families: string[]
  fullNames: string[]
  postscriptNames: string[]
  style: string
}

function tag4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

/** name 记录优先级：Windows en-US > Windows 其他 > Macintosh（仅用于 style 取主名） */
function nameRecordRank(platform: number, encoding: number, language: number): number {
  if (platform === 3) return language === 0x409 && encoding === 1 ? 0 : 1
  if (platform === 1) return 2
  return 3
}

// TextDecoder 不认 utf-16be / utf-32be，手动解（长度非整倍视为坏记录）
function decodeUtf16Be(raw: Uint8Array): string | null {
  if (raw.length % 2) return null
  let text = ''
  for (let i = 0; i + 1 < raw.length; i += 2)
    text += String.fromCharCode((raw[i] << 8) | raw[i + 1])
  return text
}

function decodeUtf32Be(raw: Uint8Array): string | null {
  if (raw.length % 4) return null
  let text = ''
  for (let i = 0; i + 3 < raw.length; i += 4) {
    text += String.fromCodePoint(
      ((raw[i] << 24) | (raw[i + 1] << 16) | (raw[i + 2] << 8) | raw[i + 3]) >>> 0,
    )
  }
  return text
}

const decoderCache = new Map<string, TextDecoder>()

/** 未知 label / 非法字节返回 null（fatal 模式，禁用 U+FFFD 替换） */
function decodeWith(label: string, raw: Uint8Array): string | null {
  try {
    let decoder = decoderCache.get(label)
    if (!decoder) {
      decoder = new TextDecoder(label, { fatal: true })
      decoderCache.set(label, decoder)
    }
    return decoder.decode(raw)
  } catch {
    return null
  }
}

/**
 * 按 OpenType 'name' 表规范解码（微软 name record 文档的 platform/encoding 矩阵，
 * 与 fontTools toUnicode / EasyRip subset.py 的家族名解析同语义）：
 * - platform 0 Unicode：encoding 0/1/3/5 → UTF-16BE，2/4/6 → UTF-32BE
 * - platform 1 Macintosh：encoding 0 → Mac Roman；1-32 已废弃，不猜
 * - platform 2 ISO：0 → ASCII，1 → UTF-16BE，2 → ISO 8859-1
 * - platform 3 Windows：0（Symbol）/1（UCS-2）/10（UCS-4）的 name 串均 UTF-16BE；
 *   遗留代码页 2 → Shift-JIS、3 → GBK、4 → Big5、5 → EUC-KR
 * 不认识的组合或非法字节返回 null（跳过该记录）——绝不能按错误编码硬解出乱码。
 */
function decodeNameString(raw: Uint8Array, platform: number, encoding: number): string | null {
  switch (platform) {
    case 0:
      if (encoding === 2 || encoding === 4 || encoding === 6) return decodeUtf32Be(raw)
      if (encoding === 0 || encoding === 1 || encoding === 3 || encoding === 5)
        return decodeUtf16Be(raw)
      return null
    case 1:
      if (encoding === 0) return decodeWith('macintosh', raw)
      return null
    case 2:
      if (encoding === 1) return decodeUtf16Be(raw)
      if (encoding === 0 || encoding === 2) return decodeWith('windows-1252', raw)
      return null
    case 3:
      if (encoding === 0 || encoding === 1 || encoding === 10) return decodeUtf16Be(raw)
      if (encoding === 2) return decodeWith('shift_jis', raw)
      if (encoding === 3) return decodeWith('gb18030', raw)
      if (encoding === 4) return decodeWith('big5', raw)
      if (encoding === 5) return decodeWith('euc-kr', raw)
      return null // 6 = Johab（TextDecoder 无此编码）等
    default:
      return null
  }
}

/** 追加候选名（大小写不敏感去重，保持出现顺序） */
function pushName(target: string[], seen: Set<string>, text: string): void {
  const trimmed = text.trim()
  const key = trimmed.toLowerCase()
  if (!key || seen.has(key)) return
  seen.add(key)
  target.push(trimmed)
}

function parseFaceNameTable(view: DataView, bytes: Uint8Array, base: number): SfntFace | null {
  const numTables = view.getUint16(base + 4)
  let nameOffset = 0
  for (let i = 0; i < numTables; i += 1) {
    const record = base + 12 + i * 16
    if (tag4(bytes, record) === 'name') {
      nameOffset = view.getUint32(record + 8)
      break
    }
  }
  if (!nameOffset) return null
  const count = view.getUint16(nameOffset + 2)
  const stringOffset = nameOffset + view.getUint16(nameOffset + 4)
  // nameID 1（家族）/16（首选家族）/4（全名）/6（PostScript）的全部记录进候选集；
  // 各列表独立去重（fullName 常与 family 相同，跨列表去重会把 postscriptNames 挤空）；
  // nameID 2（样式）取 rank 最小的一条
  const families: string[] = []
  const fullNames: string[] = []
  const postscriptNames: string[] = []
  const seenFamilies = new Set<string>()
  const seenFullNames = new Set<string>()
  const seenPostscript = new Set<string>()
  let bestStyle: { rank: number; text: string } | null = null
  for (let i = 0; i < count; i += 1) {
    const record = nameOffset + 6 + i * 12
    const platform = view.getUint16(record)
    const encoding = view.getUint16(record + 2)
    const nameId = view.getUint16(record + 6)
    if (nameId !== 1 && nameId !== 2 && nameId !== 4 && nameId !== 6 && nameId !== 16) continue
    const length = view.getUint16(record + 8)
    const offset = view.getUint16(record + 10)
    const text = decodeNameString(
      bytes.subarray(stringOffset + offset, stringOffset + offset + length),
      platform,
      encoding,
    )
    if (text === null) continue // 未按规范编码的坏记录直接跳过（subset.py 同语义）
    if (nameId === 2) {
      const rank = nameRecordRank(platform, encoding, view.getUint16(record + 4))
      if (text.trim() && (!bestStyle || rank < bestStyle.rank))
        bestStyle = { rank, text: text.trim() }
      continue
    }
    if (nameId === 1 || nameId === 16) pushName(families, seenFamilies, text)
    else if (nameId === 4) pushName(fullNames, seenFullNames, text)
    else pushName(postscriptNames, seenPostscript, text)
  }
  if (!families.length) return null
  return { families, fullNames, postscriptNames, style: bestStyle?.text ?? 'Regular' }
}

/** 解析 ttf/otf/ttc 的全部 face；非 sfnt（woff/woff2/fon 等）返回 null */
export function parseSfntFaces(bytes: Uint8Array): SfntFace[] | null {
  if (bytes.length < 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = tag4(bytes, 0)
  let offsets: number[]
  if (tag === 'ttcf') {
    const numFonts = view.getUint32(8)
    offsets = []
    for (let i = 0; i < numFonts; i += 1) offsets.push(view.getUint32(12 + i * 4))
  } else if (tag === 'wOFF' || tag === 'wOF2') {
    return null
  } else {
    offsets = [0] // ttf / OTTO / true / typ1 同一 sfnt 布局
  }
  const faces: SfntFace[] = []
  for (const offset of offsets) {
    try {
      const face = parseFaceNameTable(view, bytes, offset)
      if (face) faces.push(face)
    } catch {
      // 单个 face 解析失败不影响其余
    }
  }
  return faces.length ? faces : null
}

// ---------------------------------------------------------------------------
// 缓存操作
// ---------------------------------------------------------------------------

/** 旧版记录只有单名字段（family/fullName/postscriptName 各取一条）；读出时归一成
 * 数组形态，旧字体仍按原主名可匹配，重新导入后升级为全量名字 */
function normalizeFaceRecord(record: FontFaceRecord): FontFaceRecord {
  if (Array.isArray(record.families)) return record
  const legacy = record as unknown as {
    family?: string
    fullName?: string
    postscriptName?: string
  }
  return {
    families: legacy.family ? [legacy.family] : [],
    fullNames: legacy.fullName ? [legacy.fullName] : [],
    postscriptNames: legacy.postscriptName ? [legacy.postscriptName] : [],
    style: record.style,
    fileName: record.fileName,
    size: record.size,
    addedAt: record.addedAt,
    data: record.data,
  }
}

/** 名字集签名（导入去重用：尺寸相同但名字更全 → 原地覆盖升级） */
function nameSignature(record: FontFaceRecord): string {
  return [...record.families, ...record.fullNames, ...record.postscriptNames]
    .map((name) => name.toLowerCase())
    .sort()
    .join('\n')
}

/** face 的唯一键：首选 PostScript 名（缺失时退回文件名） */
function faceKey(record: FontFaceRecord): string {
  return (record.postscriptNames[0] ?? record.fileName).toLowerCase()
}

/** 导入字体文件（拖入 / 手动选择），返回新注册（含元数据升级）的 face 数 */
export async function importFontFiles(files: File[]): Promise<number> {
  if (!files.length) return 0
  const database = await openMainDatabase()
  const existing = await new Promise<Map<string, { size: number; signature: string }>>(
    (resolve, reject) => {
      const result = new Map<string, { size: number; signature: string }>()
      const request = database.transaction(STORE).objectStore(STORE).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          const face = normalizeFaceRecord(cursor.value as FontFaceRecord)
          result.set(cursor.key as string, { size: face.size, signature: nameSignature(face) })
          cursor.continue()
        } else resolve(result)
      }
      request.onerror = () => reject(request.error)
    },
  )

  // 事务外先完成文件读取与名字表解析（executor 里不能 await）
  const parsedBatches: FontFaceRecord[][] = []
  for (const file of files) {
    const baseName = file.name.replace(/\.[^.]+$/, '')
    const faces: FontFaceRecord[] = []
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()) // oxlint-disable-line eslint/no-await-in-loop
      for (const face of parseSfntFaces(bytes) ?? []) {
        faces.push({
          families: face.families,
          fullNames: face.fullNames,
          postscriptNames: face.postscriptNames,
          style: face.style,
          fileName: file.name,
          size: file.size,
          addedAt: Date.now(),
          data: file,
        })
      }
    } catch {
      // 读取失败按无元数据处理
    }
    if (!faces.length) {
      // woff/woff2/fon 等：文件名作匹配提示，交给 libass 读真名
      faces.push({
        families: [baseName],
        fullNames: [baseName],
        postscriptNames: [baseName],
        style: 'Regular',
        fileName: file.name,
        size: file.size,
        addedAt: Date.now(),
        data: file,
      })
    }
    parsedBatches.push(faces)
  }

  let added = 0
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    for (const faces of parsedBatches) {
      faces.forEach((face, index) => {
        const key = faceKey(face)
        const signature = nameSignature(face)
        const known = existing.get(key)
        // 完全相同（同尺寸同名集）跳过
        if (known && known.size === face.size && known.signature === signature) return
        // 同键 face 换了尺寸 → 另存 #index 追加；尺寸相同但名字更全（旧版单名
        // 记录升级为全量名字）→ 原键覆盖
        const target = known && known.size !== face.size ? `${key}#${index}` : key
        store.put(face, target)
        existing.set(target, { size: face.size, signature })
        added += 1
      })
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
  if (added) invalidateCache()
  return added
}

export async function listFontFaces(): Promise<FontFaceRecord[]> {
  if (faceCache) return faceCache
  const database = await openMainDatabase()
  const records = await new Promise<FontFaceRecord[]>((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).getAll()
    request.onsuccess = () => resolve((request.result as FontFaceRecord[]) ?? [])
    request.onerror = () => reject(request.error)
  })
  database.close()
  faceCache = records.map(normalizeFaceRecord)
  return faceCache
}

export async function clearFontCache(): Promise<void> {
  const database = await openMainDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
  invalidateCache()
}

/** 统计（Browser Cache 子页显示） */
export async function fontCacheStats(): Promise<{ count: number; bytes: number }> {
  const records = await listFontFaces()
  return { count: records.length, bytes: records.reduce((sum, record) => sum + record.size, 0) }
}
