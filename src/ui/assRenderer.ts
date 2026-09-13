/**
 * JASSUB（libass WASM）字幕渲染器包装。
 *
 * 对应原版 Aegisub 的 SubtitlesProvider（src/subtitles_provider_libass.cpp）：
 * 编辑文档序列化为 ASS 文本喂给 libass，渲染到独立 canvas 叠在视频上，
 * 交互 canvas（PreviewPane 的 .subtitle-overlay）保留 visual tools 与辅助绘制。
 *
 * - worker/wasm 资产经 Vite ?worker&url / ?url 打包，仅在创建实例时加载（懒加载）
 * - 字体供给对齐原版 Aegisub（fontconfig/DirectWrite 提供系统字体）：解析字幕
 *   引用的字体名，按优先级从 Local Font Access（Chromium，需授权）与 IndexedDB
 *   字体缓存（拖入/导入的字体文件）读出字体文件字节预载进 libass（fonts 选项，
 *   embedded provider 按字体真名注册）——请求 Arial 就渲染真 Arial；两个来源
 *   都没有时按需懒加载 availableFonts 兜底。libass 0.17 没有
 *   跨字体的字形级回退（find_font 只对家族名命中的字体检查 check_glyph），因此
 *   default font 必须覆盖全部用到的字形——指向 Noto Sans SC（OFL，见
 *   src/assets/fonts/NotoSansSC-LICENSE.txt，拉丁+CJK 全覆盖）
 * - 内嵌字体（track 的 [Fonts]）由 libass 原生解析，优先级与原版一致
 * - setTrack 防抖（编辑器高频修改）；render 由 PreviewPane 的时间/尺寸变化驱动
 */
import JASSUB from 'jassub'
import jassubDefaultFontUrl from 'jassub/dist/default.woff2?url'
import jassubModernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url'
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url'
import jassubWorkerUrl from 'jassub/dist/worker/worker.js?worker&url'

// NotoSansSC 来自 Google Fonts。woff 单文件下载技巧：css2 API 用 Chrome 35 UA
// （支持 woff、不支持 unicode-range）返回单文件完整 woff；现代 UA 会返回分片
import cjkFallbackFontUrl from '../assets/fonts/NotoSansSC-Regular.woff?url'
import { fontCacheVersion, listFontFaces, type FontFaceRecord } from '../storage/fontStore'
import { logInfo, logWarning } from './log'

export interface AssRenderer {
  /** 全量替换 track（内部防抖） */
  setTrack(content: string): void
  /**
   * 渲染某一时刻。storage 为视频分辨率坐标（真实视频 = videoWidth/Height，
   * dummy = dummy 宽高），同时把 canvas 对齐到宿主内媒体元素的位置与尺寸。
   */
  render(timeMs: number, storageWidth: number, storageHeight: number): void
  destroy(): void
}

const SET_TRACK_DEBOUNCE_MS = 250
const READY_TIMEOUT_MS = 20000

/** exportAss 产物带 UTF-8 BOM，libass 的行解析不认，去掉 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Local Font Access API（Chromium，TypeScript 标准库尚未收录） */
interface LocalFontInfo {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob(): Promise<Blob>
}

/** 收集字幕引用的字体名：Style 行的 fontname + 文本里的 \fn 覆写。
 * \fn 前缀 @ 是竖排标记（libass 解析时自行剥离），不参与字体名匹配 */
function collectFontNames(ass: string): string[] {
  const names = new Set<string>()
  for (const m of ass.matchAll(/^Style:\s*[^,]*,\s*([^,]*),/gm))
    names.add(m[1].trim().replace(/^@/, ''))
  for (const m of ass.matchAll(/\\fn([^\\}]+)/gi)) names.add(m[1].trim().replace(/^@/, ''))
  return [...names].filter(Boolean)
}

/** 同一字体名最多注册的 face 数：同 family 多 weight 变体取前几个即可，
 * bold/italic 由 libass 挑最近（fontconfig 语义）——Source Han 全家 14 个
 * weight 全下会瞬间吃掉几百 MB */
const MAX_FACES_PER_NAME = 3
/** 会话内最多注册的系统字体数（Source Han 系 OTF 单文件 ~17MB，必须限流） */
const MAX_SYSTEM_FONTS = 24

