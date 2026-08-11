/**
 * Aegisub 命令层（Web 版 "无 UI Context"）。
 *
 * 对应 Aegisub 的 command/*.cpp：每个命令是一个独立对象，接收一个 Context
 * （文档/选区/视频/音频状态机）并通过 CommandApi 执行副作用。
 * 菜单、工具栏、快捷键、网格右键菜单统一经此分发，命令可声明 enabled/checked。
 */
import type { CoreCommand, CoreState, SortColumn, SubtitleCue, SubtitleFormat } from '../core/types';
import type { DummyVideoOptions, MediaSource, SyntheticAudioKind } from '../platform/types';

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
  | null;
export type AudioView = 'waveform' | 'spectrum';
export type GridTagsMode = 'show' | 'hide' | 'simplify';
export type DisplayMode = 'full' | 'subs' | 'video_subs' | 'audio_subs';
export interface AudioOptions {
  autoCommit: boolean;
  autoNext: boolean;
  autoScroll: boolean;
  globalHotkeys: boolean;
  karaoke: boolean;
  verticalLink: boolean;
}

export interface CommandContext {
  core: CoreState;
  selected: string[];
  activeCue: SubtitleCue | null;
  videoMedia: MediaSource | null;
  audioMedia: MediaSource | null;
  videoTimeMs: number;
  videoDurationMs: number;
  audioTimeMs: number;
  audioDurationMs: number;
  audioView: AudioView;
  audioOptions: AudioOptions;
  audioPlaying: boolean;
  videoAutoScroll: boolean;
  gridTags: GridTagsMode;
  displayMode: DisplayMode;
  toolbarVisible: boolean;
}

export interface CommandApi {
  apply(commands: CoreCommand[], label: string): Promise<CoreState | null>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  openSubtitles(): Promise<void>;
  newSubtitles(): Promise<void>;
  saveSubtitles(format?: SubtitleFormat): Promise<void>;
  openVideo(): Promise<void>;
  closeVideo(): void;
  openAudio(): Promise<void>;
  openAudioFromVideo(): void;
  closeAudio(): void;
  openDummyVideo(options: DummyVideoOptions): void;
  openSyntheticAudio(kind: SyntheticAudioKind): void;
  setVideoTime(value: number): void;
  setAudioTime(value: number): void;
  setStatus(message: string): void;
  sendVideoAction(type: string): void;
  sendAudioAction(type: string): void;
  moveSelection(direction: number): void;
  moveSelectionOrCreate(): void;
  selectLines(ids: string[]): void;
  openFind(mode: 'find' | 'replace'): void;
  findNext(): void;
  replaceCurrent(): void;
  replaceAll(): void;
  openStyleManager(): void;
  openDialog(dialog: DialogKind): void;
  setToolbarVisible(value: boolean): void;
  setAudioView(view: AudioView): void;
  setAudioOption(option: keyof AudioOptions, value: boolean): void;
  setVideoAutoScroll(value: boolean): void;
  setGridTags(mode: GridTagsMode): void;
  setDisplayMode(mode: DisplayMode): void;
}

export interface CommandDef {
  run(ctx: CommandContext, api: CommandApi): void | Promise<void>;
  enabled?(ctx: CommandContext): boolean;
  checked?(ctx: CommandContext): boolean;
}

// ---------------------------------------------------------------------------
// 剪贴板（Web 版无系统 ASS 剪贴板，用模块级内存模拟）
// ---------------------------------------------------------------------------
let clipboardLines: SubtitleCue[] = [];

function cueData(cue: SubtitleCue): Omit<SubtitleCue, 'id'> {
  const clone = structuredClone(cue) as Omit<SubtitleCue, 'id'> & { id?: string };
  delete clone.id;
  return clone;
}

