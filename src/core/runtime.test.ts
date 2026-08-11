import { describe, expect, it } from 'vitest';
import { createDocument } from './defaults';
import { TypeScriptCoreRuntime } from './runtime';

describe('core runtime', () => {
  it('applies edits and restores them through undo and redo', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument());
    const id = runtime.getState().document.cues[0].id;
    expect(
      runtime.apply([{ type: 'updateCue', id, patch: { text: 'Edited' } }], 'Edit text').document.cues[0].text,
    ).toBe('Edited');
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web');
    expect(runtime.redo().document.cues[0].text).toBe('Edited');
  });

  it('keeps at least one cue after deletion', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument());
    const id = runtime.getState().document.cues[0].id;
    expect(runtime.apply([{ type: 'deleteCues', ids: [id] }], 'Delete').document.cues).toHaveLength(1);
  });

  it('moves selected cues through the document', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument());
    const first = runtime.getState().document.cues[0].id;
    const added = runtime.apply(
      [
        { type: 'addCue', afterId: first },
        { type: 'addCue', afterId: first },
      ],
      'Add',
    );
    const selected = added.document.cues[1].id;
    const moved = runtime.apply([{ type: 'moveCues', ids: [selected], direction: 1 }], 'Move');
    expect(moved.document.cues[2].id).toBe(selected);
  });

  it('replaces multiple matches from right to left and supports undo', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument());
    const id = runtime.getState().document.cues[0].id;
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'a a a' } }], 'Set text');

    expect(runtime.replaceAll({ find: 'a', replaceWith: 'long' })).toBe(3);
    expect(runtime.getState().document.cues[0].text).toBe('long long long');
    expect(runtime.getState().canUndo).toBe(true);
    expect(runtime.undo().document.cues[0].text).toBe('a a a');
  });

  it('returns zero for replace all without changing history', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument());
    const before = runtime.getState();

    expect(runtime.replaceAll({ find: 'missing', replaceWith: 'value' })).toBe(0);
    expect(runtime.getState().document).toEqual(before.document);
    expect(runtime.getState().canUndo).toBe(false);
  });
});
