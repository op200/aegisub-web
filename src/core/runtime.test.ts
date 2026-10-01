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
  it('coalesces consecutive amended edits of the same label into one undo point', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'a' } }], 'Edit text', true)
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'ab' } }], 'Edit text', true)
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'abc' } }], 'Edit text', true)
    // 连续 amend 的同描述编辑合并为一个撤销点：一次撤销回到初始文本
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web')
  })

  // 命令类提交不传 amend（源码 AssFile::Commit 的 commitId 默认 -1 → 永不合并且各自成点）
  it('does not coalesce commands that are not amended (duplicate twice = two undo points)', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const first = runtime.getState().document.cues[0].id
    const dup = (ids: string[]) =>
      runtime.apply([{ type: 'duplicateCues', ids }], 'Duplicate Lines').document.cues
    expect(dup([first])).toHaveLength(2)
    expect(dup([first])).toHaveLength(3)
    expect(runtime.undo().document.cues).toHaveLength(2)
    expect(runtime.undo().document.cues).toHaveLength(1)
  })

  it('does not coalesce when the label changes', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'a' } }], 'Edit text', true)
    runtime.apply([{ type: 'updateCue', id, patch: { startMs: 1000 } }], 'Edit timing', true)
    // 不同描述打断合并（subs_edit_box:Commit 的 desc == last_commit_type 前置条件）
    expect(runtime.undo().document.cues[0].startMs).not.toBe(1000)
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web')
  })

  // 提交清空 redo 栈（subs_controller.cpp:OnCommit 的 redo_stack.clear()）：缺失时 redo 长期
  // 非空，而合并前提恰要求 redo 空 → 撤销过一次后每次提交各成一个撤销点
  it('clears the redo stack on a commit so a drag stays one undo point after an undo', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'typed' } }], 'Edit text')
    runtime.undo()
    expect(runtime.getState().canRedo).toBe(true)

    // 一次拖拽 = 拖拽期间的多次 amend 提交（首帧 amend 无栈顶可修订，之后逐帧合并）
    runtime.apply(
      [{ type: 'updateCue', id, patch: { text: '\\pos(1,2)x' } }],
      'visual typesetting',
      true,
    )
    runtime.apply(
      [{ type: 'updateCue', id, patch: { text: '\\pos(3,4)x' } }],
      'visual typesetting',
      true,
    )
    runtime.apply(
      [{ type: 'updateCue', id, patch: { text: '\\pos(5,6)x' } }],
      'visual typesetting',
      true,
    )
    expect(runtime.getState().canRedo).toBe(false)

    // 一次撤销即回滚整次拖拽
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web')
  })

  // 拖拽首帧不 amend（源码 VisualTool::commit_id 在鼠标抬起时置 -1）→ 两次拖拽各成一个撤销点
  it('does not coalesce across two drags (amend resets on mouse up)', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    const id = runtime.getState().document.cues[0].id
    runtime.apply(
      [{ type: 'updateCue', id, patch: { text: '\\pos(1,2)x' } }],
      'visual typesetting',
      true,
    )
    runtime.apply(
      [{ type: 'updateCue', id, patch: { text: '\\pos(3,4)x' } }],
      'visual typesetting',
      true,
    )
    // 第二次拖拽的首帧（按下鼠标）不携带 amend
    runtime.apply(
      [{ type: 'updateCue', id, patch: { text: '\\pos(5,6)x' } }],
      'visual typesetting',
      false,
    )
    expect(runtime.undo().document.cues[0].text).toBe('\\pos(3,4)x')
    expect(runtime.undo().document.cues[0].text).toBe('Welcome to Aegisub Web')
  })

  it('cannot undo past the initial state and breaks coalescing after save', () => {
    const runtime = new TypeScriptCoreRuntime(createDocument())
    expect(runtime.getState().canUndo).toBe(false)
    expect(runtime.undo().canUndo).toBe(false)

    const id = runtime.getState().document.cues[0].id
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'saved' } }], 'Edit text', true)
    runtime.markSaved()
    runtime.apply([{ type: 'updateCue', id, patch: { text: 'after save' } }], 'Edit text', true)
    // 保存后下一次同描述 amend 提交不与保存前合并（saved_commit_id+1 != commit_id）
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