/** 可参与名字匹配的字体 face 元数据。两种来源异构：LocalFontInfo 浏览器每 face
 * 只给一个名字；FontFaceRecord 存 name 表全量名字（nameID 1/16/4/6 × 全平台全语言，
 * 对齐 fontconfig/DirectWrite 的索引语义） */
type LocalFontNames = Pick<LocalFontInfo, 'family' | 'fullName' | 'postscriptName' | 'style'>
type CachedFontNames = Pick<
  FontFaceRecord,
  'families' | 'fullNames' | 'postscriptNames' | 'style' | 'fileName'
>
type FontNameSource = LocalFontNames | CachedFontNames

function faceStyleRank(style: string): number {
  const s = style.toLowerCase()
  if (s === 'regular') return 0
  if (s === 'bold') return 1
  if (s.includes('regular')) return 2
  if (s.includes('bold')) return 3
  return 4
}

/** face 的全部候选名（任一被引用即算命中） */
function fontNameCandidates(font: FontNameSource): string[] {
  return 'families' in font
    ? [...font.families, ...font.fullNames, ...font.postscriptNames]
    : [font.family, font.fullName, font.postscriptName]
}

/** face 的注册去重键（libass 内部也按 PostScript 名区分 face） */
function facePostscriptName(font: FontNameSource): string {
  return 'families' in font ? (font.postscriptNames[0] ?? font.fileName) : font.postscriptName
}

/** 字体名匹配：引用名可命中 face 的任一名字——family/fullName/postscript
 * （如 方正兰亭中黑_GBK 的 family 是 FZLanTingHei-DB-GBK，中文名在 fullName 里；
 * 思源黑体的中文名只在 zh-CN 的 name 记录里）；空格差异做无空格兜底比较
 * （Source Han Sans JP ↔ SourceHanSansJP） */
function fontMatchesName(font: FontNameSource, name: string): boolean {
  const compact = name.replace(/\s+/g, '')
  return fontNameCandidates(font).some((candidate) => {
    const lower = candidate.toLowerCase()
    return name === lower || compact === lower.replace(/\s+/g, '')
  })
}

/**
 * 创建字体供给器（对齐原版 fontconfig/DirectWrite 的角色）。
 * 字节来源按优先级：Local Font Access API（Chromium，需用户手势授权）→
 * IndexedDB 字体缓存（拖入/导入的字体文件，任何浏览器可用）。
 * 跨 track 调用共享枚举与注册记录：文档变化（打开文件/改样式）时只增量读取
 * 新引用的字体；缓存内容变化（新导入）时全部重试。任何失败都静默降级，
 * 交给 availableFonts 懒加载兜底——非手势 + 未授权时浏览器直接 reject，
 * 不会弹授权框。
 */