function compareBy(column: SortColumn): (a: SubtitleCue, b: SubtitleCue) => number {
  switch (column) {
    case 'start':
      return (a, b) => a.startMs - b.startMs || a.endMs - b.endMs;
    case 'end':
      return (a, b) => a.endMs - b.endMs || a.startMs - b.startMs;
    case 'style':
      return (a, b) => a.style.localeCompare(b.style) || a.startMs - b.startMs;
    case 'actor':
      return (a, b) => a.actor.localeCompare(b.actor) || a.startMs - b.startMs;
    case 'effect':
      return (a, b) => a.effect.localeCompare(b.effect) || a.startMs - b.startMs;
    case 'layer':
      return (a, b) => a.layer - b.layer || a.startMs - b.startMs;
  }
}

/** 把 selected 行重新插入（删除后重建），保持相对顺序，返回新的 id 列表 */
async function reinsertLines(
  ctx: CommandContext,
  api: CommandApi,
  label: string,
  place: 'top' | 'bottom' | 'at-start' | 'at-end',
): Promise<void> {
  const { core, selected } = ctx;
  const doc = core.document;
  const selSet = new Set(selected);
  const ordered = doc.cues.filter((cue) => selSet.has(cue.id));
  if (!ordered.length) return;
  const before = new Set(doc.cues.map((cue) => cue.id));

  let anchorId: string | undefined;
  if (place === 'top' || place === 'at-start') {
    const firstSelectedIndex = doc.cues.findIndex((cue) => selSet.has(cue.id));
    anchorId = doc.cues[firstSelectedIndex - 1]?.id;
    // 从开头插入：以第一个未被选中的行之后为锚
    if (!anchorId && firstSelectedIndex === 0) anchorId = undefined;
  } else {
    const lastSelectedIndex = doc.cues.findIndex(
      (cue, index, arr) => selSet.has(cue.id) && !selSet.has(arr[index + 1]?.id),
    );
    anchorId = doc.cues[lastSelectedIndex + 1]?.id;
  }

  const commands: CoreCommand[] = [{ type: 'deleteCues', ids: selected }];
  // 逆序插入，保证最终相对顺序
  for (let i = ordered.length - 1; i >= 0; i--) {
    commands.push({
      type: 'addCue',
      ...(place === 'top' || place === 'at-start' ? { beforeId: anchorId } : { afterId: anchorId }),
      cue: cueData(ordered[i]),
    });
  }
  const next = await api.apply(commands, label);
  if (!next) return;
  const inserted = next.document.cues.filter((cue) => !before.has(cue.id));
  if (inserted.length) api.selectLines(inserted.map((cue) => cue.id));
}

