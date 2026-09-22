import { getOptionInt } from '../config/options'
import { exportAudioClip } from '../core/audioClip'
/**
 * Aegisub 命令层（Web 版 "无 UI Context"）。
 *
 * 对应 Aegisub 的 command/*.cpp：每个命令是一个独立对象，接收一个 Context
 * （文档/选区/视频/音频状态机）并通过 CommandApi 执行副作用。
 * 菜单、工具栏、快捷键、网格右键菜单统一经此分发，命令可声明 enabled/checked。
 */
import type { CoreCommand, CoreState, SortColumn, SubtitleCue, SubtitleFormat } from '../core/types'
import { Framerate, utf8ByteLength } from '../core/vfr'
import type { DummyVideoOptions, MediaSource, SyntheticAudioKind } from '../platform/types'

export type DialogKind =
  | 'shift'
  | 'jump'
  | 'about'
  | 'video-details'
  | 'dummy-video'
  | 'properties'
  | 'styling-assistant'
  | 'attachments'
  | 'font-collector'
  | 'automation'
  | 'translation'
  | 'resample'
  | 'timing-postprocess'
  | 'kanji-timer'
  | 'spellcheck'
  | 'options'
  | 'select-lines'
  | 'export'
  | 'language'
  | null
export type AudioView = 'waveform' | 'spectrum'
export type GridTagsMode = 'show' | 'hide' | 'simplify'
export type DisplayMode = 'full' | 'subs' | 'video_subs' | 'audio_subs'
export interface AudioOptions {
  autoCommit: boolean
  autoNext: boolean
  autoScroll: boolean
  globalHotkeys: boolean
  karaoke: boolean
  verticalLink: boolean
}

export interface CommandContext {
  core: CoreState
  selected: string[]
  activeCue: SubtitleCue | null
  videoMedia: MediaSource | null
  audioMedia: MediaSource | null
  videoTimeMs: number
  videoDurationMs: number
  audioTimeMs: number
  audioDurationMs: number
  audioView: AudioView
  audioOptions: AudioOptions
  audioPlaying: boolean
  videoAutoScroll: boolean
  gridTags: GridTagsMode
  displayMode: DisplayMode
  toolbarVisible: boolean
  /** video/show_overscan toggle（Video/Overscan Mask） */
  videoOverscan: boolean
  /** video/aspect/*：null = Default，否则为强制宽高比 */
  aspectOverride: number | null
  /** 帧率状态机（timecodes 文件 > 视频 CFR；无视频为 empty） */
  frameRate: Framerate
  /** 当前视频帧号（FrameAtTime(EXACT)） */
  currentFrame: number
  /** 总帧数（timecodes 表长或时长×fps 估算） */
  frameCount: number
  /** 关键帧列表（空 = 无） */
  keyframes: number[]
  /** 关键帧来自外部文件（CanCloseKeyframes） */
  keyframesFromFile: boolean
  /** timecodes 来自外部文件（CanCloseTimecodes） */
  timecodesFromFile: boolean
  /** 网格/编辑框帧号显示模式（需 timecodes IsLoaded） */
  frameMode: boolean
}

export interface CommandApi {
  apply(commands: CoreCommand[], label: string): Promise<CoreState | null>
  undo(): Promise<void>
  redo(): Promise<void>
  openSubtitles(): Promise<void>
  newSubtitles(): Promise<void>
  saveSubtitles(format?: SubtitleFormat): Promise<void>
  openVideo(): Promise<void>
  closeVideo(): void
  openAudio(): Promise<void>
  openAudioFromVideo(): void
  closeAudio(): void
  openDummyVideo(options: DummyVideoOptions): void
  openSyntheticAudio(kind: SyntheticAudioKind): void
  setVideoTime(value: number): void
  setAudioTime(value: number): void
  setStatus(message: string): void
  sendVideoAction(type: string): void
  sendAudioAction(type: string): void
  moveSelection(direction: number): void
  moveSelectionOrCreate(): void
  selectLines(ids: string[]): void
  openFind(mode: 'find' | 'replace'): void
  findNext(): void
  replaceCurrent(): void
  replaceAll(): void
  openStyleManager(): void
  openDialog(dialog: DialogKind): void
  setToolbarVisible(value: boolean): void
  setAudioView(view: AudioView): void
  setAudioOption(option: keyof AudioOptions, value: boolean): void
  setVideoAutoScroll(value: boolean): void
  setGridTags(mode: GridTagsMode): void
  setDisplayMode(mode: DisplayMode): void
  setVideoOverscan(value: boolean): void
  setAspectOverride(value: number | null): void
  restoreAutosave(): void
  /** keyframe/open（timecode.cpp / keyframe.cpp 命令层负责文件选择与解析） */
  openKeyframes(): void
  saveKeyframes(): void
  closeKeyframes(): void
  openTimecodes(): void
  saveTimecodes(): void
  closeTimecodes(): void
  setFrameMode(value: boolean): void
  /** recent/<type>/<index>：重新打开最近文件（mru_wrapper） */
  openRecent(type: string, index: number): void
  /** app/log：显隐 Log window 浮窗（dialog_log 的 Web 版；底部单行消息与它无关） */
  toggleLog(): void
  /** 二进制文件保存（audio/save/clip 等） */
  saveBinary(name: string, data: Uint8Array, description: string, extension: string): void
}

export interface CommandDef {
  run(ctx: CommandContext, api: CommandApi): void | Promise<void>
  enabled?(ctx: CommandContext): boolean
  checked?(ctx: CommandContext): boolean
}

// ---------------------------------------------------------------------------
// 剪贴板（Web 版无系统 ASS 剪贴板，用模块级内存模拟）
// ---------------------------------------------------------------------------
let clipboardLines: SubtitleCue[] = []

/**
 * 编辑框光标状态（对应 text_selection_controller：命令取 selectionStart 拆行）。
 * EditPanel 在选区/输入变化时写入。
 */
export const editCursorState: { selectionStart: number; selectionEnd: number } = {
  selectionStart: 0,
  selectionEnd: 0,
}

function cueData(cue: SubtitleCue): Omit<SubtitleCue, 'id'> {
  const clone = structuredClone(cue) as Omit<SubtitleCue, 'id'> & { id?: string }
  delete clone.id
  return clone
}

function compareBy(column: SortColumn): (a: SubtitleCue, b: SubtitleCue) => number {
  switch (column) {
    case 'start':
      return (a, b) => a.startMs - b.startMs || a.endMs - b.endMs
    case 'end':
      return (a, b) => a.endMs - b.endMs || a.startMs - b.startMs
    case 'style':
      return (a, b) => a.style.localeCompare(b.style) || a.startMs - b.startMs
    case 'actor':
      return (a, b) => a.actor.localeCompare(b.actor) || a.startMs - b.startMs
    case 'effect':
      return (a, b) => a.effect.localeCompare(b.effect) || a.startMs - b.startMs
    case 'layer':
      return (a, b) => a.layer - b.layer || a.startMs - b.startMs
  }
}

function requireSelection(ctx: CommandContext): boolean {
  return ctx.selected.length > 0
}