function createSystemFontLoader(): (names: string[]) => Promise<Uint8Array[]> {
  const api = window as Window & { queryLocalFonts?: () => Promise<LocalFontInfo[]> }
  const queryLocalFonts = api.queryLocalFonts
  if (!queryLocalFonts) {
    // Local Font Access 仅 Chromium 实现（Firefox/Safari 无）——系统字体拿不到，
    // 提示用户走字体导入通道（warning 级会自动唤起底部日志面板）
    logWarning(
      'fonts',
      'Local Font Access API unavailable in this browser; system fonts cannot be loaded. ' +
        'Drop font files (.ttf/.otf/.ttc) onto the window to make them available for rendering.',
    )
  }
  /** 已处理过的引用名（无论是否命中）——全部命中后跳过重复枚举；
   * 字体缓存版本变化时清空以重试（导入新字体后补齐） */
  let knownNamesVersion = -1
  const knownNames = new Set<string>()
  /** 已注册进 libass 的 face（按 postscriptName 跨调用去重） */
  const registeredFaces = new Set<string>()

  return async (names) => {
    const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))]
    const cacheVersion = fontCacheVersion()
    if (cacheVersion !== knownNamesVersion) {
      knownNamesVersion = cacheVersion
      knownNames.clear()
    }
    if (wanted.length === 0 || wanted.every((name) => knownNames.has(name))) return []

    // 本地枚举（Local Font Access）：权限拒绝/环境不支持时放弃本地源
    let localList: LocalFontInfo[] = []
    let localError = ''
    if (queryLocalFonts) {
      try {
        // 仅作提示：部分环境（Electron/旧版）permissions.query 不认识 local-fonts
        // 会直接 throw，不能因它放弃——是否真的可读由 queryLocalFonts 自己决定
        let granted = true
        try {
          const { state } = await navigator.permissions.query({
            name: 'local-fonts' as PermissionName,
          })
          granted = state === 'granted'
        } catch {
          granted = true
        }
        localList = await queryLocalFonts()
        if (!granted) logInfo('fonts', 'local fonts: permission not granted yet')
      } catch (cause) {
        localError = cause instanceof Error ? cause.message : String(cause)
        logInfo('fonts', `local fonts unavailable: ${localError}`)
      }
    }
    const cacheList = await listFontFaces()

    /** face → 字节读取器（本地经 blob()，缓存经存的 File） */
    const readers: Array<() => Promise<Uint8Array>> = []

    for (const name of wanted) {
      knownNames.add(name)
      // 本地优先，缓存补足同名剩余 weight 槽位
      const local = localList
        .filter((f) => fontMatchesName(f, name))
        .sort((a, b) => faceStyleRank(a.style) - faceStyleRank(b.style))
      const cached = cacheList
        .filter((f) => fontMatchesName(f, name))
        .sort((a, b) => faceStyleRank(a.style) - faceStyleRank(b.style))
      let taken = 0
      for (const face of [...local, ...cached]) {
        if (taken >= MAX_FACES_PER_NAME) break
        const postscript = facePostscriptName(face).toLowerCase()
        if (registeredFaces.has(postscript)) continue
        registeredFaces.add(postscript)
        taken += 1
        readers.push(() =>
          'blob' in face
            ? (face as LocalFontInfo)
                .blob()
                .then((blob) => blob.arrayBuffer())
                .then((buffer) => new Uint8Array(buffer))
            : (face as FontFaceRecord).data.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        )
      }
    }

    const fonts: Uint8Array[] = []
    for (const read of readers) {
      if (fonts.length >= MAX_SYSTEM_FONTS) break
      try {
        // 顺序读取：超限时立即停止，避免读出超出上限的字节
        // oxlint-disable-next-line eslint/no-await-in-loop
        fonts.push(await read())
      } catch {
        // 单个字体读取失败不影响其余
      }
    }
    logInfo(
      'fonts',
      `system fonts: +${fonts.length} loaded for [${wanted.join(', ')}]` +
        ` (local ${localList.length}${localError ? `, ${localError}` : ''}, cache ${cacheList.length})`,
    )
    return fonts
  }
}

