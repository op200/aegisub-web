import { Captions, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreClient } from '../core/client';
import { createDocument } from '../core/defaults';
import type { CoreCommand, CoreState } from '../core/types';
import { BrowserHostAdapter, MEDIA_FILE_TYPES, SUBTITLE_FILE_TYPES } from '../platform/browserHost';
import { createNativeHostAdapter } from '../platform/nativeHost';
import type { HostAdapter, MediaSource } from '../platform/types';
import { loadAutosave, saveAutosave } from '../storage/projectStore';
import { commandForShortcut, shortcutFromKeyboardEvent, type ShortcutContext } from './commands';
import {
  COMMAND_REGISTRY,
  type AudioOptions,
  type AudioView,
  type CommandApi,
  type CommandContext,
  type DialogKind,
  type DisplayMode,
  type GridTagsMode,
} from './commandRegistry';
import { AudioPane } from './components/AudioPane';
import {
  AboutDialog,
  AttachmentDialog,
  DummyVideoDialog,
  FontCollectorDialog,
  JumpToDialog,
  ResampleDialog,
  ScriptPropertiesDialog,
  ShiftTimesDialog,
  StylingAssistantDialog,
  ToolInfoDialog,
  TranslationDialog,
  VideoDetailsDialog,
} from './components/dialogs';
import { EditPanel } from './components/EditPanel';
import { MenuBar } from './components/MenuBar';
import { PreviewPane } from './components/PreviewPane';
import { StyleManagerDialog } from './components/StyleManagerDialog';
import { SubtitleGrid } from './components/SubtitleGrid';
import { Toolbar } from './components/Toolbar';
import { calculateAttachedVideoLayout } from './layout/videoLayout';

const host: HostAdapter = createNativeHostAdapter() ?? new BrowserHostAdapter();

function selectedOrActive(document: CoreState['document'], selected: Set<string>, activeId: string | null): string[] {
  if (selected.size) return [...selected];
  if (activeId) return [activeId];
  return document.cues[0] ? [document.cues[0].id] : [];
}