function requireSelection(ctx: CommandContext): boolean {
  return ctx.selected.length > 0;
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
  'tool/export': { run: (_, api) => void api.saveSubtitles('srt') },
  'subtitle/properties': {
    run: (_, api) => api.openDialog('properties'),
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
      const lines = ctx.core.document.cues.filter((cue) => ctx.selected.includes(cue.id));
      clipboardLines = lines.map((cue) => structuredClone(cue));
      void navigator.clipboard?.writeText(lines.map((cue) => cue.text).join('\n')).catch(() => undefined);
      api.setStatus(`Copied ${lines.length} line${lines.length === 1 ? '' : 's'}`);
    },
    enabled: requireSelection,
  },
  'edit/line/cut': {
    run: (ctx, api) => {
      const lines = ctx.core.document.cues.filter((cue) => ctx.selected.includes(cue.id));
      clipboardLines = lines.map((cue) => structuredClone(cue));
      void navigator.clipboard?.writeText(lines.map((cue) => cue.text).join('\n')).catch(() => undefined);
      void api.apply([{ type: 'deleteCues', ids: ctx.selected }], 'Cut lines');
    },
    enabled: requireSelection,
  },
  'edit/line/paste': {
    run: (ctx, api) => {
      if (!clipboardLines.length) return;
      const before = new Set(ctx.core.document.cues.map((cue) => cue.id));
      const commands = [...clipboardLines]
        .reverse()
        .map((cue): CoreCommand => ({ type: 'addCue', afterId: ctx.activeCue?.id, cue: cueData(cue) }));
      void api.apply(commands, 'Paste lines').then((next) => {
        if (!next) return;
        const inserted = next.document.cues.filter((cue) => !before.has(cue.id));
        if (inserted.length) api.selectLines(inserted.map((cue) => cue.id));
      });
    },
    enabled: () => clipboardLines.length > 0,
  },
  'edit/line/paste/over': {
    run: (ctx, api) => {
      if (!clipboardLines.length || !ctx.activeCue) return;
      const lines = clipboardLines.map((cue) => structuredClone(cue));
      const first = lines[0];
      void api.apply([{ type: 'updateCue', id: ctx.activeCue.id, patch: cueData(first) }], 'Paste lines over');
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
    run: (ctx, api) => void api.apply([{ type: 'duplicateCues', ids: ctx.selected }], 'Duplicate lines'),
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
  'edit/line/delete': {
    run: (ctx, api) => void api.apply([{ type: 'deleteCues', ids: ctx.selected }], 'Delete lines'),
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

  // ---- 网格 ----
  'grid/swap': {
    run: (ctx, api) => {
      const doc = ctx.core.document;
      const index = doc.cues.findIndex((cue) => cue.id === ctx.activeCue?.id);
      if (index < 0 || index >= doc.cues.length - 1) return;
      const a = doc.cues[index];
      const b = doc.cues[index + 1];
      void api.apply(
        [
          { type: 'updateCue', id: a.id, patch: cueData(b) },
          { type: 'updateCue', id: b.id, patch: cueData(a) },
        ],
        'Swap lines',
      );
    },
    enabled: (ctx) => {
      const index = ctx.core.document.cues.findIndex((cue) => cue.id === ctx.activeCue?.id);
      return ctx.activeCue !== null && index >= 0 && index < ctx.core.document.cues.length - 1;
    },
  },
  'grid/move/up': {
    run: (ctx, api) => void api.apply([{ type: 'moveCues', ids: ctx.selected, direction: -1 }], 'Move lines up'),
    enabled: requireSelection,
  },
  'grid/move/down': {
    run: (ctx, api) => void api.apply([{ type: 'moveCues', ids: ctx.selected, direction: 1 }], 'Move lines down'),
    enabled: requireSelection,
  },
  'grid/move/up/end': {
    run: (ctx, api) => void reinsertLines(ctx, api, 'Move lines to top', 'top'),
    enabled: requireSelection,
  },
  'grid/move/down/end': {
    run: (ctx, api) => void reinsertLines(ctx, api, 'Move lines to bottom', 'bottom'),
    enabled: requireSelection,
  },
  'grid/sort/start': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'start' }], 'Sort lines by start'),
  },
  'grid/sort/end': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'end' }], 'Sort lines by end'),
  },
  'grid/sort/style': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'style' }], 'Sort lines by style'),
  },
  'grid/sort/actor': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'actor' }], 'Sort lines by actor'),
  },
  'grid/sort/effect': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'effect' }], 'Sort lines by effect'),
  },
  'grid/sort/layer': {
    run: (ctx, api) => void api.apply([{ type: 'sortCuesBy', column: 'layer' }], 'Sort lines by layer'),
  },
  ...sortSelectedCommands(),

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
    // Aegisub grid.cpp：mode 0 显示 → 1 简化(☀) → 2 隐藏 → 循环
    run: (ctx, api) => {
      const next: GridTagsMode = ctx.gridTags === 'show' ? 'simplify' : ctx.gridTags === 'simplify' ? 'hide' : 'show';
      api.setGridTags(next);
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
    run: (ctx, api) => {
      const targetEnd = ctx.videoTimeMs + 1000 / 24;
      const commands = ctx.core.document.cues
        .filter((cue) => ctx.selected.includes(cue.id))
        .map((cue): CoreCommand => ({
          type: 'updateCue',
          id: cue.id,
          patch: {
            startMs: ctx.videoTimeMs,
            ...(cue.endMs < targetEnd ? { endMs: targetEnd } : {}),
          },
        }));
      if (commands.length) void api.apply(commands, 'Snap start to video');
    },
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.selected.length),
  },
  'time/snap/end_video': {
    run: (ctx, api) => {
      const targetEnd = ctx.videoTimeMs + 1000 / 24;
      const commands = ctx.core.document.cues
        .filter((cue) => ctx.selected.includes(cue.id))
        .map((cue): CoreCommand => ({
          type: 'updateCue',
          id: cue.id,
          patch: {
            endMs: targetEnd,
            ...(cue.startMs > ctx.videoTimeMs ? { startMs: ctx.videoTimeMs } : {}),
          },
        }));
      if (commands.length) void api.apply(commands, 'Snap end to video');
    },
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.selected.length),
  },
  'time/frame/current': {
    run: (ctx, api) => {
      if (!ctx.activeCue) return;
      const shift = Math.max(0, ctx.videoTimeMs) - ctx.activeCue.startMs;
      const commands = ctx.core.document.cues
        .filter((cue) => ctx.selected.includes(cue.id))
        .map((cue): CoreCommand => ({
          type: 'updateCue',
          id: cue.id,
          patch: { startMs: cue.startMs + shift, endMs: cue.endMs + shift },
        }));
      if (commands.length) void api.apply(commands, 'Shift lines to current frame');
    },
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.activeCue && ctx.selected.length),
  },
  'time/continuous/start': {
    run: (ctx, api) => void makeContinuous(ctx, api, true),
    enabled: adjoinable,
  },
  'time/continuous/end': {
    run: (ctx, api) => void makeContinuous(ctx, api, false),
    enabled: adjoinable,
  },
  'time/prev': {
    run: (_, api) => api.moveSelection(-1),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'time/next': {
    run: (_, api) => api.moveSelection(1),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'time/lead/in': {
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
          'Adjust start time',
        );
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'time/lead/out': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [{ type: 'updateCue', id: ctx.activeCue.id, patch: { endMs: ctx.activeCue.endMs + 350 } }],
          'Adjust end time',
        );
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
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
          'Adjust start time',
        );
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
          'Adjust start time',
        );
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'time/length/increase': {
    run: (ctx, api) => {
      if (ctx.activeCue)
        void api.apply(
          [{ type: 'updateCue', id: ctx.activeCue.id, patch: { endMs: ctx.activeCue.endMs + 100 } }],
          'Adjust end time',
        );
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
          'Adjust end time',
        );
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
  'video/jump': { run: (_, api) => api.openDialog('jump'), enabled: (ctx) => Boolean(ctx.videoMedia) },
  'video/jump/start': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.setVideoTime(ctx.activeCue.startMs);
    },
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.activeCue),
  },
  'video/jump/end': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.setVideoTime(ctx.activeCue.endMs);
    },
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.activeCue),
  },
  'video/play': {
    run: (_, api) => api.sendVideoAction('toggle'),
    enabled: (ctx) => Boolean(ctx.videoMedia),
  },
  'video/play/line': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setVideoTime(ctx.activeCue.startMs);
        api.sendVideoAction('play');
      }
    },
    enabled: (ctx) => Boolean(ctx.videoMedia && ctx.activeCue),
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
  'video/frame/prev/keyframe': {
    run: (_, api) => api.sendVideoAction('keyframe-prev'),
  },
  'video/frame/next/keyframe': {
    run: (_, api) => api.sendVideoAction('keyframe-next'),
  },
  'video/frame/prev/boundary': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.setVideoTime(ctx.activeCue.startMs);
    },
  },
  'video/frame/next/boundary': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.setVideoTime(ctx.activeCue.endMs);
    },
  },
  'video/frame/prev/large': {
    run: (ctx, api) => api.setVideoTime(Math.max(0, ctx.videoTimeMs - 1000)),
  },
  'video/frame/next/large': {
    run: (ctx, api) =>
      api.setVideoTime(Math.min(ctx.videoDurationMs || ctx.videoTimeMs + 1000, ctx.videoTimeMs + 1000)),
  },
  'video/focus_seek': {
    run: () => document.querySelector<HTMLInputElement>('.seek-slider')?.focus(),
  },
  'video/zoom/in': { run: (_, api) => api.sendVideoAction('zoom-in'), enabled: (ctx) => Boolean(ctx.videoMedia) },
  'video/zoom/out': { run: (_, api) => api.sendVideoAction('zoom-out'), enabled: (ctx) => Boolean(ctx.videoMedia) },
  'video/zoom/50': { run: (_, api) => api.sendVideoAction('zoom-50') },
  'video/zoom/100': { run: (_, api) => api.sendVideoAction('zoom-100') },
  'video/zoom/200': { run: (_, api) => api.sendVideoAction('zoom-200') },
  'video/tool/cross': { run: (_, api) => api.sendVideoAction('video/tool/cross') },
  'video/tool/drag': { run: (_, api) => api.sendVideoAction('video/tool/drag') },
  'video/tool/rotate/z': { run: (_, api) => api.sendVideoAction('video/tool/rotate/z') },
  'video/tool/rotate/xy': { run: (_, api) => api.sendVideoAction('video/tool/rotate/xy') },
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
  'audio/commit': {
    run: (ctx, api) => {
      api.setStatus('Line committed');
      if (ctx.audioOptions.autoNext) api.moveSelection(1);
    },
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'audio/commit/default': {
    run: (_, api) => api.setStatus('Line committed'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'audio/play/selection': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.startMs);
        api.sendAudioAction('play-selection');
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.activeCue),
  },
  'audio/play/line': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.startMs);
        api.sendAudioAction('play-line');
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.activeCue),
  },
  'audio/play/selection/before': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(Math.max(0, ctx.activeCue.startMs - 500));
        api.sendAudioAction('play-before');
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.activeCue),
  },
  'audio/play/selection/after': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.endMs);
        api.sendAudioAction('play-after');
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.activeCue),
  },
  'audio/play/selection/begin': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(ctx.activeCue.startMs);
        api.sendAudioAction('play-begin');
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.activeCue),
  },
  'audio/play/selection/end': {
    run: (ctx, api) => {
      if (ctx.activeCue) {
        api.setAudioTime(Math.max(ctx.activeCue.startMs, ctx.activeCue.endMs - 500));
        api.sendAudioAction('play-end');
      }
    },
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.activeCue),
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
      api.setAudioTime(Math.min(ctx.audioDurationMs || ctx.audioTimeMs + 1000, ctx.audioTimeMs + 1000)),
  },
  'audio/stop': {
    run: (_, api) => api.sendAudioAction('stop'),
    enabled: (ctx) => Boolean(ctx.audioMedia && ctx.audioPlaying),
  },
  'audio/go_to': {
    run: (ctx, api) => {
      if (ctx.activeCue) api.setAudioTime(ctx.activeCue.startMs);
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

  // ---- 视图 ----
  'app/display/subs': {
    run: (_, api) => api.setDisplayMode('subs'),
    checked: (ctx) => ctx.displayMode === 'subs',
  },
  'app/display/video_subs': {
    run: (_, api) => api.setDisplayMode('video_subs'),
    checked: (ctx) => ctx.displayMode === 'video_subs',
  },
  'app/display/audio_subs': {
    run: (_, api) => api.setDisplayMode('audio_subs'),
    checked: (ctx) => ctx.displayMode === 'audio_subs',
  },
  'app/display/full': {
    run: (_, api) => api.setDisplayMode('full'),
    checked: (ctx) => ctx.displayMode === 'full',
  },
  'app/toggle/toolbar': {
    run: (ctx, api) => api.setToolbarVisible(!ctx.toolbarVisible),
    checked: (ctx) => ctx.toolbarVisible,
  },
  'app/about': { run: (_, api) => api.openDialog('about') },

  // ---- 工具/附加功能（Web 版提供状态提示，保持按钮可用与 Aegisub 一致）----
  'subtitle/select/visible': {
    run: (ctx, api) => {
      const visible = ctx.core.document.cues
        .filter((cue) => !cue.comment && cue.startMs <= ctx.videoTimeMs && cue.endMs >= ctx.videoTimeMs)
        .map((cue) => cue.id);
      api.selectLines(visible);
      api.setStatus(
        visible.length
          ? `Selected ${visible.length} visible line${visible.length === 1 ? '' : 's'}`
          : 'No visible lines at current time',
      );
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
    run: (_, api) => api.openDialog('styling-assistant'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'tool/translation_assistant': {
    run: (_, api) => api.openDialog('translation'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'tool/resampleres': {
    run: (_, api) => api.openDialog('resample'),
  },
  'tool/time/postprocess': {
    run: (_, api) => api.openDialog('timing-postprocess'),
  },
  'tool/time/kanji': {
    run: (_, api) => api.openDialog('kanji-timer'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'subtitle/spellcheck': {
    run: (_, api) => api.openDialog('spellcheck'),
    enabled: (ctx) => Boolean(ctx.activeCue),
  },
  'app/options': {
    run: (_, api) => api.openDialog('options'),
  },
  'app/language': {
    run: (_, api) => api.setStatus('The web build only ships the system language'),
  },
  'app/updates': {
    run: (_, api) => api.setStatus('The web build updates automatically'),
  },
  'app/log': {
    run: (_, api) => api.setStatus('No log available in the web build'),
  },
  'time/snap/scene': {
    run: (_, api) => api.setStatus('Scene snapshots are not available in the web build'),
    enabled: () => false,
  },

  // ---- 帮助 ----
  'help/contents': { run: (_, api) => api.setStatus('Aegisub-compatible shortcuts are active') },
  'help/website': {
    run: () => {
      window.open('https://aegisub.org/', '_blank', 'noopener');
    },
  },
  'help/bugs': {
    run: () => {
      window.open('https://github.com/TypesettingTools/Aegisub/issues', '_blank', 'noopener');
    },
  },
};

// ---------------------------------------------------------------------------
// 组合命令实现
// ---------------------------------------------------------------------------

function sortSelectedCommands(): Record<string, CommandDef> {
  const defs: Record<string, CommandDef> = {};
  for (const column of ['start', 'end', 'style', 'actor', 'effect', 'layer'] as const) {
    defs[`grid/sort/${column}/selected`] = {
      run: (ctx, api) => {
        const { core, selected } = ctx;
        const selSet = new Set(selected);
        const ordered = core.document.cues.filter((cue) => selSet.has(cue.id));
        if (ordered.length < 2) return;
        const sorted = [...ordered].sort(compareBy(column));
        void reinsertSorted(ctx, api, sorted, `Sort selected by ${column}`);
      },
      enabled: (ctx) => ctx.selected.length > 1,
    };
  }
  return defs;
}

async function reinsertSorted(
  ctx: CommandContext,
  api: CommandApi,
  sorted: SubtitleCue[],
  label: string,
): Promise<void> {
  const { core, selected } = ctx;
  const doc = core.document;
  const selSet = new Set(selected);
  const before = new Set(doc.cues.map((cue) => cue.id));
  const firstSelectedIndex = doc.cues.findIndex((cue) => selSet.has(cue.id));
  const anchorId = doc.cues[firstSelectedIndex - 1]?.id;
  const commands: CoreCommand[] = [{ type: 'deleteCues', ids: selected }];
  for (let i = sorted.length - 1; i >= 0; i--) {
    commands.push({ type: 'addCue', afterId: anchorId, cue: cueData(sorted[i]) });
  }
  const next = await api.apply(commands, label);
  if (!next) return;
  const inserted = next.document.cues.filter((cue) => !before.has(cue.id));
  if (inserted.length) api.selectLines(inserted.map((cue) => cue.id));
}

async function insertLine(ctx: CommandContext, api: CommandApi, before: boolean, atVideoTime: boolean): Promise<void> {
  const { core, activeCue, videoTimeMs } = ctx;
  const existing = new Set(core.document.cues.map((cue) => cue.id));
  const startMs = atVideoTime ? videoTimeMs : before ? (activeCue?.startMs ?? 0) : (activeCue?.endMs ?? 0);
  const cue = {
    startMs,
    endMs: startMs + 5000,
    style: activeCue?.style ?? core.document.styles[0].name,
  };
  const next = await api.apply(
    [{ type: 'addCue', ...(before ? { beforeId: activeCue?.id } : { afterId: activeCue?.id }), cue }],
    'Insert line',
  );
  if (!next) return;
  const inserted = next.document.cues.filter((item) => !existing.has(item.id));
  if (inserted.length) api.selectLines(inserted.map((item) => item.id));
}

async function splitLine(ctx: CommandContext, api: CommandApi, before: boolean): Promise<void> {
  const { core, activeCue, videoTimeMs } = ctx;
  if (!activeCue) return;
  const splitAt =
    videoTimeMs > activeCue.startMs && videoTimeMs < activeCue.endMs
      ? videoTimeMs
      : Math.round((activeCue.startMs + activeCue.endMs) / 2);
  const existing = new Set(core.document.cues.map((cue) => cue.id));
  const data = cueData(activeCue);
  const commands: CoreCommand[] = before
    ? [
        { type: 'updateCue', id: activeCue.id, patch: { startMs: splitAt } },
        { type: 'addCue', beforeId: activeCue.id, cue: { ...data, endMs: splitAt } },
      ]
    : [
        { type: 'updateCue', id: activeCue.id, patch: { endMs: splitAt } },
        { type: 'addCue', afterId: activeCue.id, cue: { ...data, startMs: splitAt } },
      ];
  const next = await api.apply(commands, 'Split line');
  if (!next) return;
  const inserted = next.document.cues.filter((cue) => !existing.has(cue.id));
  if (inserted.length) api.selectLines(inserted.map((cue) => cue.id));
}

async function joinLines(
  ctx: CommandContext,
  api: CommandApi,
  mode: 'concatenate' | 'keep_first' | 'as_karaoke',
): Promise<void> {
  const { core, selected } = ctx;
  const selSet = new Set(selected);
  const ordered = core.document.cues.filter((cue) => selSet.has(cue.id));
  if (ordered.length < 2) return;
  const first = ordered[0];
  let text = first.text;
  if (mode === 'concatenate') {
    text = ordered.map((cue) => cue.text).join(' ');
  } else if (mode === 'as_karaoke') {
    text = ordered.map((cue) => `{\\k${Math.round((cue.endMs - cue.startMs) / 10)}}${cue.text}`).join('');
  }
  // keep_first：保留首行文本
  const endMs = Math.max(...ordered.map((cue) => cue.endMs));
  const next = await api.apply(
    [
      { type: 'updateCue', id: first.id, patch: { text, endMs } },
      { type: 'deleteCues', ids: ordered.slice(1).map((cue) => cue.id) },
    ],
    mode === 'as_karaoke' ? 'join as karaoke' : 'join lines',
  );
  if (next) api.selectLines([first.id]);
}

async function makeContinuous(ctx: CommandContext, api: CommandApi, changeStart: boolean): Promise<void> {
  const { core, selected } = ctx;
  const selSet = new Set(selected);
  const cues = core.document.cues;
  const patches: CoreCommand[] = [];
  for (let i = 0; i < cues.length; i++) {
    if (!selSet.has(cues[i].id)) continue;
    if (changeStart && i > 0) {
      patches.push({ type: 'updateCue', id: cues[i].id, patch: { startMs: cues[i - 1].endMs } });
    } else if (!changeStart && i < cues.length - 1) {
      patches.push({ type: 'updateCue', id: cues[i].id, patch: { endMs: cues[i + 1].startMs } });
    }
  }
  if (patches.length) void api.apply(patches, 'make continuous');
}

/** Aegisub validate_adjoinable：选区为空、非相邻时禁用 */
function adjoinable(ctx: CommandContext): boolean {
  const sel = ctx.selected;
  const cues = ctx.core.document.cues;
  if (!sel.length) return false;
  if (sel.length === 1 || sel.length === cues.length) return true;
  const set = new Set(sel);
  let seen = 0;
  for (const cue of cues) {
    if (set.has(cue.id)) seen++;
    else if (seen > 0 && seen < sel.length) return false;
  }
  return seen === sel.length;
}