export async function createAssRenderer(
  host: HTMLElement,
  subContent: string,
): Promise<AssRenderer> {
  const canvas = document.createElement('canvas')
  canvas.className = 'jassub-canvas'
  canvas.style.position = 'absolute'
  canvas.style.pointerEvents = 'none'
  host.appendChild(canvas)

  let instance: JASSUB | null = null
  /** 字体供给器（会话内增量注册；Local Font Access + IndexedDB 缓存双源） */
  const loadSystemFonts = createSystemFontLoader()
  try {
    // 已授权/缓存命中时把字幕引用的字体预载进 embedded provider（对齐原版
    // fontconfig/DirectWrite 供字）；全 miss 返回空数组走懒加载兜底。
    // 之后文档变化（打开文件/改样式）经 flushTrack 增量同步新字体
    const systemFonts = await loadSystemFonts(collectFontNames(subContent))
    instance = new JASSUB({
      canvas,
      subContent: stripBom(subContent),
      workerUrl: jassubWorkerUrl,
      wasmUrl: jassubWasmUrl,
      modernWasmUrl: jassubModernWasmUrl,
      // 系统字体字节直接预载（libass 按字体真名注册，fontselect 直接命中）；
      // availableFonts 仅留兜底：default font 懒加载，首个含 CJK 的字幕
      // 触发下载注册，避免每次启动固定拉 6MB
      fonts: systemFonts,
      availableFonts: {
        'liberation sans': jassubDefaultFontUrl,
        // 键必须与 defaultFont 一致：libass 字形缺失时按 default family 请求，
        // worker 经 availableFonts 命中后下载注册（字体的真实家族名为 Noto Sans SC）
        'noto sans sc': cjkFallbackFontUrl,
      },
      defaultFont: 'noto sans sc',
      queryFonts: 'local',
    })
    // worker/wasm 加载失败时超时兜底（ready 可能永不 settle）
    await Promise.race([
      instance.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('jassub ready timeout')), READY_TIMEOUT_MS),
      ),
    ])
  } catch (error) {
    canvas.remove()
    throw error
  }

  let trackTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTrack: string | null = null
  /** 最近一次渲染参数（补偿重绘用） */
  let lastRender: { timeMs: number; storageWidth: number; storageHeight: number } | null = null
  /** 字体加载补偿窗口内的重绘定时器 */
  let redrawTimers: ReturnType<typeof setTimeout>[] = []
  let startedAt = 0

  /** 补绘上一帧：字体异步注册（_allocFonts）与 setTrack 都不触发重绘，
   * 暂停状态下没有渲染 demand，必须手动补一帧画面才更新 */
  const redrawLast = () => {
    if (!instance || !lastRender) return
    void instance.manualRender({
      expectedDisplayTime: performance.now(),
      width: lastRender.storageWidth,
      height: lastRender.storageHeight,
      mediaTime: lastRender.timeMs / 1000,
    })
  }

  /** 字体经 queryLocalFonts/懒加载就绪的时间不可知，且 jassub _allocFonts 不重绘上一帧；
   *  创建后短窗口内补绘两帧，保证（本地）字体就绪后画面立即出现 */
  const scheduleRedraws = () => {
    for (const timer of redrawTimers) clearTimeout(timer)
    redrawTimers = [600, 1500].map((delay) => setTimeout(redrawLast, delay))
  }

  /** 增量注册 track 新引用的字体（打开文件/改样式名后触发），
   * 注册完成后补绘一帧让新字体立即生效 */
  const syncSystemFonts = (content: string) => {
    loadSystemFonts(collectFontNames(content))
      .then((fonts) => {
        if (!fonts.length || !instance?.renderer) return
        return instance.renderer.addFonts(fonts)
      })
      .then(redrawLast)
      .catch(() => {})
  }

  const flushTrack = () => {
    trackTimer = null
    if (!pendingTrack || !instance) return
    const content = stripBom(pendingTrack)
    pendingTrack = null
    // 先增量注册新引用的系统字体（异步），再换 track；字体就绪后补绘
    syncSystemFonts(content)
    instance.renderer.setTrack(content)
    // jassub 的 setTrack 只换 track 不重绘；暂停状态下没有下一帧渲染 demand，
    // 必须手动补一帧，编辑器里改字才能即时反映到画面（对应原版实时预览）
    redrawLast()
  }

  /** canvas 对齐宿主内的媒体元素（video / WebCodecs 包裹层 / dummy 框），未打开媒体时隐藏 */
  const syncCanvasBox = () => {
    const media = host.querySelector<HTMLVideoElement | HTMLElement>(
      'video, .dummy-video-stage, .webcodecs-video-wrap',
    )
    if (!media) {
      canvas.style.display = 'none'
      return
    }
    canvas.style.display = 'block'
    canvas.style.left = `${media.offsetLeft}px`
    canvas.style.top = `${media.offsetTop}px`
    canvas.style.width = `${media.offsetWidth}px`
    canvas.style.height = `${media.offsetHeight}px`
  }

  return {
    setTrack(content) {
      pendingTrack = content
      if (trackTimer) clearTimeout(trackTimer)
      trackTimer = setTimeout(flushTrack, SET_TRACK_DEBOUNCE_MS)
    },
    render(timeMs, storageWidth, storageHeight) {
      if (!instance) return
      syncCanvasBox()
      if (!storageWidth || !storageHeight) return
      lastRender = { timeMs, storageWidth, storageHeight }
      if (!startedAt) {
        startedAt = performance.now()
        scheduleRedraws()
      }
      void instance.manualRender({
        expectedDisplayTime: performance.now(),
        width: storageWidth,
        height: storageHeight,
        mediaTime: timeMs / 1000,
      })
    },
    destroy() {
      for (const timer of redrawTimers) clearTimeout(timer)
      redrawTimers = []
      if (trackTimer) clearTimeout(trackTimer)
      trackTimer = null
      pendingTrack = null
      lastRender = null
      const target = instance
      instance = null
      canvas.remove()
      if (target) void target.destroy()
    },
  }
}
