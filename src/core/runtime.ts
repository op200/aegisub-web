import { createCue, createDefaultStyle, makeId } from './defaults';
import { exportSubtitle, parseSubtitle } from './format';
import type { CoreCommand, CoreState, SortColumn, SubtitleCue, SubtitleDocument, SubtitleFormat } from './types';
import type { SearchMatch, SearchSettings } from '../workers/protocol';

interface HistoryEntry {
  label: string;
  document: SubtitleDocument;
}

export class TypeScriptCoreRuntime {
  private document: SubtitleDocument;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(document: SubtitleDocument) {
    this.document = structuredClone(document);
  }

  open(bytes: Uint8Array, sourceName: string): CoreState {
    const text = new TextDecoder('utf-8').decode(bytes);
    this.document = parseSubtitle(text, sourceName);
    this.undoStack = [];
    this.redoStack = [];
    return this.getState();
  }

  restore(document: SubtitleDocument): CoreState {
    this.document = structuredClone(document);
    this.undoStack = [];
    this.redoStack = [];
    return this.getState();
  }

  apply(commands: CoreCommand[], label: string): CoreState {
    if (!commands.length) return this.getState();
    this.undoStack.push({ label, document: structuredClone(this.document) });
    this.redoStack = [];
    for (const command of commands) this.applyCommand(command);
    this.document.revision += 1;
    return this.getState();
  }

  undo(): CoreState {
    const entry = this.undoStack.pop();
    if (!entry) return this.getState();
    this.redoStack.push({ label: entry.label, document: structuredClone(this.document) });
    this.document = entry.document;
    return this.getState();
  }

  redo(): CoreState {
    const entry = this.redoStack.pop();
    if (!entry) return this.getState();
    this.undoStack.push({ label: entry.label, document: structuredClone(this.document) });
    this.document = entry.document;
    return this.getState();
  }

  export(format?: SubtitleFormat): Uint8Array {
    return new TextEncoder().encode(exportSubtitle(this.document, format));
  }