export function App() {
  const coreRef = useRef<CoreClient | null>(null);
  const anchorRef = useRef<string | null>(null);
  const executeRef = useRef<(id: string) => void>(() => undefined);
  const [core, setCore] = useState<CoreState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [videoMedia, setVideoMedia] = useState<MediaSource | null>(null);
  const [audioMedia, setAudioMedia] = useState<MediaSource | null>(null);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [videoWindowZoom, setVideoWindowZoom] = useState(1);
  const [videoIntrinsicSize, setVideoIntrinsicSize] = useState({ width: 1280, height: 720 });
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  const [videoTimeMs, setVideoTimeMs] = useState(0);
  const [audioTimeMs, setAudioTimeMs] = useState(0);
  const [videoAction, setVideoAction] = useState({ sequence: 0, type: '' });
  const [audioAction, setAudioAction] = useState({ sequence: 0, type: '' });
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [showStyleManager, setShowStyleManager] = useState(false);
  const [findMode, setFindMode] = useState<'find' | 'replace' | null>(null);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [audioView, setAudioView] = useState<AudioView>('waveform');
  const [audioOptions, setAudioOptions] = useState<AudioOptions>({
    autoCommit: false,
    autoNext: true,
    autoScroll: true,
    globalHotkeys: false,
    karaoke: false,
    verticalLink: true,
  });
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [videoAutoScroll, setVideoAutoScroll] = useState(false);
  // Aegisub 默认 Subtitle/Grid/Hide Overrides = 1（简化，override 块显示为 ☀）
  const [gridTags, setGridTags] = useState<GridTagsMode>('simplify');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('full');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    const client = new CoreClient();
    coreRef.current = client;
    let cancelled = false;
    void (async () => {
      let initial = await client.state();
      try {
        const saved = await loadAutosave();
        if (saved?.document && Date.now() - saved.updatedAt < 30 * 24 * 60 * 60 * 1000)
          initial = await client.restore(saved.document);
      } catch {
        // IndexedDB is optional in private browsing and embedded WebViews.
      }
      if (cancelled) return;
      setCore(initial);
      const first = initial.document.cues[0]?.id ?? null;
      setActiveId(first);
      if (first) setSelectedIds(new Set([first]));
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
      client.close();
    };
  }, []);

  useEffect(() => {
    if (!core || !loadedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveAutosave(core.document).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [core]);

  // 窗口标题：与 Aegisub 一致（* 前缀表示已修改）
  useEffect(() => {
    if (!core) return;
    const name = core.document.sourceName || 'untitled';
    document.title = `${name} - Aegisub`;
  }, [core]);

  const selectedCue = useMemo(() => core?.document.cues.find((cue) => cue.id === activeId) ?? null, [activeId, core]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const videoLayout = useMemo(
    () =>
      calculateAttachedVideoLayout(
        videoIntrinsicSize,
        videoWindowZoom,
        videoIntrinsicSize.width / Math.max(1, videoIntrinsicSize.height),
      ),
    [videoIntrinsicSize, videoWindowZoom],
  );

  useEffect(() => {
    if (videoAutoScroll && videoMedia && selectedCue) setVideoTimeMs(selectedCue.startMs);
  }, [selectedCue, videoAutoScroll, videoMedia]);

  const apply = useCallback(async (commands: CoreCommand[], label: string): Promise<CoreState | null> => {
    if (!coreRef.current) return null;
    setBusy(true);
    try {
      const next = await coreRef.current.apply(commands, label);
      setCore(next);
      setStatus(label);
      return next;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Edit failed');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!core || (activeId && core.document.cues.some((cue) => cue.id === activeId))) return;
    const first = core.document.cues[0]?.id ?? null;
    setActiveId(first);
    setSelectedIds(first ? new Set([first]) : new Set());
    anchorRef.current = first;
  }, [activeId, core]);

  const selectOnly = (id: string) => {
    setActiveId(id);
    setSelectedIds(new Set([id]));
    anchorRef.current = id;
  };

  const moveSelection = (direction: number) => {
    if (!core || !activeId) return;
    const index = core.document.cues.findIndex((cue) => cue.id === activeId);
    const next = core.document.cues[Math.max(0, Math.min(core.document.cues.length - 1, index + direction))];
    if (next) selectOnly(next.id);
  };

  const moveSelectionOrCreate = async () => {
    if (!core || !activeId) return;
    const index = core.document.cues.findIndex((cue) => cue.id === activeId);
    const next = core.document.cues[index + 1];
    if (next) {
      selectOnly(next.id);
      return;
    }
    const active = core.document.cues[index];
    if (!active) return;
    const before = new Set(core.document.cues.map((cue) => cue.id));
    const state = await apply(
      [
        {
          type: 'addCue',
          afterId: active.id,
          cue: { startMs: active.endMs, endMs: active.endMs + 5000, style: active.style },
        },
      ],
      'Insert line',
    );
    const inserted = state?.document.cues.find((cue) => !before.has(cue.id));
    if (inserted) selectOnly(inserted.id);
  };

  const selectCue = (id: string, modifiers: { toggle: boolean; range: boolean }) => {
    if (!core) return;
    if (modifiers.range && anchorRef.current) {
      const from = core.document.cues.findIndex((cue) => cue.id === anchorRef.current);
      const to = core.document.cues.findIndex((cue) => cue.id === id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelectedIds(new Set(core.document.cues.slice(start, end + 1).map((cue) => cue.id)));
      }
      setActiveId(id);
    } else if (modifiers.toggle) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setActiveId(id);
    } else selectOnly(id);
  };

  const openSubtitles = async () => {
    const file = await host.openFile(SUBTITLE_FILE_TYPES);
    if (!file || !coreRef.current) return;
    setBusy(true);
    try {
      const state = await coreRef.current.open(await host.readFile(file), file.name);
      setCore(state);
      const id = state.document.cues[0]?.id ?? null;
      setActiveId(id);
      setSelectedIds(id ? new Set([id]) : new Set());
      anchorRef.current = id;
      setVideoTimeMs(0);
      setStatus(`Opened ${file.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not open subtitles');
    } finally {
      setBusy(false);
    }
  };

  const newSubtitles = async () => {
    if (!coreRef.current) return;
    const state = await coreRef.current.restore(createDocument());
    setCore(state);
    selectOnly(state.document.cues[0].id);
    setStatus('New subtitles');
  };

  const saveSubtitles = async (format = core?.document.format) => {
    if (!coreRef.current || !core) return;
    const output = await coreRef.current.export(format);
    const base = core.document.sourceName.replace(/\.(ass|ssa|srt)$/i, '') || 'untitled';
    const extension = format === 'srt' ? 'srt' : 'ass';
    await host.saveFile(`${base}.${extension}`, output, {
      description: 'Subtitle',
      accept: { 'text/plain': [`.${extension}`] },
    });
    setStatus(`Saved ${base}.${extension}`);
  };

  const openVideo = async () => {
    const file = await host.openFile(MEDIA_FILE_TYPES);
    if (!file) return;
    const source = await host.openMedia(file);
    if (source.kind === 'audio') {
      URL.revokeObjectURL(source.url);
      setStatus('The selected file does not contain video');
      return;
    }
    const previousVideo = videoMedia;
    const previousAudio = audioMedia;
    setVideoMedia(source);
    setAudioMedia(source);
    setVideoTimeMs(0);
    setVideoDurationMs(0);
    setAudioTimeMs(0);
    setAudioDurationMs(0);
    if (previousAudio && previousAudio !== previousVideo) URL.revokeObjectURL(previousAudio.url);
    if (previousVideo) URL.revokeObjectURL(previousVideo.url);
    setStatus(`Video: ${file.name}`);
  };

  const closeVideo = () => {
    if (videoMedia && videoMedia !== audioMedia) URL.revokeObjectURL(videoMedia.url);
    setVideoMedia(null);
    setVideoDurationMs(0);
    setVideoTimeMs(0);
    setStatus('Video closed');
  };

  const openAudio = async () => {
    const file = await host.openFile(MEDIA_FILE_TYPES);
    if (!file) return;
    const source = await host.openMedia(file);
    if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url);
    setAudioMedia(source);
    setAudioTimeMs(0);
    setAudioDurationMs(0);
    setStatus(`Audio: ${file.name}`);
  };

  const openAudioFromVideo = () => {
    if (!videoMedia) {
      setStatus('Open a video first');
      return;
    }
    if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url);
    setAudioMedia(videoMedia);
    setAudioTimeMs(0);
    setAudioDurationMs(videoDurationMs);
    setStatus('Audio loaded from video');
  };

  const closeAudio = () => {
    if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url);
    setAudioMedia(null);
    setAudioDurationMs(0);
    setAudioTimeMs(0);
    setStatus('Audio closed');
  };

  const sendVideoAction = (type: string) => setVideoAction((current) => ({ sequence: current.sequence + 1, type }));
  const sendAudioAction = (type: string) => setAudioAction((current) => ({ sequence: current.sequence + 1, type }));

  const findNext = async () => {
    if (!core || !findQuery.trim()) {
      setFindMode('find');
      return;
    }
    try {
      const matches = (await coreRef.current?.search({ find: findQuery, field: 'text' })) ?? [];
      if (!matches.length) {
        setStatus(`Not found: ${findQuery}`);
        return;
      }
      const currentIndex = core.document.cues.findIndex((cue) => cue.id === activeId);
      let next = matches.find((match) => {
        const index = core.document.cues.findIndex((cue) => cue.id === match.id);
        return index >= 0 && index > currentIndex;
      });
      if (!next) next = matches[0];
      const found = core.document.cues.find((cue) => cue.id === next?.id);
      if (found) {
        selectOnly(found.id);
        setStatus(`Found in line ${core.document.cues.indexOf(found) + 1}`);
      }
    } catch {
      setStatus('Search failed');
    }
  };

  const replaceCurrent = async () => {
    if (!selectedCue || !findQuery) return;
    try {
      const matches = (await coreRef.current?.search({ find: findQuery, field: 'text' })) ?? [];
      const match = matches.find((item) => item.id === selectedCue.id);
      if (match) {
        const text = selectedCue.text.slice(0, match.start) + replaceQuery + selectedCue.text.slice(match.end);
        void apply([{ type: 'updateCue', id: selectedCue.id, patch: { text } }], 'Replace text');
      } else {
        setStatus('No match in current line');
      }
    } catch {
      setStatus('Replace failed');
    }
  };

  const replaceAll = async () => {
    if (!core || !findQuery.trim()) return;
    try {
      const count =
        (await coreRef.current?.replaceAll({ find: findQuery, replaceWith: replaceQuery, field: 'text' })) ?? 0;
      setStatus(`Replaced ${count} occurrence${count === 1 ? '' : 's'}`);
      const next = await coreRef.current?.state();
      if (next) setCore(next);
    } catch {
      setStatus('Replace all failed');
    }
  };

  const api: CommandApi = {
    apply,
    undo: async () => {
      const next = await coreRef.current?.undo();
      if (next) setCore(next);
    },
    redo: async () => {
      const next = await coreRef.current?.redo();
      if (next) setCore(next);
    },
    openSubtitles,
    newSubtitles,
    saveSubtitles: (format) => saveSubtitles(format),
    openVideo,
    closeVideo,
    openAudio,
    openAudioFromVideo,
    closeAudio,
    openDummyVideo: (options) => {
      if (videoMedia && videoMedia !== audioMedia) URL.revokeObjectURL(videoMedia.url);
      setVideoMedia({ name: 'Dummy Video', url: '', kind: 'video', dummy: options });
      setVideoDurationMs(options.lengthMs);
      setVideoTimeMs(0);
      setStatus(`Dummy video ${options.width}×${options.height}`);
    },
    openSyntheticAudio: (kind) => {
      if (audioMedia && audioMedia !== videoMedia) URL.revokeObjectURL(audioMedia.url);
      // Aegisub audio.cpp：150 分钟（ln=396900000 @ 44100Hz）
      const lengthMs = 9_000_000;
      setAudioMedia({
        name: kind === 'blank' ? 'Blank Audio' : 'Noise Audio',
        url: '',
        kind: 'audio',
        syntheticAudio: { kind, durationMs: lengthMs },
      });
      setAudioDurationMs(lengthMs);
      setAudioTimeMs(0);
      setStatus(kind === 'blank' ? '2h30 blank audio loaded' : '2h30 noise audio loaded');
    },
    setVideoTime: setVideoTimeMs,
    setAudioTime: setAudioTimeMs,
    setStatus,
    sendVideoAction,
    sendAudioAction,
    moveSelection,
    moveSelectionOrCreate: () => void moveSelectionOrCreate(),
    selectLines: (ids) => {
      setActiveId(ids[0] ?? null);
      setSelectedIds(new Set(ids));
      anchorRef.current = ids[0] ?? null;
    },
    openFind: (mode) => setFindMode(mode),
    findNext,
    replaceCurrent,
    replaceAll,
    openStyleManager: () => setShowStyleManager(true),
    openDialog: (kind) => setDialog(kind),
    setToolbarVisible,
    setAudioView,
    setAudioOption: (option, value) => setAudioOptions((current) => ({ ...current, [option]: value })),
    setVideoAutoScroll,
    setGridTags,
    setDisplayMode,
  };

  const commandContext = (): CommandContext | null => {
    if (!core) return null;
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
    };
  };

  const executeCommand = (id: string) => {
    const ctx = commandContext();
    const def = COMMAND_REGISTRY[id];
    if (!ctx || !def) {
      setStatus('This command is not available in the web build');
      return;
    }
    if (def.enabled && !def.enabled(ctx)) return;
    void def.run(ctx, api);
  };
  executeRef.current = executeCommand;

  const isCommandEnabled = (id: string) => {
    const ctx = commandContext();
    const def = COMMAND_REGISTRY[id];
    return Boolean(ctx && def && (!def.enabled || def.enabled(ctx)));
  };

  const isCommandChecked = (id: string) => {
    const ctx = commandContext();
    const def = COMMAND_REGISTRY[id];
    return Boolean(ctx && def?.checked?.(ctx));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      const editing = target.matches('input, textarea, select, [contenteditable="true"]');
      const contextElement = target.closest<HTMLElement>('[data-shortcut-context]');
      const context = (contextElement?.dataset.shortcutContext ?? 'Default') as ShortcutContext;
      const shortcut = shortcutFromKeyboardEvent(event);
      const command = commandForShortcut(shortcut, context);
      const isSubtitleEditor = context === 'Subtitle Edit Box';
      const nativeEditingCommands = new Set([
        'edit/line/cut',
        'edit/line/copy',
        'edit/line/paste',
        'edit/undo',
        'edit/redo',
        'subtitle/select/all',
      ]);
      if (command && (!editing || (isSubtitleEditor && !nativeEditingCommands.has(command)))) {
        event.preventDefault();
        executeRef.current(command);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!core)
    return (
      <main className="loading-screen">
        <Captions size={30} />
        <span>Loading Aegisub Web</span>
      </main>
    );

  return (
    <main className={`app-shell${toolbarVisible ? '' : ' toolbar-hidden'}`}>
      <MenuBar
        projectName={core.document.sourceName}
        onCommand={executeCommand}
        isCommandEnabled={isCommandEnabled}
        isCommandChecked={isCommandChecked}
      />
      {toolbarVisible && (
        <Toolbar onCommand={executeCommand} isCommandEnabled={isCommandEnabled} isCommandChecked={isCommandChecked} />
      )}
      <div
        className="workspace"
        style={
          displayMode === 'full' || displayMode === 'video_subs'
            ? { gridTemplateRows: `${videoLayout.panelHeight}px minmax(120px, 1fr)` }
            : undefined
        }
      >
        <div className="top-workspace">
          {(displayMode === 'full' || displayMode === 'video_subs') && (
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
              onPatchCue={(id, patch, label) => void apply([{ type: 'updateCue', id, patch }], label)}
              onPatchStyle={(id, patch, label) => void apply([{ type: 'updateStyle', id, patch }], label)}
              isCommandEnabled={isCommandEnabled}
              isCommandChecked={isCommandChecked}
              windowZoom={videoWindowZoom}
              onWindowZoomChange={setVideoWindowZoom}
              onIntrinsicSizeChange={(width, height) => setVideoIntrinsicSize({ width, height })}
              intrinsicWidth={videoIntrinsicSize.width}
              intrinsicHeight={videoIntrinsicSize.height}
              style={{ flexBasis: `${videoLayout.panelWidth}px` }}
            />
          )}
          <div className="right-workspace">
            {(displayMode === 'full' || displayMode === 'audio_subs') && (
              <AudioPane
                media={audioMedia}
                durationMs={audioDurationMs}
                currentTimeMs={audioTimeMs}
                videoTimeMs={videoMedia ? videoTimeMs : null}
                selectedCue={selectedCue}
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
                onDurationChange={setAudioDurationMs}
                onCommand={executeCommand}
                onPatchCue={(id, patch, label) => void apply([{ type: 'updateCue', id, patch }], label)}
              />
            )}
            <EditPanel
              cue={selectedCue}
              styles={core.document.styles}
              onCommit={(patch, label) => {
                if (selectedCue) void apply([{ type: 'updateCue', id: selectedCue.id, patch }], label);
              }}
              onCommand={executeCommand}
              onInsertLine={() => void executeCommand('subtitle/insert/after')}
            />
          </div>
        </div>
        <SubtitleGrid
          cues={core.document.cues}
          activeId={activeId}
          selectedIds={selectedSet}
          currentTimeMs={videoTimeMs}
          textMode={gridTags}
          onSelect={selectCue}
          onActivate={(cue) => selectOnly(cue.id)}
          onSetActive={setActiveId}
          onSortColumn={(column) => void apply([{ type: 'sortCuesBy', column }], `Sort by ${column}`)}
          onCommand={executeCommand}
          isCommandEnabled={isCommandEnabled}
        />
      </div>
      <footer className="app-footer">
        {/* Aegisub CreateStatusBar(2)：左字段 = 状态消息，右字段 = 临时状态 */}
        <span className={`status-indicator${busy ? ' busy' : ''}`} />
        <span className="status-message">{status}</span>
        <span className="status-info">{core.runtime === 'wasm' ? 'Aegisub core' : 'Web core'}</span>
      </footer>

      {showStyleManager && (
        <StyleManagerDialog
          styles={core.document.styles}
          activeStyleName={selectedCue?.style ?? core.document.styles[0]?.name ?? ''}
          onClose={() => setShowStyleManager(false)}
          onUpdate={(id, patch) => void apply([{ type: 'updateStyle', id, patch }], 'Update style')}
          onAdd={(style) => void apply([{ type: 'addStyle', style }], 'Add style')}
          onDelete={(ids) => ids.forEach((id) => void apply([{ type: 'deleteStyle', id }], 'Delete style'))}
          onReorder={(ids) => void apply([{ type: 'reorderStyles', ids }], 'Move styles')}
        />
      )}

      {findMode && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFindMode(null);
          }}
        >
          <form
            className="app-dialog find-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={findMode === 'replace' ? 'Find and Replace' : 'Find'}
            onSubmit={(event) => {
              event.preventDefault();
              findNext();
            }}
          >
            <header>
              <strong>{findMode === 'replace' ? 'Find and Replace' : 'Find'}</strong>
              <button
                type="button"
                className="dialog-close"
                onClick={() => setFindMode(null)}
                title="Close"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>
            <div className="dialog-fields">
              <label>
                Find what
                <input autoFocus value={findQuery} onChange={(event) => setFindQuery(event.target.value)} />
              </label>
              {findMode === 'replace' && (
                <label>
                  Replace with
                  <input value={replaceQuery} onChange={(event) => setReplaceQuery(event.target.value)} />
                </label>
              )}
            </div>
            <footer>
              {findMode === 'replace' && (
                <>
                  <button type="button" onClick={replaceCurrent}>
                    Replace
                  </button>
                  <button type="button" onClick={replaceAll}>
                    Replace All
                  </button>
                </>
              )}
              <button type="submit">Find Next</button>
              <button type="button" onClick={() => setFindMode(null)}>
                Cancel
              </button>
            </footer>
          </form>
        </div>
      )}

      {dialog === 'shift' && core && (
        <ShiftTimesDialog
          cues={core.document.cues}
          selectedIds={selectedOrActive(core.document, selectedSet, activeId)}
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
      {dialog === 'video-details' && videoMedia && (
        <VideoDetailsDialog media={videoMedia} durationMs={videoDurationMs} onClose={() => setDialog(null)} />
      )}
      {dialog === 'dummy-video' && core && (
        <DummyVideoDialog
          scriptInfo={core.document.scriptInfo}
          onClose={() => setDialog(null)}
          onApply={(options) => api.openDummyVideo(options)}
        />
      )}
      {dialog === 'properties' && core && (
        <ScriptPropertiesDialog
          scriptInfo={core.document.scriptInfo}
          onClose={() => setDialog(null)}
          onApply={(patch) => void apply([{ type: 'updateScriptInfo', patch }], 'Update script properties')}
        />
      )}
      {dialog === 'styling-assistant' && selectedCue && (
        <StylingAssistantDialog
          cue={selectedCue}
          styles={core.document.styles}
          onClose={() => setDialog(null)}
          onApply={(style, next) => {
            void apply([{ type: 'updateCue', id: selectedCue.id, patch: { style } }], 'Apply style');
            if (next) moveSelection(1);
          }}
          onPrevious={() => moveSelection(-1)}
          onPlay={() => {
            setVideoTimeMs(selectedCue.startMs);
            sendVideoAction('play');
          }}
        />
      )}
      {dialog === 'attachments' && <AttachmentDialog onClose={() => setDialog(null)} />}
      {dialog === 'font-collector' && core && (
        <FontCollectorDialog
          styles={core.document.styles}
          text={core.document.cues.map((cue) => cue.text).join('\n')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'translation' && selectedCue && (
        <TranslationDialog
          cue={selectedCue}
          onApply={(text) => void apply([{ type: 'updateCue', id: selectedCue.id, patch: { text } }], 'Translate line')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'resample' && core && (
        <ResampleDialog
          scriptInfo={core.document.scriptInfo}
          onApply={(patch) => void apply([{ type: 'updateScriptInfo', patch }], 'Resample resolution')}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'automation' && (
        <ToolInfoDialog
          title="Automation Manager"
          message="Automation scripts require the Lua runtime. The document remains compatible with Aegisub automation metadata."
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'timing-postprocess' && (
        <ToolInfoDialog
          title="Timing Post-Processor"
          message="Lead-in/out controls are available in the audio toolbar. Keyframe processing requires loaded timecodes and keyframe data."
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'kanji-timer' && (
        <ToolInfoDialog
          title="Kanji Timer"
          message="Kanji timing requires paired source and destination karaoke lines. Select the lines in Aegisub desktop for the complete matcher workflow."
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'spellcheck' && (
        <ToolInfoDialog
          title="Spell Checker"
          message="Browser spell checking is enabled directly in the subtitle edit box. Right-click a misspelled word to use the browser dictionary."
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'options' && (
        <ToolInfoDialog
          title="Options"
          message="Aegisub-compatible defaults are active. Browser-specific settings are stored locally with the project and style catalogs."
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}
