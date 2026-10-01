// 验证 Aegisub WASM 核心 ABI 的完整流程（create/open/state/apply/undo/export）。
// 用法: node native/scripts/test_wasm_core.mjs
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const buildDir = path.resolve(__dirname, '../build')
// Emscripten ESM 输出：export default createAegisubCore
const { default: createCore } = await import(
  pathToFileURL(path.join(buildDir, 'aegisub_core_wasm.js')).href + '?t=' + Date.now()
)

const module_ = await createCore({
  locateFile: (f) => path.join(buildDir, f),
})

const ASS = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello {\\i1}world{\\i0}
Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,a comment
`

function cstr(s) {
  return module_.allocateUTF8(s)
}
function free(ptr) {
  if (ptr) module_._free(ptr)
}

// 1. create
const doc = module_._aegisub_document_create()
if (!doc) throw new Error('create failed')

// 2. open
const data = new TextEncoder().encode(ASS)
const dataPtr = module_._malloc(data.length)
module_.HEAPU8.set(data, dataPtr)
const namePtr = cstr('test.ass')
const openResult = module_._aegisub_document_open(doc, dataPtr, data.length, namePtr)
free(dataPtr)
free(namePtr)
if (openResult !== 0)
  throw new Error('open failed: ' + module_.UTF8ToString(module_._aegisub_core_last_error()))
console.log('open: OK')

// 3. state
const statePtr = module_._aegisub_document_state_json(doc)
const state = JSON.parse(module_.UTF8ToString(statePtr))
module_._aegisub_core_free(statePtr)
console.log('state.document.cues:', state.document.cues.length)
console.log('state.document.styles:', state.document.styles.length)
console.log(
  '  cue0:',
  JSON.stringify({
    style: state.document.cues[0].style,
    text: state.document.cues[0].text,
    startMs: state.document.cues[0].startMs,
    endMs: state.document.cues[0].endMs,
  }),
)
console.log(
  '  style0:',
  JSON.stringify({
    name: state.document.styles[0].name,
    fontSize: state.document.styles[0].fontSize,
  }),
)
console.log('  runtime:', state.runtime, 'canUndo:', state.canUndo)

if (state.document.cues.length !== 2) throw new Error('expected 2 cues')

// 4. apply updateCue
const cue0 = state.document.cues[0]
const applyCmds = JSON.stringify([
  { type: 'updateCue', id: cue0.id, patch: { text: 'Edited text' } },
])
const cmdsPtr = cstr(applyCmds)
const labelPtr = cstr('Edit text')
// 第 4 参 amend（ABI v6）：非 0 = 修订上一次提交（源码 AssFile::Commit 的 commitId 回传）；
// 命令类提交传 0 → 各自成点
const applyResult = module_._aegisub_document_apply_json(doc, cmdsPtr, labelPtr, 0)
free(cmdsPtr)
free(labelPtr)
if (applyResult !== 0) throw new Error('apply failed')
const state2Ptr = module_._aegisub_document_state_json(doc)
const state2 = JSON.parse(module_.UTF8ToString(state2Ptr))
module_._aegisub_core_free(state2Ptr)
console.log('apply: text ->', state2.document.cues[0].text, '| canUndo:', state2.canUndo)
if (state2.document.cues[0].text !== 'Edited text') throw new Error('apply text mismatch')
if (!state2.canUndo) throw new Error('canUndo should be true')

// 5. undo
module_._aegisub_document_undo(doc)
const state3Ptr = module_._aegisub_document_state_json(doc)
const state3 = JSON.parse(module_.UTF8ToString(state3Ptr))
module_._aegisub_core_free(state3Ptr)
console.log('undo: text ->', state3.document.cues[0].text, '| canRedo:', state3.canRedo)
if (state3.document.cues[0].text !== 'Hello {\\i1}world{\\i0}') throw new Error('undo mismatch')

// 6. export ASS
const sizePtr = module_._malloc(4)
const fmtPtr = cstr('ass')
const exportPtr = module_._aegisub_document_export(doc, fmtPtr, sizePtr)
free(fmtPtr)
const size = module_.HEAP32[sizePtr >> 2]
const exported = new TextDecoder().decode(module_.HEAPU8.slice(exportPtr, exportPtr + size))
module_._aegisub_core_free(exportPtr)
module_._free(sizePtr)
console.log(
  'export: has Dialogue =',
  exported.includes('Dialogue:'),
  '| has Comment =',
  exported.includes('Comment:'),
)
if (!exported.includes('Dialogue: 0,0:00:01.00')) throw new Error('export dialogue mismatch')

// 7. export SRT
const sizePtr2 = module_._malloc(4)
const fmtPtr2 = cstr('srt')
const exportPtr2 = module_._aegisub_document_export(doc, fmtPtr2, sizePtr2)
free(fmtPtr2)
const size2 = module_.HEAP32[sizePtr2 >> 2]
const srtOut = new TextDecoder().decode(module_.HEAPU8.slice(exportPtr2, exportPtr2 + size2))
module_._aegisub_core_free(exportPtr2)
module_._free(sizePtr2)
console.log('srt:', JSON.stringify(srtOut.split('\r\n').slice(0, 3).join(' | ')))
if (!srtOut.includes('Hello world')) throw new Error('srt text mismatch')

// 8. 搜索（text 字段，忽略大小写）
const searchPtr = module_._aegisub_document_search(
  doc,
  module_.allocateUTF8(
    JSON.stringify({ find: 'hello', field: 'text', matchCase: false, useRegex: false }),
  ),
)
const searchJson = module_.UTF8ToString(searchPtr)
module_._aegisub_core_free(searchPtr)
const searchResults = JSON.parse(searchJson)
console.log('search matches:', searchResults.length, 'first:', JSON.stringify(searchResults[0]))
if (!searchResults.some((m) => m.field === 'text')) throw new Error('search mismatch')

// 9. replace all
const repPtr = module_._aegisub_document_replace_all(
  doc,
  module_.allocateUTF8(
    JSON.stringify({ find: 'hello', replaceWith: 'hi', field: 'text', matchCase: false }),
  ),
)
console.log('replace count:', repPtr)
if (repPtr < 1) throw new Error('replace_all failed')
const stateRepPtr = module_._aegisub_document_state_json(doc)
const stateRep = JSON.parse(module_.UTF8ToString(stateRepPtr))
module_._aegisub_core_free(stateRepPtr)
console.log('after replace text:', stateRep.document.cues[0].text)
if (stateRep.document.cues[0].text !== 'hi {\\i1}world{\\i0}')
  throw new Error('replace text mismatch')

// 10. 编辑框文本选区（subs_controller.cpp:UndoInfo pos/sel_start/sel_end）：
// notify_text_selection 实时修订栈顶条目，undo 后恢复新栈顶的快照
if (module_._aegisub_core_abi_version() < 5) throw new Error('abi version should be >= 5')
module_._aegisub_document_notify_text_selection(doc, 7, 2, 7)
const selPtr = module_._aegisub_document_state_json(doc)
const selState = JSON.parse(module_.UTF8ToString(selPtr))
module_._aegisub_core_free(selPtr)
console.log('textSelection:', JSON.stringify(selState.textSelection))
if (
  selState.textSelection.pos !== 7 ||
  selState.textSelection.start !== 2 ||
  selState.textSelection.end !== 7
)
  throw new Error('textSelection mismatch')
module_._aegisub_document_undo(doc)
const selPtr2 = module_._aegisub_document_state_json(doc)
const selState2 = JSON.parse(module_.UTF8ToString(selPtr2))
module_._aegisub_core_free(selPtr2)
console.log('undo textSelection:', JSON.stringify(selState2.textSelection))
if (
  selState2.textSelection.pos !== 0 ||
  selState2.textSelection.start !== 0 ||
  selState2.textSelection.end !== 0
)
  throw new Error('undo textSelection mismatch')

if (module_._aegisub_core_abi_version() < 6) throw new Error('abi version should be >= 6')

// 11. 撤销合并判据（ABI v6 的显式 amend）：
//   同标签 + amend=1 连续提交合并为一个撤销点；命令类（amend=0）各自成点
const cueId = state.document.cues[0].id
function cueText() {
  const ptr = module_._aegisub_document_state_json(doc)
  const value = JSON.parse(module_.UTF8ToString(ptr)).document.cues[0].text
  module_._aegisub_core_free(ptr)
  return value
}
function applyText(text, label, amend) {
  const cmds = cstr(JSON.stringify([{ type: 'updateCue', id: cueId, patch: { text } }]))
  const lbl = cstr(label)
  if (module_._aegisub_document_apply_json(doc, cmds, lbl, amend) !== 0) throw new Error('applyText failed')
  free(cmds)
  free(lbl)
}
const baseText = cueText()
applyText('amend-1', 'amend test', 1)
applyText('amend-2', 'amend test', 1)
if (cueText() !== 'amend-2') throw new Error('amend apply mismatch')
module_._aegisub_document_undo(doc)
console.log('coalesced amend undo ->', cueText())
if (cueText() !== baseText) throw new Error('consecutive amended edits should coalesce into one undo point')

applyText('cmd-1', 'amend test', 0)
applyText('cmd-2', 'amend test', 0)
module_._aegisub_document_undo(doc)
console.log('non-amend undo 1 ->', cueText())
if (cueText() !== 'cmd-1') throw new Error('non-amended commits must be separate undo points')
module_._aegisub_document_undo(doc)
if (cueText() !== baseText) throw new Error('second non-amended undo mismatch')

module_._aegisub_document_destroy(doc)
console.log('\nALL ABI TESTS PASSED')