  search(settings: SearchSettings): SearchMatch[] {
    const field = settings.field ?? 'text';
    const needle = settings.matchCase ? settings.find : settings.find.toLowerCase();
    const flags = settings.matchCase ? '' : 'i';
    const re = settings.useRegex ? new RegExp(settings.find, flags) : null;
    const matches: SearchMatch[] = [];
    for (const cue of this.document.cues) {
      let value: string;
      if (field === 'style') value = cue.style;
      else if (field === 'actor') value = cue.actor;
      else if (field === 'effect') value = cue.effect;
      else value = cue.text;
      if (settings.skipTags && field === 'text') value = value.replace(/\{[^}]*\}/g, '');
      if (settings.exactMatch) {
        const ok = re ? re.test(value) : (settings.matchCase ? value : value.toLowerCase()) === needle;
        if (ok) matches.push({ id: cue.id, start: 0, end: value.length, field });
        continue;
      }
      let from = 0;
      while (from <= value.length) {
        const index = re ? value.slice(from).search(re) : value.toLowerCase().indexOf(needle, from);
        if (index < 0) break;
        const start = re ? from + index : index;
        const len = re ? (value.slice(from).match(re)?.[0].length ?? 0) : needle.length;
        if (!len) break;
        matches.push({ id: cue.id, start, end: start + len, field });
        from = start + len;
      }
    }
    return matches;
  }

  replaceAll(settings: SearchSettings): number {
    const matches = this.search(settings);
    if (!matches.length) return 0;
    const replacement = settings.replaceWith ?? '';
    this.undoStack.push({ label: 'Replace all', document: structuredClone(this.document) });
    this.redoStack = [];
    for (const match of [...matches].reverse()) {
      const cue = this.document.cues.find((item) => item.id === match.id);
      if (!cue) continue;
      const field =
        match.field === 'style'
          ? 'style'
          : match.field === 'actor'
            ? 'actor'
            : match.field === 'effect'
              ? 'effect'
              : 'text';
      const value = cue[field];
      if (typeof value === 'string') cue[field] = value.slice(0, match.start) + replacement + value.slice(match.end);
    }
    this.document.revision += 1;
    return matches.length;
  }

  getState(): CoreState {
    return {
      document: structuredClone(this.document),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? '',
      redoLabel: this.redoStack.at(-1)?.label ?? '',
      runtime: 'typescript',
    };
  }

  private applyCommand(command: CoreCommand): void {
    switch (command.type) {
      case 'updateCue': {
        const cue = this.document.cues.find((item) => item.id === command.id);
        if (cue) Object.assign(cue, command.patch);
        break;
      }
      case 'addCue': {
        const afterIndex = command.beforeId
          ? this.document.cues.findIndex((cue) => cue.id === command.beforeId) - 1
          : command.afterId
            ? this.document.cues.findIndex((cue) => cue.id === command.afterId)
            : this.document.cues.length - 1;
        const reference = this.document.cues[Math.max(0, afterIndex)];
        const cue = {
          ...createCue(reference?.endMs ?? 0, (reference?.endMs ?? 0) + 5000),
          ...command.cue,
          id: makeId('cue'),
        };
        this.document.cues.splice(afterIndex + 1, 0, cue);
        break;
      }
      case 'deleteCues': {
        const selected = new Set(command.ids);
        this.document.cues = this.document.cues.filter((cue) => !selected.has(cue.id));
        if (!this.document.cues.length) this.document.cues.push(createCue());
        break;
      }
      case 'duplicateCues': {
        const selected = new Set(command.ids);
        const result = [];
        for (const cue of this.document.cues) {
          result.push(cue);
          if (selected.has(cue.id)) result.push({ ...structuredClone(cue), id: makeId('cue') });
        }
        this.document.cues = result;
        break;
      }
      case 'moveCues': {
        const selected = new Set(command.ids);
        if (command.direction < 0) {
          for (let index = 1; index < this.document.cues.length; index += 1) {
            if (selected.has(this.document.cues[index].id) && !selected.has(this.document.cues[index - 1].id)) {
              [this.document.cues[index - 1], this.document.cues[index]] = [
                this.document.cues[index],
                this.document.cues[index - 1],
              ];
            }
          }
        } else {
          for (let index = this.document.cues.length - 2; index >= 0; index -= 1) {
            if (selected.has(this.document.cues[index].id) && !selected.has(this.document.cues[index + 1].id)) {
              [this.document.cues[index], this.document.cues[index + 1]] = [
                this.document.cues[index + 1],
                this.document.cues[index],
              ];
            }
          }
        }
        break;
      }
      case 'updateStyle': {
        const style = this.document.styles.find((item) => item.id === command.id);
        if (style) {
          const previousName = style.name;
          Object.assign(style, command.patch);
          if (command.patch.name && command.patch.name !== previousName) {
            for (const cue of this.document.cues) if (cue.style === previousName) cue.style = command.patch.name;
          }
        }
        break;
      }
      case 'addStyle':
        this.document.styles.push({
          ...createDefaultStyle(`Style ${this.document.styles.length + 1}`),
          ...command.style,
          id: makeId('style'),
        });
        break;
      case 'deleteStyle': {
        const style = this.document.styles.find((item) => item.id === command.id);
        if (this.document.styles.length > 1)
          this.document.styles = this.document.styles.filter((item) => item.id !== command.id);
        if (style)
          for (const cue of this.document.cues) if (cue.style === style.name) cue.style = this.document.styles[0].name;
        break;
      }
      case 'reorderStyles': {
        const order = new Map(command.ids.map((id, index) => [id, index]));
        this.document.styles.sort(
          (left, right) =>
            (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
        );
        break;
      }
      case 'updateScriptInfo':
        Object.assign(this.document.scriptInfo, command.patch);
        break;
      case 'sortCues':
        this.document.cues.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
        break;
      case 'sortCuesBy':
        this.sortBy(command.column);
        break;
    }
  }

  private sortBy(column: SortColumn): void {
    const value = (cue: SubtitleCue): number | string => {
      switch (column) {
        case 'start':
          return cue.startMs;
        case 'end':
          return cue.endMs;
        case 'style':
          return cue.style.toLowerCase();
        case 'actor':
          return cue.actor.toLowerCase();
        case 'effect':
          return cue.effect.toLowerCase();
        case 'layer':
          return cue.layer;
      }
    };
    this.document.cues.sort((left, right) => {
      const a = value(left);
      const b = value(right);
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return String(a).localeCompare(String(b));
    });
  }
}
