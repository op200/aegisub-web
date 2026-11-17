import { Captions, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import {
  applyLuaPayload,
  documentExportFilters,
  documentToLuaRows,
  withExportFilters,
} from '../automation/luaAssFile'
import {
  applyDialogSettings,
  defaultDialogValues,
  dialogConfigTable,
  inlineStringEncode,
  readBackButton,
  serializeDialogSettings,
  type DialogSpec,
  type DialogValue,
} from '../automation/luaDialog'
import {
  configureAutomationFilter,
  isActiveAutomationMacro,
  loadAutomationScript,
  orderedExportFilters,
  resetAutomationBackend,
  runAutomationFilter,
  runAutomationMacro,
  unloadAutomationScript,
  validateAutomationMacro,
  type AutomationFilterDisplayInfo,
  type AutomationFilterInfo,
  type AutomationHost,
  type AutomationMacroInfo,
  type DialogResponseLike,
  type LuaTextExtentsStyle,
} from '../automation/luaEngine'
import {
  getOptionBool,
  getOptionInt,
  getOptionString,
  setOption,
  useOptionsVersion,
} from '../config/options'
import { hasStyleOverride } from '../core/assTags'
import { CoreClient } from '../core/client'
import { createDocument, createProjectProperties } from '../core/defaults'
import { decodeWithEncoding, detectEncoding, encodeText } from '../core/encoding'
import { fixStyles, transformFramerateDocument } from '../core/exportFilters'
import { attachmentBytes, attachmentFileName, makeAttachment } from '../core/format'
import type { TextImportOptions } from '../core/formatExtra'
import { detectFormat, exportExtension, exportSubtitle, type ParseOptions } from '../core/formats'
import { extractMkvSubtitles, type MkvSubtitleTrack } from '../core/mkv'
import {
  getScriptInfo,
  parseYcbcrHeader,
  resampleCommands,
  RESAMPLE_AR_ADD_BORDERS,
  RESAMPLE_AR_REMOVE_BORDERS,
  RESAMPLE_AR_STRETCH,
  ycbcrHeaderToBestPractice,
  ycbcrHeaderToBestPracticeString,
  type YcbcrColorspace,
  type YcbcrHeader,
  type YcbcrMatrix,
  type YcbcrRange,
} from '../core/resample'
import {
  compileMatcher,
  findNext as findNextMatch,
  replaceAllMatches,
  replaceNext as replaceNextMatch,
  SEARCH_FIELDS,
  type SearchReplaceSettings,
} from '../core/searchReplace'
import { ensureSpellCheckerLoaded } from '../core/spellcheck'
import { ensureThesaurusLoaded } from '../core/thesaurus'
import type {
  CoreCommand,
  CoreState,
  ProjectProperties,
  SubtitleAttachment,
  SubtitleAttachmentGroup,
  SubtitleCue,
  SubtitleDocument,
  SubtitleFormat,
} from '../core/types'
import {
  Framerate,
  lowerBoundIndex,
  parseKeyframes,
  parseTimecodes,
  serializeKeyframes,
  serializeTimecodes,
  serializeTimecodesKeepOffset,
} from '../core/vfr'
import {
  extractVideoKeyframes,
  listMediaTracks,
  probeVideoInfo,
  type MediaTrackInfo,
  type VideoStreamInfo,
} from '../media/demux'
import { parseContainerColorspace } from '../media/videoColor'
import { BrowserHostAdapter, MEDIA_FILE_TYPES, SUBTITLE_FILE_TYPES } from '../platform/browserHost'
import { createNativeHostAdapter } from '../platform/nativeHost'
import type { AppFileHandle, HostAdapter, MediaSource } from '../platform/types'
import {
  automationLocalScriptPath,
  loadAutomationScripts,
  readAutomationScriptFile,
  writeLocalAutomationScript,
} from '../storage/automationStore'
import { restoreFactoryScripts } from '../storage/factoryScripts'
import { importFontFiles } from '../storage/fontStore'
import { loadCachedKeyframes, storeCachedKeyframes } from '../storage/keyframeCacheStore'
import { loadLatestAutosave, saveAutosave, saveSubtitleBackup } from '../storage/projectStore'
import {
  loadLastSubtitleName,
  loadRecentLists,
  loadSearchMru,
  pushRecent,
  pushSearchMru,
  RECENT_TYPES,
  saveLastSubtitleName,
  type RecentLists,
  type RecentType,
  type SearchMruLists,
} from '../storage/recentStore'
import {
  fileExists,
  joinPath,
  listTree,
  readBytes,
  readFile as readVfsFile,
  vfsDecode,
} from '../storage/vfs'
import { invertLightness } from './color'
import {
  COMMAND_REGISTRY,
  type AudioOptions,
  type AudioView,
  type CommandApi,
  type CommandContext,
  type DialogKind,
  type DisplayMode,
  type GridTagsMode,
} from './commandRegistry'
import { commandForShortcut, shortcutFromKeyboardEvent, type ShortcutContext } from './commands'
import { AudioPane } from './components/AudioPane'
import {
  AboutDialog,
  AspectRatioDialog,
  AttachmentDialog,
  CharsetDialog,
  PasteOverDialog,
  ChoicePromptDialog,
  type ChoicePromptState,
  AutomationManagerDialog,
  DummyVideoDialog,
  ExportSubtitlesDialog,
  FontCollectorDialog,
  JumpToDialog,
  LanguageDialog,
  LuaConfigDialog,
  LuaProgressDialog,
  ResampleDialog,
  ScriptPropertiesDialog,
  SelectLinesDialog,
  ShiftTimesDialog,
  StylingAssistantDialog,
  TextImportDialog,
  TimecodesOffsetDialog,
  TimingProcessorDialog,
  TranslationDialog,
  VideoDetailsDialog,
  VideoOffsetNoticeDialog,
  useEscapeClose,
  type ExportOptions,
  type FramerateFilterSettings,
  type SelectLinesSettings,
} from './components/dialogs'
import { EditPanel } from './components/EditPanel'
import { FileManagerDialog } from './components/FileManagerDialog'
import { KanjiTimerDialog } from './components/KanjiTimerDialog'
import { LogPanel } from './components/LogPanel'
import { MenuBar } from './components/MenuBar'
import { PreferencesDialog } from './components/PreferencesDialog'
import { PreviewPane, type VideoPlaybackMode } from './components/PreviewPane'
import { SpellCheckerDialog } from './components/SpellCheckerDialog'
import { StyleEditorDialog } from './components/StyleEditorDialog'
import { StyleManagerDialog } from './components/StyleManagerDialog'
import { gridRowHeight, SubtitleGrid } from './components/SubtitleGrid'
import { Toolbar } from './components/Toolbar'
import { initLocale, tFmt, tPlain, tPlural, useLocaleVersion } from './i18n'
import {
  calculateAttachedVideoLayout,
  fitWindowZoomToVideo,
  PLACEHOLDER_VIDEO_SIZE,
} from './layout/videoLayout'
import { installGlobalLogHandlers, logError, logInfo, getLogEntries, subscribeLogs } from './log'
import { useSystemTheme } from './theme'

const host: HostAdapter = createNativeHostAdapter() ?? new BrowserHostAdapter()

/** keyframe/open 的文件过滤器（keyframe.cpp：*.txt;*.pass;*.stats;*.log） */
const KEYFRAME_FILE_TYPES = [
  { description: 'Keyframes', accept: { 'text/plain': ['.txt', '.pass', '.stats', '.log'] } },
]
/** timecode/open 的文件过滤器（timecode.cpp：*.txt） */
const TIMECODES_FILE_TYPES = [{ description: 'Timecodes', accept: { 'text/plain': ['.txt'] } }]

/** 拖放分类扩展名表（project.cpp Project::LoadList） */
const DROP_VIDEO_EXTS = [
  '.asf',
  '.avi',
  '.avs',
  '.d2v',
  '.h264',
  '.hevc',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.ogm',
  '.rm',
  '.rmvb',
  '.ts',
  '.webm',
  '.wmv',
  '.y4m',
  '.yuv',
]
const DROP_SUBS_EXTS = ['.ass', '.srt', '.ssa', '.sub', '.ttxt']
const DROP_AUDIO_EXTS = [
  '.aac',
  '.ac3',
  '.ape',
  '.dts',
  '.eac3',
  '.flac',
  '.m4a',
  '.mka',
  '.mp3',
  '.ogg',
  '.opus',
  '.w64',
  '.wav',
  '.wma',
]
/** LoadList 之外的 Web 扩展：字体文件拖入 → IndexedDB 字体缓存 */
const DROP_FONT_EXTS = ['.ttf', '.otf', '.ttc', '.woff', '.woff2', '.fon']
/** 查找/替换 In Field 单选标签（dialog_search_replace.cpp：&Text/St&yle/A&ctor/&Effect） */
const SEARCH_FIELD_LABELS: Record<string, string> = {
  text: 'Text',
  style: 'Style',
  actor: 'Actor',
  effect: 'Effect',
}

/** FrameMain::StatusTimeout 默认超时（frame_main.h ms=10000，到期 OnStatusClear 清空右字段） */
const STATUS_TIMEOUT_MS = 10000

function decodeText(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data)
}

/** Web 版恒定帧率（DummyVideoProvider 与既有实现一致，24fps） */
const DEFAULT_FPS = 24

/** HelpButton::OpenPage 的 web 对应物：桌面打开本地帮助包，web 打开官方在线文档 */
const HELP_PAGE_PATHS: Record<string, string> = {
  Main: 'Main_Page',
  'Automation Manager': 'Automation/Manager',
  Export: 'Exporting',
  'Fonts Collector': 'Fonts_Collector',
  Options: 'Options',
  Properties: 'Properties',
  'Select Lines': 'Select_Lines',
  'Shift Times': 'Shift_Times',
  'Style Editor': 'Styles',
  'Styles Manager': 'Styles',
}

function openHelpPage(page: string): void {
  const target = HELP_PAGE_PATHS[page] ?? page.replace(/ /g, '_')
  window.open(`https://docs.aegisub.org/3.5/${target}/`, '_blank', 'noopener')
}

/** 已加载的 Automation 脚本（auto4_base Script 的 Web 版） */
interface LoadedAutomationEntry {
  key: string
  filename: string
  code: string
  /** true = autoload 全局脚本（G）；false = 项目 Automation Scripts 引用的本地脚本（L） */
  isGlobal: boolean
  stateId: number
  name: string
  description: string
  author: string
  version: string
  warnings: string[]
  macros: AutomationMacroInfo[]
  filters: AutomationFilterInfo[]
  error?: string
}

function selectedOrActive(
  document: CoreState['document'],
  selected: Set<string>,
  activeId: string | null,
): string[] {
  if (selected.size) return [...selected]
  if (activeId) return [activeId]
  return document.cues[0] ? [document.cues[0].id] : []
}

/**
 * 对白 id → 对白序数。Lua 接口只接受 0-based 行号，逐次 findIndex 在
 * 「全选 + 大文件」时是 O(n²)；一次建 Map 后查询为 O(1)。
 */
function makeCueIndex(document: CoreState['document']): (id: string) => number {
  const index = new Map<string, number>()
  document.cues.forEach((cue, ordinal) => index.set(cue.id, ordinal))
  return (id) => index.get(id) ?? -1
}

/**
 * 设备像素比跟踪（video_display.cpp 的 GetContentScaleFactor）：
 * 监听 (resolution: Xdppx)，DPR 变化（跨显示器拖动/浏览器缩放）时更新。
 */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const update = () => setDpr(window.devicePixelRatio || 1)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [dpr])
  return dpr
}

/** 音频工具栏开关 → 持久化选项（AudioOptions 中 karaoke 为会话状态不持久化） */
const AUDIO_TOGGLE_OPTIONS: Record<string, string> = {
  autoCommit: 'Audio/Auto/Commit',
  autoNext: 'Audio/Next Line on Commit',
  autoScroll: 'Audio/Auto/Scroll',
  globalHotkeys: 'Audio/Medusa Timing Hotkeys',
  verticalLink: 'Audio/Link',
}

// ---------------------------------------------------------------------------
// aegisub.text_extents：auto4_base.cpp CalculateTextExtents 的 canvas 近似
// 桌面以 wxDC 度量后按字体高度归一到字号（并除以 64 的缩放因子），这里用
// measureText 同法归一：高度取字号、外距取 0（TrueType 的 tmExternalLeading
// 通常为 0），再应用 scale_x/scale_y 百分比；有字间距时逐字符量取（不走 kerning）。
// ---------------------------------------------------------------------------
let extentsContext: CanvasRenderingContext2D | null = null
/** 当前 canvas 字体串（重复赋值会触发字体解析，命中缓存时跳过） */
let extentsFont = ''
/** 字体串 → 'Hg' 度量缓存（ascent/descent/scaling 只与字体有关） */
const extentsFontMetrics = new Map<string, { ascent: number; descent: number; scaling: number }>()
/** 字体 + 间距 + 缩放 + 文本 → 宽度缓存（脚本常重复量取同一文本/空串） */
const extentsWidthCache = new Map<string, number>()
const EXTENTS_CACHE_LIMIT = 4096
const EXTENTS_CACHE_MAX_TEXT = 64

function applyExtentsFont(context: CanvasRenderingContext2D, font: string): void {
  if (extentsFont !== font) {
    context.font = font
    extentsFont = font
  }
}

