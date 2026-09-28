import { describe, expect, it } from 'vitest'

import { createDocument } from './defaults'
import { TypeScriptCoreRuntime } from './runtime'

describe('core runtime', () => {
  it('applies edits and restores them through undo and redo', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    expect(
      runtime.apply([{ type: 'updateCue', id, patch: { text: 'Edited' } }], 'Edit text').document
        .cues[0].text,
    ).toBe('Edited')
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web')
    expect(runtime.redo().document.cues[0].text).toBe('Edited')
  })

  it('keeps at least one cue after deletion', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    expect(runtime.apply([{ type: 'deleteCues', ids: [id] }], 'Delete').document.cues).toHaveLength(
      1,
    )
  })

  it('moves selected cues through the document', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const first = runtime.getState().document.cues[0].id
    const added = runtime.apply(
      [
        { type: 'addCue', afterId: first },
        { type: 'addCue', afterId: first },
      ],
      'Add',
    )
    const selected = added.document.cues[1].id
    const moved = runtime.apply([{ type: 'moveCues', ids: [selected], direction: 1 }], 'Move')
    expect(moved.document.cues[2].id).toBe(selected)
  })

  it('replaces multiple matches from right to left and supports undo', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'a a a' } }], 'Set text')

    expect(runtime.replaceAll({ find: 'a', replaceWith: 'long' })).toBe(3)
    expect(runtime.getState().document.cues[0].text).toBe('long long long')
    expect(runtime.getState().canUndo).toBe(true)
    expect(runtime.undo().document.cues[0].text).toBe('a a a')
  })

  it('returns zero for replace all without changing history', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const before = runtime.getState()

    expect(runtime.replaceAll({ find: 'missing', replaceWith: 'value' })).toBe(0)
    expect(runtime.getState().document).toEqual(before.document)
    expect(runtime.getState().canUndo).toBe(false)
  })

  // 撤销栈语义对齐 subs_controller.cpp
  it('coalesces consecutive same-label edits into one undo point', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'a' } }], 'Edit text')
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'ab' } }], 'Edit text')
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'abc' } }], 'Edit text')
    // 连续同描述编辑合并为一个撤销点：一次撤销回到初始文本
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web')
  })

  it('does not coalesce different labels or different target lines', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const first = runtime.getState().document.cues[0].id
    const added = runtime.apply([{ type: 'addCue', afterId: first }], 'Add line')
    const second = added.document.cues[1].id
    runtime.apply([{ type: 'updateCue', id: first, patch: { text: 'a' } }], 'Edit text')
    runtime.apply([{ type: 'updateCue', id: second, patch: { text: 'b' } }], 'Edit text')
    // 切行打断合并（subs_edit_box OnActiveLineChanged 重置 commit_id）：'b' 是独立撤销点
    expect(runtime.undo().document.cues[1].text).not.toBe('b')
    runtime.apply([{ type: 'updateCue', id: first, patch: { text: 'c' } }], 'Edit text')
    runtime.apply([{ type: 'updateCue', id: first, patch: { startMs: 1000 } }], 'Edit timing')
    // 不同描述打断合并
    expect(runtime.undo().document.cues[0].startMs).not.toBe(1000)
    expect(runtime.undo().document.cues[0].text).toBe('a')
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web')
  })

  it('cannot undo past the initial state and breaks coalescing after save', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    expect(runtime.getState().canUndo).toBe(false)
    expect(runtime.undo().canUndo).toBe(false)

    const id = runtime.getState().document.cues[0].id
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'saved' } }], 'Edit text')
    runtime.markSaved()
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'after save' } }], 'Edit text')
    // 保存后下一次同描述提交不与保存前合并
    expect(runtime.undo().document.cues[0].text).toBe('saved')
    expect(runtime.redo().document.cues[0].text).toBe('after save')
  })

  // 源码 Load/Close 路径 Commit("", COMMIT_NEW) 建立首个撤销点：
  // 缺失会让首次提交成为伪栈底（canUndo 恒 false）
  it('makes the first commit undoable', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    const after = runtime.apply([{ type: 'updateCue', id, patch: { text: 'first' } }], 'Edit text')
    expect(after.canUndo).toBe(true)
    const undone = runtime.undo()
    expect(undone.canUndo).toBe(false)
    expect(undone.document.cues[0].text).toBe('Welcome to Aegisub Web')
  })

  // 撤销条目携带选中/活动行快照（subs_controller.cpp:UndoInfo + SetSelectionAndActive）
  it('stores and restores selection with undo and redo', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const first = runtime.getState().document.cues[0].id
    const added = runtime.apply([{ type: 'addCue', afterId: first }], 'Add line')
    const second = added.document.cues[1].id
    runtime.notifySelection([second], second)
    // 提交时快照当前选中集
    const edited = runtime.apply(
      [{ type: 'updateCue', id: second, patch: { text: 'b' } }],
      'Edit text',
    )
    expect(edited.selected).toEqual([second])
    expect(edited.activeId).toBe(second)

    runtime.notifySelection([first], first)
    const undone = runtime.undo()
    // 撤销恢复条目快照的选中/活动行
    expect(undone.selected).toEqual([second])
    expect(undone.activeId).toBe(second)
    // 切行上报打断合并语义不受影响：'b' 仍是独立撤销点
    expect(undone.document.cues[1].text).not.toBe('b')

    const redone = runtime.redo()
    expect(redone.selected).toEqual([first])
    expect(redone.activeId).toBe(first)
  })

  // 撤销条目携带编辑框文本选区快照（subs_controller.cpp:UndoInfo pos/sel_start/sel_end）
  it('stores and restores text selection with undo and redo', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    // 栈底条目文本选区为初值
    expect(runtime.getState().textSelection).toEqual({ pos: 0, start: 0, end: 0 })

    runtime.notifyTextSelection(5, 2, 5)
    const edited = runtime.apply(
      [{ type: 'updateCue', id, patch: { text: 'Edited' } }],
      'Edit text',
    )
    // 提交时沿用上一栈顶的文本选区快照（此后 notifyTextSelection 实时修订）
    expect(edited.textSelection).toEqual({ pos: 5, start: 2, end: 5 })

    runtime.notifyTextSelection(7, 7, 7)
    expect(runtime.getState().textSelection).toEqual({ pos: 7, start: 7, end: 7 })

    // 撤销/重做按条目快照恢复
    const undone = runtime.undo()
    expect(undone.textSelection).toEqual({ pos: 5, start: 2, end: 5 })
    const redone = runtime.redo()
    expect(redone.textSelection).toEqual({ pos: 7, start: 7, end: 7 })
  })
})