// ---------------------------------------------------------------------------
// 命令注册表
// ---------------------------------------------------------------------------
export const COMMAND_REGISTRY: Record<string, CommandDef> = {
  // ---- 字幕文件 ----
  'subtitle/new': { run: (_, api) => void api.newSubtitles() },
  'subtitle/open': { run: (_, api) => void api.openSubtitles() },
  'subtitle/save': { run: (_, api) => void api.saveSubtitles() },
  'subtitle/save/as': { run: (_, api) => void api.saveSubtitles() },
  'tool/export': { run: (_, api) => api.openDialog('export') },
  'subtitle/properties': {
    run: (_, api) => api.openDialog('properties'),
  },
  'subtitle/open/charset': {
    // Aegisub 以指定编码打开；Web 版文本一律按 UTF-8 解码
    run: (_, api) => api.setStatus('Web build decodes subtitles as UTF-8'),
  },
  'subtitle/open/autosave': {
    run: (_, api) => api.restoreAutosave(),
  },
  'subtitle/open/video': {
    // CanLoadSubtitlesFromVideo = false：Web 版无法从视频容器提取字幕
    enabled: () => false,
    run: () => undefined,
  },

  // ---- 撤销/重做/剪贴板 ----
  'edit/undo': {
    run: (_, api) => void api.undo(),
    enabled: (ctx) => Boolean(ctx.core.canUndo),
  },
  'edit/redo': {
    run: (_, api) => void api.redo(),
    enabled: (ctx) => Boolean(ctx.core.canRedo),
  },
  'edit/line/copy': {
    run: (ctx, api) => {
      const lines = ctx.core.document.cues.filter((cue) => ctx.selected.includes(cue.id))
      clipboardLines = lines.map((cue) => structuredClone(cue))
      void navigator.clipboard
        ?.writeText(lines.map((cue) => cue.text).join('\n'))
        .catch(() => undefined)
      api.setStatus(`Copied ${lines.length} line${lines.length === 1 ? '' : 's'}`)
    },
    enabled: requireSelection,
  },
  'edit/line/cut': {
    run: (ctx, api) => {
      const lines = ctx.core.document.cues.filter((cue) => ctx.selected.includes(cue.id))
      clipboardLines = lines.map((cue) => structuredClone(cue))
      void navigator.clipboard
        ?.writeText(lines.map((cue) => cue.text).join('\n'))
        .catch(() => undefined)
      void api.apply([{ type: 'deleteCues', ids: ctx.selected }], 'cut lines')
    },
    enabled: requireSelection,
  },
  'edit/line/paste': {
    run: (ctx, api) => {
      if (!clipboardLines.length) return
      const before = new Set(ctx.core.document.cues.map((cue) => cue.id))
      const commands = [...clipboardLines].reverse().map((cue): CoreCommand => ({
        type: 'addCue',
        afterId: ctx.activeCue?.id,
        cue: cueData(cue),
      }))
      void api.apply(commands, 'paste').then((next) => {
        if (!next) return
        const inserted = next.document.cues.filter((cue) => !before.has(cue.id))
        if (inserted.length) api.selectLines(inserted.map((cue) => cue.id))
      })
    },
    enabled: () => clipboardLines.length > 0,
  },
  'edit/line/paste/over': {
    run: (ctx, api) => {
      if (!clipboardLines.length || !ctx.activeCue) return
      const lines = clipboardLines.map((cue) => structuredClone(cue))
      const first = lines[0]
      void api.apply([{ type: 'updateCue', id: ctx.activeCue.id, patch: cueData(first) }], 'paste')
    },
    enabled: (ctx) => clipboardLines.length > 0 && Boolean(ctx.activeCue),
  },

  // ---- 查找 ----
  'subtitle/find': { run: (_, api) => api.openFind('find') },
  'subtitle/find/next': { run: (_, api) => api.findNext() },
  'edit/find_replace': { run: (_, api) => api.openFind('replace') },

  // ---- 样式 ----
  'tool/style/manager': { run: (_, api) => api.openStyleManager() },
  'edit/color/primary': { run: (_, api) => api.openStyleManager() },
  'edit/color/secondary': { run: (_, api) => api.openStyleManager() },
  'edit/color/outline': { run: (_, api) => api.openStyleManager() },
  'edit/color/shadow': { run: (_, api) => api.openStyleManager() },

  // ---- 行插入/编辑 ----
  'subtitle/insert/before': {
    run: (ctx, api) => void insertLine(ctx, api, true, false),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'subtitle/insert/after': {
    run: (ctx, api) => void insertLine(ctx, api, false, false),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'subtitle/insert/before/videotime': {
    run: (ctx, api) => void insertLine(ctx, api, true, true),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'subtitle/insert/after/videotime': {
    run: (ctx, api) => void insertLine(ctx, api, false, true),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'edit/line/duplicate': {
    run: (ctx, api) =>
      void api.apply([{ type: 'duplicateCues', ids: ctx.selected }], 'duplicate lines'),
    enabled: requireSelection,
  },
  'edit/line/split/before': {
    run: (ctx, api) => void splitLine(ctx, api, true),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'edit/line/split/after': {
    run: (ctx, api) => void splitLine(ctx, api, false),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  // edit.cpp split_lines：光标处拆行（活动行保留为左半，右半紧随其后；接缝仅裁空白）
  'edit/line/split/preserve': {
    run: (ctx, api) => void splitLinesAtCursor(ctx, api, 'preserve'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'edit/line/split/estimate': {
    run: (ctx, api) => void splitLinesAtCursor(ctx, api, 'estimate'),
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.activeCue),
  },
  'edit/line/split/video': {
    run: (ctx, api) => void splitLinesAtCursor(ctx, api, 'video'),
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.activeCue),
  },
  'edit/line/delete': {
    run: (ctx, api) => void api.apply([{ type: 'deleteCues', ids: ctx.selected }], 'delete lines'),
    enabled: requireSelection,
  },
  'edit/line/join/concatenate': {
    run: (ctx, api) => void joinLines(ctx, api, 'concatenate'),
    enabled: (ctx) => ctx.selected.length > 1,
  },
  'edit/line/join/keep_first': {
    run: (ctx, api) => void joinLines(ctx, api, 'keep_first'),
    enabled: (ctx) => ctx.selected.length > 1,
  },
  'edit/line/join/as_karaoke': {
    run: (ctx, api) => void joinLines(ctx, api, 'as_karaoke'),
    enabled: (ctx) => ctx.selected.length > 1,
  },
  'edit/line/recombine': {
    run: (ctx, api) => void recombineLines(ctx, api),
    enabled: (ctx) => ctx.selected.length > 1,
  },
  'edit/line/split/by_karaoke': {
    run: (ctx, api) => void splitByKaraoke(ctx, api),
    enabled: requireSelection,
  },

  // ---- 网格 ----
  'grid/swap': {
    run: (ctx, api) => {
      const doc = ctx.core.document
      const index = doc.cues.findIndex((cue) => cue.id === ctx.activeCue?.id)
      if (index < 0 || index >= doc.cues.length - 1) return
      const a = doc.cues[index]
      const b = doc.cues[index + 1]
      void api.apply(
        [
          { type: 'updateCue', id: a.id, patch: cueData(b) },
          { type: 'updateCue', id: b.id, patch: cueData(a) },
        ],
        'Swap lines',
      )
    },
    enabled: (ctx) => {
      const index = ctx.core.document.cues.findIndex((cue) => cue.id === ctx.activeCue?.id)
      return ctx.activeCue !== null && index >= 0 && index < ctx.core.document.cues.length - 1
    },
  },
  'grid/move/up': {
    run: (ctx, api) =>
      void api.apply([{ type: 'moveCues', ids: ctx.selected, direction: -1 }], 'move lines'),
    enabled: requireSelection,
  },
  'grid/move/down': {
    run: (ctx, api) =>
      void api.apply([{ type: 'moveCues', ids: ctx.selected, direction: 1 }], 'move lines'),
    enabled: requireSelection,
  },
  'grid/sort/start': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'start' }], 'sort'),
  },
  'grid/sort/end': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'end' }], 'sort'),
  },
  'grid/sort/style': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'style' }], 'sort'),
  },
  'grid/sort/actor': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'actor' }], 'sort'),
  },
  'grid/sort/effect': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'effect' }], 'sort'),
  },
  'grid/sort/layer': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'layer' }], 'sort'),
  },
  ...sortSelectedCommands(),
  ...recentCommands(),

  'grid/tags/show': {
    run: (_, api) => api.setGridTags('show'),
    checked: (ctx) => ctx.gridTags === 'show',
  },
  'grid/tags/hide': {
    run: (_, api) => api.setGridTags('hide'),
    checked: (ctx) => ctx.gridTags === 'hide',
  },
  'grid/tags/simplify': {
    run: (_, api) => api.setGridTags('simplify'),
    checked: (ctx) => ctx.gridTags === 'simplify',
  },
  'grid/tag/cycle_hiding': {
    // Aegisub grid.cpp：mode 0 显示 → 1 简化(☀) → 2 隐藏 → 循环，并提示当前模式
    run: (ctx, api) => {
      const next: GridTagsMode =
        ctx.gridTags === 'show' ? 'simplify' : ctx.gridTags === 'simplify' ? 'hide' : 'show'
      api.setGridTags(next)
      api.setStatus(
        next === 'show'
          ? 'ASS Override Tag mode set to show full tags.'
          : next === 'simplify'
            ? 'ASS Override Tag mode set to simplify tags.'
            : 'ASS Override Tag mode set to hide tags.',
      )
    },
  },
  'subtitle/select/all': {
    run: (ctx, api) => api.selectLines(ctx.core.document.cues.map((cue) => cue.id)),
  },
  'grid/line/next': {
    run: (_, api) => api.moveSelection(1),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'grid/line/next/create': {
    run: (_, api) => api.moveSelectionOrCreate(),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'grid/line/prev': {
    run: (_, api) => api.moveSelection(-1),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },

  // ---- 时间 ----
  'time/shift': { run: (_, api) => api.openDialog('shift') },
  'time/snap/start_video': {
    // time.cpp snap_subs_video(true)：Start 必设；End 仅在原值更短时延长
    run: (ctx, api) => {
      const start = ctx.frameRate.timeAtFrame(ctx.currentFrame, 'start')
      const end = ctx.frameRate.timeAtFrame(ctx.currentFrame, 'end')
      const commands = ctx.core.document.cues
        .filter((cue) => ctx.selected.includes(cue.id))
        .map((cue): CoreCommand => ({
          type: 'updateCue',
          id: cue.id,
          patch: { startMs: start, ...(cue.endMs < end ? { endMs: end } : {}) },
        }))
      if (commands.length) void api.apply(commands, 'timing')
    },
    // time.cpp validate_video_loaded：仅要求视频已加载，无选中行时 no-op
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'time/snap/end_video': {
    // snap_subs_video(false)：End 必设；Start 仅在原值更晚时提前
    run: (ctx, api) => {
      const start = ctx.frameRate.timeAtFrame(ctx.currentFrame, 'start')
      const end = ctx.frameRate.timeAtFrame(ctx.currentFrame, 'end')
      const commands = ctx.core.document.cues
        .filter((cue) => ctx.selected.includes(cue.id))
        .map((cue): CoreCommand => ({
          type: 'updateCue',
          id: cue.id,
          patch: { endMs: end, ...(cue.startMs > start ? { startMs: start } : {}) },
        }))
      if (commands.length) void api.apply(commands, 'timing')
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'time/frame/current': {
    // 整体平移选中集，使活动行 Start 对齐 TimeAtFrame(cur, START)
    run: (ctx, api) => {
      if (!ctx.activeCue) return
      const shift = ctx.frameRate.timeAtFrame(ctx.currentFrame, 'start') - ctx.activeCue.startMs
      const commands = ctx.core.document.cues
        .filter((cue) => ctx.selected.includes(cue.id))
        .map((cue): CoreCommand => ({
          type: 'updateCue',
          id: cue.id,
          patch: { startMs: cue.startMs + shift, endMs: cue.endMs + shift },
        }))
      if (commands.length) void api.apply(commands, 'shift to frame')
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'time/continuous/start': {
    run: (ctx, api) => void makeContinuous(ctx, api, true),
    enabled: adjoinable,
  },
  'time/continuous/end': {
    run: (ctx, api) => void makeContinuous(ctx, api, false),
    enabled: adjoinable,
  },
  // time.cpp：time/prev、time/lead/* 无 Validate（无活动行时 no-op），按钮保持可用
  'time/prev': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.moveSelection(-1)
    },
  },
  'time/next': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.moveSelection(1)
    },
  },
  'time/lead/in': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [
            {
              type: 'updateCue',
              id: ctx.activeCue.id,
              patch: {
                startMs: Math.max(0, ctx.activeCue.startMs - getOptionInt('Audio/Lead/IN')),
              },
            },
          ],
          'timing',
        )
    },
  },
  'time/lead/out': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [
            {
              type: 'updateCue',
              id: ctx.activeCue.id,
              patch: { endMs: ctx.activeCue.endMs + getOptionInt('Audio/Lead/OUT') },
            },
          ],
          'timing',
        )
    },
  },
  'time/start/decrease': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [
            {
              type: 'updateCue',
              id: ctx.activeCue.id,
              patch: { startMs: Math.max(0, ctx.activeCue.startMs - 100) },
            },
          ],
          'timing',
        )
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'time/start/increase': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [
            {
              type: 'updateCue',
              id: ctx.activeCue.id,
              patch: { startMs: Math.min(ctx.activeCue.endMs, ctx.activeCue.startMs + 100) },
            },
          ],
          'timing',
        )
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'time/length/increase': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [
            {
              type: 'updateCue',
              id: ctx.activeCue.id,
              patch: { endMs: ctx.activeCue.endMs + 100 },
            },
          ],
          'timing',
        )
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'time/length/decrease': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [
            {
              type: 'updateCue',
              id: ctx.activeCue.id,
              patch: { endMs: Math.max(ctx.activeCue.startMs, ctx.activeCue.endMs - 100) },
            },
          ],
          'timing',
        )
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
  },

  // ---- 视频 ----
  'video/open': { run: (_, api) => void api.openVideo() },
  'video/open/dummy': { run: (_, api) => api.openDialog('dummy-video') },
  'video/close': {
    run: (_, api) => api.closeVideo(),
  },
  'video/details': {
    run: (_, api) => api.openDialog('video-details'),
  },
  'video/jump': {
    // video.cpp：先停止播放再弹出跳转框
    run: (_, api) => {
      api.sendVideoAction('stop')
      api.openDialog('jump')
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/jump/start': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        // video.cpp：JumpToFrame(FrameAtTime(Start, START))，落帧 EXACT 时间
        api.setVideoTime(
          ctx.frameRate.timeAtFrame(
            ctx.frameRate.frameAtTime(ctx.activeCue.startMs, 'start'),
            'exact',
          ),
        )
    },
    // video.cpp validator_video_loaded：仅要求视频已加载，无活动行时 no-op
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/jump/end': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        // video.cpp：JumpToFrame(FrameAtTime(End, END))
        api.setVideoTime(
          ctx.frameRate.timeAtFrame(ctx.frameRate.frameAtTime(ctx.activeCue.endMs, 'end'), 'exact'),
        )
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/play': {
    run: (_, api) => api.sendVideoAction('toggle'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/play/line': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setVideoTime(ctx.activeCue.startMs)
        api.sendVideoAction('play')
      }
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/stop': {
    run: (_, api) => api.sendVideoAction('stop'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/frame/prev': {
    run: (_, api) => api.sendVideoAction('frame-prev'),
  },
  'video/frame/next': {
    run: (_, api) => api.sendVideoAction('frame-next'),
  },
  'video/frame/prev/large': {
    // Video/Slider/Fast Jump Step（Preferences → Video → Options）
    run: (ctx, api) =>
      api.setVideoTime(
        ctx.frameRate.timeAtFrame(
          Math.max(0, ctx.currentFrame - getOptionInt('Video/Slider/Fast Jump Step')),
          'exact',
        ),
      ),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/frame/next/large': {
    run: (ctx, api) =>
      api.setVideoTime(
        ctx.frameRate.timeAtFrame(
          Math.min(
            ctx.frameCount - 1,
            ctx.currentFrame + getOptionInt('Video/Slider/Fast Jump Step'),
          ),
          'exact',
        ),
      ),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  // video.cpp video_frame_prev|next_boundary：活动行起止边界定帧跳转
  'video/frame/prev/boundary': {
    run: (ctx, api) => {
      // video.cpp video_frame_prev_boundary：仅活动行边界，FrameAtTime 定帧比较
      const line = ctx.activeCue
      if (!line) return
      const jumpToFrame = (frame: number) =>
        api.setVideoTime(ctx.frameRate.timeAtFrame(frame, 'exact'))
      const endFrame = ctx.frameRate.frameAtTime(line.endMs, 'end')
      if (endFrame < ctx.currentFrame) return jumpToFrame(endFrame)
      const startFrame = ctx.frameRate.frameAtTime(line.startMs, 'start')
      if (startFrame < ctx.currentFrame) return jumpToFrame(startFrame)
      // 两边界都不在当前帧之前 → PrevLine 并无条件跳其行尾（JumpToTime(End, END)）
      const index = ctx.core.document.cues.findIndex((cue) => cue.id === line.id)
      const prev = ctx.core.document.cues[index - 1]
      if (!prev) return
      api.selectLines([prev.id])
      jumpToFrame(ctx.frameRate.frameAtTime(prev.endMs, 'end'))
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/frame/next/boundary': {
    run: (ctx, api) => {
      // video.cpp video_frame_next_boundary：仅活动行边界，FrameAtTime 定帧比较
      const line = ctx.activeCue
      if (!line) return
      const jumpToFrame = (frame: number) =>
        api.setVideoTime(ctx.frameRate.timeAtFrame(frame, 'exact'))
      const startFrame = ctx.frameRate.frameAtTime(line.startMs, 'start')
      if (startFrame > ctx.currentFrame) return jumpToFrame(startFrame)
      const endFrame = ctx.frameRate.frameAtTime(line.endMs, 'end')
      if (endFrame > ctx.currentFrame) return jumpToFrame(endFrame)
      // 两边界都不在当前帧之后 → NextLine 并无条件跳其行首（JumpToTime(Start)）
      const index = ctx.core.document.cues.findIndex((cue) => cue.id === line.id)
      const next = ctx.core.document.cues[index + 1]
      if (!next) return
      api.selectLines([next.id])
      jumpToFrame(ctx.frameRate.frameAtTime(next.startMs, 'start'))
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  // video.cpp：lower_bound 语义的关键帧跳转
  'video/frame/next/keyframe': {
    run: (ctx, api) => {
      const { keyframes } = ctx
      if (!keyframes.length) {
        api.setVideoTime(ctx.frameRate.timeAtFrame(ctx.frameCount - 1, 'exact'))
        return
      }
      const index = keyframes.findIndex((frame) => frame > ctx.currentFrame)
      api.setVideoTime(
        index < 0
          ? ctx.frameRate.timeAtFrame(ctx.frameCount - 1, 'exact')
          : ctx.frameRate.timeAtFrame(keyframes[index], 'exact'),
      )
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/frame/prev/keyframe': {
    run: (ctx, api) => {
      const { keyframes } = ctx
      if (!keyframes.length) {
        api.setVideoTime(0)
        return
      }
      const index = keyframes.findIndex((frame) => frame >= ctx.currentFrame)
      // 当前帧在首个关键帧或之前 → 原地；否则跳到前一个关键帧；全部小于当前 → 最后一个
      if (index > 0) api.setVideoTime(ctx.frameRate.timeAtFrame(keyframes[index - 1], 'exact'))
      else if (index === -1)
        api.setVideoTime(ctx.frameRate.timeAtFrame(keyframes[keyframes.length - 1], 'exact'))
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/focus_seek': {
    run: () => document.querySelector<HTMLCanvasElement>('.video-slider')?.focus(),
  },
  'video/zoom/in': {
    run: (_, api) => api.sendVideoAction('zoom-in'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/zoom/out': {
    run: (_, api) => api.sendVideoAction('zoom-out'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/zoom/50': {
    run: (_, api) => api.sendVideoAction('zoom-50'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/zoom/100': {
    run: (_, api) => api.sendVideoAction('zoom-100'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/zoom/200': {
    run: (_, api) => api.sendVideoAction('zoom-200'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/detach': {
    // Web 版不支持分离视频窗口
    run: (_, api) => api.setStatus('Detached video is not available in the web build'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/show_overscan': {
    // video_display.cpp DrawOverscanMask：BBC 标准的两组遮罩矩形
    run: (ctx, api) => api.setVideoOverscan(!ctx.videoOverscan),
    checked: (ctx) => ctx.videoOverscan,
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/aspect/default': {
    run: (_, api) => api.setAspectOverride(null),
    checked: (ctx) => ctx.aspectOverride === null,
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/aspect/full': {
    run: (_, api) => api.setAspectOverride(4 / 3),
    checked: (ctx) => ctx.aspectOverride === 4 / 3,
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/aspect/wide': {
    run: (_, api) => api.setAspectOverride(16 / 9),
    checked: (ctx) => ctx.aspectOverride === 16 / 9,
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/aspect/cinematic': {
    run: (_, api) => api.setAspectOverride(2.35),
    checked: (ctx) => ctx.aspectOverride === 2.35,
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/aspect/custom': {
    run: (_, api) => api.setStatus('Custom aspect ratio is not available in the web build'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/reset_pan': {
    // 复位平移与内容缩放（video_display.cpp ResetContentZoom）
    run: (_, api) => api.sendVideoAction('reset-pan'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/tool/cross': { run: (_, api) => api.sendVideoAction('video/tool/cross') },
  'video/tool/drag': { run: (_, api) => api.sendVideoAction('video/tool/drag') },
  'video/tool/rotate/z': { run: (_, api) => api.sendVideoAction('video/tool/rotate/z') },
  'video/tool/rotate/xy': { run: (_, api) => api.sendVideoAction('video/tool/rotate/xy') },
  'video/tool/perspective': { run: (_, api) => api.sendVideoAction('video/tool/perspective') },
  'video/tool/scale': { run: (_, api) => api.sendVideoAction('video/tool/scale') },
  'video/tool/clip': { run: (_, api) => api.sendVideoAction('video/tool/clip') },
  'video/tool/vector_clip': { run: (_, api) => api.sendVideoAction('video/tool/vector_clip') },

  // ---- 音频 ----
  'audio/open': { run: (_, api) => void api.openAudio() },
  // Aegisub audio.cpp：dummy-audio:silence / noise（150 分钟）
  'audio/open/blank': { run: (_, api) => api.openSyntheticAudio('blank') },
  'audio/open/noise': { run: (_, api) => api.openSyntheticAudio('noise') },
  'audio/open/video': {
    run: (_, api) => api.openAudioFromVideo(),
  },
  'audio/close': {
    run: (_, api) => api.closeAudio(),
  },
  'audio/view/waveform': {
    run: (_, api) => api.setAudioView('waveform'),
    checked: (ctx) => ctx.audioView === 'waveform',
  },
  'audio/view/spectrum': {
    run: (_, api) => api.setAudioView('spectrum'),
    checked: (ctx) => ctx.audioView === 'spectrum',
  },
  // audio.cpp audio/commit：无 Validate；无活动行时 no-op
  'audio/commit': {
    run: (ctx, api) => {
      if (!ctx.activeCue) return
      api.setStatus('Line committed')
      if (ctx.audioOptions.autoNext) api.moveSelection(1)
    },
  },
  'audio/commit/default': {
    run: (_, api) => api.setStatus('Line committed'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'audio/commit/stay': {
    run: (_, api) => api.setStatus('Line committed'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'audio/save/clip': {
    // audio.cpp：把选中行的时间段导出为 wav
    run: (ctx, api) => {
      const cues = ctx.core.document.cues.filter((cue) => ctx.selected.includes(cue.id))
      if (!cues.length) return
      const startMs = Math.min(...cues.map((cue) => cue.startMs))
      const endMs = Math.max(...cues.map((cue) => cue.endMs))
      void exportAudioClip(ctx.audioMedia?.file, startMs, endMs)
        .then((data) => {
          if (!data) {
            api.setStatus('Audio could not be decoded')
            return
          }
          api.saveBinary(
            `audio-clip-${Math.round(startMs)}-${Math.round(endMs)}ms.wav`,
            data,
            'Audio clip',
            '.wav',
          )
          api.setStatus('Audio clip saved')
        })
        .catch(() => api.setStatus('Audio clip export failed'))
    },
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.selected.length),
  },
  // audio.cpp：播放类仅 validate_audio_open（音频已打开即启用），无活动行时 no-op
  'audio/play/selection': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.startMs)
        api.sendAudioAction('play-selection')
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'audio/play/line': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.startMs)
        api.sendAudioAction('play-line')
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'audio/play/selection/before': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(Math.max(0, ctx.activeCue.startMs - 500))
        api.sendAudioAction('play-before')
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'audio/play/selection/after': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.endMs)
        api.sendAudioAction('play-after')
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'audio/play/selection/begin': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.startMs)
        api.sendAudioAction('play-begin')
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'audio/play/selection/end': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(Math.max(ctx.activeCue.startMs, ctx.activeCue.endMs - 500))
        api.sendAudioAction('play-end')
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'audio/play/to_end': {
    run: (_, api) => api.sendAudioAction('play-to-end'),
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'audio/play/toggle': {
    run: (_, api) => api.sendAudioAction('toggle'),
  },
  'audio/scroll/left': {
    run: (ctx, api) => api.setAudioTime(Math.max(0, ctx.audioTimeMs - 1000)),
  },
  'audio/scroll/right': {
    run: (ctx, api) =>
      api.setAudioTime(
        Math.min(ctx.audioDurationMs || ctx.audioTimeMs + 1000, ctx.audioTimeMs + 1000),
      ),
  },
  'audio/stop': {
    run: (_, api) => api.sendAudioAction('stop'),
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.audioPlaying),
  },
  'audio/go_to': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.setAudioTime(ctx.activeCue.startMs)
    },
  },
  'audio/opt/spectrum': {
    run: (ctx, api) => api.setAudioView(ctx.audioView === 'spectrum' ? 'waveform' : 'spectrum'),
    checked: (ctx) => ctx.audioView === 'spectrum',
  },
  'audio/opt/vertical_link': {
    run: (ctx, api) => api.setAudioOption('verticalLink', !ctx.audioOptions.verticalLink),
    checked: (ctx) => ctx.audioOptions.verticalLink,
  },
  'audio/opt/autocommit': {
    run: (ctx, api) => api.setAudioOption('autoCommit', !ctx.audioOptions.autoCommit),
    checked: (ctx) => ctx.audioOptions.autoCommit,
  },
  'audio/opt/autonext': {
    run: (ctx, api) => api.setAudioOption('autoNext', !ctx.audioOptions.autoNext),
    checked: (ctx) => ctx.audioOptions.autoNext,
  },
  'audio/opt/autoscroll': {
    run: (ctx, api) => api.setAudioOption('autoScroll', !ctx.audioOptions.autoScroll),
    checked: (ctx) => ctx.audioOptions.autoScroll,
  },
  'app/toggle/global_hotkeys': {
    run: (ctx, api) => api.setAudioOption('globalHotkeys', !ctx.audioOptions.globalHotkeys),
    checked: (ctx) => ctx.audioOptions.globalHotkeys,
  },
  'audio/karaoke': {
    run: (ctx, api) => api.setAudioOption('karaoke', !ctx.audioOptions.karaoke),
    checked: (ctx) => ctx.audioOptions.karaoke,
  },
  'video/opt/autoscroll': {
    run: (ctx, api) => api.setVideoAutoScroll(!ctx.videoAutoScroll),
    checked: (ctx) => ctx.videoAutoScroll,
  },

  // ---- 视图（app.cpp：COMMAND_VALIDATE 要求对应的 provider 已打开）----
  'app/display/subs': {
    run: (_, api) => api.setDisplayMode('subs'),
    checked: (ctx) => ctx.displayMode === 'subs',
  },
  'app/display/video_subs': {
    run: (_, api) => api.setDisplayMode('video_subs'),
    checked: (ctx) => ctx.displayMode === 'video_subs',
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'app/display/audio_subs': {
    run: (_, api) => api.setDisplayMode('audio_subs'),
    checked: (ctx) => ctx.displayMode === 'audio_subs',
    enabled: (ctx) => Boolean(ctx.audioMedia),
  },
  'app/display/full': {
    run: (_, api) => api.setDisplayMode('full'),
    checked: (ctx) => ctx.displayMode === 'full',
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.audioMedia),
  },
  'app/toggle/toolbar': {
    run: (ctx, api) => api.setToolbarVisible(!ctx.toolbarVisible),
    checked: (ctx) => ctx.toolbarVisible,
  },
  'app/about': { run: (_, api) => api.openDialog('about') },
  'app/new_window': {
    run: () => {
      window.open(window.location.href, '_blank', 'noopener')
    },
  },
  'app/exit': {
    run: (_, api) => {
      // window.close 仅对脚本打开的窗口生效，与桌面退出语义一致地尽力而为
      window.close()
      api.setStatus('Close the browser tab to exit')
    },
  },

  // ---- 工具/附加功能（Web 版提供状态提示，保持按钮可用与 Aegisub 一致）----
  'subtitle/select/visible': {
    // subtitle.cpp：按帧号比较（FrameAtTime START/END），注释行同样参与选择
    run: (ctx, api) => {
      const visible = ctx.core.document.cues
        .filter(
          (cue) =>
            ctx.frameRate.frameAtTime(cue.startMs, 'start') <= ctx.currentFrame &&
            ctx.frameRate.frameAtTime(cue.endMs, 'end') >= ctx.currentFrame,
        )
        .map((cue) => cue.id)
      api.selectLines(visible)
      api.setStatus(
        visible.length
          ? `Selected ${visible.length} visible line${visible.length === 1 ? '' : 's'}`
          : 'No visible lines at current time',
      )
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'subtitle/attachment': {
    run: (_, api) => api.openDialog('attachments'),
  },
  'tool/font_collector': {
    run: (_, api) => api.openDialog('font-collector'),
  },
  'am/meta': {
    run: (_, api) => api.openDialog('automation'),
  },
  'tool/style/assistant': {
    // 源码无 Validate：按钮恒可用（无活动行时 Web 对话框不渲染）
    run: (_, api) => api.openDialog('styling-assistant'),
  },
  'tool/translation_assistant': {
    // 源码无 Validate；NothingToTranslate 时提示（Web 版无活动行时同样提示）
    run: (ctx, api) => {
      if (!ctx.activeCue) {
        api.setStatus('There is nothing to translate in the file.')
        return
      }
      api.openDialog('translation')
    },
  },
  'tool/resampleres': {
    run: (_, api) => api.openDialog('resample'),
  },
  'tool/line/select': {
    run: (_, api) => api.openDialog('select-lines'),
  },
  'tool/time/postprocess': {
    run: (_, api) => api.openDialog('timing-postprocess'),
  },
  'tool/time/kanji': {
    run: (_, api) => api.openDialog('kanji-timer'),
  },
  'subtitle/spellcheck': {
    run: (_, api) => api.openDialog('spellcheck'),
  },
  'app/options': {
    run: (_, api) => api.openDialog('options'),
  },
  'app/language': {
    // 源码 app.cpp：wxLocale::PickLanguage() 选择语言后写 OPT_SET("App/Language")
    run: (_, api) => api.openDialog('language'),
  },
  'app/updates': {
    run: (_, api) => api.setStatus('The web build updates automatically'),
  },
  'app/log': {
    run: (_, api) => api.toggleLog(),
  },
  'time/snap/scene': {
    // time.cpp：把选中行的 Start/End 设为当前帧两侧关键帧区间的边界
    run: (ctx, api) => {
      const { keyframes, frameRate } = ctx
      if (!keyframes.length) return
      const current = ctx.currentFrame
      let previous: number
      let next: number
      if (current < keyframes[0]) {
        previous = 0
        next = keyframes[0]
      } else if (current >= keyframes[keyframes.length - 1]) {
        previous = keyframes[keyframes.length - 1]
        next = ctx.frameCount // 视频末尾视为虚拟关键帧
      } else {
        const index = keyframes.findIndex((frame) => frame >= current)
        if (keyframes[index] === current) {
          previous = current
          next = keyframes[index + 1] ?? ctx.frameCount
        } else {
          previous = keyframes[index - 1]
          next = keyframes[index]
        }
      }
      const startMs = frameRate.timeAtFrame(previous, 'start')
      const endMs = frameRate.timeAtFrame(next - 1, 'end')
      const commands = ctx.core.document.cues
        .filter((cue) => ctx.selected.includes(cue.id))
        .map((cue): CoreCommand => ({ type: 'updateCue', id: cue.id, patch: { startMs, endMs } }))
      if (commands.length) void api.apply(commands, 'snap to scene')
    },
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },

  // ---- timecodes / keyframes（timecode.cpp / keyframe.cpp）----
  'timecode/open': { run: (_, api) => api.openTimecodes() },
  'timecode/save': {
    run: (_, api) => api.saveTimecodes(),
    enabled: (ctx) => ctx.frameRate.isLoaded(),
  },
  'timecode/close': {
    run: (_, api) => api.closeTimecodes(),
    enabled: (ctx) => ctx.timecodesFromFile,
  },
  'keyframe/open': { run: (_, api) => api.openKeyframes() },
  'keyframe/save': {
    run: (_, api) => api.saveKeyframes(),
    enabled: (ctx) => ctx.keyframes.length > 0,
  },
  'keyframe/close': {
    run: (_, api) => api.closeKeyframes(),
    enabled: (ctx) => ctx.keyframesFromFile,
  },

  // ---- 帮助 ----
  'help/contents': { run: (_, api) => api.setStatus('Aegisub-compatible shortcuts are active') },
  'help/website': {
    run: () => {
      window.open('https://aegisub.org/', '_blank', 'noopener')
    },
  },
  'help/bugs': {
    run: () => {
      window.open('https://github.com/TypesettingTools/Aegisub/issues', '_blank', 'noopener')
    },
  },
  'help/irc': {
    // Web 无法打开 irc:// 协议
    run: (_, api) => api.setStatus('irc://irc.rizon.net/aegisub'),
  },
  'help/video': {
    run: () => {
      window.open('https://aegisub.org/docs/latest/visual-typesetting/', '_blank', 'noopener')
    },
  },
}

// ---------------------------------------------------------------------------
// 组合命令实现
// ---------------------------------------------------------------------------

function sortSelectedCommands(): Record<string, CommandDef> {
  const defs: Record<string, CommandDef> = {}
  for (const column of ['start', 'end', 'style', 'actor', 'effect', 'layer'] as const) {
    defs[`grid/sort/${column}/selected`] = {
      run: (ctx, api) => {
        const { core, selected } = ctx
        const selSet = new Set(selected)
        const ordered = core.document.cues.filter((cue) => selSet.has(cue.id))
        if (ordered.length < 2) return
        const sorted = [...ordered].sort(compareBy(column))
        void reinsertSorted(ctx, api, sorted, 'sort')
      },
      enabled: (ctx) => ctx.selected.length > 1,
    }
  }
  return defs
}

/**
 * recent.cpp mru_wrapper：recent/{audio,keyframes,subtitle,timecodes,video}/0..15。
 * 索引由 App 端最近文件列表解析；越界时提示（与源码越界 no-op 语义一致）。
 */
function recentCommands(): Record<string, CommandDef> {
  const defs: Record<string, CommandDef> = {}
  for (const type of ['subtitle', 'video', 'audio', 'timecodes', 'keyframes']) {
    for (let index = 0; index < 16; index++) {
      defs[`recent/${type}/${index}`] = {
        run: (_, api) => api.openRecent(type, index),
      }
    }
  }
  return defs
}

async function reinsertSorted(
  ctx: CommandContext,
  api: CommandApi,
  sorted: SubtitleCue[],
  label: string,
): Promise<void> {
  const { core, selected } = ctx
  const doc = core.document
  const selSet = new Set(selected)
  const before = new Set(doc.cues.map((cue) => cue.id))
  const firstSelectedIndex = doc.cues.findIndex((cue) => selSet.has(cue.id))
  const anchorId = doc.cues[firstSelectedIndex - 1]?.id
  const commands: CoreCommand[] = [{ type: 'deleteCues', ids: selected }]
  for (let i = sorted.length - 1; i >= 0; i--) {
    commands.push({ type: 'addCue', afterId: anchorId, cue: cueData(sorted[i]) })
  }
  const next = await api.apply(commands, label)
  if (!next) return
  const inserted = next.document.cues.filter((cue) => !before.has(cue.id))
  if (inserted.length) api.selectLines(inserted.map((cue) => cue.id))
}

async function insertLine(
  ctx: CommandContext,
  api: CommandApi,
  before: boolean,
  atVideoTime: boolean,
): Promise<void> {
  const { core, activeCue, videoTimeMs } = ctx
  const existing = new Set(core.document.cues.map((cue) => cue.id))
  const startMs = atVideoTime
    ? videoTimeMs
    : before
      ? (activeCue?.startMs ?? 0)
      : (activeCue?.endMs ?? 0)
  const cue = {
    startMs,
    endMs: startMs + getOptionInt('Timing/Default Duration'),
    style: activeCue?.style ?? core.document.styles[0].name,
  }
  const next = await api.apply(
    [
      {
        type: 'addCue',
        ...(before ? { beforeId: activeCue?.id } : { afterId: activeCue?.id }),
        cue,
      },
    ],
    'line insertion',
  )
  if (!next) return
  const inserted = next.document.cues.filter((item) => !existing.has(item.id))
  if (inserted.length) api.selectLines(inserted.map((item) => item.id))
}

async function splitLine(ctx: CommandContext, api: CommandApi, before: boolean): Promise<void> {
  const { core, activeCue, videoTimeMs } = ctx
  if (!activeCue) return
  const splitAt =
    videoTimeMs > activeCue.startMs && videoTimeMs < activeCue.endMs
      ? videoTimeMs
      : Math.round((activeCue.startMs + activeCue.endMs) / 2)
  const existing = new Set(core.document.cues.map((cue) => cue.id))
  const data = cueData(activeCue)
  const commands: CoreCommand[] = before
    ? [
        { type: 'updateCue', id: activeCue.id, patch: { startMs: splitAt } },
        { type: 'addCue', beforeId: activeCue.id, cue: { ...data, endMs: splitAt } },
      ]
    : [
        { type: 'updateCue', id: activeCue.id, patch: { endMs: splitAt } },
        { type: 'addCue', afterId: activeCue.id, cue: { ...data, startMs: splitAt } },
      ]
  const next = await api.apply(commands, 'split')
  if (!next) return
  const inserted = next.document.cues.filter((cue) => !existing.has(cue.id))
  if (inserted.length) api.selectLines(inserted.map((cue) => cue.id))
}

async function joinLines(
  ctx: CommandContext,
  api: CommandApi,
  mode: 'concatenate' | 'keep_first' | 'as_karaoke',
): Promise<void> {
  const { core, selected } = ctx
  const selSet = new Set(selected)
  const ordered = core.document.cues.filter((cue) => selSet.has(cue.id))
  if (ordered.length < 2) return
  const first = ordered[0]
  let text = first.text
  if (mode === 'concatenate') {
    text = ordered.map((cue) => cue.text).join(' ')
  } else if (mode === 'as_karaoke') {
    text = ordered
      .map((cue) => `{\\k${Math.round((cue.endMs - cue.startMs) / 10)}}${cue.text}`)
      .join('')
  }
  // keep_first：保留首行文本
  const endMs = Math.max(...ordered.map((cue) => cue.endMs))
  const next = await api.apply(
    [
      { type: 'updateCue', id: first.id, patch: { text, endMs } },
      { type: 'deleteCues', ids: ordered.slice(1).map((cue) => cue.id) },
    ],
    mode === 'as_karaoke' ? 'join as karaoke' : 'join lines',
  )
  if (next) api.selectLines([first.id])
}

async function makeContinuous(
  ctx: CommandContext,
  api: CommandApi,
  changeStart: boolean,
): Promise<void> {
  const { core, selected } = ctx
  const selSet = new Set(selected)
  const cues = core.document.cues
  const patches: CoreCommand[] = []
  for (let i = 0; i < cues.length; i++) {
    if (!selSet.has(cues[i].id)) continue
    if (changeStart && i > 0) {
      patches.push({ type: 'updateCue', id: cues[i].id, patch: { startMs: cues[i - 1].endMs } })
    } else if (!changeStart && i < cues.length - 1) {
      patches.push({ type: 'updateCue', id: cues[i].id, patch: { endMs: cues[i + 1].startMs } })
    }
  }
  if (patches.length) void api.apply(patches, 'adjoin')
}

/** Aegisub validate_adjoinable：选区为空、非相邻时禁用 */
function adjoinable(ctx: CommandContext): boolean {
  const sel = ctx.selected
  const cues = ctx.core.document.cues
  if (!sel.length) return false
  if (sel.length === 1 || sel.length === cues.length) return true
  const set = new Set(sel)
  let seen = 0
  for (const cue of cues) {
    if (set.has(cue.id)) seen++
    else if (seen > 0 && seen < sel.length) return false
  }
  return seen === sel.length
}

/**
 * edit/line/recombine（edit.cpp RecombineCombination）：
 * 把"时间部分重叠、文本互补"的行重新合并。
 */
async function recombineLines(ctx: CommandContext, api: CommandApi): Promise<void> {
  const { core, selected } = ctx
  const selSet = new Set(selected)
  const cues = core.document.cues.filter((cue) => selSet.has(cue.id))
  if (cues.length < 2) return

  interface Group {
    style: string
    actor: string
    effect: string
    layer: number
    lines: SubtitleCue[]
  }
  const groups = new Map<string, Group>()
  for (const cue of cues) {
    const key = `${cue.style}\u0000${cue.actor}\u0000${cue.effect}\u0000${cue.layer}`
    if (!groups.has(key))
      groups.set(key, {
        style: cue.style,
        actor: cue.actor,
        effect: cue.effect,
        layer: cue.layer,
        lines: [],
      })
    groups.get(key)!.lines.push(cue)
  }

  interface MergePlan {
    first: SubtitleCue
    startMs: number
    endMs: number
    text: string
    dropIds: string[]
  }
  const plans: MergePlan[] = []
  for (const group of groups.values()) {
    const lines = [...group.lines].sort((a, b) => a.startMs - b.startMs)
    for (let i = 0; i < lines.length; i++) {
      const base = lines[i]
      if (plans.some((plan) => plan.dropIds.includes(base.id) || plan.first.id === base.id))
        continue
      for (let j = i + 1; j < lines.length; j++) {
        const other = lines[j]
        if (plans.some((plan) => plan.dropIds.includes(other.id) || plan.first.id === other.id))
          continue
        // 部分重叠：base 先开始，other 在 base 结束前开始
        if (other.startMs < base.endMs && other.endMs > base.endMs) {
          const baseTail = lastLineText(base.text).replace(/\\N$/i, '')
          const otherHead = firstLineText(other.text).replace(/^\\N/i, '')
          plans.push({
            first: base,
            startMs: base.startMs,
            endMs: other.endMs,
            text:
              base.text.slice(0, base.text.length - baseTail.length) +
              baseTail +
              otherHead +
              other.text.slice(otherHead.length),
            dropIds: [other.id],
          })
          break
        }
        // 完全包含（other 完全在 base 内）：文本拼接
        if (other.startMs >= base.startMs && other.endMs <= base.endMs) {
          plans.push({
            first: base,
            startMs: base.startMs,
            endMs: base.endMs,
            text: `${base.text} ${other.text}`.trim(),
            dropIds: [other.id],
          })
          break
        }
      }
    }
  }
  if (!plans.length) {
    api.setStatus('No recombination possibilities found')
    return
  }
  const commands: CoreCommand[] = []
  for (const plan of plans) {
    commands.push({
      type: 'updateCue',
      id: plan.first.id,
      patch: { startMs: plan.startMs, endMs: plan.endMs, text: plan.text },
    })
    commands.push({ type: 'deleteCues', ids: plan.dropIds })
  }
  await api.apply(commands, 'combining')
}

/** 最后一行可见文本（供 recombine 拼接判断） */
function lastLineText(text: string): string {
  const stripped = text.replace(/\{[^}]*\}/g, '')
  const parts = stripped.split(/\\[Nn]/)
  return parts[parts.length - 1] ?? ''
}

/** 第一行可见文本 */
function firstLineText(text: string): string {
  const stripped = text.replace(/\{[^}]*\}/g, '')
  return stripped.split(/\\[Nn]/)[0] ?? ''
}

/**
 * edit/line/split/by_karaoke（edit.cpp）：按 \k 系列卡拉OK计时把行拆成多行。
 */
async function splitByKaraoke(ctx: CommandContext, api: CommandApi): Promise<void> {
  const { core, selected } = ctx
  const selSet = new Set(selected)
  const cues = core.document.cues
  const commands: CoreCommand[] = []
  const before = new Set(cues.map((cue) => cue.id))
  let karaokeFound = false

  for (const cue of cues) {
    if (!selSet.has(cue.id)) continue
    const syllables = parseKaraoke(cue.text)
    if (syllables.length < 2) continue
    karaokeFound = true
    const total = syllables.reduce((sum, item) => sum + item.durationCs, 0)
    const lineDuration = cue.endMs - cue.startMs
    const scale = total > 0 ? lineDuration / (total * 10) : 0
    let cursor = cue.startMs
    const data = cueData(cue)
    const timed = syllables.map((syllable, index) => {
      const durationMs = Math.max(0, Math.round(syllable.durationCs * 10 * scale))
      const startMs = cursor
      const endMs = index === syllables.length - 1 ? cue.endMs : startMs + durationMs
      cursor = endMs
      return { startMs, endMs, text: syllable.text }
    })
    // 第一个音节留在原行；其余按 afterId:cue.id 逆序插入以保持顺序
    commands.push({
      type: 'updateCue',
      id: cue.id,
      patch: { endMs: timed[0].endMs, text: timed[0].text },
    })
    for (let index = timed.length - 1; index >= 1; index--) {
      commands.push({
        type: 'addCue',
        afterId: cue.id,
        cue: {
          ...data,
          startMs: timed[index].startMs,
          endMs: timed[index].endMs,
          text: timed[index].text,
        },
      })
    }
  }
  if (!karaokeFound) {
    api.setStatus('Selected lines have no karaoke timing')
    return
  }
  const next = await api.apply(commands, 'splitting')
  if (!next) return
  const inserted = next.document.cues.filter((cue) => !before.has(cue.id))
  if (inserted.length) api.selectLines(inserted.map((cue) => cue.id))
}

/** 解析 {\kN} 文本序列（k/K/kf/kO 同样按 N 厘秒计） */
function parseKaraoke(text: string): { durationCs: number; text: string }[] {
  const result: { durationCs: number; text: string }[] = []
  const pattern = /\{[^}]*\\[kK][fFoO]?(\d+)[^}]*\}/g
  const marks: { index: number; durationCs: number; length: number }[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    marks.push({ index: match.index, durationCs: Number(match[1]), length: match[0].length })
  }
  if (!marks.length) return [{ durationCs: 0, text }]
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i].length
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length
    result.push({ durationCs: marks[i].durationCs, text: text.slice(start, end) })
  }
  return result.filter((item) => item.text || item.durationCs)
}

/**
 * edit.cpp split_lines：光标处拆行。左半行 = 活动行（保持活动），右半行拷贝其余字段紧随其后；
 * 接缝仅 trim 空白，不做任何标签感知（原版即"笨切"）。
 * - preserve：两行时间不变
 * - estimate：按 UTF-8 字节数占比分配时长（trunc 截断）
 * - video：当前帧钳制在行首尾帧之间，边界 = TimeAtFrame(cur, END)
 */
async function splitLinesAtCursor(
  ctx: CommandContext,
  api: CommandApi,
  kind: 'preserve' | 'estimate' | 'video',
): Promise<void> {
  const { activeCue } = ctx
  if (!activeCue) return
  const position = Math.max(0, Math.min(editCursorState.selectionStart, activeCue.text.length))
  const leftText = activeCue.text.slice(0, position).trimEnd()
  const rightText = activeCue.text.slice(position).trimStart()

  let boundary: number | null = null
  if (kind === 'estimate') {
    const leftLength = utf8ByteLength(leftText)
    const total = leftLength + utf8ByteLength(rightText)
    if (total > 0) {
      boundary =
        Math.trunc((activeCue.endMs - activeCue.startMs) * (leftLength / total)) + activeCue.startMs
    }
  } else if (kind === 'video') {
    const clamped = Math.max(
      ctx.frameRate.frameAtTime(activeCue.startMs, 'start'),
      Math.min(ctx.currentFrame, ctx.frameRate.frameAtTime(activeCue.endMs, 'end')),
    )
    boundary = ctx.frameRate.timeAtFrame(clamped, 'end')
  }

  const commands: CoreCommand[] = []
  const leftPatch: Partial<SubtitleCue> = { text: leftText }
  const right: Omit<SubtitleCue, 'id'> = { ...cueData(activeCue), text: rightText }
  if (boundary !== null) {
    leftPatch.endMs = boundary
    right.startMs = boundary
  }
  commands.push({ type: 'updateCue', id: activeCue.id, patch: leftPatch })
  commands.push({ type: 'addCue', afterId: activeCue.id, cue: right })
  await api.apply(commands, 'split')
}