function measureLuaTextExtents(
  style: LuaTextExtentsStyle,
  text: string,
): { width: number; height: number; descent: number; externalLead: number } | null {
  if (!extentsContext) extentsContext = document.createElement('canvas').getContext('2d')
  if (!extentsContext) return null
  const context = extentsContext
  const fontsize = Math.max(1, style.fontsize)
  const family = style.fontname || 'Arial'
  const font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fontsize}px "${family}"`
  let metrics = extentsFontMetrics.get(font)
  if (!metrics) {
    applyExtentsFont(context, font)
    const fontMetrics = context.measureText('Hg')
    const ascent =
      fontMetrics.fontBoundingBoxAscent || fontMetrics.actualBoundingBoxAscent || fontsize
    const descent = fontMetrics.fontBoundingBoxDescent || fontMetrics.actualBoundingBoxDescent || 0
    // 桌面 scaling = fontsize / GetTextExtent 的字高（源码用于弥补字体 OS/2 表缺失）
    metrics = { ascent, descent, scaling: fontsize / (ascent + descent || fontsize) }
    if (extentsFontMetrics.size >= EXTENTS_CACHE_LIMIT) extentsFontMetrics.clear()
    extentsFontMetrics.set(font, metrics)
  }
  const scaleX = style.scale_x / 100
  const scaleY = style.scale_y / 100
  const height = fontsize * scaleY
  const resultDescent = metrics.descent * metrics.scaling * scaleY
  // 空串只需字体度量（scaling/descent），宽度恒为 0
  if (text.length === 0) return { width: 0, height, descent: resultDescent, externalLead: 0 }

  const widthKey = `${font}|${style.spacing}|${scaleX}|${text}`
  let width = extentsWidthCache.get(widthKey)
  if (width === undefined) {
    applyExtentsFont(context, font)
    if (style.spacing !== 0) {
      width = 0
      for (const char of text) width += context.measureText(char).width + style.spacing
    } else {
      width = context.measureText(text).width
    }
    width *= metrics.scaling * scaleX
    if (text.length <= EXTENTS_CACHE_MAX_TEXT) {
      if (extentsWidthCache.size >= EXTENTS_CACHE_LIMIT) extentsWidthCache.clear()
      extentsWidthCache.set(widthKey, width)
    }
  }
  return { width, height, descent: resultDescent, externalLead: 0 }
}

/** ffmpeg AVColorSpace 名 → ycbcr_matrix（H.273 数值与 FFMS2 一致） */
const FFMPEG_MATRIX: Record<string, YcbcrMatrix> = {
  rgb: 'Unspecified',
  bt709: 'BT709',
  fcc: 'FCC',
  bt470bg: 'BT470BG',
  smpte170m: 'SMPTE170M',
  bt601: 'SMPTE170M',
  smpte240m: 'SMPTE240M',
  ycgco: 'Unspecified',
  bt2020nc: 'BT2020_NCL',
  bt2020ncl: 'BT2020_NCL',
  bt2020c: 'BT2020_CL',
  bt2020cl: 'BT2020_CL',
  smpte2085: 'Unspecified',
}

const FFMPEG_RANGE: Record<string, YcbcrRange> = {
  tv: 'MPEG',
  mpeg: 'MPEG',
  limited: 'MPEG',
  pc: 'JPEG',
  jpeg: 'JPEG',
  full: 'JPEG',
}

/** ycbcr::matrix_to_string（提示文案） */
const MATRIX_DISPLAY: Partial<Record<YcbcrMatrix, string>> = {
  BT709: 'BT.709',
  FCC: 'FCC',
  BT470BG: 'BT.470-BG',
  SMPTE170M: 'SMPTE ST 170M',
  SMPTE240M: 'SMPTE ST 240M',
  BT2020_NCL: 'BT.2020 NCL',
  BT2020_CL: 'BT.2020 CL',
}

function ffmpegColorspace(matrixName: string, rangeName: string): YcbcrColorspace {
  const matrix = FFMPEG_MATRIX[matrixName.toLowerCase()] ?? 'Unspecified'
  const range = FFMPEG_RANGE[rangeName.toLowerCase()] ?? 'Unspecified'
  return { matrix, range }
}

/** ycbcr::guess_colorspace：未标记时按分辨率猜 601/709 */
function guessVideoColorspace(
  colorspace: YcbcrColorspace,
  width: number,
  height: number,
): YcbcrColorspace {
  const matrix =
    colorspace.matrix !== 'Unspecified'
      ? colorspace.matrix
      : width > 1024 || height >= 600
        ? 'BT709'
        : 'SMPTE170M'
  const range = colorspace.range !== 'Unspecified' ? colorspace.range : 'MPEG'
  return { matrix, range }
}

/** video_provider_ffmpegsource.cpp IsHDRFrame：PQ/HLG/BT.2020/P3 视为 HDR/WCG */
function isHdrOrWcg(colorPrimaries: string, colorTransfer: string): boolean {
  const transfer = colorTransfer.toLowerCase()
  if (transfer === 'smpte2084' || transfer === 'arib-std-b67') return true
  const primaries = colorPrimaries.toLowerCase()
  return primaries === 'bt2020' || primaries === 'smpte431' || primaries === 'smpte432'
}

/** dialog_video_properties.cpp check_ar_changed（1% 容差） */
function scriptAspectChanged(sx: number, sy: number, vx: number, vy: number): boolean {
  if (sy === 0 || vy === 0) return (sy === 0) !== (vy === 0)
  const sar = sx / sy
  const varRatio = vx / vy
  return Math.abs(sar - varRatio) / varRatio > 0.01
}

/** 分离视频窗口：把主文档样式复制到弹出窗口（Vite 注入的 <style> 与构建后的 <link>） */
function copyStylesToPopup(popup: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    const node = sheet.ownerNode
    if (!(node instanceof HTMLElement)) continue
    if (node.tagName === 'LINK' || node.tagName === 'STYLE')
      popup.document.head.appendChild(node.cloneNode(true))
  }
  const style = popup.document.createElement('style')
  style.textContent =
    'html,body{margin:0;height:100%;overflow:hidden;background:#1e1e1e}' +
    '.preview-panel{width:100%;height:100%}'
  popup.document.head.appendChild(style)
}

export function App() {
  const optionsVersion = useOptionsVersion() // Preferences 提交后触发全应用重渲染
  const theme = useSystemTheme() // 自动主题：跟随系统深浅色
  const coreRef = useRef<CoreClient | null>(null)
  const anchorRef = useRef<string | null>(null)
  const executeRef = useRef<(id: string) => void>(() => undefined)
  const [core, setCore] = useState<CoreState | null>(null)
  const coreStateRef = useRef<CoreState | null>(null)
  coreStateRef.current = core
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  // 撤销/重做跳转计数：核心的文本选区快照需在跳转后强制回写编辑框（含光标），
  // 由 EditPanel 按此 nonce 触发（subs_controller.cpp:Apply → SetTextTo + SetSelection）
  const [historyNonce, setHistoryNonce] = useState(0)
  const [videoMedia, setVideoMedia] = useState<MediaSource | null>(null)
  const [audioMedia, setAudioMedia] = useState<MediaSource | null>(null)
  const [videoDurationMs, setVideoDurationMs] = useState(0)
  // 视频自身色彩空间（容器标记；对应 FFMS2 解码帧的 ColorSpace/ColorRange）。
  // 未标记为 Unspecified，由 ycbcr.cpp 的 guess_colorspace 按分辨率补全
  const [videoColorspace, setVideoColorspace] = useState<YcbcrColorspace>({
    matrix: 'Unspecified',
    range: 'Unspecified',
  })
  // Video/Default Zoom：预设 0..23 → 缩放 (n+1)/8（7 → 100%）
  const [videoWindowZoom, setVideoWindowZoom] = useState(
    () => (getOptionInt('Video/Default Zoom') + 1) / 8,
  )
  // 未载入视频时的占位显示缩放：默认 50%，直接作为初始状态（不在挂载后的 effect/hook
  // 里重新结算，否则首屏会先按一个值绘制、再跳到另一个值，画面闪烁）。
  // 滚轮/缩放命令直接更新该值；它不写入真实视频的 windowZoom
  const [placeholderZoom, setPlaceholderZoom] = useState(0.5)
  // 设备像素比（源码 GetContentScaleFactor）：视频缩放按物理设备像素计
  const devicePixelRatioValue = useDevicePixelRatio()
  // 拼写检查/同义词库词库在启动时后台加载（spellchecker_hunspell / thesaurus 构造时读 ?dictionary）
  useEffect(() => {
    void ensureSpellCheckerLoaded()
    void ensureThesaurusLoaded()
  }, [])
  const prevDprRef = useRef(devicePixelRatioValue)
  useEffect(() => {
    // wxEVT_DPI_CHANGED：new_zoom = zoom × 新scale/旧scale，保持视频表观尺寸不跳变
    const prev = prevDprRef.current
    if (prev === devicePixelRatioValue) return
    prevDprRef.current = devicePixelRatioValue
    if (prev > 0) {
      const factor = devicePixelRatioValue / prev
      setVideoWindowZoom((zoom) => Math.max(0.125, Math.min(3, zoom * factor)))
    }
  }, [devicePixelRatioValue])
  const [videoIntrinsicSize, setVideoIntrinsicSize] = useState({ width: 1280, height: 720 })
  // 当前视频的真实尺寸是否已上报：载入中（已 setVideoMedia、尚未拿到元数据）沿用占位布局，
  // 避免视频栏先跳到上一个视频/默认 1280×720 的尺寸再跳回
  const [videoSizeReady, setVideoSizeReady] = useState(false)
  // AudioBox（wxSashWindow）底边 sash：SetSashVisible(wxSASH_BOTTOM) + OnSashDrag 改变
  // 音频栏高度（SetMinSize → 父 Layout），OPT_SET("Audio/Display Height") 持久化
  const [audioBoxHeight, setAudioBoxHeight] = useState(() => getOptionInt('Audio/Display Height'))
  // 播放音量增益（audio_box.cpp 三次方曲线）：AudioPane 计算并上报，视频播放出声共用
  // （源码唯一 audio player 同时供视频/音频出声，Volume 滑条对两者都生效）
  const [playbackGain, setPlaybackGain] = useState(() =>
    Math.pow(Math.max(1, Math.min(100, getOptionInt('Audio/Volume'))) / 50, 3),
  )
  const audioSashDragRef = useRef<{
    startY: number
    startHeight: number
    maxHeight: number
    current: number
  } | null>(null)
  // 稳定标识 + 值不变时返回原对象，避免 PreviewPane 的媒体 effect 依赖抖动造成重渲染循环。
  // 注意：源码 FitClientSizeToVideo 只按 video×windowZoom 定住显示框（SetMin/MaxClientSize），
  // 从不因窗口放不下而降档缩放；放不下时由窗口裁剪，与原版一致。
  // 这里只在视频**载入时**结算一次 FrameMain::OnVideoOpen 的减档（pendingZoomFitRef）。
  const pendingZoomFitRef = useRef(false)
  const setIntrinsicSizeStable = useCallback((width: number, height: number) => {
    setVideoIntrinsicSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    )
    setVideoSizeReady(true)
    // frame_main.cpp FrameMain::OnVideoOpen：参数是 provider 的像素尺寸与主窗口尺寸
    // （wx GetSize 为逻辑像素，Web 对应 CSS 像素的 window.innerWidth/Height）。
    // 同一视频在原生/WebCodecs 通道间切换会重复上报尺寸，只在本轮打开后结算第一次
    if (!pendingZoomFitRef.current) return
    pendingZoomFitRef.current = false
    setVideoWindowZoom((zoom) =>
      fitWindowZoomToVideo({ width, height }, zoom, window.innerWidth, window.innerHeight),
    )
  }, [])
  // 本地字体授权次数：递增触发 PreviewPane 重建 jassub 实例（libass 用新权限重新匹配字体）
  const [localFontsEpoch, setLocalFontsEpoch] = useState(0)
  // Log window（View → app/log 的独立弹窗，dialog_log）；底部状态栏不承载它
  const [logWindowOpen, setLogWindowOpen] = useState(false)
  const [audioDurationMs, setAudioDurationMs] = useState(0)
  const [videoTimeMs, setVideoTimeMs] = useState(0)
  const [audioTimeMs, setAudioTimeMs] = useState(0)
  // 状态栏解码器指示与切换：videoPlaybackMode 为当前生效通道；override 为用户手动
  // 选择（true=强制 WebCodecs，false=强制原生，null=自动：原生失败才切 WebCodecs）
  const [videoPlaybackMode, setVideoPlaybackMode] = useState<VideoPlaybackMode | null>(null)
  const [videoDecoderOverride, setVideoDecoderOverride] = useState<boolean | null>(null)
  const [videoAction, setVideoAction] = useState({ sequence: 0, type: '' })
  const [audioAction, setAudioAction] = useState<{
    sequence: number
    type: string
    startMs?: number
    endMs?: number
  }>({ sequence: 0, type: '' })
  // 双击网格行的音频 ScrollToActiveLine 请求（audio_box.cpp，nonce 递增触发 Waveform 滚动）
  const [audioScrollRequest, setAudioScrollRequest] = useState<{
    seq: number
    mode: 'range' | 'start' | 'end'
  }>({ seq: 0, mode: 'range' })
  // audio/scroll/left|right：只滚动视图（audio_box.cpp ScrollAudioBy，±128px），不移动播放头
  const [audioScrollBy, setAudioScrollBy] = useState({ seq: 0, delta: 0 })
  // 状态栏消息（CreateStatusBar(2) 右字段 = field 1）。Aegisub 所有临时消息都走
  // FrameMain::StatusTimeout(text, ms=10000)：显示后由 ID_APP_TIMER_STATUSCLEAR 定时器
  // 清空（OnStatusClear → SetStatusText("", 1)）；左字段（field 0）源码从不写入
  const [status, setStatusState] = useState('Ready')
  const statusClearTimer = useRef<number | undefined>(undefined)
  const setStatus = useCallback((message: string, ms = STATUS_TIMEOUT_MS) => {
    setStatusState(message)
    window.clearTimeout(statusClearTimer.current)
    if (ms > 0) statusClearTimer.current = window.setTimeout(() => setStatusState(''), ms)
  }, [])
  const [busy, setBusy] = useState(false)
  const [toolbarVisible, setToolbarVisible] = useState(() => getOptionBool('App/Show Toolbar'))
  const [showStyleManager, setShowStyleManager] = useState(false)
  // 编辑框 Edit 按钮直达样式编辑（源码 subs_edit_box.cpp ShowModal DialogStyleEditor）
  // 句柄：源码持 AssStyle* 指针，改名不影响身份；WASM 核心的样式 id 即样式名（改名后
  // 随之变化），故同时记录打开时的 id 与最近应用的名字，解析时先按 id 再按名字回退
  const [editingStyleHandle, setEditingStyleHandle] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [findMode, setFindMode] = useState<'find' | 'replace' | null>(null)
  // 查找/替换弹窗 ESC 关闭（不响应点击外部关闭）
  useEscapeClose(() => setFindMode(null), findMode !== null)
  // 查找/替换设置（dialog_search_replace.cpp：初值取 Tool/Search Replace/* 与 MRU 首项）
  const [findSettings, setFindSettings] = useState<SearchReplaceSettings>(() => {
    const mru = loadSearchMru()
    const field = SEARCH_FIELDS[getOptionInt('Tool/Search Replace/Field')] ?? 'text'
    return {
      find: mru.Find[0] ?? '',
      replaceWith: mru.Replace[0] ?? '',
      field,
      limitTo: getOptionInt('Tool/Search Replace/Affect') === 1 ? 'selected' : 'all',
      matchCase: getOptionBool('Tool/Search Replace/Match Case'),
      useRegex: getOptionBool('Tool/Search Replace/RegExp'),
      ignoreComments: getOptionBool('Tool/Search Replace/Skip Comments'),
      skipTags: getOptionBool('Tool/Search Replace/Skip Tags'),
    }
  })
  // Find/Replace 最近记录（wxComboBox 下拉；源码 mru.cpp "Find"/"Replace"）
  const [findMru, setFindMru] = useState<SearchMruLists>(() => loadSearchMru())
  const [findError, setFindError] = useState('')
  // 编辑框当前文本选区（源码 GetSelectionStart/End()）：由 EditPanel 上报，供查找起点使用
  const textSelectionRef = useRef({ pos: 0, start: 0, end: 0 })
  // 查找/替换命中后回写编辑框选区（覆盖一次 core.textSelection 快照）
  const [findTextSelection, setFindTextSelection] = useState<{
    pos: number
    start: number
    end: number
  } | null>(null)
  // Audio/Spectrum 选项决定音频默认显示模式
  const [audioView, setAudioView] = useState<AudioView>(() =>
    getOptionBool('Audio/Spectrum') ? 'spectrum' : 'waveform',
  )
  // 音频工具栏开关持久化到对应选项（audio.cpp 各 toggle 命令的 OPT_SET）
  const [audioOptions, setAudioOptions] = useState<AudioOptions>(() => ({
    autoCommit: getOptionBool('Audio/Auto/Commit'),
    autoNext: getOptionBool('Audio/Next Line on Commit'),
    autoScroll: getOptionBool('Audio/Auto/Scroll'),
    globalHotkeys: getOptionBool('Audio/Medusa Timing Hotkeys'),
    karaoke: false,
    verticalLink: getOptionBool('Audio/Link'),
  }))
  const [audioPlaying, setAudioPlaying] = useState(false)
  // Video/Subtitle Sync 默认 true（源码 default_config.json）
  const [videoAutoScroll, setVideoAutoScroll] = useState(() => getOptionBool('Video/Subtitle Sync'))
  // Subtitle/Grid/Hide Overrides：0 显示 → 1 简化(☀) → 2 隐藏
  const [gridTags, setGridTags] = useState<GridTagsMode>(() => {
    const value = getOptionInt('Subtitle/Grid/Hide Overrides')
    return value === 2 ? 'hide' : value === 0 ? 'show' : 'simplify'
  })
  const [displayMode, setDisplayMode] = useState<DisplayMode>('full')
  // ≤900px 走移动端堆叠布局（styles.css @media），视频面板为固定高度预览，不应用挂靠锁定尺寸
  const [isNarrowViewport, setIsNarrowViewport] = useState(
    () => window.matchMedia('(max-width: 900px)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)')
    const onChange = (event: MediaQueryListEvent) => setIsNarrowViewport(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  // frame_main.cpp OnAudioOpen(provider)：音频 provider 载入 → SetDisplayMode(-1, 1)（显示音频栏），
  // 关闭 → SetDisplayMode(-1, 0)（隐藏音频栏）；参数为 -1 的维度保持现状，故只换算音频维度
  const setDisplayModeAudio = (shown: boolean) =>
    setDisplayMode((mode) =>
      shown
        ? mode === 'subs'
          ? 'audio_subs'
          : mode === 'video_subs'
            ? 'full'
            : mode
        : mode === 'full'
          ? 'video_subs'
          : mode === 'audio_subs'
            ? 'subs'
            : mode,
    )
  const [dialog, setDialog] = useState<DialogKind>(null)
  // 打开流程中的临时状态（编码选择 / 纯文本导入选项，dialog_charset + dialog_text_import）
  const [pendingOpen, setPendingOpen] = useState<{
    file: AppFileHandle
    bytes: Uint8Array
    format: SubtitleFormat
    /** charset 对话框选定后的编码（纯文本导入阶段沿用） */
    encoding?: string
    /** 会话恢复等场景：不自动载入 Project Garbage 里的关联文件（避免启动弹窗） */
    skipLinkedFiles?: boolean
  } | null>(null)
  // Paste Over：待覆盖行与目标行
  const [pasteOver, setPasteOver] = useState<{
    lines: Omit<SubtitleCue, 'id'>[]
    targetIds: string[]
  } | null>(null)
  // Project Garbage：网格滚动位置（保存时写入 properties.scrollPosition）
  const [gridScrollRow, setGridScrollRow] = useState(0)
  const [gridScrollRestore, setGridScrollRestore] = useState<
    { row: number; token: number } | undefined
  >()
  const gridRestoreTokenRef = useRef(0)
  // 打开文档时等待视频/时间码就绪后再跳到 Project Garbage 的 videoPosition（帧）
  const pendingVideoPositionRef = useRef<number | null>(null)
  // 通用 wxGetSingleChoiceIndex / wxMessageBox 提示（视频属性校正、轨道选择）
  const [choicePrompt, setChoicePrompt] = useState<ChoicePromptState | null>(null)
  // 当前提示引用 + 排队：并发 askChoice（如轨道选择与视频属性校正）不能互相覆盖，
  // 覆盖会让前一个 Promise 永不 resolve，整个载入流程卡死
  const choicePromptRef = useRef<ChoicePromptState | null>(null)
  const choiceQueueRef = useRef<ChoicePromptState[]>([])
  const videoPropertiesRunRef = useRef(0)
  // 文档代次：自动载入关联文件等异步流程用它丢弃上一文档的迟到结果/弹窗
  const documentGenerationRef = useRef(0)
  const askChoice = (
    title: string,
    message: string,
    choices: string[],
    initial = 0,
  ): Promise<number | null> =>
    new Promise((resolve) => {
      const prompt: ChoicePromptState = {
        title,
        message,
        choices,
        initial,
        onResolve: (index) => {
          resolve(index)
          const next = choiceQueueRef.current.shift() ?? null
          choicePromptRef.current = next
          setChoicePrompt(next)
        },
      }
      if (choicePromptRef.current) {
        choiceQueueRef.current.push(prompt)
        return
      }
      choicePromptRef.current = prompt
      setChoicePrompt(prompt)
    })
  const showMessage = (title: string, message: string) =>
    askChoice(title, message, [], 0).then(() => undefined)
  /**
   * ffmpegsource_common.cpp AskForTrackSelection：
   * 多条同类型轨道时弹出选择框；单选/探测失败时用容器默认（首条）轨道。
   */
  const chooseTrackIndex = async (
    kind: 'video' | 'audio',
    tracks: MediaTrackInfo[],
  ): Promise<{ index?: number; cancelled: boolean }> => {
    if (tracks.length <= 1) return { index: tracks[0]?.index, cancelled: false }
    const descriptions = tracks.map((track) =>
      kind === 'video'
        ? `${track.description} (${track.width}×${track.height})`
        : `${track.description} (${track.channels} ch, ${track.sampleRate} Hz)`,
    )
    const choice = await askChoice(
      kind === 'video' ? tPlain('Select video track') : tPlain('Select audio track'),
      kind === 'video'
        ? tPlain('The file contains multiple video tracks. Which track would you like to load?')
        : tPlain('The file contains multiple audio tracks. Which track would you like to load?'),
      descriptions,
      0,
    )
    if (choice === null) return { cancelled: true }
    return { index: tracks[choice]?.index, cancelled: false }
  }
  const [videoOverscan, setVideoOverscan] = useState(false) // Video/Overscan Mask 默认 false
  // 分离视频窗口（video/detach）：PreviewPane 始终渲染进稳定 host，再在挂靠位与弹窗间搬运
  const [videoDetached, setVideoDetached] = useState(false)
  const previewHostRef = useRef<HTMLDivElement | null>(null)
  const previewMountRef = useRef<HTMLDivElement | null>(null)
  const previewWindowRef = useRef<Window | null>(null)
  const detachedKeyTargetRef = useRef<HTMLDivElement | null>(null)
  if (!previewHostRef.current) {
    const previewHost = document.createElement('div')
    previewHost.style.display = 'contents'
    previewHostRef.current = previewHost
  }
  const [aspectOverride, setAspectOverride] = useState<number | null>(null) // video/aspect/*
  const [dirty, setDirty] = useState(false) // 标题 * 前缀（FrameMain::UpdateTitle）
  // keyframes / timecodes 状态机（project.cpp：文件加载 > 视频自带 > 无）
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [keyframesFromFile, setKeyframesFromFile] = useState(false)
  const [keyframesFileName, setKeyframesFileName] = useState('')
  // 视频自带关键帧（ms；解复用扫描/WebCodecs 读流上报，帧号随帧率派生）
  const [videoKeyframeTimes, setVideoKeyframeTimes] = useState<number[]>([])
  const keyframeScanIdRef = useRef(0) // 换视频/关视频时作废旧的后台扫描
  // 后台扫描的追踪句柄：保存时间码/关键帧前必须等它完成（Aegisub 保存的是 provider
  // 逐帧表，CFR 回退与 WC 渐进关键帧都不是完整索引，保存值必然与源码不一致）
  const videoScanRef = useRef<{
    id: number
    promise: Promise<void>
    done: boolean
    keyframeTimes: number[]
    frameTimes: number[] | null
  } | null>(null)
  const [timecodes, setTimecodes] = useState<Framerate | null>(null)
  const [timecodesFromFile, setTimecodesFromFile] = useState(false)
  const [timecodesFileName, setTimecodesFileName] = useState('')
  // 视频自带逐帧时间码表（ms；FFMS2 TimecodesVector 语义，解复用扫描上报）
  const [videoFrameTimes, setVideoFrameTimes] = useState<number[] | null>(null)
  // 首帧偏移感知 UI：载入提醒（每视频一次）+ 导出时间码时保留偏移选择
  const [videoOffsetNotice, setVideoOffsetNotice] = useState<{
    offsetMs: number
    frameDurationMs: number
  } | null>(null)
  const offsetNoticeShownRef = useRef<File | undefined>(undefined)
  const [timecodesOffsetAsk, setTimecodesOffsetAsk] = useState<number | null>(null)
  const [frameMode, setFrameMode] = useState(false) // 网格/编辑框帧号模式
  // 最近文件（mru.cpp）与探测到的真实视频帧率
  const [recentLists, setRecentLists] = useState<RecentLists>(() => ({
    subtitle: [],
    video: [],
    audio: [],
    timecodes: [],
    keyframes: [],
  }))
  const [detectedFps, setDetectedFps] = useState<number | null>(null)
  // Lua Automation（auto4_base ScriptManager）
  const [automationScripts, setAutomationScripts] = useState<LoadedAutomationEntry[]>([])
  // 异步重载需要卸载旧脚本状态；state 在 useCallback([]) 里读到的是旧闭包，用 ref 同步
  const automationScriptsRef = useRef<LoadedAutomationEntry[]>([])
  useEffect(() => {
    automationScriptsRef.current = automationScripts
  }, [automationScripts])
  // 宏运行期的 aegisub.dialog.display 请求与进度对话框（替代源码的模态对话框）
  const [luaDialog, setLuaDialog] = useState<{
    spec: DialogSpec
    /** 导出过滤器 Configure 重开时的回填值 */
    initialValues?: DialogValue[]
    resolve: (response: DialogResponseLike) => void
  } | null>(null)
  const [luaProgress, setLuaProgress] = useState<{
    title: string
    task: string
    value: number
    /** aegisub.log / debug.out 累积输出（DialogProgress 的只读日志框） */
    log: string
    /** 任务已结束：窗口保持显示日志，按钮切换为 Close */
    finished: boolean
    /** 已请求取消：按钮禁用并显示 Cancelling...（dialog_progress.cpp OnCancel） */
    cancelling: boolean
  } | null>(null)
  const luaProgressCloseRef = useRef<(() => void) | null>(null)
  const luaCancelledRef = useRef(false)
  // 导出过滤器的 Configure 结果（键 `${stateId}:${name}`；spec + 最后一次回读值）。
  // 对应桌面的 automation_settings 持久化（本版本不落盘，仅会话内缓存）
  const [filterConfigs, setFilterConfigs] = useState<
    Record<string, { spec: DialogSpec; values: DialogValue[] }>
  >({})
  // Automation 菜单项的 validate / isactive 结果缓存（menu.cpp CommandManager::UpdateItem：
  // 打开菜单时刷新 dynamic 项 → 禁用/勾选态）。键为宏命令 id
  const [macroMenuState, setMacroMenuState] = useState<
    Record<string, { enabled: boolean; checked: boolean }>
  >({})
  const loadedRef = useRef(false)
  // autosaved_commit_id 对应物：最近一次自动保存/文档替换时的 revision
  const lastAutosaveRevisionRef = useRef(0)

  // 多语言引导（app.cpp wxLocale 初始化语义）：App/Language 或浏览器语言 →
  // 异步拉取 po → i18n 版本号通知整树重渲染；切换语言时同样经 useLocaleVersion 刷新
  useLocaleVersion()
  useEffect(() => {
    void initLocale()
  }, [])

  // 日志 → 状态栏单行消息。Aegisub 的诊断出口是 agi::log（Log window 查看），
  // 用户可见反馈走 StatusTimeout；Web 版把日志条目同步显示到状态栏：
  // info 10 秒自动清除，warning/error 保持到下一条消息（如 Local Font 不可用提示）
  useEffect(() => {
    installGlobalLogHandlers()
    // 渲染器创建发生在子组件 effect（早于本订阅），补读缓冲里最近一条
    const entries = getLogEntries()
    const last = entries[entries.length - 1]
    if (last && Date.now() - last.time < 5000)
      // oxlint-disable-next-line react/set-state-in-effect
      setStatus(last.message, last.level === 'info' ? STATUS_TIMEOUT_MS : 0)
    return subscribeLogs((entry) => {
      setStatus(entry.message, entry.level === 'info' ? STATUS_TIMEOUT_MS : 0)
    })
  }, [setStatus])

  useEffect(() => {
    const client = new CoreClient()
    coreRef.current = client
    let cancelled = false
    void (async () => {
      // 启动不采纳自动保存（源码 frame_main 同样不恢复）：自动保存的恢复只能由
      // File → Open Autosaved Subtitles... 显式触发。启动静默载入历史自动保存会
      // 把 UI 拖进异常状态——旧核心遗留的空文档经 TS 回退运行时 restore 直接
      // structuredClone，网格变 0 行、编辑栏「未选中行」、插入行无操作
      const initial = await client.state()
      const recents = await loadRecentLists()
      if (cancelled) return
      setRecentLists(recents)
      setCore(initial)
      const first = initial.document.cues[0]?.id ?? null
      setActiveId(first)
      if (first) setSelectedIds(new Set([first]))
      loadedRef.current = true
    })()
    return () => {
      cancelled = true
      client.close()
    }
  }, [])

  // Limits/Undo Levels 下发到文档运行时（WASM 核心由 C++ 侧管理，仅 TS 回退生效）
  useEffect(() => {
    coreRef.current?.configure({ undoLevels: getOptionInt('Limits/Undo Levels') })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- optionsVersion 仅为触发重读配置
  }, [optionsVersion])

  // 自动保存（SubsController::AutoSave：仅当存在未自动保存的修改——autosaved_commit_id
  // 语义用 document.revision 追踪；Save on Every Change 优先，其次定时 App/Auto/Save）
  useEffect(() => {
    if (!core || !loadedRef.current) return
    const document = core.document
    const save = () => {
      if (document.revision === lastAutosaveRevisionRef.current) return
      lastAutosaveRevisionRef.current = document.revision
      const name = document.sourceName || 'Untitled'
      const client = coreRef.current
      if (!client) return
      // 自动保存写真实 .ass 文本到 Path/Auto/Save（源码 SubtitleFormat::GetWriter(path)->WriteFile）
      void client
        .export('ass')
        .then((bytes) => saveAutosave(name, decodeText(bytes)))
        .then((path) => setStatus(`File backup saved as "${path}".`))
        .catch(() => undefined)
    }
    if (getOptionBool('App/Auto/Save on Every Change')) {
      // 源码：仅已有文件名（非新建未命名）的文档才每次修改后保存
      if (document.sourceName && document.sourceName !== 'untitled.ass') {
        const timer = window.setTimeout(save, 700)
        return () => window.clearTimeout(timer)
      }
      return undefined
    }
    if (getOptionBool('App/Auto/Save')) {
      const ms = Math.max(1, getOptionInt('App/Auto/Save Every Seconds')) * 1000
      const timer = window.setInterval(save, ms)
      return () => window.clearInterval(timer)
    }
    return undefined
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- optionsVersion 仅为触发重建定时器
  }, [core, optionsVersion, setStatus])

  // 网格配色 → CSS 变量（Colour/Subtitle Grid，Preferences → Interface → Colors）
  // dark 主题下这些 Aegisub 亮色向配色按 HSL 亮度反相适配：背景抬升下限、前景压低上限
  useEffect(() => {
    const root = document.documentElement
    const dark = theme === 'dark'
    const adaptBg = (value: string) => (dark ? invertLightness(value, { min: 0.07 }) : value)
    const adaptFg = (value: string) => (dark ? invertLightness(value, { max: 0.93 }) : value)
    const setVar = (name: string, value: string) => root.style.setProperty(name, value)
    setVar('--grid-fg', adaptFg(getOptionString('Colour/Subtitle Grid/Standard')))
    setVar('--grid-fg-collision', adaptFg(getOptionString('Colour/Subtitle Grid/Collision')))
    setVar('--grid-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Background')))
    setVar('--grid-sel-fg', adaptFg(getOptionString('Colour/Subtitle Grid/Selection')))
    setVar('--grid-sel-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Selection')))
    setVar('--grid-comment-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Comment')))
    setVar(
      '--grid-sel-comment-bg',
      adaptBg(getOptionString('Colour/Subtitle Grid/Background/Selected Comment')),
    )
    setVar('--grid-inframe-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Background/Inframe')))
    setVar('--grid-header-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Header')))
    setVar('--grid-left-bg', adaptBg(getOptionString('Colour/Subtitle Grid/Left Column')))
    setVar('--grid-active-border', adaptBg(getOptionString('Colour/Subtitle Grid/Active Border')))
    setVar('--grid-line', adaptBg(getOptionString('Colour/Subtitle Grid/Lines')))
    setVar('--grid-cps-error', adaptFg(getOptionString('Colour/Subtitle Grid/CPS Error')))
    // Subtitle/Grid/Font Size：wxWidgets pt → CSS px（9pt → 12px）
    const gridSize = getOptionInt('Subtitle/Grid/Font Size')
    setVar('--grid-font-size', `${Math.round((gridSize * 4) / 3)}px`)
    // 行高 = 字符高 + 4（base_grid.cpp UpdateStyle），随字号实测
    setVar('--row-height', `${gridRowHeight()}px`)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- optionsVersion 仅为触发重读配置
  }, [theme, optionsVersion])

  // 窗口标题：与 FrameMain::UpdateTitle 一致（未保存时 "* " 前缀 + 文件名 + " - Aegisub"）
  useEffect(() => {
    if (!core) return
    const name = core.document.sourceName || 'untitled'
    document.title = `${dirty ? '* ' : ''}${name} - Aegisub`
  }, [core, dirty])

  const selectedCue = useMemo(
    () => core?.document.cues.find((cue) => cue.id === activeId) ?? null,
    [activeId, core],
  )
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // subs_edit_box.cpp：active_style = c->ass->GetStyle(line->Style)（样式缺失时 Edit 按钮禁用）
  const activeStyle = core?.document.styles.find((item) => item.name === selectedCue?.style) ?? null
  // Edit 按钮打开的样式（对话框随文档更新取最新值；改名后 id 失配时按名字回退）
  const editingStyle =
    core?.document.styles.find((item) => item.id === editingStyleHandle?.id) ??
    core?.document.styles.find((item) => item.name === editingStyleHandle?.name) ??
    null
  // 改名落地后把句柄切到新 id（否则连续改名时既失去 id 也失去旧名字的回退依据）
  if (editingStyle && editingStyle.id !== editingStyleHandle?.id) {
    setEditingStyleHandle({ id: editingStyle.id, name: editingStyle.name })
  }
  /** dialog_style_editor.cpp StyleRenamer::NeedsReplace：脚本内是否存在该样式引用 */
  const styleHasReferences = (name: string) =>
    core?.document.cues.some((cue) => cue.style === name || hasStyleOverride(cue.text, name)) ??
    false
  // subs_edit_box.cpp PopulateList：全文档 Actor/Effect 去重排序，供编辑框 datalist
  const actorValues = useMemo(() => {
    if (!core) return []
    return [...new Set(core.document.cues.map((cue) => cue.actor).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    )
  }, [core])
  const effectValues = useMemo(() => {
    if (!core) return []
    return [...new Set(core.document.cues.map((cue) => cue.effect).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    )
  }, [core])
  // 视觉工具 SetSelectedOverride 的目标集合：选中行（无选中时回退活动行）
  const selectedCues = useMemo(() => {
    if (!core) return []
    return selectedOrActive(core.document, selectedSet, activeId)
      .map((id) => core.document.cues.find((cue) => cue.id === id))
      .filter((cue) => cue !== undefined)
  }, [core, selectedSet, activeId])
  // 无视频或真实尺寸尚未上报（载入中）时，视频面板按 1080p 占位；预览内部视口
  // 必须用同一组 intrinsic/zoom，否则会按上一个视频的尺寸与缩放渲染（看似缩放错乱）
  const videoPlaceholder = !videoMedia || !videoSizeReady
  // 占位缩放是独立的显示值（默认 50%），与真实视频的 windowZoom 互不影响：
  // 载入视频后由 OnVideoOpen 结算到 videoWindowZoom，占位值保持不变
  const previewZoom = videoPlaceholder ? placeholderZoom : videoWindowZoom
  // 缩放输入落到当前生效的缩放：占位期间改占位显示值，真实视频载入后改 windowZoom
  const changeVideoZoom = useCallback(
    (zoom: number) => {
      if (videoPlaceholder) setPlaceholderZoom(zoom)
      else setVideoWindowZoom(zoom)
    },
    [videoPlaceholder],
  )
  const previewIntrinsic = videoPlaceholder ? PLACEHOLDER_VIDEO_SIZE : videoIntrinsicSize
  const videoLayout = useMemo(
    () =>
      calculateAttachedVideoLayout(
        previewIntrinsic,
        previewZoom,
        aspectOverride ?? previewIntrinsic.width / Math.max(1, previewIntrinsic.height),
        devicePixelRatioValue,
      ),
    [aspectOverride, previewIntrinsic, previewZoom, devicePixelRatioValue],
  )
  const videoLayoutRef = useRef(videoLayout)
  videoLayoutRef.current = videoLayout

  // video/detach：把视频面板 host 搬进/搬出独立窗口（关闭窗口即重新挂回）
  useEffect(() => {
    const previewHost = previewHostRef.current
    if (!previewHost) return
    if (!videoDetached) {
      const mount = previewMountRef.current
      if (mount && previewHost.parentNode !== mount) mount.appendChild(previewHost)
      previewHost.style.display = 'contents'
      previewWindowRef.current?.close()
      previewWindowRef.current = null
      return
    }
    const layout = videoLayoutRef.current
    const popup = window.open(
      '',
      'aegisub-detached-video',
      `popup=yes,width=${Math.round(layout.panelWidth) + 24},height=${Math.round(layout.panelHeight) + 48}`,
    )
    if (!popup) {
      setStatus(tPlain('Could not open the detached video window'))
      setVideoDetached(false)
      return
    }
    previewWindowRef.current = popup
    copyStylesToPopup(popup)
    popup.document.title = 'Aegisub — Video'
    // 跨文档搬运 host 节点（appendChild 会 adopt），React portal 事件仍挂在 host 上
    previewHost.style.cssText =
      'display:block;position:fixed;inset:0;overflow:hidden;background:#1e1e1e;'
    popup.document.body.appendChild(previewHost)
    // 弹窗内按键转发到主窗口 Video 上下文（热键表监听在主 window 上）
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return
      const proxy = detachedKeyTargetRef.current
      if (!proxy) return
      const forwarded = new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        which: event.which,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      })
      proxy.dispatchEvent(forwarded)
      if (forwarded.defaultPrevented) event.preventDefault()
    }
    popup.document.addEventListener('keydown', onKeyDown)
    const closedCheck = window.setInterval(() => {
      if (popup.closed) setVideoDetached(false)
    }, 400)
    return () => {
      window.clearInterval(closedCheck)
      popup.document.removeEventListener('keydown', onKeyDown)
      if (!popup.closed) popup.close()
      if (previewWindowRef.current === popup) previewWindowRef.current = null
      const mount = previewMountRef.current
      if (mount) mount.appendChild(previewHost)
      previewHost.style.display = 'contents'
    }
  }, [videoDetached, setStatus])

  // JumpToTime(ms, START)（video_controller.cpp）：FrameAtTime(start, START) 定帧后
  // 落到该帧 EXACT 时间。直接用原始行首 ms 会落到"包含行首的那一帧"（≤ 行首），
  // 与源码"第一个 ≥ 行首的帧"差一帧，且时间框相对值符号相反（对不上字幕时间戳）
  const seekVideoToLineStart = (startMs: number) => {
    if (!videoMedia || !frameRate.isLoaded()) return
    setVideoTimeMs(frameRate.timeAtFrame(frameRate.frameAtTime(startMs, 'start'), 'exact'))
  }

  // 活动行切换标记：仅行变化时 seek（源码 OnActiveLineChanged 只由行切换触发，
  // 字幕内容/时间编辑不改活动行，不应错误跳转）
  const activeLineIdRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const lineChanged = activeLineIdRef.current !== activeId
    activeLineIdRef.current = activeId
    // 视频自动跟随选中行（video_controller.cpp OnActiveLineChanged：Stop() + JumpToTime）
    // oxlint-disable-next-line react/set-state-in-effect
    if (lineChanged && videoAutoScroll && videoMedia && selectedCue) {
      sendVideoAction('stop')
      seekVideoToLineStart(selectedCue.startMs)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, selectedCue, videoAutoScroll, videoMedia])

  // 帧率状态机（project.cpp）：timecodes 文件 > 视频自带逐帧时间码表（FFMS2
  // TimecodesVector）> 视频自带 CFR（探测帧率或 24，表不可得时的回退）> 未加载
  const frameRate = useMemo(() => {
    if (timecodes) return timecodes
    if (videoFrameTimes && videoFrameTimes.length >= 2)
      return Framerate.fromTimecodes(videoFrameTimes)
    if (videoMedia) return Framerate.cfr(detectedFps ?? DEFAULT_FPS)
    return Framerate.empty()
  }, [timecodes, videoFrameTimes, videoMedia, detectedFps])
  const currentFrame = useMemo(
    () => (frameRate.isLoaded() ? frameRate.frameAtTime(videoTimeMs) : 0),
    [frameRate, videoTimeMs],
  )
  // Project Garbage videoPosition：视频/时间码就绪后跳到保存时的帧（project.cpp LoadSubtitles）
  useEffect(() => {
    const frame = pendingVideoPositionRef.current
    if (frame === null || !videoMedia || !frameRate.isLoaded()) return
    pendingVideoPositionRef.current = null
    setVideoTimeMs(Math.max(0, frameRate.timeAtFrame(frame)))
  }, [videoMedia, frameRate])
  const frameCount = useMemo(() => {
    // 源码 project.cpp：timecodes 文件只改时间↔帧映射，帧数仍是视频 provider 的
    // （GetFrameCount 不随加载的 timecodes 变；滑块长度、Save Timecodes 外推长度同理）
    if (videoFrameTimes && videoFrameTimes.length >= 2) return videoFrameTimes.length
    // 回退：provider GetFrameCount 语义按探测帧率而非固定 24（否则滑块游标错位）
    if (videoDurationMs > 0)
      return Math.max(1, Math.round((videoDurationMs * (detectedFps ?? DEFAULT_FPS)) / 1000))
    if (timecodes) return timecodes.frameCount()
    return 1
  }, [timecodes, videoFrameTimes, videoDurationMs, detectedFps])
  // 视频关键帧 ms→帧号：关键帧时间为视频流原始 PTS。帧号 = 在原始逐帧时间码表中的
  // 下界序号（FFMS2 索引按 PTS 升序排帧，keyframe 帧号即排序后位置）——不能用归一化
  // 后的 frameRate.frameAtTime（首帧 PTS ≠ 0 时整体偏移 N 帧；加载 timecodes 文件后
  // 时间线也换掉），视频自身帧序号不随这些变
  const videoKeyframes = useMemo(() => {
    if (!videoKeyframeTimes.length) return []
    if (videoFrameTimes && videoFrameTimes.length >= 2)
      return videoKeyframeTimes.map((ms) => lowerBoundIndex(videoFrameTimes, ms))
    // 无表（CFR 回退）：帧号按探测帧率时间线外推
    return videoKeyframeTimes.map((ms) => frameRate.frameAtTime(ms))
  }, [videoKeyframeTimes, videoFrameTimes, frameRate])
  // keyframes 文件优先（project.cpp：文件加载 > 视频自带）
  const activeKeyframes = keyframesFromFile ? keyframes : videoKeyframes

  /**
   * aegisub.video_size（auto4_lua.cpp video_size）：仅在已加载视频时返回
   * 宽、高、宽高比数值与 video_controller.h 的 AspectRatio 枚举。
   */
  const luaVideoSize = () => {
    if (!videoMedia) return null
    const width = videoIntrinsicSize.width
    const height = videoIntrinsicSize.height
    const aspectValue = aspectOverride ?? width / Math.max(1, height)
    // AspectRatio：Default=0 Fullscreen=1 Widescreen=2 Cinematic=3 Custom=4
    let aspectType = 0
    if (aspectOverride !== null) {
      if (aspectOverride === 4 / 3) aspectType = 1
      else if (aspectOverride === 16 / 9) aspectType = 2
      else if (aspectOverride === 2.35) aspectType = 3
      else aspectType = 4
    }
    return { width, height, aspectValue, aspectType }
  }

  /** aegisub.frame_from_ms / ms_from_frame：Timecodes 未加载时桌面返回 nil */
  const luaFrameFromMs = (ms: number) =>
    frameRate.isLoaded() ? frameRate.frameAtTime(ms, 'start') : null
  const luaMsFromFrame = (frame: number) =>
    frameRate.isLoaded() ? frameRate.timeAtFrame(frame, 'start') : null

  /** 把一份源码登记为脚本条目（加载失败也保留，错误由管理器展示） */
  const loadAutomationEntry = async (
    code: string,
    path: string,
    filename: string,
    isGlobal: boolean,
  ): Promise<LoadedAutomationEntry> => {
    try {
      const loaded = await loadAutomationScript(code, path)
      return { key: path, filename, code, isGlobal, ...loaded, error: undefined }
    } catch (error) {
      return {
        key: path,
        filename,
        code,
        isGlobal,
        stateId: -1,
        name: filename,
        description: '',
        author: '',
        version: '',
        warnings: [],
        macros: [],
        filters: [],
        error: error instanceof Error ? error.message : tPlain('Failed to load script'),
      }
    }
  }

  /** 全局脚本：扫描 /automation/autoload（AutoloadScriptManager::Reload） */
  const loadGlobalAutomationEntries = async (): Promise<LoadedAutomationEntry[]> => {
    const stored = await loadAutomationScripts()
    return Promise.all(
      stored.map((script) => loadAutomationEntry(script.code, script.id, script.filename, true)),
    )
  }

  /**
   * 解析项目属性里的脚本引用（LocalScriptManager::Reload L381-401）：
   * `/` 绝对路径、`$` 相对 Path/Automation/Base、`~` 相对字幕目录。
   * Web 字幕不在 VFS 中，`~` 按 VFS 根目录尽力解析；未知前缀忽略。
   */
  const resolveAutomationScriptRef = (token: string): string | null => {
    const trimmed = token.trim()
    if (!trimmed) return null
    const rest = trimmed.slice(1)
    if (trimmed[0] === '/') return rest.startsWith('/') ? rest : `/${rest}`
    if (trimmed[0] === '$') return joinPath('/automation', rest)
    if (trimmed[0] === '~') return `/${rest.replace(/^\/+/, '')}`
    return null
  }

  /** 把本地脚本列表写回项目属性（LocalScriptManager::SaveLoadedList） */
  const persistLocalAutomationScripts = (entries: LoadedAutomationEntry[]) => {
    if (!coreRef.current) return
    const value = entries
      .filter((entry) => !entry.isGlobal)
      .map((entry) => {
        if (entry.key.startsWith('/automation/'))
          return `$${entry.key.slice('/automation/'.length)}`
        return `/${entry.key.replace(/^\/+/, '')}`
      })
      .join('|')
    // 空 label：属性变更不建立撤销点（对应桌面 Project Garbage 的非撤销写入）
    coreRef.current.apply([{ type: 'updateProperties', patch: { automationScripts: value } }], '')
  }

  /** 本地脚本：读取项目 Automation Scripts 引用，按桌面流程询问是否信任并加载 */
  const loadLocalAutomationEntries = async (
    document: SubtitleDocument,
  ): Promise<LoadedAutomationEntry[]> => {
    const refs = (document.properties.automationScripts ?? '')
      .split('|')
      .map((token) => token.trim())
      .filter(Boolean)
    if (!refs.length) return []
    const resolved = refs
      .map(resolveAutomationScriptRef)
      .filter((path): path is string => path !== null)
    if (!resolved.length) return []
    const list = resolved.map((path) => `    ${path}`).join('\n')
    const choice = await askChoice(
      tPlain('Load associated automation scripts?'),
      tFmt(
        'The subtitle file you have opened contains local automation scripts. Do you want to load the associated automation scripts?\n\nList of scripts:\n\n%1\n\nYou should only load associated automation scripts if you trust their authors! They are not required to view or edit the subtitle file.',
        list,
      ),
      [tPlain('Trust the authors && load scripts'), tPlain('No')],
      1,
    )
    if (choice !== 0) {
      // 桌面版拒绝后 SaveLoadedList 会把属性清空
      persistLocalAutomationScripts([])
      return []
    }
    const entries: LoadedAutomationEntry[] = []
    for (const path of resolved) {
      // 脚本可能已被移动/删除：警告后跳过（LocalScriptManager::Reload）
      // oxlint-disable-next-line no-await-in-loop -- 脚本须按引用顺序加载
      const code = await readAutomationScriptFile(path)
      if (code === null) {
        setStatus(tFmt('Automation script "%1" could not be found', path))
        continue
      }
      const filename = path.split('/').pop() || path
      // oxlint-disable-next-line no-await-in-loop -- 同上
      entries.push(await loadAutomationEntry(code, path, filename, false))
    }
    return entries
  }

  /** 重新加载全局脚本（保留已加载的本地脚本；am/reload/autoload 与 Rescan Autoload Dir） */
  const reloadGlobalAutomationScripts = async () => {
    for (const script of automationScriptsRef.current) {
      if (script.isGlobal) unloadAutomationScript(script.stateId)
    }
    const entries = await loadGlobalAutomationEntries()
    setAutomationScripts((current) => [...entries, ...current.filter((script) => !script.isGlobal)])
  }

  /** 文件打开监听：LocalScriptManager 随字幕文件重新加载本地脚本 */
  const reloadLocalAutomationScripts = async (document: SubtitleDocument) => {
    // 旧文件的本地脚本先卸载（ScriptManager::Remove）
    for (const script of automationScriptsRef.current) {
      if (!script.isGlobal) unloadAutomationScript(script.stateId)
    }
    const entries = await loadLocalAutomationEntries(document)
    setAutomationScripts((current) => [...current.filter((script) => script.isGlobal), ...entries])
  }

  /** am/reload：重载全局 + 本地脚本 */
  const reloadAllAutomationScripts = useCallback(async () => {
    for (const script of automationScriptsRef.current) unloadAutomationScript(script.stateId)
    const globalEntries = await loadGlobalAutomationEntries()
    const document = coreRef.current ? (await coreRef.current.state()).document : null
    const localEntries = document ? await loadLocalAutomationEntries(document) : []
    setAutomationScripts([...globalEntries, ...localEntries])
    // 上述加载函数只依赖 coreRef / 稳定 store，不需要跟随渲染重建
    // oxlint-disable-next-line react/exhaustive-deps -- 仅需在挂载/后端切换时执行
  }, [])

  useEffect(() => {
    // 启动时只恢复全局脚本；本地脚本在字幕文件打开后由 reloadLocalAutomationScripts 加载
    let cancelled = false
    void loadGlobalAutomationEntries().then((entries) => {
      if (!cancelled) {
        setAutomationScripts((current) => [
          ...entries,
          ...current.filter((script) => !script.isGlobal),
        ])
      }
    })
    return () => {
      cancelled = true
    }
    // oxlint-disable-next-line react/exhaustive-deps -- 仅挂载时扫描一次 autoload
  }, [])

  // Automation/Backend 变更：旧 VM 的脚本状态全部失效，重建后端并重新加载脚本
  const luaBackendRef = useRef(getOptionString('Automation/Backend'))
  useEffect(() => {
    const backend = getOptionString('Automation/Backend')
    if (backend === luaBackendRef.current) return
    luaBackendRef.current = backend
    resetAutomationBackend()
    void reloadAllAutomationScripts()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- optionsVersion 仅为触发重读配置
  }, [optionsVersion, reloadAllAutomationScripts])

  const addAutomationScript = async () => {
    const file = await host.openFile([
      { description: 'Lua scripts', accept: { 'text/plain': ['.lua', '.moon'] } },
    ])
    if (!file) return
    // 桌面 DialogAutomation::OnAdd：同名脚本已加载时报错（"Script '%s' is already loaded"）
    if (automationScripts.some((script) => script.filename === file.name)) {
      setStatus(`Automation: script "${file.name}" is already loaded`)
      return
    }
    const code = decodeText(await host.readFile(file))
    try {
      const path = automationLocalScriptPath(file.name)
      const loaded = await loadAutomationScript(code, path)
      // 落盘到 /automation/local，并把引用写入项目属性（本地脚本随字幕文件保存）
      await writeLocalAutomationScript(file.name, code)
      const entry: LoadedAutomationEntry = {
        key: path,
        filename: file.name,
        code,
        isGlobal: false,
        ...loaded,
      }
      const next = [...automationScripts, entry]
      setAutomationScripts(next)
      persistLocalAutomationScripts(next)
      setStatus(`Automation: ${loaded.name} loaded (${loaded.macros.length} macros)`)
    } catch (error) {
      setStatus(
        `Automation load failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }

  const removeAutomationScript = (key: string) => {
    const entry = automationScripts.find((script) => script.key === key)
    // 全局脚本来自 autoload 目录，管理器不允许 Remove（DialogAutomation::OnRemove）
    if (!entry || entry.isGlobal) return
    // 桌面 Remove 只把脚本移出项目列表，不删除源文件
    unloadAutomationScript(entry.stateId)
    const next = automationScripts.filter((script) => script.key !== key)
    setAutomationScripts(next)
    persistLocalAutomationScripts(next)
  }

  const reloadAutomationScript = async (key: string) => {
    const script = automationScripts.find((item) => item.key === key)
    if (!script) return
    // Script::Reload：重新读取脚本文件内容，旧脚本状态先卸载
    const oldStateId = script.stateId
    const code = (await readAutomationScriptFile(key)) ?? script.code
    try {
      const loaded = await loadAutomationScript(code, key)
      if (oldStateId >= 0) unloadAutomationScript(oldStateId)
      setAutomationScripts((current) =>
        current.map((item) =>
          item.key === key ? { ...item, ...loaded, code, error: undefined } : item,
        ),
      )
    } catch (error) {
      if (oldStateId >= 0) unloadAutomationScript(oldStateId)
      const message = error instanceof Error ? error.message : tPlain('Failed to load script')
      setAutomationScripts((current) =>
        current.map((item) =>
          item.key === key
            ? { ...item, stateId: -1, macros: [], filters: [], warnings: [], error: message }
            : item,
        ),
      )
    }
  }

  /**
   * 刷新 Automation 菜单项的禁用/勾选态（menu.cpp CommandManager::UpdateItem）：
   * 仅在宏注册了 validate（COMMAND_VALIDATE）或 isactive（COMMAND_TOGGLE）时才调用脚本。
   * 打开 Automation 菜单时触发，对齐源码 wxEVT_MENU_OPEN 的 lazy 求值。
   */
  const refreshMacroMenuStates = async () => {
    if (!core) return
    const macros = automationScripts.flatMap((script) =>
      script.stateId < 0 ? [] : script.macros.map((macro) => ({ stateId: script.stateId, macro })),
    )
    if (!macros.some(({ macro }) => macro.hasValidate || macro.hasIsActive)) return

    const rows = documentToLuaRows(core.document)
    const cueIndex = makeCueIndex(core.document)
    const selectedIndexes = selectedOrActive(core.document, selectedSet, activeId)
      .map((cueId) => cueIndex(cueId))
      .filter((index) => index >= 0)
    const activeIndex = activeId ? cueIndex(activeId) : -1
    const menuHost: AutomationHost = {
      log: (message) => logInfo('automation', message),
      textExtents: (style, text) => measureLuaTextExtents(style, text),
      setStatusText: (text) => setStatus(text),
      videoSize: () => luaVideoSize(),
      frameFromMs: (ms) => luaFrameFromMs(ms),
      msFromFrame: (frame) => luaMsFromFrame(frame),
    }

    const next: Record<string, { enabled: boolean; checked: boolean }> = {}
    for (const { stateId, macro } of macros) {
      let enabled = true
      let checked = false
      try {
        if (macro.hasValidate) {
          // 各宏共享同一 Lua 状态机，必须串行求值
          // oxlint-disable-next-line no-await-in-loop
          const result = await validateAutomationMacro(
            stateId,
            macro.name,
            rows,
            selectedIndexes,
            activeIndex,
            menuHost,
          )
          enabled = result.ok
          // 校验函数内 log/错误走 wxLogWarning 语义（源码 Validate 的 wxLogWarning）
          for (const message of result.log) logInfo('automation', message)
        }
        if (macro.hasIsActive) {
          // oxlint-disable-next-line no-await-in-loop
          const result = await isActiveAutomationMacro(
            stateId,
            macro.name,
            rows,
            selectedIndexes,
            activeIndex,
            menuHost,
          )
          checked = result.ok && result.active
          for (const message of result.log) logInfo('automation', message)
        }
      } catch {
        // validate/isactive 求值失败按 Aegisub 语义视为禁用（源码 Validate 返回 false）
        enabled = false
      }
      next[macro.id] = { enabled, checked }
    }
    setMacroMenuState(next)
  }

  /**
   * DialogProgress::Run 的任务结束收尾：取消或没有日志时直接收起；否则窗口保持打开、
   * 按钮变为 Close、进度拉满，等待用户读完日志后关闭（运行期错误也走这条路径）。
   */
  const finishLuaProgress = async (log: string[]): Promise<void> => {
    if (luaCancelledRef.current || log.length === 0) {
      setLuaProgress(null)
      return
    }
    setLuaProgress((current) =>
      current
        ? { ...current, log: log.join(''), value: 100, finished: true, cancelling: false }
        : current,
    )
    await new Promise<void>((resolve) => {
      luaProgressCloseRef.current = resolve
    })
    luaProgressCloseRef.current = null
    setLuaProgress(null)
  }

  /** 宏/过滤器运行的宿主（aegisub.* 的 UI 出口：配置对话框、进度、取消、日志） */
  const makeAutomationHost = (): AutomationHost => {
    // 脚本常按行调用 progress.set（数千次），逐次入队 React 更新会淹没调度器；
    // 仅在进度变化 ≥0.5% 或距上次刷新 ≥50ms 时提交（首尾值始终提交）
    let lastProgressValue = -1
    let lastProgressAt = 0
    return {
      showDialog: (spec) =>
        new Promise<DialogResponseLike>((resolve) => setLuaDialog({ spec, resolve })),
      setProgress: (value) => {
        const now = performance.now()
        if (
          value > 0 &&
          value < 100 &&
          Math.abs(value - lastProgressValue) < 0.5 &&
          now - lastProgressAt < 50
        )
          return
        lastProgressValue = value
        lastProgressAt = now
        setLuaProgress((current) => (current ? { ...current, value } : current))
      },
      setTask: (task) => setLuaProgress((current) => (current ? { ...current, task } : current)),
      setTitle: (title) =>
        setLuaProgress((current) =>
          current
            ? { ...current, title }
            : { title, task: '', value: 0, log: '', finished: false, cancelling: false },
        ),
      isCancelled: () => luaCancelledRef.current,
      log: (message) => {
        logInfo('automation', message)
        // ps->Log：追加到进度窗口的日志框（DialogProgress 的 pending_log）
        setLuaProgress((current) =>
          current ? { ...current, log: current.log + message } : current,
        )
      },
      textExtents: (style, text) => measureLuaTextExtents(style, text),
      setStatusText: (text) => setStatus(text),
      videoSize: () => luaVideoSize(),
      frameFromMs: (ms) => luaFrameFromMs(ms),
      msFromFrame: (frame) => luaMsFromFrame(frame),
      // wxFileDialog 的 web 对应物：浏览器选择器无可配置标题/目录，也拿不到真实路径
      openFileDialog: async ({ title, wildcard }) => {
        const extensions = [...wildcard.matchAll(/\*\.[a-z0-9]+/gi)].map((match) =>
          match[0].slice(1),
        )
        const file = await host.openFile([
          {
            description: title || 'Files',
            accept: extensions.length ? { 'application/octet-stream': extensions } : { '*/*': [] },
          },
        ])
        return file ? [file.name] : null
      },
      // 桌面弹 wxFileDialog 返回完整路径；web 用 prompt 取文件名（脚本无法据此写盘）
      saveFileDialog: async ({ title, defaultFile }) => {
        const name = window.prompt(title || 'Save', defaultFile)
        return name?.trim() ? name.trim() : null
      },
    }
  }

  /**
   * 宏命令入口：按撤销点顺序整表重放（auto4_lua.cpp ProcessingComplete →
   * 每个 LuaSetUndoPoint 一次 Commit，末尾修改以宏名为描述提交）。
   */
  const runAutomationMacroById = async (id: string) => {
    if (!core || !coreRef.current) return
    const entry = automationScripts.find((script) => script.macros.some((macro) => macro.id === id))
    const macro = entry?.macros.find((item) => item.id === id)
    if (!entry || !macro || entry.stateId < 0) {
      setStatus(tPlain('Automation macro is not loaded'))
      return
    }
    const rows = documentToLuaRows(core.document)
    const cueIndex = makeCueIndex(core.document)
    const selectedIndexes = selectedOrActive(core.document, selectedSet, activeId)
      .map((cueId) => cueIndex(cueId))
      .filter((index) => index >= 0)
    const activeIndex = activeId ? cueIndex(activeId) : -1

    luaCancelledRef.current = false
    setLuaProgress({
      title: macro.name,
      task: '',
      value: 0,
      log: '',
      finished: false,
      cancelling: false,
    })
    const luaHost = makeAutomationHost()

    try {
      const result = await runAutomationMacro(
        entry.stateId,
        macro.name,
        rows,
        selectedIndexes,
        activeIndex,
        luaHost,
      )
      if (!result.ok) {
        const cancelled = result.error === 'cancelled'
        setStatus(
          cancelled ? tPlain('Cancelled') : `Automation error: ${result.error ?? 'unknown error'}`,
        )
        // 运行期错误已由引擎写入 result.log（含 "Lua reported a runtime error" 块）；
        // DialogProgress 捕获抛出的异常后还会追加异常消息，随后保持窗口显示日志
        await finishLuaProgress(cancelled ? [] : [...result.log, 'Script threw an error'])
        return
      }
      let next: CoreState | null = core
      for (const commit of result.commits) {
        // 各撤销点必须按顺序串行提交，后一个提交依赖前一个的结果
        // oxlint-disable-next-line no-await-in-loop
        next = await apply([{ type: 'replaceDocument', ...commit.payload }], commit.label)
        if (!next) return
      }
      if (next) {
        const cues = next.document.cues
        // selected / active 已是最终文档的对白序数（0-based）
        if (result.selected?.length) {
          const ids = result.selected
            .filter((index) => index >= 0 && index < cues.length)
            .map((index) => cues[index].id)
          if (ids.length) setSelectedIds(new Set(ids))
        }
        if (result.active !== null && result.active >= 0 && result.active < cues.length)
          setActiveId(cues[result.active].id)
      }
      setStatus(`Automation: ${macro.name}`)
      // 有 aegisub.log / debug.out 输出时保持日志窗口（DialogProgress::Run 完成分支）
      await finishLuaProgress(result.log)
    } catch (error) {
      setStatus(`Automation error: ${error instanceof Error ? error.message : 'unknown error'}`)
      setLuaProgress(null)
    } finally {
      setLuaDialog(null)
    }
  }

  const apply = useCallback(
    // amend = 修订上一次提交（源码 AssFile::Commit 的 commitId / subs_controller.cpp:OnCommit
    // 的 commit_id 邻接判据）：只有编辑框与视觉工具拖拽这类"同一次交互内的连续提交"才传 true，
    // 命令类提交省略 → 各自成一个撤销点
    async (commands: CoreCommand[], label: string, amend?: boolean): Promise<CoreState | null> => {
      if (!coreRef.current) return null
      setBusy(true)
      try {
        const next = await coreRef.current.apply(commands, label, amend)
        setCore(next)
        setDirty(true)
        // label 为源码 msgid（小写），经 tPlain 命中 po 翻译显示
        setStatus(tPlain(label))
        return next
      } catch (error) {
        setStatus(error instanceof Error ? error.message : tPlain('Edit failed'))
        return null
      } finally {
        setBusy(false)
      }
    },
    [setStatus],
  )

  useEffect(() => {
    if (!core || (activeId && core.document.cues.some((cue) => cue.id === activeId))) return
    const first = core.document.cues[0]?.id ?? null
    // 活动行被删除后回退到首行（文档结构变化同步）
    // oxlint-disable-next-line react/set-state-in-effect
    setActiveId(first)
    setSelectedIds(first ? new Set([first]) : new Set())
    anchorRef.current = first
  }, [activeId, core])

  // 选中/活动行变化实时同步核心：修订撤销栈顶条目
  // （subs_controller.cpp:OnSelectionChanged/OnActiveLineChanged），撤销时按条目快照恢复
  useEffect(() => {
    coreRef.current?.notifySelection([...selectedIds], activeId)
  }, [selectedIds, activeId])

  const selectOnly = (id: string) => {
    setActiveId(id)
    setSelectedIds(new Set([id]))
    anchorRef.current = id
  }

  // 视觉工具点击特征的选择语义（visual_tool.cpp OnMouseEvent）：
  // SetSelection(feat, !ctrl)（Ctrl=并集/否则单选）+ SetActiveLine；BaseGrid::OnActiveLineChanged
  // 会把 extendRow（锚点）同步为活动行
  const visualSelectCue = (id: string, toggle: boolean) => {
    setSelectedIds((current) => {
      if (!toggle) return new Set([id])
      if (current.has(id)) return current
      const next = new Set(current)
      next.add(id)
      return next
    })
    setActiveId(id)
    anchorRef.current = id
  }

  const visualSetActiveCue = (id: string) => {
    setActiveId(id)
    anchorRef.current = id
  }

  // RemoveSelection：不移除最后一行；被移除的行恰为活动行时活动行转移到任一成员
  const visualDeselectCue = (id: string) => {
    if (!selectedIds.has(id) || selectedIds.size <= 1) return
    const next = new Set(selectedIds)
    next.delete(id)
    setSelectedIds(next)
    if (activeId === id) {
      const fallback = [...next][0] ?? null
      setActiveId(fallback)
      anchorRef.current = fallback
    }
  }

  const moveSelection = (direction: number) => {
    if (!core || !activeId) return
    const index = core.document.cues.findIndex((cue) => cue.id === activeId)
    const next =
      core.document.cues[Math.max(0, Math.min(core.document.cues.length - 1, index + direction))]
    if (next) selectOnly(next.id)
  }

  // audio_timing_dialogue.cpp Next(ResetMode)：
  // LINE_RESET_DEFAULT 或下一行 End==0 时，把下一行时间重置为 [上一行 End, +Default Duration]
  const moveSelectionOrCreate = async (resetDefault = false) => {
    if (!core || !activeId) return
    const index = core.document.cues.findIndex((cue) => cue.id === activeId)
    const active = core.document.cues[index]
    const next = core.document.cues[index + 1]
    if (next) {
      if (active && (resetDefault || next.endMs === 0)) {
        const startMs = active.endMs
        await apply(
          [
            {
              type: 'updateCue',
              id: next.id,
              patch: {
                startMs,
                endMs: startMs + getOptionInt('Timing/Default Duration'),
              },
            },
          ],
          tPlain('timing'),
        )
      }
      selectOnly(next.id)
      return
    }
    if (!active) return
    const before = new Set(core.document.cues.map((cue) => cue.id))
    const state = await apply(
      [
        {
          type: 'addCue',
          afterId: active.id,
          cue: {
            startMs: active.endMs,
            endMs: active.endMs + getOptionInt('Timing/Default Duration'),
            style: active.style,
          },
        },
      ],
      tPlain('line insertion'),
    )
    const inserted = state?.document.cues.find((cue) => !before.has(cue.id))
    if (inserted) selectOnly(inserted.id)
  }

  // base_grid.cpp OnMouseEvent 对齐：
  // - ctrl+单击 = 切换勾选（若该行是唯一选中行则不动，避免空选），锚点行随活动行更新
  // - shift+单击 = 块选 anchor..row（活动行移到点击行，锚点保持）
  // - ctrl+shift = 现有选中 ∪ 块选
  const selectCue = (id: string, modifiers: { toggle: boolean; range: boolean }) => {
    if (!core) return
    if (modifiers.range && anchorRef.current) {
      const from = core.document.cues.findIndex((cue) => cue.id === anchorRef.current)
      const to = core.document.cues.findIndex((cue) => cue.id === id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        const block = core.document.cues.slice(start, end + 1).map((cue) => cue.id)
        setSelectedIds((current) => {
          if (!modifiers.toggle) return new Set(block)
          const next = new Set(current)
          for (const cueId of block) next.add(cueId)
          return next
        })
      }
      setActiveId(id)
    } else if (modifiers.toggle) {
      setSelectedIds((current) => {
        if (current.has(id) && current.size === 1) return current
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setActiveId(id)
      anchorRef.current = id
    } else selectOnly(id)
  }

  // 块选（拖动/shift 范围）：同 base_grid.cpp 块选分支——SetActiveLine 后把锚点恢复为 fromId
  const selectRange = (fromId: string, toId: string, union: boolean) => {
    if (!core) return
    const from = core.document.cues.findIndex((cue) => cue.id === fromId)
    const to = core.document.cues.findIndex((cue) => cue.id === toId)
    if (from < 0 || to < 0) return
    const [start, end] = from < to ? [from, to] : [to, from]
    const block = core.document.cues.slice(start, end + 1).map((cue) => cue.id)
    setSelectedIds((current) => {
      if (!union) return new Set(block)
      const next = new Set(current)
      for (const cueId of block) next.add(cueId)
      return next
    })
    setActiveId(toId)
    anchorRef.current = fromId
  }

  // ---- 最近文件（mru.cpp：打开即记录，可从 Recent 子菜单重新打开）----
  const recordRecent = async (type: RecentType, handle: AppFileHandle) => {
    const lists = await pushRecent(type, { name: handle.name, file: handle.file })
    setRecentLists(lists)
  }

  const openRecent = async (type: string, index: number) => {
    const recentType = RECENT_TYPES.includes(type as RecentType) ? (type as RecentType) : null
    if (!recentType) return
    const entry = recentLists[recentType][index]
    if (!entry) return
    if (!entry.file) {
      setStatus(`"${entry.name}" is no longer available`)
      return
    }
    const handle: AppFileHandle = { name: entry.name, file: entry.file }
    switch (recentType) {
      case 'subtitle':
        await openSubtitleHandle(handle)
        break
      case 'video':
        await openVideoHandle(handle)
        break
      case 'audio':
        await openAudioHandle(handle)
        break
      case 'timecodes':
        await openTimecodesHandle(handle)
        break
      case 'keyframes':
        await openKeyframesHandle(handle)
        break
    }
  }

  /** 把 Project Garbage 里的 UI 状态还原到网格/视频（project.cpp LoadSubtitles） */
  const applyLoadedDocument = (state: CoreState) => {
    documentGenerationRef.current += 1
    setCore(state)
    setDirty(false)
    lastAutosaveRevisionRef.current = state.document.revision
    const properties = state.document.properties ?? createProjectProperties()
    const cues = state.document.cues
    const index =
      cues.length > 0 ? Math.max(0, Math.min(cues.length - 1, properties.activeRow)) : -1
    const id = index >= 0 ? cues[index].id : null
    setActiveId(id)
    setSelectedIds(id ? new Set([id]) : new Set())
    anchorRef.current = id
    if (Number.isFinite(properties.videoZoom) && properties.videoZoom > 0) {
      setVideoWindowZoom(properties.videoZoom)
    }
    // 宽高比不在此恢复：project.cpp LoadUnloadFiles 只在关联视频实际载入时用工程存档的
    // ArMode/ArValue 覆盖（见 autoLoadLinkedFiles）。仅打开字幕（无视频、会话恢复跳过
    // 关联文件）时若提前套用，后续手动打开的非 16:9 视频也会被撑成存档里的宽高比。
    setGridScrollRow(Math.max(0, properties.scrollPosition))
    gridRestoreTokenRef.current += 1
    setGridScrollRestore({
      row: Math.max(0, properties.scrollPosition),
      token: gridRestoreTokenRef.current,
    })
    pendingVideoPositionRef.current = properties.videoPosition > 0 ? properties.videoPosition : null
    // LocalScriptManager 随字幕文件打开事件重载本地脚本（auto4_base.cpp L364）
    void reloadLocalAutomationScripts(state.document)
  }

  /** 关联文件：VFS 路径 → VFS 文件名 → 最近文件（Web 无原生路径，按此顺序解析） */
  const resolveLinkedHandle = async (
    path: string,
    kind: RecentType,
  ): Promise<AppFileHandle | null> => {
    const candidates = [path, vfsDecode(path)].filter(Boolean)
    const found = await Promise.all(
      candidates.map(async (candidate) => {
        if (!(await fileExists(candidate))) return null
        const bytes = await readBytes(candidate)
        return bytes ? { candidate, bytes } : null
      }),
    )
    const hit = found.find((item) => item !== null)
    if (hit) {
      const name = hit.candidate.split('/').pop() || path
      return { name, file: new File([new Uint8Array(hit.bytes)], name) }
    }
    const baseName = (path.split(/[\\/]/).pop() || path).toLowerCase()
    const tree = await listTree('/')
    const entry = tree.find((item) => !item.directory && item.name.toLowerCase() === baseName)
    if (entry) {
      const blob = await readVfsFile(entry.path)
      if (blob) return { name: entry.name, file: new File([blob], entry.name) }
    }
    const recent = recentLists[kind].find(
      (item) => item.name.toLowerCase() === baseName && item.file,
    )
    return recent?.file ? { name: recent.name, file: recent.file } : null
  }

  /** App/Auto/Load Linked Files：0=No，1=Ask，2=Yes */
  const autoLoadLinkedFiles = async (document: SubtitleDocument) => {
    const mode = getOptionInt('App/Auto/Load Linked Files')
    if (mode === 0) return
    // 文档切换后丢弃前一文档的迟到载入/弹窗：避免把上一文档的关联视频套到新文档，
    // 或在新文档上突然弹出上一视频的轨道选择框（用户还没选过任何视频文件）
    const generation = documentGenerationRef.current
    const stale = () => generation !== documentGenerationRef.current
    const properties = document.properties ?? createProjectProperties()
    const confirm = async (path: string) => {
      if (stale()) return false
      if (mode === 2) return true
      const choice = await askChoice(
        tPlain('Load linked file'),
        tFmt('Load "%1" now?', path),
        [tPlain('Yes'), tPlain('No')],
        0,
      )
      return choice === 0 && !stale()
    }

    if (properties.videoFile && !videoMedia && (await confirm(properties.videoFile))) {
      const handle = await resolveLinkedHandle(properties.videoFile, 'video')
      if (stale()) return
      if (handle) {
        const opened = await openVideoHandle(handle)
        // project.cpp LoadUnloadFiles：关联视频载入成功后，用工程存档的 Video AR Mode/Value
        // 覆盖 DoLoadVideo 设的视频自身 DAR（AspectRatio：0 Default / 1 Fullscreen /
        // 2 Widescreen / 3 Cinematic / 4 Custom；Custom 值非法时退回 Default）
        if (opened && !stale()) {
          if (properties.arMode === 1) setAspectOverride(4 / 3)
          else if (properties.arMode === 2) setAspectOverride(16 / 9)
          else if (properties.arMode === 3) setAspectOverride(2.35)
          else if (properties.arMode === 4)
            setAspectOverride(properties.arValue > 0 ? properties.arValue : null)
          else setAspectOverride(null)
        }
      } else setStatus(tFmt('Could not find linked video "%1"', properties.videoFile))
    }
    if (properties.audioFile && !audioMedia && (await confirm(properties.audioFile))) {
      const handle = await resolveLinkedHandle(properties.audioFile, 'audio')
      if (stale()) return
      if (handle) await openAudioHandle(handle)
      else setStatus(tFmt('Could not find linked audio "%1"', properties.audioFile))
    }
    if (
      properties.timecodesFile &&
      !timecodesFromFile &&
      (await confirm(properties.timecodesFile))
    ) {
      const handle = await resolveLinkedHandle(properties.timecodesFile, 'timecodes')
      if (stale()) return
      if (handle) await openTimecodesHandle(handle)
      else setStatus(tFmt('Could not find linked timecodes "%1"', properties.timecodesFile))
    }
    if (
      properties.keyframesFile &&
      !keyframesFromFile &&
      (await confirm(properties.keyframesFile))
    ) {
      const handle = await resolveLinkedHandle(properties.keyframesFile, 'keyframes')
      if (stale()) return
      if (handle) await openKeyframesHandle(handle)
      else setStatus(tFmt('Could not find linked keyframes "%1"', properties.keyframesFile))
    }
  }

  /** dialog_charset + dialog_text_import 之后的实际载入 */
  const finishOpenSubtitle = async (
    file: AppFileHandle,
    bytes: Uint8Array,
    encoding: string,
    format: SubtitleFormat,
    textImport?: TextImportOptions,
    skipLinkedFiles = false,
  ): Promise<boolean> => {
    if (!coreRef.current) return false
    setBusy(true)
    try {
      let fps: number | undefined
      if (format === 'microdvd') {
        const first =
          new TextDecoder('utf-8')
            .decode(bytes)
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)[0] ?? ''
        const firstBody = /^[{[]\d+[}\]][{[]\d+[}\]](.*)$/.exec(first)?.[1]?.trim() ?? ''
        const cfr = Number.parseFloat(firstBody)
        if (Number.isFinite(cfr) && cfr > 0) fps = cfr
        else if (frameRate.isLoaded()) fps = frameRate.fps()
        else {
          const choice = await askChoice(
            tPlain('Frame rate'),
            tPlain('The frame rate is required to read this file:'),
            ['23.976', '24', '25', '29.97', '30'],
            3,
          )
          if (choice === null) return false
          fps = [23.976, 24, 25, 29.97, 30][choice]
        }
      }
      const options: ParseOptions = { format, textImport, fps }
      const state = await coreRef.current.open(bytes, file.name, encoding, options)
      applyLoadedDocument(state)
      setVideoTimeMs(0)
      // App/Auto/Backup：打开成功后把原始文件备份为 .ORIGINAL（subs_controller.cpp Load）
      if (getOptionBool('App/Auto/Backup') && file.file) {
        void saveSubtitleBackup(file.name, new TextDecoder('utf-8').decode(bytes)).catch(
          () => undefined,
        )
      }
      setStatus(`Opened ${file.name}`)
      void recordRecent('subtitle', file)
      saveLastSubtitleName(file.name)
      if (!skipLinkedFiles) void autoLoadLinkedFiles(state.document)
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not open subtitles'))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** charset 之后按格式继续：纯文本先经 dialog_text_import（subtitle_format_txt.cpp ReadFile） */
  const beginSubtitleLoad = async (
    file: AppFileHandle,
    bytes: Uint8Array,
    format: SubtitleFormat,
    encoding: string,
    skipLinkedFiles = false,
  ): Promise<boolean> => {
    if (format === 'txt') {
      setPendingOpen({ file, bytes, format, encoding, skipLinkedFiles })
      setDialog('text-import')
      return true
    }
    return await finishOpenSubtitle(file, bytes, encoding, format, undefined, skipLinkedFiles)
  }

  /**
   * 打开字幕：charset_detect → dialog_charset（不确定/强制）→ dialog_text_import（.txt）→ Load。
   * MKV 走内嵌轨道提取，再以 ASS 文本载入核心。
   */
  const openSubtitleHandle = async (
    file: AppFileHandle,
    overrides: {
      charset?: boolean
      encoding?: string
      format?: SubtitleFormat
      /** 会话恢复：不自动载入关联视频/音频/时间码（避免启动时无端弹窗） */
      skipLinkedFiles?: boolean
    } = {},
  ): Promise<boolean> => {
    if (!coreRef.current) return false
    setBusy(true)
    try {
      const bytes = await host.readFile(file)
      if (/\.(mkv|mka|mks)$/i.test(file.name)) {
        setBusy(false)
        return await openExtractedSubtitles(bytes, file.name, overrides.skipLinkedFiles)
      }
      const decoded = overrides.encoding
        ? decodeWithEncoding(bytes, overrides.encoding)
        : detectEncoding(bytes)
      if (decoded.binary)
        throw new Error(tPlain('File appears to be binary and cannot be loaded as subtitles.'))
      const format = overrides.format ?? detectFormat(file.name, decoded.text)
      if (!overrides.encoding && (overrides.charset || !decoded.definite)) {
        setPendingOpen({
          file,
          bytes,
          format,
          skipLinkedFiles: overrides.skipLinkedFiles,
        })
        setDialog('charset')
        setBusy(false)
        return true
      }
      setBusy(false)
      return await beginSubtitleLoad(
        file,
        bytes,
        format,
        overrides.encoding ?? decoded.encoding,
        overrides.skipLinkedFiles,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not open subtitles'))
      setBusy(false)
      return false
    }
  }

  /** Matroska 内嵌字幕提取（mkv_wrap.cpp GetSubtitles） */
  const openExtractedSubtitles = async (
    bytes: Uint8Array,
    sourceName: string,
    skipLinkedFiles = false,
  ): Promise<boolean> => {
    if (!coreRef.current) return false
    setBusy(true)
    try {
      const tracks = extractMkvSubtitles(bytes)
      if (!tracks.length) throw new Error(tPlain('File has no recognised subtitle tracks.'))
      let track: MkvSubtitleTrack = tracks[0]
      if (tracks.length > 1) {
        const labels = tracks.map((item) => {
          const name = item.name || item.language || 'Track'
          return `${name} (${item.codecId}, track ${item.number})`
        })
        const choice = await askChoice(
          tPlain('Select subtitle track'),
          tPlain('File contains multiple subtitle tracks:'),
          labels,
          0,
        )
        if (choice === null) {
          setBusy(false)
          return false
        }
        track = tracks[choice]
      }
      const state = await coreRef.current.open(
        new TextEncoder().encode(track.assText),
        sourceName,
        undefined,
        { format: track.ssa ? 'ssa' : 'ass' },
      )
      applyLoadedDocument(state)
      setVideoTimeMs(0)
      setStatus(tFmt('Opened %1 (track %2)', sourceName, String(track.number)))
      saveLastSubtitleName(sourceName)
      if (!skipLinkedFiles) void autoLoadLinkedFiles(state.document)
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not extract subtitles'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const openSubtitles = async (options: { charset?: boolean } = {}) => {
    const file = await host.openFile(SUBTITLE_FILE_TYPES)
    if (!file) return
    await openSubtitleHandle(file, options)
  }

  const openSubtitlesFromVideo = async () => {
    if (!videoMedia) {
      setStatus(tPlain('No video loaded'))
      return
    }
    try {
      const bytes = videoMedia.file
        ? new Uint8Array(await videoMedia.file.arrayBuffer())
        : new Uint8Array(await (await fetch(videoMedia.url)).arrayBuffer())
      await openExtractedSubtitles(bytes, videoMedia.name)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not extract subtitles'))
    }
  }

  // 会话恢复：启动后若上次关闭标签页时有打开的字幕，且 MRU 中仍能取到文件句柄，
  // 则默认重新打开（等价“打开标签页即恢复上次的 ASS”）
  const startupRestoreRef = useRef(false)
  useEffect(() => {
    if (startupRestoreRef.current || !core || !loadedRef.current) return
    startupRestoreRef.current = true
    const name = loadLastSubtitleName()
    if (!name) return
    const entry = recentLists.subtitle.find((item) => item.name === name && item.file)
    // 会话恢复只还原字幕本身：不自动载入 Project Garbage 里缓存的关联视频，
    // 否则启动时会在用户未选择任何视频文件的情况下弹出上一视频的轨道/属性对话框
    if (entry?.file)
      void openSubtitleHandle({ name: entry.name, file: entry.file }, { skipLinkedFiles: true })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- startupRestoreRef 保证仅执行一次，openSubtitleHandle 每次渲染新建
  }, [core, recentLists, openSubtitleHandle])

  const newSubtitles = async () => {
    if (!coreRef.current) return
    // Subtitle/Default Resolution：Auto = 首个视频的分辨率，否则用选项宽高
    const auto = getOptionBool('Subtitle/Default Resolution/Auto')
    const resolution =
      auto && videoMedia
        ? { width: videoIntrinsicSize.width, height: videoIntrinsicSize.height }
        : {
            width: getOptionInt('Subtitle/Default Resolution/Width'),
            height: getOptionInt('Subtitle/Default Resolution/Height'),
          }
    const state = await coreRef.current.restore(createDocument('untitled.ass', resolution))
    setCore(state)
    setDirty(false)
    lastAutosaveRevisionRef.current = state.document.revision
    const id = state.document.cues[0]?.id ?? null
    setActiveId(id)
    setSelectedIds(id ? new Set([id]) : new Set())
    setStatus(tPlain('New subtitles'))
    // 新文档没有 Automation Scripts 引用：卸载上一文件的本地脚本
    setAutomationScripts((current) => current.filter((script) => script.isGlobal))
    saveLastSubtitleName(null)
  }

  /**
   * app/updates：web 构建没有版本号，改为重新取入口页并比较 Vite 资源哈希；
   * 哈希变化说明部署了新版本（浏览器缓存旧 JS 时需要刷新）。
   */
  const checkForUpdates = async () => {
    try {
      const currentScript = [...document.scripts]
        .map((script) => script.src)
        .find((src) => /\/assets\/[^/]+\.js$/.test(src))
      const response = await fetch(window.location.href, { cache: 'no-store' })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const html = await response.text()
      const match = /<script[^>]+src="([^"]+\.js)"/i.exec(html)
      const nextScript = match ? new URL(match[1], window.location.href).href : currentScript
      if (currentScript && nextScript && nextScript !== currentScript) {
        const choice = await askChoice(
          tPlain('Check for Updates'),
          tPlain('A new version of the web build is available. Reload now?'),
          [tPlain('Reload'), tPlain('Close')],
          0,
        )
        if (choice === 0) window.location.reload()
      } else {
        await showMessage(
          tPlain('Check for Updates'),
          tPlain('You are running the latest version.'),
        )
      }
    } catch (cause) {
      setStatus(
        `${tPlain('Could not check for updates')}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
  }

  const restoreAutosave = async () => {
    if (!coreRef.current) return
    try {
      const saved = await loadLatestAutosave()
      if (!saved) {
        setStatus(tPlain('No autosave found'))
        return
      }
      // VFS 保存的新格式把 .ass 当普通文件打开（源码 subtitle/open/autosave →
      // load_subtitles(c, filename)）；legacy 为旧内存文档快照，走 restore
      const state =
        saved.kind === 'file'
          ? await coreRef.current.open(new TextEncoder().encode(saved.text), saved.fileName)
          : await coreRef.current.restore(saved.document)
      setCore(state)
      // Load()：新载入文档视为已自动保存（autosaved_commit_id = commit_id）
      if (saved.kind === 'file') {
        lastAutosaveRevisionRef.current = state.document.revision
        setDirty(false)
      } else {
        setDirty(true)
      }
      const id = state.document.cues[0]?.id ?? null
      setActiveId(id)
      setSelectedIds(id ? new Set([id]) : new Set())
      setStatus(tPlain('Autosaved subtitles restored'))
      saveLastSubtitleName(null)
    } catch {
      setStatus(tPlain('Could not restore autosave'))
    }
  }

  /** 保存时把当前界面/媒体状态合并进 Project Garbage（不产生撤销记录） */
  const buildProjectProperties = (document: SubtitleDocument): ProjectProperties => {
    const base = document.properties ?? createProjectProperties()
    const activeIndex = document.cues.findIndex((cue) => cue.id === activeId)
    return {
      ...base,
      audioFile: audioMedia ? (audioMedia.file?.name ?? audioMedia.name) : '',
      videoFile: videoMedia && !videoMedia.dummy ? (videoMedia.file?.name ?? videoMedia.name) : '',
      timecodesFile: timecodesFromFile ? timecodesFileName : '',
      keyframesFile: keyframesFromFile ? keyframesFileName : '',
      videoZoom: videoWindowZoom,
      scrollPosition: gridScrollRow,
      activeRow: activeIndex < 0 ? 0 : activeIndex,
      videoPosition: frameRate.isLoaded() ? frameRate.frameAtTime(videoTimeMs, 'start') : 0,
      arMode: aspectOverride ? 4 : 0,
      arValue: aspectOverride ?? 0,
    }
  }

  const saveSubtitles = async (format = core?.document.format) => {
    if (!coreRef.current || !core) return
    const writable: SubtitleFormat[] = [
      'ass',
      'ssa',
      'srt',
      'txt',
      'ttxt',
      'microdvd',
      'ebu',
      'transtation',
      'encore',
    ]
    const target: SubtitleFormat = format && writable.includes(format) ? format : 'ass'
    let rateOptions: { fps?: number; frameTimes?: number[] } = frameRate.isLoaded()
      ? {
          fps: frameRate.fps(),
          frameTimes: frameRate.timecodes.length > 1 ? [...frameRate.timecodes] : undefined,
        }
      : {}
    if (['microdvd', 'transtation', 'encore'].includes(target) && !rateOptions.fps) {
      const choice = await askChoice(
        tPlain('Frame rate'),
        tPlain('The frame rate is required to export this format:'),
        ['23.976', '24', '25', '29.97', '30'],
        3,
      )
      if (choice === null) return
      rateOptions = { fps: [23.976, 24, 25, 29.97, 30][choice] }
    }
    try {
      const output = await coreRef.current.export(
        target,
        {
          ...rateOptions,
          saveUiState: getOptionBool('App/Save UI State'),
          properties: buildProjectProperties(core.document),
        },
        getOptionString('App/Save Charset') || 'UTF-8',
      )
      const base =
        core.document.sourceName
          .replace(/\.(encore|transtation)\.txt$/i, '')
          .replace(/\.[^.]+$/, '') || 'untitled'
      const extension = exportExtension(target)
      await host.saveFile(`${base}.${extension}`, output, {
        description: 'Subtitle',
        accept:
          target === 'ebu'
            ? { 'application/octet-stream': [`.${extension}`] }
            : { 'text/plain': [`.${extension}`] },
      })
      setDirty(false)
      // Save()：手动保存后视为已自动保存（autosaved_commit_id = saved_commit_id）
      lastAutosaveRevisionRef.current = core.document.revision
      // 保存后打断撤销合并链（subs_controller.cpp：saved_commit_id 使下一次提交不合并）
      coreRef.current.markSaved()
      setStatus(`Saved ${base}.${extension}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not save subtitles'))
    }
  }

  /**
   * dialog_video_properties.cpp UpdateVideoProperties：
   * 载入视频后按 YCbCr → PlayRes → LayoutRes 顺序校正脚本属性，可提示/直接设置/忽略。
   */
  const runVideoProperties = async (info: VideoStreamInfo) => {
    const runId = ++videoPropertiesRunRef.current
    const alive = () => videoPropertiesRunRef.current === runId && Boolean(coreRef.current)
    const scriptInfo = () => coreStateRef.current?.document.scriptInfo ?? {}
    const atoi = (text: string) => {
      const value = Number.parseInt(text, 10)
      return Number.isFinite(value) ? value : 0
    }
    const real = ffmpegColorspace(info.colorSpace, info.colorRange)
    const guessed = guessVideoColorspace(real, info.width, info.height)
    const recommended: YcbcrHeader = { kind: 'colorspace', colorspace: guessed }
    const recommendedHeader = ycbcrHeaderToBestPractice(recommended)
    const recommendedText = ycbcrHeaderToBestPracticeString(recommended)
    const matrixName = MATRIX_DISPLAY[guessed.matrix] ?? guessed.matrix

    // 未标记矩阵 / HDR 警告
    if (real.matrix === 'Unspecified' && getOptionBool('Video/Untagged Matrix Warning')) {
      await showMessage(
        tPlain('Untagged video'),
        tPlain(
          'The video you have loaded has no specified color matrix. ' +
            'Aegisub will guess the color matrix to be %s, but there is no guarantee that other programs will guess the same matrix. ' +
            'This may make the video appear with different colors in different media players and can prevent subtitle colors from matching video colors.' +
            '\n \n' +
            'Consider tagging your video with a color matrix to ensure that your video displays consistently in all players and that subtitle colors can reliably match video colors.',
        ).replace('%s', matrixName),
      )
      if (!alive()) return
    }
    if (
      isHdrOrWcg(info.colorPrimaries, info.colorTransfer) &&
      getOptionBool('Video/HDR Video Warning')
    ) {
      await showMessage(
        tPlain('HDR and/or WCG video'),
        tPlain(
          'The video you have loaded has HDR and/or WCG colors. ' +
            'While ordinary dialogue subtitles will work fine on such videos, ' +
            'matching video colors using subtitles will not be possible on HDR and/or WCG footage.',
        ),
      )
      if (!alive()) return
    }

    // ---- YCbCr Matrix ----
    const scriptMatrix = parseYcbcrHeader(getScriptInfo(scriptInfo(), 'YCbCr Matrix'))
    if (scriptMatrix.kind === 'missing' || scriptMatrix.kind === 'invalid') {
      let action = getOptionInt('Video/No YCbCr Matrix in Script') // 0 Ignore / 1 Prompt / 2 Set
      if (action === 1) {
        const choice = await askChoice(
          tPlain("Set script's YCbCr Matrix?"),
          tPlain(
            'The current subtitle file has no YCbCr Matrix set.\n\n' +
              'If you plan to use this subtitle file on this newly loaded video file,\nyou should set the subtitle file\'s YCbCr Matrix to the video\'s color space ("%s").\n\n' +
              'If you plan to use a different video file, you may want to\nleave the YCbCr Matrix unset until you load the correct video file.\n\n' +
              'This prompt can be configured in the preferences.',
          ).replace('%s', recommendedText),
          [
            tPlain('Leave YCbCr Matrix unset'),
            tPlain('Set script\'s YCbCr Matrix to the video\'s ("%s")').replace(
              '%s',
              recommendedText,
            ),
          ],
          getOptionInt('Video/Last No YCbCr Matrix in Script Choice'),
        )
        if (!alive()) return
        if (choice === null) action = 0
        else {
          setOption('Video/Last No YCbCr Matrix in Script Choice', choice)
          action = choice === 1 ? 2 : 0
        }
      }
      if (action === 2) {
        await apply(
          [{ type: 'updateScriptInfo', patch: { 'YCbCr Matrix': recommendedText } }],
          'change ycbcr matrix',
        )
        return
      }
    } else if (scriptMatrix.kind === 'colorspace') {
      const same =
        recommendedHeader.kind === 'colorspace' &&
        scriptMatrix.colorspace.matrix === recommendedHeader.colorspace.matrix &&
        scriptMatrix.colorspace.range === recommendedHeader.colorspace.range
      if (!same) {
        let action = getOptionInt('Video/YCbCr Matrix Mismatch') // 0 Ignore / 1 Prompt / 2 Set
        const scriptText = ycbcrHeaderToBestPracticeString(scriptMatrix)
        if (action === 1) {
          const choice = await askChoice(
            tPlain('YCbCr Matrix mismatch'),
            tPlain(
              'This video\'s recommended YCbCr Matrix ("%s") differs from the subtitle file\'s YCbCr Matrix ("%s").\n\n' +
                "If this new video's colors look identical to the video the subtitle file was originally authored for,\n" +
                "then the subtitle file's YCbCr Matrix should be set to the video's YCbCr Matrix.",
            )
              .replace('%s', recommendedText)
              .replace('%s', scriptText),
            [
              tPlain('Leave script\'s YCbCr Matrix as it is ("%s")').replace('%s', scriptText),
              tPlain('Set script\'s YCbCr Matrix to the video\'s ("%s")').replace(
                '%s',
                recommendedText,
              ),
            ],
            getOptionInt('Video/Last YCbCr Matrix Mismatch Choice'),
          )
          if (!alive()) return
          if (choice === null) action = 0
          else {
            setOption('Video/Last YCbCr Matrix Mismatch Choice', choice)
            action = choice === 1 ? 2 : 0
          }
        }
        if (action === 2) {
          await apply(
            [{ type: 'updateScriptInfo', patch: { 'YCbCr Matrix': recommendedText } }],
            'change ycbcr matrix',
          )
          return
        }
      }
    }

    // ---- PlayRes ----
    const playResX = atoi(getScriptInfo(scriptInfo(), 'PlayResX'))
    const playResY = atoi(getScriptInfo(scriptInfo(), 'PlayResY'))
    const vx = info.displayWidth
    const vy = info.displayHeight
    if (!vx || !vy) return
    if (playResX === 0 && playResY === 0) {
      await apply(
        [{ type: 'updateScriptInfo', patch: { PlayResX: String(vx), PlayResY: String(vy) } }],
        'change script resolution',
      )
    } else if (!(playResX % vx === 0 && playResY % vy === 0)) {
      const arChanged = scriptAspectChanged(playResX, playResY, vx, vy)
      const action = getOptionInt('Video/PlayRes Mismatch') // 0 Ignore / 1 Prompt / 2 Resample
      let resampleMode: number | null = null
      if (action === 2 && !arChanged) resampleMode = RESAMPLE_AR_STRETCH
      else if (action === 2 || action === 1) {
        const choices = arChanged
          ? [
              tPlain('Leave resolution as it is'),
              tPlain('Resample script (stretch to new aspect ratio)'),
              tPlain('Resample script (add borders)'),
              tPlain('Resample script (remove borders)'),
            ]
          : [tPlain('Leave resolution as it is'), tPlain('Resample script')]
        const choice = await askChoice(
          tPlain('Resolution mismatch'),
          tPlain(
            "The resolution of the loaded video and the resolution specified for the subtitles don't match.\n\n" +
              'Video resolution:\t%d × %d\n' +
              'Script resolution:\t%d × %d\n\n' +
              'Change subtitles resolution to match video?',
          )
            .replace('%d', String(vx))
            .replace('%d', String(vy))
            .replace('%d', String(playResX))
            .replace('%d', String(playResY)),
          choices,
          getOptionInt('Video/Last PlayRes Mismatch Choice'),
        )
        if (!alive()) return
        if (choice !== null && choice > 0) {
          setOption('Video/Last PlayRes Mismatch Choice', choice)
          resampleMode = arChanged
            ? [RESAMPLE_AR_STRETCH, RESAMPLE_AR_ADD_BORDERS, RESAMPLE_AR_REMOVE_BORDERS][choice - 1]
            : RESAMPLE_AR_STRETCH
        }
      }
      if (resampleMode !== null && coreStateRef.current) {
        const document = coreStateRef.current.document
        await apply(
          resampleCommands(document, {
            sourceX: playResX,
            sourceY: playResY,
            destX: vx,
            destY: vy,
            margin: [0, 0, 0, 0],
            arMode: resampleMode,
            matrixConversion: null,
          }),
          'change script resolution',
        )
      }
    }
    if (!alive()) return

    // ---- LayoutRes ----
    const playResX2 = atoi(getScriptInfo(scriptInfo(), 'PlayResX'))
    const playResY2 = atoi(getScriptInfo(scriptInfo(), 'PlayResY'))
    const layoutX = atoi(getScriptInfo(scriptInfo(), 'LayoutResX'))
    const layoutY = atoi(getScriptInfo(scriptInfo(), 'LayoutResY'))
    if (layoutX === 0 || layoutY === 0) {
      let action = getOptionInt('Video/No LayoutRes in Script') // 0 Ignore / 1 Prompt / 2 Set / 3 SetToPlayRes
      if (action === 1) {
        const choice = await askChoice(
          tPlain("Set script's layout resolution?"),
          tPlain(
            'The current subtitle file has no layout resolution set.\n\n' +
              "If you plan to use this subtitle file on this newly loaded video file,\nyou should set the subtitle file's layout resolution to the video's display resolution.\n\n" +
              'If you plan to use a different video file, you may want to leave\nthe layout resolution unset until you load the correct video file.\n\n' +
              'If you are adapting an existing old subtitle file that does not yet have\na layout resolution set, you should set its layout resolution to the resolution\nof the video the subtitle file was intended to be played back on.\n' +
              "Often, this is the same as the file's script resolution. (%d × %d)\n\n" +
              'This prompt can be configured in the preferences.',
          )
            .replace('%d', String(playResX2))
            .replace('%d', String(playResY2)),
          [
            tPlain('Leave layout resolution unset'),
            tPlain("Set script's layout resolution to the video's (%d × %d)")
              .replace('%d', String(vx))
              .replace('%d', String(vy)),
            tPlain("Set script's layout resolution to its script resolution (%d × %d)")
              .replace('%d', String(playResX2))
              .replace('%d', String(playResY2)),
          ],
          getOptionInt('Video/Last No LayoutRes in Script Choice'),
        )
        if (!alive()) return
        if (choice === null) action = 0
        else {
          setOption('Video/Last No LayoutRes in Script Choice', choice)
          action = [0, 2, 3][choice] ?? 0
        }
      }
      if (action === 2) {
        await apply(
          [{ type: 'updateScriptInfo', patch: { LayoutResX: String(vx), LayoutResY: String(vy) } }],
          'change layout resolution',
        )
        return
      }
      if (action === 3) {
        await apply(
          [
            {
              type: 'updateScriptInfo',
              patch: { LayoutResX: String(playResX2), LayoutResY: String(playResY2) },
            },
          ],
          'change layout resolution',
        )
        return
      }
    } else if (layoutX !== vx || layoutY !== vy) {
      const condition = getOptionInt('Video/LayoutRes Mismatch') // 0 Never / 1 OnAR / 2 Always
      if (condition === 0) return
      const arChanged = scriptAspectChanged(layoutX, layoutY, vx, vy)
      if (!arChanged && condition === 1) return
      const choice = await askChoice(
        tPlain('Layout resolution mismatch'),
        (arChanged
          ? tPlain(
              'The resolution of the loaded video and the layout resolution specified for the subtitles differ in aspect ratios.\n\n' +
                'Video resolution:    %d × %d\n' +
                'Subtitle layout resolution:    %d × %d\n\n' +
                'Change layout resolution of subtitles to match video?',
            )
          : tPlain(
              "The resolution of the loaded video and the layout resolution specified for the subtitles don't match.\n\n" +
                'Video resolution:    %d × %d\n' +
                'Subtitle layout resolution:    %d × %d\n\n' +
                "Usually, this is not an issue, and you may leave the subtitle file's layout resolution as it is.\n" +
                'If your subtitle file does not contain any significant formatting and you now intend to perform\n' +
                "formatting on the newly loaded video, you may want to set the script's layout resolution\n" +
                "to the video's display resolution.",
            )
        )
          .replace('%d', String(vx))
          .replace('%d', String(vy))
          .replace('%d', String(layoutX))
          .replace('%d', String(layoutY)),
        [
          tPlain('Leave layout resolution as it is (%d × %d)')
            .replace('%d', String(layoutX))
            .replace('%d', String(layoutY)),
          tPlain("Set script's layout resolution to the video's (%d × %d)")
            .replace('%d', String(vx))
            .replace('%d', String(vy)),
        ],
        getOptionInt('Video/Last LayoutRes Mismatch Choice'),
      )
      if (!alive()) return
      if (choice === 1) {
        setOption('Video/Last LayoutRes Mismatch Choice', choice)
        await apply(
          [{ type: 'updateScriptInfo', patch: { LayoutResX: String(vx), LayoutResY: String(vy) } }],
          'change layout resolution',
        )
      }
    }
  }

  const openVideoHandle = async (file: AppFileHandle): Promise<boolean> => {
    const source = await host.openMedia(file)
    if (source.kind === 'audio') {
      URL.revokeObjectURL(source.url)
      setStatus(tPlain('The selected file does not contain video'))
      return false
    }
    const previousVideo = videoMedia
    videoPropertiesRunRef.current += 1 // 旧视频的属性提示失效
    // 多轨道：FFMS2 在 LoadVideo/LoadAudio 时询问轨道（AskForTrackSelection）
    let videoStreamIndex: number | undefined
    let singleVideoTrack = false
    let audioStreamIndex: number | undefined
    let audioSelected = !file.file // 无法探测（如本地原生句柄）时沿用默认音轨
    if (file.file) {
      try {
        const tracks = await listMediaTracks(file.file)
        singleVideoTrack = tracks.videos.length <= 1
        const videoTrack = await chooseTrackIndex('video', tracks.videos)
        if (videoTrack.cancelled) {
          URL.revokeObjectURL(source.url)
          setStatus(tPlain('Video track selection cancelled'))
          return false
        }
        videoStreamIndex = videoTrack.index
        // Video/Open Audio（Preferences → Video → Options）：打开视频时是否自动挂载音轨
        if (getOptionBool('Video/Open Audio')) {
          const audioTrack = await chooseTrackIndex('audio', tracks.audios)
          if (!audioTrack.cancelled) {
            audioStreamIndex = audioTrack.index
            audioSelected = tracks.audios.length > 0
          }
        }
      } catch {
        // 探测失败不阻止播放：使用容器默认轨道
      }
    }
    const videoSource: MediaSource =
      videoStreamIndex === undefined ? source : { ...source, videoStreamIndex, singleVideoTrack }
    const audioSource: MediaSource =
      audioStreamIndex === undefined ? source : { ...source, audioStreamIndex }
    const openAudio = getOptionBool('Video/Open Audio') && audioSelected
    if (openAudio) {
      const previousAudio = audioMedia
      setAudioMedia(audioSource)
      setAudioTimeMs(0)
      setAudioDurationMs(0)
      setDisplayModeAudio(true)
      if (previousAudio && previousAudio !== previousVideo && previousAudio.url !== source.url)
        URL.revokeObjectURL(previousAudio.url)
    }
    setVideoMedia(videoSource)
    // project.cpp DoLoadVideo：载入任何视频后 AR 回到视频自身的 DAR（代码里的 Default =
    // 不做覆盖）。工程存档的 AR 只在关联视频随字幕一起载入时覆盖（见 autoLoadLinkedFiles）
    setAspectOverride(null)
    setVideoSizeReady(false)
    // FrameMain::OnVideoOpen 的减档等真实尺寸上报后结算（见 setIntrinsicSizeStable）
    pendingZoomFitRef.current = true
    setVideoTimeMs(0)
    setVideoDurationMs(0)
    setDetectedFps(null) // 新视频重新探测帧率
    setVideoFrameTimes(null) // 新视频重新扫描逐帧时间码表
    setVideoColorspace({ matrix: 'Unspecified', range: 'Unspecified' })
    // 关键帧后台扫描（project.cpp：视频 provider 建索引提供 keyframes——是文件属性，
    // 与解码路径无关；原生 <video> 拿不到 chunk 类型，必须独立解复用扫描）。
    // ffindex 索引缓存对应物：同 crc32_大小_修改时间 的文件命中 IndexedDB 缓存免扫描
    keyframeScanIdRef.current += 1
    const scanId = keyframeScanIdRef.current
    const scanFile = file.file
    // 载入偏移提醒：偏移 > 每帧时长(1000/fps)的 1/5（如 24fps → 8.33ms）时弹窗，
    // 每次载入最多一次；本项目按主线语义归一化（首帧记 0），弹窗指引导出可保留偏移
    const maybeNoticeVideoOffset = (table: number[]) => {
      if (offsetNoticeShownRef.current === scanFile) return
      offsetNoticeShownRef.current = scanFile
      if (table.length < 2) return
      const offsetMs = table[0]
      if (offsetMs <= 0) return
      const fps = Framerate.fromTimecodes(table).fps()
      if (Number.isFinite(fps) && fps > 0 && offsetMs > 1000 / fps / 5)
        setVideoOffsetNotice({ offsetMs, frameDurationMs: 1000 / fps })
    }
    if (scanFile) {
      // 视频流头信息（容器标称帧率 + 色彩空间）：源码的帧率/矩阵来自 FFMS2 索引读到的流属性。
      // 不在此播放采样——否则载入时会"自动播放约一秒再回第一帧"
      void probeVideoInfo(scanFile, videoStreamIndex).then((info) => {
        if (keyframeScanIdRef.current !== scanId || !info) return
        if (info.fps >= 5 && info.fps <= 240) setDetectedFps(info.fps)
        setVideoColorspace(parseContainerColorspace(info.colorSpace, info.colorRange))
        // UpdateVideoProperties：YCbCr / PlayRes / LayoutRes 校正与提示
        void runVideoProperties(info)
      })
      const scan: NonNullable<typeof videoScanRef.current> = {
        id: scanId,
        promise: null as unknown as Promise<void>,
        done: false,
        keyframeTimes: [],
        frameTimes: null,
      }
      videoScanRef.current = scan
      scan.promise = (async () => {
        let latest: number[] = []
        let latestFrames: number[] | null = null
        const cached = await loadCachedKeyframes(scanFile, videoStreamIndex)
        if (keyframeScanIdRef.current !== scanId) return
        if (cached) {
          latest = cached.keyframeTimesMs ?? []
          // v2 条目附带逐帧时间码表；v1 旧条目（undefined）继续走扫描补全
          if (cached.frameTimesMs && cached.frameTimesMs.length >= 2)
            latestFrames = cached.frameTimesMs
          setVideoKeyframeTimes(latest)
          if (latestFrames) {
            setVideoFrameTimes(latestFrames)
            maybeNoticeVideoOffset(latestFrames)
            scan.done = true
            scan.keyframeTimes = latest
            scan.frameTimes = latestFrames
            return
          }
        }
        await extractVideoKeyframes(
          scanFile,
          (times) => {
            latest = times
            if (keyframeScanIdRef.current === scanId) setVideoKeyframeTimes(times)
          },
          () => keyframeScanIdRef.current !== scanId,
          (frames) => {
            latestFrames = frames
            if (keyframeScanIdRef.current === scanId) {
              setVideoFrameTimes(frames)
              maybeNoticeVideoOffset(frames)
            }
          },
          videoStreamIndex,
        ).catch((error: unknown) => {
          // 容器打不开（罕见封装）时保持无关键帧/无表，不影响视频播放；日志便于诊断
          console.error('keyframe scan failed:', error)
        })
        if (keyframeScanIdRef.current !== scanId) return
        if (latest.length > 0)
          void storeCachedKeyframes(scanFile, latest, latestFrames ?? [], videoStreamIndex)
        scan.done = true
        scan.keyframeTimes = latest
        scan.frameTimes = latestFrames
      })()
    }
    // 旧视频 URL 若仍被保留的音频引用（Video/Open Audio 关闭时）不能释放
    // 注意比较 URL：多轨选择会为音轨创建同 URL 的独立 MediaSource
    if (previousVideo && previousVideo.url !== audioMedia?.url)
      URL.revokeObjectURL(previousVideo.url)
    setStatus(`Video: ${file.name}`)
    void recordRecent('video', file)
    return true
  }

  const openVideo = async () => {
    const file = await host.openFile(MEDIA_FILE_TYPES)
    if (!file) return
    await openVideoHandle(file)
  }

  const closeVideo = () => {
    if (videoMedia && videoMedia.url !== audioMedia?.url) URL.revokeObjectURL(videoMedia.url)
    setVideoDetached(false) // dialog_detached_video.cpp：关闭视频时一并关闭分离窗口
    setVideoMedia(null)
    setVideoSizeReady(false)
    // project.cpp CloseVideo：ar_mode/ar_value 归零（回到视频自身的宽高比）
    setAspectOverride(null)
    // 回到无视频状态：占位栏恢复默认 50%
    setPlaceholderZoom(0.5)
    pendingZoomFitRef.current = false
    setVideoDurationMs(0)
    setVideoTimeMs(0)
    keyframeScanIdRef.current += 1 // 作废后台扫描
    setVideoKeyframeTimes([])
    setVideoFrameTimes(null)
    setVideoColorspace({ matrix: 'Unspecified', range: 'Unspecified' })
    // project.cpp DoCloseVideo：无外部文件时回退为空关键帧/未加载 timecodes
    if (!keyframesFromFile) setKeyframes([])
    if (!timecodesFromFile) {
      setTimecodes(null)
      setFrameMode(false) // UpdateFrameTiming：fps 未加载时强制回退 Time 模式
    }
    setStatus(tPlain('Video closed'))
  }

  // ---- keyframes / timecodes 文件命令（command/keyframe.cpp、timecode.cpp）----
  const openKeyframesHandle = async (file: AppFileHandle) => {
    try {
      const list = parseKeyframes(decodeText(await host.readFile(file)))
      setKeyframes(list)
      setKeyframesFromFile(true)
      setKeyframesFileName(file.name)
      setStatus(`Keyframes: ${file.name} (${list.length} keyframes)`)
      void recordRecent('keyframes', file)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not parse keyframes'))
    }
  }

  const openKeyframes = async () => {
    const file = await host.openFile(KEYFRAME_FILE_TYPES)
    if (!file) return
    await openKeyframesHandle(file)
  }

  /** 保存时间码/关键帧前确保逐帧索引就绪：后台扫描对大文件可能要数十秒，未完成时
   *  同步等一次（源码 ffms2 打开视频即建全量索引，保存时必然可用）。返回 null 表示
   *  无视频文件或无关联扫描（保存走现有回退路径）。 */
  const ensureVideoIndex = async (): Promise<{
    keyframeTimes: number[]
    frameTimes: number[] | null
  } | null> => {
    const scan = videoScanRef.current
    if (!scan || scan.id !== keyframeScanIdRef.current) return null
    if (!scan.done) setStatus(tPlain('Indexing video...'))
    await scan.promise
    return { keyframeTimes: scan.keyframeTimes, frameTimes: scan.frameTimes }
  }

  const saveKeyframes = async () => {
    const base = core?.document.sourceName.replace(/\.(ass|ssa|srt)$/i, '') || 'keyframes'
    let frames = activeKeyframes
    if (!keyframesFromFile) {
      // 源码关键帧帧号来自 provider 全量索引：等扫描完成后按逐帧表换算（ms→下界序号），
      // CFR 回退换算的帧号会整体错位（扫描未完成时 WC 上报的也只是已读流的部分列表）
      const index = await ensureVideoIndex()
      if (index) {
        const table = index.frameTimes
        frames =
          table && table.length >= 2
            ? index.keyframeTimes.map((ms) => lowerBoundIndex(table, ms))
            : index.keyframeTimes.map((ms) => frameRate.frameAtTime(ms))
      }
    }
    const data = new TextEncoder().encode(serializeKeyframes(frames))
    await host.saveFile(`${base}.key.txt`, data, {
      description: 'Keyframes',
      accept: { 'text/plain': ['.txt'] },
    })
    setStatus(tPlain('Keyframes saved'))
  }

  const closeKeyframes = () => {
    // project.cpp CloseKeyframes：回退到视频自带（activeKeyframes 派生自动切换）
    setKeyframesFromFile(false)
    setKeyframesFileName('')
    setStatus(tPlain('Keyframes closed'))
  }

  const openTimecodesHandle = async (file: AppFileHandle) => {
    try {
      const rate = parseTimecodes(decodeText(await host.readFile(file)))
      setTimecodes(rate)
      setTimecodesFromFile(true)
      setTimecodesFileName(file.name)
      setStatus(`Timecodes: ${file.name} (${rate.frameCount()} frames)`)
      void recordRecent('timecodes', file)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tPlain('Could not parse timecodes'))
    }
  }

  const openTimecodes = async () => {
    const file = await host.openFile(TIMECODES_FILE_TYPES)
    if (!file) return
    await openTimecodesHandle(file)
  }

  const doSaveTimecodes = async (keepOffset: boolean) => {
    setTimecodesOffsetAsk(null)
    const base = core?.document.sourceName.replace(/\.(ass|ssa|srt)$/i, '') || 'timecodes'
    // 源码 timecode.cpp：provider ? provider->GetFrameCount() : -1——有视频就传帧数
    // （CFR 时 timecodes 表仅 [0] 哨兵，缺帧数会导出只含 1 行的废文件）
    // 保存值 = provider 逐帧表（FFMS2 TimecodesVector）：表未就绪先等扫描——CFR 回退
    // 的 numerator/2 四舍五入值与逐帧截断表必然不一致（如 24fps 表为 0,41,83,125…），
    // 是"保存时间码与 Aegisub 不一致"的根因
    const index = await ensureVideoIndex()
    const table = index?.frameTimes
    const rate = timecodes
      ? timecodes
      : table && table.length >= 2
        ? Framerate.fromTimecodes(table)
        : frameRate
    const providerFrameCount = videoMedia ? (table ? table.length : frameCount) : -1
    // 保留偏移 = 写原始 PTS 表（arch1t3cht fork b7d228c0ce 语义）；默认归一化到 0（主线）
    const data = new TextEncoder().encode(
      keepOffset && table && table.length >= 2
        ? serializeTimecodesKeepOffset(table, providerFrameCount)
        : serializeTimecodes(rate, providerFrameCount),
    )
    await host.saveFile(`${base}.timecodes.txt`, data, {
      description: 'Timecodes',
      accept: { 'text/plain': ['.txt'] },
    })
    setStatus(tPlain('Timecodes saved'))
  }

  const saveTimecodes = async () => {
    // 仅视频自带逐帧表可能带首帧偏移（外部 timecodes 文件与 CFR 回退在解析/构造时已定形）
    const index = await ensureVideoIndex()
    const table = index?.frameTimes
    if (!timecodes && table && table.length >= 2 && table[0] > 0) {
      setTimecodesOffsetAsk(table[0])
      return
    }
    await doSaveTimecodes(false)
  }

  const closeTimecodes = () => {
    setTimecodes(null)
    setTimecodesFromFile(false)
    setTimecodesFileName('')
    setFrameMode(false)
    setStatus(tPlain('Timecodes closed'))
  }

  // ---- 拖放打开（frame_main.cpp AegisubFileDropTarget → project.cpp LoadList：
  // 按扩展名分类为字幕/视频/音频/timecodes/keyframes，各取第一个依次加载；
  // .txt/.log 依次尝试 timecodes → keyframes → 字幕。Web 扩展：字体文件缓存进
  // IndexedDB 字体库，渲染端立即可用）----
  const tryLoadTimecodesFile = async (file: File): Promise<boolean> => {
    try {
      const rate = parseTimecodes(decodeText(new Uint8Array(await file.arrayBuffer())))
      setTimecodes(rate)
      setTimecodesFromFile(true)
      setTimecodesFileName(file.name)
      setStatus(`Timecodes: ${file.name} (${rate.frameCount()} frames)`)
      void recordRecent('timecodes', { name: file.name, file })
      return true
    } catch {
      return false
    }
  }

  const tryLoadKeyframesFile = async (file: File): Promise<boolean> => {
    try {
      const list = parseKeyframes(decodeText(new Uint8Array(await file.arrayBuffer())))
      setKeyframes(list)
      setKeyframesFromFile(true)
      setKeyframesFileName(file.name)
      setStatus(`Keyframes: ${file.name} (${list.length} keyframes)`)
      void recordRecent('keyframes', { name: file.name, file })
      return true
    } catch {
      return false
    }
  }

  const handleDroppedFiles = async (fileList: FileList | File[]) => {
    if (busy) return
    const files = [...fileList]
    const extension = (file: File) => (/\.[^.]+$/.exec(file.name)?.[0] ?? '').toLowerCase()

    let subs: File | undefined
    let video: File | undefined
    let audio: File | undefined
    const fonts: File[] = []
    const plain: File[] = []
    for (const file of files) {
      const ext = extension(file)
      if (DROP_FONT_EXTS.includes(ext)) {
        fonts.push(file)
      } else if (ext === '.txt' || ext === '.log') {
        plain.push(file)
      } else {
        if (!subs && DROP_SUBS_EXTS.includes(ext)) subs = file
        if (!video && DROP_VIDEO_EXTS.includes(ext)) video = file
        if (!audio && DROP_AUDIO_EXTS.includes(ext)) audio = file
      }
    }

    // .txt/.log 可能是三者之一：依次尝试 timecodes → keyframes → 字幕
    // （LoadList 的顺序尝试语义，无法并行）
    for (const file of plain) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      if (await tryLoadTimecodesFile(file)) continue
      // oxlint-disable-next-line eslint/no-await-in-loop
      if (await tryLoadKeyframesFile(file)) continue
      if (!subs && extension(file) === '.txt') subs = file
    }

    if (fonts.length) {
      try {
        const added = await importFontFiles(fonts)
        logInfo('fonts', `Imported ${added} font face(s) from ${fonts.length} dropped file(s)`)
        setStatus(
          added
            ? `Imported ${added} font face${added === 1 ? '' : 's'}`
            : tPlain('Fonts already imported'),
        )
        // 重建渲染器：供给器重新扫描缓存，新字体经 addFonts 注册进 libass
        if (added) setLocalFontsEpoch((epoch) => epoch + 1)
      } catch (cause) {
        logError('fonts', `Font import failed: ${cause instanceof Error ? cause.message : cause}`)
      }
    }

    // 加载顺序对齐 LoadList：字幕 → 视频 → 音频（timecodes/keyframes 已在上面加载）
    if (subs) await openSubtitleHandle({ name: subs.name, file: subs })
    if (video) await openVideoHandle({ name: video.name, file: video })
    if (audio) await openAudioHandle({ name: audio.name, file: audio })
  }

  // ---- Select Lines（dialog_selection.cpp process + OnOK）----
  const applySelectLines = (settings: SelectLinesSettings, close: boolean) => {
    if (!core) return
    const { matchText, matchCase, mode, field, invert, dialogue, comments, action } = settings
    let matcher: (value: string) => boolean
    if (mode === 'regexp') {
      const regex = new RegExp(matchText, matchCase ? '' : 'i')
      matcher = (value) => regex.test(value)
    } else if (mode === 'exact') {
      matcher = matchCase
        ? (value) => value === matchText
        : (value) => value.toLowerCase() === matchText.toLowerCase()
    } else {
      matcher = matchCase
        ? (value) => value.includes(matchText)
        : (value) => value.toLowerCase().includes(matchText.toLowerCase())
    }
    const matches = new Set(
      core.document.cues
        .filter((cue) => (cue.comment ? comments : dialogue))
        .filter((cue) => matcher(cue[field]) !== invert)
        .map((cue) => cue.id),
    )
    // Action：SET / ADD / SUB / INTERSECT（活动行保持不变）
    let nextSelection: Set<string>
    if (action === 'set') nextSelection = matches
    else if (action === 'add') nextSelection = new Set([...selectedSet, ...matches])
    else if (action === 'sub')
      nextSelection = new Set([...selectedSet].filter((id) => !matches.has(id)))
    else nextSelection = new Set([...selectedSet].filter((id) => matches.has(id)))
    setSelectedIds(nextSelection)
    if (close) setDialog(null)
    setStatus(`Selected ${nextSelection.size} line${nextSelection.size === 1 ? '' : 's'}`)
  }

  // ---- Export Subtitles（dialog_export.cpp + ass_exporter.cpp 的导出过滤器链）----
  // 链序同 AssExportFilterChain::GetFilterList（优先级降序 + 重名去重）
  const exportFilters = useMemo(() => orderedExportFilters(automationScripts), [automationScripts])
  const exportFilterKey = (filter: AutomationFilterDisplayInfo) =>
    `${filter.stateId}:${filter.name}`

  /**
   * 读取脚本的 automation_settings（ExportFilter::GetConfigDialogWindow）。
   * ass_parser 解析时保留了 "Automation Settings" 后的前导空格，故两种键都查。
   */
  const storedDialogSettings = (filter: AutomationFilterDisplayInfo): string => {
    const settings = core?.document.properties.automationSettings ?? {}
    // ExportFilter::GetScriptSettingsIdentifier 用的是 Register 去重后的展示名
    const key = inlineStringEncode(filter.displayName)
    return settings[key] ?? settings[` ${key}`] ?? ''
  }

  /** 回写 automation_settings（ExportFilter::LoadSettings；属性不建立撤销点） */
  const storeDialogSettings = (
    filter: AutomationFilterDisplayInfo,
    spec: DialogSpec,
    values: DialogValue[],
  ) => {
    if (!coreRef.current) return
    const key = inlineStringEncode(filter.displayName)
    const serialized = serializeDialogSettings(spec.controls, values)
    void coreRef.current.apply(
      [
        {
          type: 'updateProperties',
          patch: {
            automationSettings: {
              ...(core?.document.properties.automationSettings ?? {}),
              [key]: serialized,
            },
          },
        },
      ],
      '',
    )
  }

  /**
   * 过滤器 Configure（web 偏差：用按钮替代桌面的内嵌配置面板）：调 config 函数
   * （只读 subtitles）生成 spec，确认后的回读值按控件名转 config 表缓存。
   */
  const openFilterConfig = async (filter: AutomationFilterDisplayInfo) => {
    if (!core) return
    const key = exportFilterKey(filter)
    const cached = filterConfigs[key]
    if (cached) {
      setLuaDialog({
        spec: cached.spec,
        initialValues: cached.values,
        resolve: (response) => {
          if (readBackButton(cached.spec.buttons, response.button) !== false) {
            setFilterConfigs((current) => ({
              ...current,
              [key]: { spec: cached.spec, values: response.values },
            }))
            storeDialogSettings(filter, cached.spec, response.values)
          }
        },
      })
      return
    }
    // LuaExportFilter::GenerateConfigDialog：以当前文档（只读）求值，失败视为无对话框
    const result = await configureAutomationFilter(
      filter.stateId,
      filter.name,
      documentToLuaRows(core.document),
      makeAutomationHost(),
    )
    if (!result.ok || !result.spec) return
    const spec = result.spec
    // 初始值 = 脚本默认值 + 项目 automation_settings（Unserialise）
    const values = applyDialogSettings(
      spec,
      defaultDialogValues(spec),
      storedDialogSettings(filter),
    )
    setFilterConfigs((current) => ({ ...current, [key]: { spec, values } }))
    setLuaDialog({
      spec,
      initialValues: values,
      resolve: (response) => {
        if (readBackButton(spec.buttons, response.button) !== false) {
          setFilterConfigs((current) => ({ ...current, [key]: { spec, values: response.values } }))
          storeDialogSettings(filter, spec, response.values)
        }
      },
    })
  }

  /**
   * 运行单个导出过滤器（LuaExportFilter::ProcessSubs：在文档副本上跑、返回值丢弃、
   * ProcessingComplete 行集整表应用）；返回 null 表示取消（UserCancelException 中止导出）。
   * 内置过滤器（Fix Styles / Transform Framerate）直接在文档副本上同步处理。
   */
  const runExportFilter = async (
    filter: AutomationFilterDisplayInfo,
    doc: SubtitleDocument,
    liveRows: ReturnType<typeof documentToLuaRows>,
    framerate?: FramerateFilterSettings,
  ): Promise<SubtitleDocument | null> => {
    if (filter.builtin === 'fix_styles') return fixStyles(doc)
    if (filter.builtin === 'transform_framerate') {
      if (!framerate) return doc
      const inputFps = Number.parseFloat(framerate.inputFps)
      const outputFps = Number.parseFloat(framerate.outputFps)
      const invalid = !(inputFps > 0) || (framerate.outputMode === 'cfr' && !(outputFps > 0))
      if (invalid) {
        setStatus(tPlain('Invalid framerate for Transform Framerate'))
        return null
      }
      // LoadSettings(false)：Variable = 工程 timecodes；Constant = 输入框帧率；Reverse 交换
      let input = Framerate.cfr(inputFps)
      let output = framerate.outputMode === 'variable' ? frameRate : Framerate.cfr(outputFps)
      if (framerate.reverse) [input, output] = [output, input]
      return transformFramerateDocument(doc, input, output)
    }
    const luaHost = makeAutomationHost()
    let config: Record<string, DialogValue> | null = null
    if (filter.hasConfig) {
      const cached = filterConfigs[exportFilterKey(filter)]
      if (cached) config = dialogConfigTable(cached.spec, cached.values)
      else {
        // 未配置过：以控件默认值生成（等价桌面导出对话框打开时的初始内嵌配置）
        const specResult = await configureAutomationFilter(
          filter.stateId,
          filter.name,
          liveRows,
          luaHost,
        )
        if (specResult.ok && specResult.spec) {
          // 未 Configure 过：脚本默认值 + 项目 automation_settings
          config = dialogConfigTable(
            specResult.spec,
            applyDialogSettings(
              specResult.spec,
              defaultDialogValues(specResult.spec),
              storedDialogSettings(filter),
            ),
          )
        }
      }
    }
    const result = await runAutomationFilter(
      filter.stateId,
      filter.name,
      documentToLuaRows(doc),
      config,
      luaHost,
    )
    if (!result.ok) {
      const cancelled = result.error === 'cancelled'
      setStatus(
        cancelled ? tPlain('Cancelled') : `Export filter error: ${result.error ?? 'unknown error'}`,
      )
      await finishLuaProgress(cancelled ? [] : [...result.log, 'Script threw an error'])
      return null
    }
    // 过滤器同样经 DialogProgress 显示日志（aegisub.log / debug.out）
    await finishLuaProgress(result.log)
    return result.payload ? applyLuaPayload(doc, result.payload) : doc
  }

  const applyExport = async (options: ExportOptions) => {
    if (!core) return
    try {
      let doc: SubtitleDocument = core.document
      // config 函数以当前文档求值（LuaExportFilter::GenerateConfigDialog 的 c->ass）
      const liveRows = documentToLuaRows(core.document)
      for (const filter of options.filters) {
        // 内置过滤器同步执行，不弹 DialogProgress（桌面版同样没有进度窗口）
        if (filter.builtin) {
          // oxlint-disable-next-line no-await-in-loop -- 过滤器链必须串行
          const next = await runExportFilter(filter, doc, liveRows, options.framerate)
          if (!next) return
          doc = next
          continue
        }
        luaCancelledRef.current = false
        setLuaProgress({
          title: filter.displayName,
          task: '',
          value: 0,
          log: '',
          finished: false,
          cancelling: false,
        })
        // 过滤器链必须串行：后一个过滤器处理前一个的输出（AssExporter::Export 顺序执行）
        // oxlint-disable-next-line no-await-in-loop
        const next = await runExportFilter(filter, doc, liveRows, options.framerate)
        if (!next) return
        doc = next
      }
      const filtered = options.includeComments
        ? doc
        : { ...doc, cues: doc.cues.filter((cue) => !cue.comment) }
      // Export Filters 写入导出副本（桌面写在 c->ass->Properties，web 不触碰活文档）
      const written = withExportFilters(
        filtered,
        options.filters.map((filter) => filter.displayName),
      )
      let rateOptions: { fps?: number; frameTimes?: number[] } = frameRate.isLoaded()
        ? {
            fps: frameRate.fps(),
            frameTimes: frameRate.timecodes.length > 1 ? [...frameRate.timecodes] : undefined,
          }
        : {}
      if (['microdvd', 'transtation', 'encore'].includes(options.format) && !rateOptions.fps) {
        const choice = await askChoice(
          tPlain('Frame rate'),
          tPlain('The frame rate is required to export this format:'),
          ['23.976', '24', '25', '29.97', '30'],
          3,
        )
        if (choice === null) return
        rateOptions = { fps: [23.976, 24, 25, 29.97, 30][choice] }
      }
      const output = exportSubtitle(written, options.format, {
        clean: true,
        saveUiState: getOptionBool('App/Save UI State'),
        ...rateOptions,
      })
      const base =
        core.document.sourceName
          .replace(/\.(encore|transtation)\.txt$/i, '')
          .replace(/\.[^.]+$/, '') || 'untitled'
      const extension = exportExtension(options.format)
      const bytes =
        output instanceof Uint8Array
          ? output
          : encodeText(output, getOptionString('App/Save Charset') || 'UTF-8')
      void host.saveFile(`${base}.${extension}`, bytes, {
        description: 'Subtitle',
        accept:
          options.format === 'ebu'
            ? { 'application/octet-stream': [`.${extension}`] }
            : { 'text/plain': [`.${extension}`] },
      })
      setStatus(`Exported ${base}.${extension}`)
    } finally {
      setLuaProgress(null)
      setDialog(null)
    }
  }

  const openAudioHandle = async (file: AppFileHandle) => {
    // 音频命令可以打开含音轨的视频文件（<audio> 元素可播视频容器的音轨）
    const opened = await host.openMedia(file)
    let source: MediaSource = opened
    if (file.file) {
      try {
        const tracks = await listMediaTracks(file.file)
        const audioTrack = await chooseTrackIndex('audio', tracks.audios)
        if (audioTrack.cancelled) {
          URL.revokeObjectURL(opened.url)
          setStatus(tPlain('Audio track selection cancelled'))
          return
        }
        if (audioTrack.index !== undefined)
          source = { ...opened, audioStreamIndex: audioTrack.index }
      } catch {
        // 探测失败沿用默认音轨
      }
    }
    if (audioMedia && audioMedia.url !== videoMedia?.url) URL.revokeObjectURL(audioMedia.url)
    setAudioMedia(source)
    setAudioTimeMs(0)
    setAudioDurationMs(0)
    setDisplayModeAudio(true)
    setStatus(`Audio: ${file.name}`)
    void recordRecent('audio', file)
  }

  const openAudio = async () => {
    const file = await host.openFile(MEDIA_FILE_TYPES)
    if (!file) return
    await openAudioHandle(file)
  }

  const openAudioFromVideo = async () => {
    if (!videoMedia) {
      setStatus(tPlain('Open a video first'))
      return
    }
    let source = videoMedia
    if (videoMedia.file) {
      try {
        const tracks = await listMediaTracks(videoMedia.file)
        const audioTrack = await chooseTrackIndex('audio', tracks.audios)
        if (audioTrack.cancelled) return
        if (audioTrack.index !== undefined)
          source = { ...videoMedia, audioStreamIndex: audioTrack.index }
      } catch {
        // 探测失败沿用默认音轨
      }
    }
    if (audioMedia && audioMedia.url !== videoMedia.url) URL.revokeObjectURL(audioMedia.url)
    setAudioMedia(source)
    setAudioTimeMs(0)
    setAudioDurationMs(videoDurationMs)
    setDisplayModeAudio(true)
    setStatus(tPlain('Audio loaded from video'))
  }

  const closeAudio = () => {
    if (audioMedia && audioMedia.url !== videoMedia?.url) URL.revokeObjectURL(audioMedia.url)
    setAudioMedia(null)
    setAudioDurationMs(0)
    setAudioTimeMs(0)
    setDisplayModeAudio(false)
    setStatus(tPlain('Audio closed'))
  }

  const sendVideoAction = (type: string) =>
    setVideoAction((current) => ({ sequence: current.sequence + 1, type }))
  const sendAudioAction = (type: string, range?: { startMs: number; endMs: number }) =>
    setAudioAction((current) => ({ sequence: current.sequence + 1, type, ...range }))

  // 设置项局部更新（查找/替换对话框）
  const patchFindSettings = (patch: Partial<SearchReplaceSettings>) =>
    setFindSettings((current) => ({ ...current, ...patch }))

  /** 编译匹配器；正则非法时显示错误（源码 FindReplace 捕获后 wxMessageBox(Error)） */
  const buildMatcher = (current: SearchReplaceSettings) => {
    try {
      const matcher = compileMatcher(current)
      setFindError('')
      return matcher
    } catch (error) {
      setFindError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /** 字段 → updateCue patch（search_replace_engine.cpp get_dialogue_field） */
  const fieldPatch = (field: SearchReplaceSettings['field'], value: string) =>
    field === 'text'
      ? { text: value }
      : field === 'style'
        ? { style: value }
        : field === 'actor'
          ? { actor: value }
          : { effect: value }

  /** 源码 FindReplace 末尾：写回 Tool/Search Replace/*、更新 MRU 下拉 */
  const finishFindAction = (current: SearchReplaceSettings, withReplace: boolean) => {
    setOption('Tool/Search Replace/Match Case', current.matchCase)
    setOption('Tool/Search Replace/RegExp', current.useRegex)
    setOption('Tool/Search Replace/Skip Comments', current.ignoreComments)
    setOption('Tool/Search Replace/Skip Tags', current.skipTags)
    setOption('Tool/Search Replace/Field', SEARCH_FIELDS.indexOf(current.field))
    setOption('Tool/Search Replace/Affect', current.limitTo === 'selected' ? 1 : 0)
    pushSearchMru('Find', current.find)
    if (withReplace) pushSearchMru('Replace', current.replaceWith)
    setFindMru(loadSearchMru())
  }

  // 源码 SetSelectionAndActive/SetActiveLine + textSelectionController->SetSelection
  const revealMatch = (
    cueId: string,
    selectionOnly: boolean,
    start: number,
    end: number,
    viaLoop: boolean,
  ) => {
    if (viaLoop) {
      setActiveId(cueId)
      anchorRef.current = cueId
      if (!selectionOnly) setSelectedIds(new Set([cueId]))
    }
    if (findSettings.field === 'text') {
      setFindTextSelection({ pos: end, start, end })
      setHistoryNonce((value) => value + 1)
    }
  }

  const findNext = async () => {
    if (!core) return
    const current = findSettings
    if (!current.find) {
      setFindMode((mode) => mode ?? 'find')
      return
    }
    const matcher = buildMatcher(current)
    if (!matcher) return
    finishFindAction(current, false)
    const found = findNextMatch(core.document.cues, current, matcher, {
      activeId,
      selectedIds: selectedSet,
      // 文本字段从选区终点起查找（源码 GetSelectionEnd()）
      fieldStart: textSelectionRef.current.end,
    })
    if (!found) {
      setStatus(tPlain('No matches found.'))
      return
    }
    revealMatch(found.cueId, found.selectionOnly, found.start, found.end, true)
    setStatus(`Found in line ${core.document.cues.findIndex((cue) => cue.id === found.cueId) + 1}`)
  }

  const replaceNext = async () => {
    if (!core) return
    const current = findSettings
    if (!current.find) {
      setFindMode((mode) => mode ?? 'replace')
      return
    }
    const matcher = buildMatcher(current)
    if (!matcher) return
    finishFindAction(current, true)
    const selection = textSelectionRef.current
    const result = replaceNextMatch(core.document.cues, current, matcher, {
      activeId,
      selectedIds: selectedSet,
      // 文本字段以选区起点作为匹配锚点（源码 GetSelectionStart()）
      fieldStart: selection.start,
      fieldEnd: selection.end,
    })
    if (result.replacement) {
      await apply(
        [
          {
            type: 'updateCue',
            id: result.replacement.cueId,
            patch: fieldPatch(current.field, result.replacement.value),
          },
        ],
        tPlain('replace'),
      )
    }
    if (result.found) {
      revealMatch(
        result.found.cueId,
        result.found.selectionOnly,
        result.found.start,
        result.found.end,
        result.foundViaLoop,
      )
    } else if (result.fallbackSelection) {
      setFindTextSelection({
        pos: result.fallbackSelection.end,
        start: result.fallbackSelection.start,
        end: result.fallbackSelection.end,
      })
      setHistoryNonce((value) => value + 1)
    }
  }

  const replaceAll = async () => {
    if (!core) return
    const current = findSettings
    if (!current.find) {
      setFindMode((mode) => mode ?? 'replace')
      return
    }
    const matcher = buildMatcher(current)
    if (!matcher) return
    finishFindAction(current, true)
    const { updates, count } = replaceAllMatches(core.document.cues, current, matcher, selectedSet)
    if (count === 0) {
      setStatus(tPlain('No matches found.'))
      return
    }
    await apply(
      updates.map((item) => ({
        type: 'updateCue' as const,
        id: item.cueId,
        patch: fieldPatch(current.field, item.value),
      })),
      tPlain('replace'),
    )
    setStatus(tFmt(tPlural('One match was replaced.', '%d matches were replaced.', count), count))
  }

  /** dialog_paste_over.cpp / command/edit.cpp paste_over：按勾选字段覆盖目标行 */
  const applyPasteOver = async (
    target: { lines: Omit<SubtitleCue, 'id'>[]; targetIds: string[] },
    fields: boolean[],
  ) => {
    const count = Math.min(target.lines.length, target.targetIds.length)
    const commands: CoreCommand[] = []
    for (let index = 0; index < count; index += 1) {
      const source = target.lines[index]
      const patch: Partial<Omit<SubtitleCue, 'id'>> = {}
      if (fields[0]) patch.comment = source.comment
      if (fields[1]) patch.layer = source.layer
      if (fields[2]) patch.startMs = source.startMs
      if (fields[3]) patch.endMs = source.endMs
      if (fields[4]) patch.style = source.style
      if (fields[5]) patch.actor = source.actor
      if (fields[6]) patch.marginL = source.marginL
      if (fields[7]) patch.marginR = source.marginR
      if (fields[8]) patch.marginV = source.marginV
      if (fields[9]) patch.effect = source.effect
      if (fields[10]) patch.text = source.text
      commands.push({ type: 'updateCue', id: target.targetIds[index], patch })
    }
    if (commands.length) await apply(commands, 'paste')
  }

  /** dialog_attachments.cpp AttachFile：读取本地文件加入附件（同名同组替换） */
  const addAttachments = async (files: File[], group: SubtitleAttachmentGroup) => {
    if (!files.length) return
    const attachments: SubtitleAttachment[] = await Promise.all(
      files.map(async (file) =>
        makeAttachment(file.name, new Uint8Array(await file.arrayBuffer()), group),
      ),
    )
    const label = group === 'font' ? 'attach font file' : 'attach graphics file'
    await apply(
      attachments.map((attachment) => ({ type: 'addAttachment' as const, attachment })),
      label,
    )
  }

  const api: CommandApi = {
    apply,
    undo: async () => {
      const next = await coreRef.current?.undo()
      if (!next) return
      setCore(next)
      // 撤销恢复选中/活动行（subs_controller.cpp:Apply → SetSelectionAndActive）
      setSelectedIds(new Set(next.selected))
      setActiveId(next.activeId)
      anchorRef.current = next.activeId
      // 文本选区/光标随条目恢复，交由 EditPanel 按 nonce 应用
      setHistoryNonce((value) => value + 1)
    },
    redo: async () => {
      const next = await coreRef.current?.redo()
      if (!next) return
      setCore(next)
      // 重做同样恢复选中/活动行（源码 Redo 与 Apply 走同一恢复路径）
      setSelectedIds(new Set(next.selected))
      setActiveId(next.activeId)
      anchorRef.current = next.activeId
      setHistoryNonce((value) => value + 1)
    },
    openSubtitles,
    openSubtitlesFromVideo: () => openSubtitlesFromVideo(),
    openPasteOver: (lines, targetIds) => {
      setPasteOver({ lines, targetIds })
      setDialog('paste-over')
    },
    newSubtitles,
    saveSubtitles: (format) => saveSubtitles(format),
    openVideo,
    closeVideo,
    openAudio,
    openAudioFromVideo,
    closeAudio,
    openDummyVideo: (options) => {
      if (videoMedia && videoMedia !== audioMedia) URL.revokeObjectURL(videoMedia.url)
      setVideoMedia({ name: 'Dummy Video', url: '', kind: 'video', dummy: options })
      setVideoSizeReady(false)
      // project.cpp DoLoadVideo：新视频（含虚拟视频）的 AR 回到自身 DAR
      setAspectOverride(null)
      // dummy provider 同样经 FrameMain::OnVideoOpen 减档（尺寸由面板 effect 上报）
      pendingZoomFitRef.current = true
      setVideoDurationMs(options.lengthMs)
      setVideoTimeMs(0)
      keyframeScanIdRef.current += 1 // 作废旧视频扫描；dummy 无关键帧
      setVideoKeyframeTimes([])
      setStatus(`Dummy video ${options.width}×${options.height}`)
    },
    openSyntheticAudio: (kind) => {
      if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url)
      // Aegisub audio.cpp：150 分钟（ln=396900000 @ 44100Hz）
      const lengthMs = 9_000_000
      setAudioMedia({
        name: kind === 'blank' ? 'Blank Audio' : 'Noise Audio',
        url: '',
        kind: 'audio',
        syntheticAudio: { kind, durationMs: lengthMs },
      })
      setAudioDurationMs(lengthMs)
      setAudioTimeMs(0)
      setDisplayModeAudio(true)
      setStatus(
        kind === 'blank' ? tPlain('2h30 blank audio loaded') : tPlain('2h30 noise audio loaded'),
      )
    },
    setVideoTime: setVideoTimeMs,
    setAudioTime: setAudioTimeMs,
    scrollAudioToSelection: (mode) =>
      setAudioScrollRequest((current) => ({ seq: current.seq + 1, mode })),
    scrollAudioBy: (deltaMs) =>
      setAudioScrollBy((current) => ({ seq: current.seq + 1, delta: deltaMs })),
    setStatus,
    sendVideoAction,
    sendAudioAction,
    moveSelection,
    moveSelectionOrCreate: (resetDefault) => void moveSelectionOrCreate(resetDefault),
    selectLines: (ids) => {
      setActiveId(ids[0] ?? null)
      setSelectedIds(new Set(ids))
      anchorRef.current = ids[0] ?? null
    },
    // 有意偏差：源码每次构造对话框都以 MRU 首项重置 Find；web 打开时不重置（保留上次输入），
    // 仅在 App 初始化时取一次 mru.Find[0]
    openFind: (mode) => setFindMode(mode),
    findNext,
    replaceNext,
    replaceAll,
    openStyleManager: () => setShowStyleManager(true),
    openDialog: (kind) => setDialog(kind),
    reloadAutomationScripts: () => void reloadAllAutomationScripts(),
    reloadGlobalAutomationScripts: () => void reloadGlobalAutomationScripts(),
    checkForUpdates: () => void checkForUpdates(),
    setToolbarVisible: (value) => {
      setToolbarVisible(value)
      setOption('App/Show Toolbar', value)
    },
    setAudioView: (view) => {
      setAudioView(view)
      setOption('Audio/Spectrum', view === 'spectrum')
    },
    // 音频开关同时持久化（audio.cpp 各 toggle 命令写 OPT_SET；karaoke 为会话状态）
    setAudioOption: (option, value) => {
      setAudioOptions((current) => ({ ...current, [option]: value }))
      const optionName = AUDIO_TOGGLE_OPTIONS[option]
      if (optionName) setOption(optionName, value)
    },
    setVideoAutoScroll: (value) => {
      setVideoAutoScroll(value)
      setOption('Video/Subtitle Sync', value)
    },
    setGridTags: (mode) => {
      setGridTags(mode)
      setOption('Subtitle/Grid/Hide Overrides', mode === 'hide' ? 2 : mode === 'show' ? 0 : 1)
    },
    setDisplayMode,
    setVideoOverscan,
    setVideoDetached,
    setAspectOverride,
    restoreAutosave: () => void restoreAutosave(),
    toggleLog: () => setLogWindowOpen((open) => !open),
    openKeyframes: () => void openKeyframes(),
    saveKeyframes: () => void saveKeyframes(),
    closeKeyframes,
    openTimecodes: () => void openTimecodes(),
    saveTimecodes: () => void saveTimecodes(),
    closeTimecodes,
    setFrameMode,
    openRecent: (type, index) => void openRecent(type, index),
    saveBinary: (name, data, description, extension) => {
      void host.saveFile(name, data, {
        description,
        accept: { 'application/octet-stream': [extension] },
      })
    },
  }

  const commandContext = (): CommandContext | null => {
    if (!core) return null
    return {
      core,
      selected: selectedOrActive(core.document, selectedSet, activeId),
      activeCue: selectedCue,
      videoMedia,
      audioMedia,
      videoTimeMs,
      videoDurationMs,
      audioTimeMs,
      audioDurationMs,
      audioView,
      audioOptions,
      audioPlaying,
      videoAutoScroll,
      gridTags,
      displayMode,
      toolbarVisible,
      videoOverscan,
      videoDetached,
      aspectOverride,
      frameRate,
      currentFrame,
      frameCount,
      keyframes: activeKeyframes,
      keyframesFromFile,
      timecodesFromFile,
      frameMode: frameMode && frameRate.isLoaded(),
    }
  }

  const executeCommand = (id: string) => {
    // Automation 宏命令（automation/lua/<脚本>/<宏名>）
    if (id.startsWith('automation/lua/')) {
      void runAutomationMacroById(id)
      return
    }
    const ctx = commandContext()
    const def = COMMAND_REGISTRY[id]
    if (!ctx || !def) {
      setStatus(tPlain('This command is not available in the web build'))
      return
    }
    if (def.enabled && !def.enabled(ctx)) return
    void def.run(ctx, api)
  }
  // 键盘事件处理器经 ref 读取最新命令实现（渲染后同步）
  useEffect(() => {
    executeRef.current = executeCommand
  })

  const isCommandEnabled = (id: string) => {
    // Automation 宏：由 validate 结果决定（COMMAND_VALIDATE）；未求值前默认启用
    if (id.startsWith('automation/lua/')) return macroMenuState[id]?.enabled ?? true
    const ctx = commandContext()
    const def = COMMAND_REGISTRY[id]
    return Boolean(ctx && def && (!def.enabled || def.enabled(ctx)))
  }

  const isCommandChecked = (id: string) => {
    // Automation 宏：由 isactive 结果决定（COMMAND_TOGGLE）
    if (id.startsWith('automation/lua/')) return macroMenuState[id]?.checked ?? false
    const ctx = commandContext()
    const def = COMMAND_REGISTRY[id]
    return Boolean(ctx && def?.checked?.(ctx))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement
      // 模态对话框独占键盘（wx：模态窗口期间主窗口快捷键表不参与分发）。
      // 注意不能只看 target：在对话框里拖选文本后焦点可能落回 body，
      // 因此按 DOM 里是否存在打开的对话框判断。放行后浏览器原生 Ctrl+C 才能复制选区，
      // 否则会被 Default 上下文的 edit/line/copy 命中并 preventDefault
      if (document.querySelector('.app-dialog')) return
      // 编辑守卫只拦文本输入类（源码 wxTextCtrl 全消费）；range/checkbox/radio 在
      // wxSLIDER/wxCHKBUTTON 语义下仅消费自身导航键、其余键向上传播（wx 事件 Skip）
      const editing = target.matches(
        'input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"]), textarea, select, [contenteditable="true"]',
      )
      const isRangeSlider = target.matches('input[type="range"]')
      const contextElement = target.closest<HTMLElement>('[data-shortcut-context]')
      const context = (contextElement?.dataset.shortcutContext ?? 'Default') as ShortcutContext
      const shortcut = shortcutFromKeyboardEvent(event)
      // 滑条聚焦时导航键由原生控件消费（源码 wxSlider 先吃掉方向键再传播）
      if (
        isRangeSlider &&
        (shortcut === 'Left' ||
          shortcut === 'Right' ||
          shortcut === 'Up' ||
          shortcut === 'Down' ||
          shortcut === 'Home' ||
          shortcut === 'End' ||
          shortcut === 'PageUp' ||
          shortcut === 'PageDown')
      )
        return
      const command = commandForShortcut(shortcut, context)
      const isSubtitleEditor = context === 'Subtitle Edit Box'
      // 编辑框内交还浏览器原生处理的命令：cut/copy/paste 的原生行为在源码里由命令
      // 内部检查焦点实现（command/edit.cpp edit_line_copy 等），Select All 同理；
      // 而 undo/redo 无此特例——subs_edit_box.cpp OnKeyDown 的 CHAR_HOOK 把按键交给
      // hotkey::check（命中即消费），Default 上下文的 Ctrl-Z/Ctrl-Y 触发全局撤销/重做，
      // Scintilla 自身撤销不生效，故这两个命令必须走全局执行
      const nativeEditingCommands = new Set([
        'edit/line/cut',
        'edit/line/copy',
        'edit/line/paste',
        'subtitle/select/all',
      ])
      if (command && (!editing || (isSubtitleEditor && !nativeEditingCommands.has(command)))) {
        event.preventDefault()
        executeRef.current(command)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // frame_main.cpp SetDisplayMode(_, audio)：audio != 0 时 sa = !!project->AudioProvider()——
  // 没有载入音频时 ToolsSizer->Show(audioBox, false, true)，AudioBox 连同底边 sash 一起隐藏，
  // 空间全给 EditBox
  const showAudioBox = !!audioMedia && (displayMode === 'full' || displayMode === 'audio_subs')
  const rightWorkspaceRows = showAudioBox
    ? isNarrowViewport
      ? undefined // 移动端音频/编辑栏为固定高度块（styles.css @media），不设行高
      : `${audioBoxHeight}px 4px minmax(0, 1fr)`
    : isNarrowViewport
      ? 'auto' // 只剩 EditPanel 一行：行高取其自身固定高度
      : 'minmax(0, 1fr)'

  if (!core)
    return (
      <main className="loading-screen">
        <Captions size={30} />
        <span>{tPlain('Loading Aegisub Web')}</span>
      </main>
    )

  return (
    <main
      className={`app-shell${toolbarVisible ? '' : ' toolbar-hidden'}`}
      style={{ '--icon-size': `${getOptionInt('App/Toolbar Icon Size')}px` } as CSSProperties}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer?.files?.length) void handleDroppedFiles(event.dataTransfer.files)
      }}
    >
      {/* 分离窗口按键代理：把弹窗 keydown 派发到此元素，命中 Video 快捷键上下文 */}
      <div
        ref={detachedKeyTargetRef}
        data-shortcut-context="Video"
        aria-hidden="true"
        style={{ display: 'none' }}
      />
      <MenuBar
        projectName={core.document.sourceName}
        recentLists={recentLists}
        automationMacros={automationScripts.flatMap((script) =>
          script.error ? [] : script.macros.map((macro) => ({ id: macro.id, name: macro.name })),
        )}
        undoLabel={core.undoLabel}
        redoLabel={core.redoLabel}
        onCommand={executeCommand}
        isCommandEnabled={isCommandEnabled}
        isCommandChecked={isCommandChecked}
        onMenuOpen={(menuId) => {
          if (menuId === 'automation') void refreshMacroMenuStates()
        }}
      />
      {toolbarVisible && (
        <Toolbar
          onCommand={executeCommand}
          isCommandEnabled={isCommandEnabled}
          isCommandChecked={isCommandChecked}
        />
      )}
      <div
        className="workspace"
        style={
          displayMode === 'full' || displayMode === 'video_subs'
            ? {
                // video_box.cpp 挂靠 TopSizer proportion 0：视频栏高度=精确最小高（display+56），
                // 多余空间全给 Grid（proportion 1）；窗口放不下时 wx 靠 frame 最小尺寸强制窗口变大
                // （永不压缩视频栏），浏览器侧由 .workspace 的 overflow:auto 滚动到达（见 styles.css）。
                // 未载入视频时占位面板已按 1080p 预留同一高度，故空/有视频共用同一行高
                gridTemplateRows: isNarrowViewport
                  ? `min(${videoLayout.panelHeight}px, calc(100dvh - 194px)) minmax(120px, 1fr)`
                  : `minmax(${videoLayout.panelHeight}px, min-content) minmax(120px, 1fr)`,
              }
            : undefined
        }
      >
        <div className="top-workspace">
          {(displayMode === 'full' || displayMode === 'video_subs') && (
            <div
              className="preview-host-mount"
              style={videoDetached ? { display: 'none' } : { display: 'contents' }}
              ref={(node) => {
                previewMountRef.current = node
                const previewHost = previewHostRef.current
                if (node && previewHost && !videoDetached && previewHost.parentNode !== node)
                  node.appendChild(previewHost)
              }}
            >
              {createPortal(
                // video/detach 时该 portal host 被搬进独立窗口；挂靠时 display:contents
                // 让 .preview-panel 继续直接作为 top-workspace 的 flex 子项
                <PreviewPane
                  document={core.document}
                  media={videoMedia}
                  currentTimeMs={videoTimeMs}
                  activeCue={selectedCue}
                  onTimeChange={setVideoTimeMs}
                  onDurationChange={setVideoDurationMs}
                  onOpenMedia={() => void openVideo()}
                  mediaAction={videoAction}
                  onCommand={executeCommand}
                  onPatchCue={(id, patch, label, amend) =>
                    apply([{ type: 'updateCue', id, patch }], label, amend)
                  }
                  onPatchCues={(patches, label, amend) =>
                    apply(
                      patches.map(({ id, patch }) => ({ type: 'updateCue', id, patch })),
                      label,
                      amend,
                    )
                  }
                  selectedCues={selectedCues}
                  onVisualSelect={visualSelectCue}
                  onVisualSetActive={visualSetActiveCue}
                  onVisualDeselect={visualDeselectCue}
                  onPatchStyle={(id, patch, label) =>
                    void apply([{ type: 'updateStyle', id, patch }], label)
                  }
                  isCommandEnabled={isCommandEnabled}
                  isCommandChecked={isCommandChecked}
                  windowZoom={previewZoom}
                  devicePixelRatio={devicePixelRatioValue}
                  onWindowZoomChange={changeVideoZoom}
                  onIntrinsicSizeChange={setIntrinsicSizeStable}
                  localFontsEpoch={localFontsEpoch}
                  onLocalFontsAuthorize={() => setLocalFontsEpoch((epoch) => epoch + 1)}
                  intrinsicWidth={previewIntrinsic.width}
                  intrinsicHeight={previewIntrinsic.height}
                  overscan={videoOverscan}
                  keyframes={activeKeyframes}
                  currentFrame={currentFrame}
                  frameRate={frameRate}
                  frameCount={frameCount}
                  onDetectedFps={setDetectedFps}
                  onPlaybackModeChange={setVideoPlaybackMode}
                  decoderOverride={videoDecoderOverride}
                  videoColorspace={videoColorspace}
                  playbackGain={playbackGain}
                  onKeyframesChange={(list) => {
                    // WebCodecs 读流上报的也是时间（ms）；统一走派生换算，文件关键帧优先。
                    // 后台解复用扫描是全量索引（ffms2 语义）：进行中或已有完整结果时，
                    // 不得被 WebCodecs 渐进列表（只覆盖已读流片段）覆盖——扫描失败才作回退
                    if (keyframesFromFile) return
                    const scan = videoScanRef.current
                    if (scan && scan.id === keyframeScanIdRef.current) {
                      if (!scan.done || scan.keyframeTimes.length > 0) return
                    }
                    setVideoKeyframeTimes(list)
                    // 写入关键帧缓存（覆盖解复用扫描未覆盖的 WebCodecs-only 路径）
                    if (videoMedia?.file && list.length > 0)
                      void storeCachedKeyframes(
                        videoMedia.file,
                        list,
                        undefined,
                        videoMedia.videoStreamIndex,
                      )
                  }}
                  // video_display.cpp FitClientSizeToVideo：SetMinClientSize = SetMaxClientSize =
                  // video×zoom → 显示框锁定尺寸，窗口变窄也不收缩（flex-shrink: 0），溢出由窗口裁剪。
                  // 无视频的占位面板保持可收缩（basis 撑开、shrink 挤压）；移动端走 styles.css 的
                  // 固定高度预览布局（@media 覆盖），不传内联尺寸
                  style={
                    videoDetached || isNarrowViewport
                      ? undefined
                      : videoMedia
                        ? { flexBasis: `${videoLayout.panelWidth}px`, flexShrink: 0 }
                        : { flexBasis: `${videoLayout.panelWidth}px` }
                  }
                />,
                previewHostRef.current,
              )}
            </div>
          )}
          <div
            className="right-workspace"
            style={rightWorkspaceRows ? { gridTemplateRows: rightWorkspaceRows } : undefined}
          >
            {showAudioBox && (
              <AudioPane
                media={audioMedia}
                durationMs={audioDurationMs}
                currentTimeMs={audioTimeMs}
                videoTimeMs={videoMedia ? videoTimeMs : null}
                selectedCue={selectedCue}
                selectedCues={selectedCues}
                cues={core.document.cues}
                keyframes={activeKeyframes}
                fps={frameRate.isLoaded() ? frameRate.fps() : DEFAULT_FPS}
                frameRate={frameRate}
                karaokeMode={audioOptions.karaoke}
                view={audioView}
                options={audioOptions}
                playing={audioPlaying}
                onViewChange={setAudioView}
                onPlayingChange={setAudioPlaying}
                isCommandEnabled={isCommandEnabled}
                isCommandChecked={isCommandChecked}
                onSeek={setAudioTimeMs}
                onVideoSeek={setVideoTimeMs}
                mediaAction={audioAction}
                scrollToActiveLine={audioScrollRequest.seq}
                scrollToActiveLineMode={audioScrollRequest.mode}
                scrollBy={audioScrollBy}
                onDurationChange={setAudioDurationMs}
                onCommand={executeCommand}
                onPlaybackGainChange={setPlaybackGain}
                onPatchCue={(id, patch, label) => apply([{ type: 'updateCue', id, patch }], label)}
              />
            )}
            {!isNarrowViewport && showAudioBox && (
              <div
                className="audio-sash"
                role="separator"
                aria-orientation="horizontal"
                aria-label={tPlain('Audio box resize sash')}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  // OnSashDrag：new_height = min(dragRect.height, 父窗口高 - 1)；
                  // 上限按 EditPanel 保留 150px（源码 sizer min size 防挤没）
                  const workspace = event.currentTarget.parentElement
                  audioSashDragRef.current = {
                    startY: event.clientY,
                    startHeight: audioBoxHeight,
                    maxHeight: Math.max(120, (workspace?.clientHeight ?? 600) - 154),
                    current: audioBoxHeight,
                  }
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={(event) => {
                  const drag = audioSashDragRef.current
                  if (!drag) return
                  const height = Math.round(
                    Math.max(
                      80,
                      Math.min(drag.startHeight + event.clientY - drag.startY, drag.maxHeight),
                    ),
                  )
                  drag.current = height
                  setAudioBoxHeight(height)
                }}
                onPointerUp={() => {
                  const drag = audioSashDragRef.current
                  if (!drag) return
                  audioSashDragRef.current = null
                  // OPT_SET("Audio/Display Height")：拖动结束后持久化
                  setOption('Audio/Display Height', drag.current)
                }}
                onPointerCancel={() => {
                  audioSashDragRef.current = null
                }}
              />
            )}
            <EditPanel
              cue={selectedCue}
              styles={core.document.styles}
              actors={actorValues}
              effects={effectValues}
              frameRate={frameRate}
              frameMode={frameMode && frameRate.isLoaded()}
              onFrameModeChange={setFrameMode}
              onCommit={(patch, label, amend) => {
                // subs_edit_box.cpp SetSelectedRows：编辑框任一字段都作用于选中集合的全部行
                // （无选中时 selectedCues 回退活动行）；一次 apply 内多条命令 = 一个撤销点；
                // amend 由 EditPanel 按源码判定（同描述/同时间字段）后下发
                if (selectedCues.length === 0) return
                void apply(
                  selectedCues.map((cue) => ({ type: 'updateCue', id: cue.id, patch })),
                  label,
                  amend,
                )
              }}
              onCommand={executeCommand}
              isCommandEnabled={isCommandEnabled}
              onEditStyle={() =>
                setEditingStyleHandle(
                  activeStyle ? { id: activeStyle.id, name: activeStyle.name } : null,
                )
              }
              onTextSelection={(pos, start, end) => {
                textSelectionRef.current = { pos, start, end }
                // 命中回写编辑框选区后，随后的真实选区变更清除覆盖值
                setFindTextSelection((current) => (current === null ? current : null))
                coreRef.current?.notifyTextSelection(pos, start, end)
              }}
              textSelection={findTextSelection ?? core.textSelection}
              historyNonce={historyNonce}
            />
          </div>
        </div>
        <SubtitleGrid
          cues={core.document.cues}
          activeId={activeId}
          selectedIds={selectedSet}
          currentTimeMs={videoTimeMs}
          textMode={gridTags}
          frameRate={frameRate}
          frameMode={frameMode && frameRate.isLoaded()}
          hasVideo={!!videoMedia}
          onSelect={selectCue}
          onSelectRange={selectRange}
          getAnchorId={() => anchorRef.current}
          onActivate={(cue) => {
            selectOnly(cue.id)
            // base_grid.cpp 双击：audioBox->ScrollToActiveLine()（无条件，不受
            // Audio/Auto/Scroll 开关限制）+ videoController->JumpToTime(dlg->Start)
            // （START 帧语义）
            setAudioScrollRequest((current) => ({ seq: current.seq + 1, mode: 'range' }))
            seekVideoToLineStart(cue.startMs)
          }}
          // alt+方向键仅移活动行：锚点行随活动行更新（OnActiveLineChanged → extendRow）
          onSetActive={(id) => {
            setActiveId(id)
            anchorRef.current = id
          }}
          onCommand={executeCommand}
          isCommandEnabled={isCommandEnabled}
          scrollRestore={gridScrollRestore}
          onScrollRowChange={setGridScrollRow}
        />
      </div>
      {logWindowOpen && <LogPanel onClose={() => setLogWindowOpen(false)} />}

      <footer className="app-footer">
        {/* Aegisub CreateStatusBar(2)：field 0（左）源码从不写入，field 1（右）承载
            StatusTimeout 的临时消息（到点 OnStatusClear 清空） */}
        <span className={`status-indicator${busy ? ' busy' : ''}`} />
        <span className="status-info">
          {core.runtime === 'wasm' ? tPlain('Aegisub core') : tPlain('Web core')}
        </span>
        {/* 视频解码器指示（可点击切换：原生 ↔ WebCodecs） */}
        {videoPlaybackMode && (
          <button
            type="button"
            className="status-decoder"
            title="点击切换视频解码器（原生 ↔ WebCodecs）"
            onClick={() => setVideoDecoderOverride(videoPlaybackMode !== 'webcodecs')}
          >
            {tPlain('Decoder: ')}
            {videoPlaybackMode === 'native' ? tPlain('Native') : 'WebCodecs'}
          </button>
        )}
        <span className="status-message">{status === 'Ready' ? tPlain('Ready') : status}</span>
      </footer>

      {showStyleManager && (
        <StyleManagerDialog
          styles={core.document.styles}
          activeStyleName={selectedCue?.style ?? core.document.styles[0]?.name ?? ''}
          onClose={() => setShowStyleManager(false)}
          hasReferences={styleHasReferences}
          onUpdate={(id, patch, label, rename) => {
            const commands: CoreCommand[] = [{ type: 'updateStyle', id, patch }]
            // 改名询问选“是”：同一事务内改写脚本引用（源码单次 Commit 一步撤销）
            if (rename) commands.push({ type: 'renameStyleReferences', ...rename })
            void apply(commands, tPlain(label ?? 'style change'))
          }}
          onAdd={(style, label) =>
            void apply([{ type: 'addStyle', style }], tPlain(label ?? 'style change'))
          }
          onDelete={(ids) =>
            ids.forEach((id) => void apply([{ type: 'deleteStyle', id }], tPlain('style delete')))
          }
          onReorder={(ids) => void apply([{ type: 'reorderStyles', ids }], tPlain('style move'))}
        />
      )}

      {/* 编辑框 Edit 按钮：源码 DialogStyleEditor(this, active_style, c, nullptr, "", font_list) */}
      {editingStyle && (
        <StyleEditorDialog
          style={editingStyle}
          existing={core.document.styles}
          originalId={editingStyle.id}
          hasReferences={styleHasReferences}
          onApply={(style, rename) => {
            const commands: CoreCommand[] = [
              { type: 'updateStyle', id: editingStyle.id, patch: style },
            ]
            if (rename) commands.push({ type: 'renameStyleReferences', ...rename })
            void apply(commands, tPlain('style change'))
            // 新名字即刻作为回退句柄（id 待文档落地后由解析处的同步逻辑切换）
            setEditingStyleHandle((current) =>
              current ? { ...current, name: style.name } : current,
            )
          }}
          onClose={() => setEditingStyleHandle(null)}
        />
      )}

      {findMode && (
        <div className="dialog-backdrop" role="presentation">
          <form
            className="app-dialog find-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={findMode === 'replace' ? tPlain('Replace') : tPlain('Find')}
            onSubmit={(event) => {
              event.preventDefault()
              void findNext()
            }}
          >
            <header>
              <strong>{findMode === 'replace' ? tPlain('Replace') : tPlain('Find')}</strong>
              <button
                type="button"
                className="dialog-close"
                onClick={() => setFindMode(null)}
                title={tPlain('Close')}
                aria-label={tPlain('Close')}
              >
                <X size={16} />
              </button>
            </header>
            <div className="find-dialog-body">
              <div className="find-dialog-top">
                <div className="find-dialog-left">
                  <div className="find-dialog-fields">
                    <label htmlFor="find-what">{tPlain('Find what:')}</label>
                    <input
                      id="find-what"
                      autoFocus
                      list="find-mru-list"
                      value={findSettings.find}
                      onChange={(event) => patchFindSettings({ find: event.target.value })}
                    />
                    {findMode === 'replace' && (
                      <>
                        <label htmlFor="find-replace">{tPlain('Replace with:')}</label>
                        <input
                          id="find-replace"
                          list="replace-mru-list"
                          value={findSettings.replaceWith}
                          onChange={(event) =>
                            patchFindSettings({ replaceWith: event.target.value })
                          }
                          onKeyDown={(event) => {
                            // wxEVT_TEXT_ENTER：替换框回车 = Replace next
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void replaceNext()
                            }
                          }}
                        />
                      </>
                    )}
                  </div>
                  <div className="find-dialog-options">
                    <label className="find-dialog-check">
                      <input
                        type="checkbox"
                        checked={findSettings.matchCase}
                        onChange={(event) => patchFindSettings({ matchCase: event.target.checked })}
                      />
                      {tPlain('Match case')}
                    </label>
                    <label className="find-dialog-check">
                      <input
                        type="checkbox"
                        checked={findSettings.useRegex}
                        onChange={(event) => patchFindSettings({ useRegex: event.target.checked })}
                      />
                      {tPlain('Use regular expressions')}
                    </label>
                    <label className="find-dialog-check">
                      <input
                        type="checkbox"
                        checked={findSettings.ignoreComments}
                        onChange={(event) =>
                          patchFindSettings({ ignoreComments: event.target.checked })
                        }
                      />
                      {tPlain('Skip Comments')}
                    </label>
                    <label className="find-dialog-check">
                      <input
                        type="checkbox"
                        checked={findSettings.skipTags}
                        onChange={(event) => patchFindSettings({ skipTags: event.target.checked })}
                      />
                      {tPlain('Skip Override Tags')}
                    </label>
                  </div>
                </div>
                <div className="find-dialog-buttons">
                  <button type="submit">{tPlain('Find next')}</button>
                  {findMode === 'replace' && (
                    <button type="button" onClick={() => void replaceNext()}>
                      {tPlain('Replace next')}
                    </button>
                  )}
                  {findMode === 'replace' && (
                    <button type="button" onClick={() => void replaceAll()}>
                      {tPlain('Replace all')}
                    </button>
                  )}
                  <button type="button" onClick={() => setFindMode(null)}>
                    {tPlain('Cancel')}
                  </button>
                </div>
              </div>
              <div className="find-dialog-scope">
                <fieldset className="dialog-fieldset">
                  <legend>{tPlain('In Field')}</legend>
                  {SEARCH_FIELDS.map((field) => (
                    <label className="dialog-check" key={field}>
                      <input
                        type="radio"
                        name="find-field"
                        checked={findSettings.field === field}
                        onChange={() => patchFindSettings({ field })}
                      />
                      {tPlain(SEARCH_FIELD_LABELS[field] ?? field)}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="dialog-fieldset">
                  <legend>{tPlain('Limit to')}</legend>
                  <label className="dialog-check">
                    <input
                      type="radio"
                      name="find-limit"
                      checked={findSettings.limitTo === 'all'}
                      onChange={() => patchFindSettings({ limitTo: 'all' })}
                    />
                    {tPlain('All rows')}
                  </label>
                  <label className="dialog-check">
                    <input
                      type="radio"
                      name="find-limit"
                      checked={findSettings.limitTo === 'selected'}
                      onChange={() => patchFindSettings({ limitTo: 'selected' })}
                    />
                    {tPlain('Selected rows')}
                  </label>
                </fieldset>
              </div>
              {findError && <p className="dialog-error">{findError}</p>}
              <datalist id="find-mru-list">
                {findMru.Find.map((item, index) => (
                  <option key={`${item}-${index}`} value={item} />
                ))}
              </datalist>
              {findMode === 'replace' && (
                <datalist id="replace-mru-list">
                  {findMru.Replace.map((item, index) => (
                    <option key={`${item}-${index}`} value={item} />
                  ))}
                </datalist>
              )}
            </div>
          </form>
        </div>
      )}

      {dialog === 'shift' && core && (
        <ShiftTimesDialog
          cues={core.document.cues}
          selectedIds={selectedOrActive(core.document, selectedSet, activeId)}
          fileName={core.document.sourceName}
          frameRate={frameRate}
          onClose={() => setDialog(null)}
          onApply={(commands, label) => void apply(commands, label)}
        />
      )}
      {dialog === 'jump' && (
        <JumpToDialog
          currentTimeMs={videoTimeMs}
          durationMs={videoDurationMs}
          onClose={() => setDialog(null)}
          onJump={setVideoTimeMs}
        />
      )}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {choicePrompt && <ChoicePromptDialog {...choicePrompt} />}
      {dialog === 'charset' && pendingOpen && (
        <CharsetDialog
          encoding={pendingOpen.encoding ?? detectEncoding(pendingOpen.bytes).encoding}
          onApply={(encoding) => {
            const pending = pendingOpen
            setPendingOpen(null)
            setDialog(null)
            void beginSubtitleLoad(
              pending.file,
              pending.bytes,
              pending.format,
              encoding,
              pending.skipLinkedFiles,
            )
          }}
          onClose={() => {
            setPendingOpen(null)
            setDialog(null)
          }}
        />
      )}
      {dialog === 'text-import' && pendingOpen && (
        <TextImportDialog
          actorSeparator={getOptionString('Tool/Import/Text/Actor Separator')}
          commentStarter={getOptionString('Tool/Import/Text/Comment Starter')}
          includeBlank={getOptionBool('Tool/Import/Text/Include Blank')}
          onApply={(options) => {
            setOption('Tool/Import/Text/Actor Separator', options.actorSeparator)
            setOption('Tool/Import/Text/Comment Starter', options.commentStarter)
            setOption('Tool/Import/Text/Include Blank', options.includeBlank)
            const pending = pendingOpen
            setPendingOpen(null)
            setDialog(null)
            if (pending.encoding) {
              void finishOpenSubtitle(
                pending.file,
                pending.bytes,
                pending.encoding,
                pending.format,
                options,
                pending.skipLinkedFiles,
              )
            }
          }}
          onClose={() => {
            setPendingOpen(null)
            setDialog(null)
          }}
        />
      )}
      {dialog === 'paste-over' && pasteOver && (
        <PasteOverDialog
          lineCount={pasteOver.lines.length}
          targetCount={pasteOver.targetIds.length}
          onApply={(fields) => {
            const target = pasteOver
            setPasteOver(null)
            setDialog(null)
            void applyPasteOver(target, fields)
          }}
          onClose={() => {
            setPasteOver(null)
            setDialog(null)
          }}
        />
      )}
      {dialog === 'aspect-ratio' && (
        <AspectRatioDialog
          initial={
            aspectOverride ??
            (previewIntrinsic.width > 0
              ? previewIntrinsic.width / Math.max(1, previewIntrinsic.height)
              : null)
          }
          onApply={(ratio) => setAspectOverride(ratio)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'video-details' && videoMedia && (
        <VideoDetailsDialog
          media={videoMedia}
          durationMs={videoDurationMs}
          fps={frameRate.isLoaded() ? frameRate.fps() : null}
          frameCount={frameCount}
          width={videoIntrinsicSize.width}
          height={videoIntrinsicSize.height}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'dummy-video' && core && (
        <DummyVideoDialog
          onClose={() => setDialog(null)}
          onApply={(options) => api.openDummyVideo(options)}
        />
      )}
      {dialog === 'properties' && core && (
        <ScriptPropertiesDialog
          scriptInfo={core.document.scriptInfo}
          video={
            videoMedia && !videoMedia.dummy
              ? {
                  width: videoIntrinsicSize.width,
                  height: videoIntrinsicSize.height,
                  colorspace: videoColorspace,
                }
              : null
          }
          onClose={() => setDialog(null)}
          onApply={(patch) =>
            void apply([{ type: 'updateScriptInfo', patch }], tPlain('property changes'))
          }
        />
      )}
      {dialog === 'styling-assistant' && selectedCue && (
        <StylingAssistantDialog
          cue={selectedCue}
          styles={core.document.styles}
          hasAudio={!!audioMedia}
          hasVideo={!!videoMedia}
          onClose={() => setDialog(null)}
          onApply={(id, style) =>
            void apply([{ type: 'updateCue', id, patch: { style } }], 'styling assistant')
          }
          onSeekVideo={setVideoTimeMs}
          onCommand={executeCommand}
        />
      )}
      {dialog === 'attachments' && core && (
        <AttachmentDialog
          attachments={core.document.attachments}
          onAdd={(files, group) => void addAttachments(files, group)}
          onDelete={(attachments) =>
            void apply(
              attachments.map((attachment) => ({
                type: 'deleteAttachment' as const,
                name: attachment.name,
                group: attachment.group,
              })),
              'remove attachment',
            )
          }
          onExtract={(attachments) => {
            for (const attachment of attachments) {
              // 去掉目录成分，避免存档内的路径穿越到下载名
              const name = attachmentFileName(attachment).split(/[\\/]/).pop() || 'attachment'
              const dot = name.lastIndexOf('.')
              const extension = dot > 0 ? name.slice(dot) : ''
              void host.saveFile(
                name,
                attachmentBytes(attachment),
                extension
                  ? {
                      description: 'All Supported Formats',
                      accept: { 'application/octet-stream': [extension] },
                    }
                  : undefined,
              )
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'font-collector' && core && (
        <FontCollectorDialog
          styles={core.document.styles}
          text={core.document.cues.map((cue) => cue.text).join('\n')}
          fileName={core.document.sourceName}
          onLocalFontsAuthorized={() => setLocalFontsEpoch((epoch) => epoch + 1)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'translation' && selectedCue && core && (
        <TranslationDialog
          cue={selectedCue}
          cues={core.document.cues}
          hasAudio={!!audioMedia}
          hasVideo={!!videoMedia}
          onSelectCue={selectOnly}
          onApply={(id, text) =>
            void apply([{ type: 'updateCue', id, patch: { text } }], 'translation assistant')
          }
          onSeekVideo={setVideoTimeMs}
          onCommand={executeCommand}
          onMessage={setStatus}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'select-lines' && (
        <SelectLinesDialog onClose={() => setDialog(null)} onApply={applySelectLines} />
      )}
      {dialog === 'export' && (
        <ExportSubtitlesDialog
          filters={exportFilters}
          initialSelected={core ? documentExportFilters(core.document) : []}
          framerateDefaults={{
            inputFps: detectedFps ?? (frameRate.isLoaded() ? frameRate.fps() : 23.976),
            outputFps: frameRate.isLoaded() ? frameRate.fps() : 23.976,
            // Framerate::IsVFR()：timecodes 表多于一个条目
            outputVariable: frameRate.timecodes.length > 1,
            hasVideo: Boolean(videoMedia),
          }}
          onConfigure={(filter) => void openFilterConfig(filter)}
          onClose={() => setDialog(null)}
          onApply={(options) => void applyExport(options)}
        />
      )}
      {dialog === 'resample' && core && (
        <ResampleDialog
          document={core.document}
          hasVideo={!!videoMedia}
          videoWidth={videoIntrinsicSize.width}
          videoHeight={videoIntrinsicSize.height}
          onApply={(commands) => void apply(commands, 'resolution resampling')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'automation' && (
        <AutomationManagerDialog
          scripts={automationScripts.map((script) => ({
            id: script.key,
            name: script.name,
            description: script.description,
            filename: script.filename,
            macros: script.macros.map((macro) => ({ id: macro.id, name: macro.name })),
            filters: script.filters.map((filter) => filter.name),
            author: script.author,
            version: script.version,
            warnings: script.warnings,
            error: script.error,
            isGlobal: script.isGlobal,
          }))}
          onAdd={() => void addAutomationScript()}
          onRemove={removeAutomationScript}
          onReload={(key) => void reloadAutomationScript(key)}
          onRescan={() => void reloadGlobalAutomationScripts()}
          onHelp={() => openHelpPage('Automation Manager')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'file-manager' && (
        <FileManagerDialog
          onClose={() => setDialog(null)}
          onRestoreDefaults={restoreFactoryScripts}
          onChanged={() => void reloadGlobalAutomationScripts()}
        />
      )}
      {dialog === 'timing-postprocess' && core && (
        <TimingProcessorDialog
          cues={core.document.cues}
          styles={core.document.styles.map((style) => style.name)}
          selectedIds={[...selectedSet]}
          keyframes={activeKeyframes}
          frameCount={frameCount}
          hasVideo={!!videoMedia}
          frameRate={frameRate}
          onClose={() => setDialog(null)}
          onApply={(commands, label) => void apply(commands, label)}
        />
      )}
      {dialog === 'kanji-timer' && core && (
        <KanjiTimerDialog
          cues={core.document.cues}
          styles={core.document.styles.map((style) => style.name)}
          onClose={() => setDialog(null)}
          onApply={(commands, label) => void apply(commands, label)}
        />
      )}
      {dialog === 'spellcheck' && core && (
        <SpellCheckerDialog
          cues={core.document.cues}
          activeId={activeId}
          onReveal={(cueId, start, end) => {
            // dialog_spellchecker.cpp：SetSelectionAndActive + 选中错词（不依赖查找字段）
            setActiveId(cueId)
            anchorRef.current = cueId
            setFindTextSelection({ pos: end, start, end })
            setHistoryNonce((value) => value + 1)
          }}
          onApply={(commands, label) => void apply(commands, label)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'options' && <PreferencesDialog onClose={() => setDialog(null)} />}
      {dialog === 'language' && <LanguageDialog onClose={() => setDialog(null)} />}
      {videoOffsetNotice && (
        <VideoOffsetNoticeDialog
          offsetMs={videoOffsetNotice.offsetMs}
          frameDurationMs={videoOffsetNotice.frameDurationMs}
          onClose={() => setVideoOffsetNotice(null)}
        />
      )}
      {timecodesOffsetAsk !== null && (
        <TimecodesOffsetDialog
          offsetMs={timecodesOffsetAsk}
          onChoice={(keep) => void doSaveTimecodes(keep)}
          onClose={() => setTimecodesOffsetAsk(null)}
        />
      )}
      {luaProgress && (
        <LuaProgressDialog
          title={luaProgress.title}
          task={luaProgress.task}
          value={luaProgress.value}
          log={luaProgress.log}
          finished={luaProgress.finished}
          cancelling={luaProgress.cancelling}
          onCancel={() => {
            luaCancelledRef.current = true
            setLuaProgress((current) => (current ? { ...current, cancelling: true } : current))
          }}
          onClose={() => luaProgressCloseRef.current?.()}
        />
      )}
      {luaDialog && (
        <LuaConfigDialog
          spec={luaDialog.spec}
          initialValues={luaDialog.initialValues}
          title={luaProgress?.title}
          onSubmit={(response) => {
            const pending = luaDialog
            setLuaDialog(null)
            pending.resolve(response)
          }}
        />
      )}
    </main>
  )
}
