/**
 * Lua Automation 运行时（对齐 Aegisub auto4_lua.cpp / auto4_lua_assfile.cpp /
 * auto4_lua_progresssink.cpp / auto4_lua_dialog.cpp）。
 *
 * 基于 fengari（浏览器 Lua 5.3 VM）：
 * - loadAutomationScript：建 Lua 状态、注册 aegisub 表（17 个加载期字段）、执行脚本、
 *   收集 register_macro / register_filter 与 warnings；
 * - runAutomationMacro / validateAutomationMacro / isActiveAutomationMacro：以
 *   LuaAssFile 行模型 + userdata 元表暴露 subtitles 对象，脚本改动经
 *   ProcessingComplete 汇总为若干 replaceDocument 提交（每个撤销点一次）；
 * - aegisub.dialog.display / open / save 与 progress.* 通过协程 yield 交还宿主异步渲染。
 *
 * fengari 按需动态加载（首次加载脚本时拉取 Lua VM）。
 *
 * Web 环境的有意偏差：无 aegisub.* 原生模块与 MoonScript（脚本引擎列表只列 Lua *.lua）；
 * aegisub.dialog.open/save 恒返回 nil；text_extents 由宿主 host.textExtents 提供；
 * 无 AssDialogue* 指针，active/selected 用对白行序数表达；__raise_warning 仅在注册期收集；
 * 颜色控件用 <input type=color>（不支持 alpha），LuaConfigDialog 顺序布局而非绝对定位；
 * 单一脚本管理器（无全局/本地之分），Automation Manager 无 Rescan Autoload Dir / Help 按钮，
 * Show Info 为内嵌面板而非 wxMessageBox。
 */

import { getOptionInt, getOptionString } from '../config/options'
import * as karaokeModule from '../core/karaoke'
import {
  dirExists,
  dirname,
  joinPath,
  listTree,
  readTextFile,
  vfsDecode,
  VFS_DIRS,
} from '../storage/vfs'
import {
  buildReplaceDocumentPayload,
  LuaFileModel,
  makeDialogueRow,
  makeInfoRow,
  makeStyleRow,
  type LuaCommitPayload,
  type LuaDialogueRow,
  type LuaRow,
  type LuaStyleRow,
  type StyleRowFields,
} from './luaAssFile'
import {
  dialogReadBackValues,
  parseDialogSpec,
  readBackButton,
  WX_ID,
  type DialogSpec,
  type DialogValue,
} from './luaDialog'

type FengariModule = typeof import('fengari')
let fengariModules: FengariModule | null = null
let lua: any, lauxlib: any, lualib: any, to_luastring: any, to_jsstring: any

async function ensureFengari(): Promise<void> {
  if (fengariModules) return
  fengariModules = await import('fengari')
  ;({ lua, lauxlib, lualib, to_luastring, to_jsstring } = fengariModules as unknown as Record<
    string,
    any
  >)
}

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export interface AutomationMacroInfo {
  /** 命令 id：automation/lua/<脚本名>/<宏名> */
  id: string
  scriptName: string
  name: string
  description: string
  /** 注册时提供的帮助文本（validate 可通过返回值动态改写） */
  help: string
  hasValidate: boolean
  hasIsActive: boolean
}

export interface AutomationFilterInfo {
  name: string
  description: string
  priority: number
  /** 是否提供 config 函数（导出对话框的 Configure 按钮 / run 的 config 表来源） */
  hasConfig: boolean
}

export interface LoadedAutomationScript {
  /** -1 表示加载失败 */
  stateId: number
  name: string
  description: string
  author: string
  version: string
  warnings: string[]
  macros: AutomationMacroInfo[]
  filters: AutomationFilterInfo[]
  loaded: boolean
  /** 加载失败原因（loaded = false 时） */
  error?: string
}

/** 宿主环境回调（视频/音频/配置等由 UI 层提供） */
export interface AutomationHost {
  /** aegisub.dialog.display：渲染配置对话框并回读 */
  showDialog?(spec: DialogSpec): Promise<DialogResponseLike>
  setProgress?(value: number): void
  setTask?(message: string): void
  setTitle?(title: string): void
  isCancelled?(): boolean
  log?(message: string): void
  setStatusText?(text: string): void
  frameFromMs?(ms: number): number | null
  msFromFrame?(frame: number): number | null
  videoSize?(): { width: number; height: number; aspectValue: number; aspectType: number } | null
  keyframes?(): number[] | null
  decodePath?(path: string): string
  textExtents?(
    style: LuaStyleRow,
    text: string,
  ): { width: number; height: number; descent: number; externalLead: number } | null
  getAudioSelection?(): { start: number; end: number } | null
  projectProperties?(): Record<string, unknown> | null
  fileName?(): string | null
  gettext?(message: string): string
  clipboardGet?(): Promise<string>
  clipboardSet?(text: string): Promise<boolean>
}

export interface DialogResponseLike {
  button: number
  values: DialogValue[]
}

export interface AutomationCommitResult {
  payload: {
    info?: Record<string, string>
    styles?: Array<Partial<Omit<import('../core/types').SubtitleStyle, 'id'>>>
    cues: Array<Partial<Omit<import('../core/types').SubtitleCue, 'id'>>>
  }
  label: string
}

export interface AutomationRunResult {
  ok: boolean
  /** 失败原因（ok = false 时；取消时为 'cancelled'） */
  error?: string
  /** 每个撤销点一次 replaceDocument（按序应用） */
  commits: AutomationCommitResult[]
  /** 最终文档中的对白序数（0-based），已排序；null 表示无有效选区 */
  selected: number[] | null
  active: number | null
  /** aegisub.log / debug.out 输出 */
  log: string[]
}

export interface AutomationValidateResult {
  ok: boolean
  help: string | null
  log: string[]
}

export interface AutomationIsActiveResult {
  ok: boolean
  active: boolean
  log: string[]
}

/** 用户取消（aegisub.cancel 或宿主取消） */
class AutomationCancelled extends Error {}

// ---------------------------------------------------------------------------
// 脚本状态
// ---------------------------------------------------------------------------

interface MacroEntry {
  name: string
  description: string
  help: string
  fnRef: number
  validateRef: number | null
  isActiveRef: number | null
}

interface FilterEntry {
  name: string
  description: string
  priority: number
  fnRef: number
  configRef: number | null
}

interface ScriptState {
  id: number
  L: any
  filename: string
  name: string
  description: string
  author: string
  version: string
  warnings: string[]
  macros: MacroEntry[]
  filters: FilterEntry[]
}

let nextStateId = 1
const states = new Map<number, ScriptState>()
/**
 * 运行上下文存在 Lua registry（对应 C++ 的 registry "project_context"）而非 JS Map：
 * 脚本在协程里运行时，C 函数拿到的 lua_State 是协程而非主线程，只有 registry 是共享的。
 */

export function getAutomationState(stateId: number): ScriptState | undefined {
  return states.get(stateId)
}

export function closeAutomationState(stateId: number): void {
  const state = states.get(stateId)
  if (!state) return
  states.delete(stateId)
  try {
    lua.lua_close(state.L)
  } catch {
    /* 关闭失败无需处理 */
  }
}

// ---------------------------------------------------------------------------
// Lua ↔ JS 基础工具
// ---------------------------------------------------------------------------

function raiseError(L: any, message: string): number {
  lauxlib.luaL_error(L, to_luastring('%s'), to_luastring(message))
  return 0
}

function argError(L: any, narg: number, message: string): number {
  lauxlib.luaL_argerror(L, narg, to_luastring(message))
  return 0
}

function luaTypeName(L: any, idx: number): string {
  return to_jsstring(lua.lua_typename(L, lua.lua_type(L, idx)))
}

function typeError(L: any, idx: number, tname: string): number {
  return argError(L, idx, `${tname} expected, got ${luaTypeName(L, idx)}`)
}

function checkString(L: any, idx: number): string {
  if (!lua.lua_isstring(L, idx)) return typeError(L, idx, 'string') as unknown as string
  return to_jsstring(lua.lua_tostring(L, idx))
}

function checkInt(L: any, idx: number): number {
  if (!lua.lua_isnumber(L, idx)) return typeError(L, idx, 'number') as unknown as number
  return Math.trunc(lua.lua_tointeger(L, idx))
}

function checkUint(L: any, idx: number): number {
  if (!lua.lua_isnumber(L, idx)) return typeError(L, idx, 'number') as unknown as number
  const value = Math.trunc(lua.lua_tointeger(L, idx))
  if (value < 0) return argError(L, idx, 'must be >= 0') as unknown as number
  return value
}

function argCheck(L: any, condition: boolean, narg: number, message: string): void {
  if (!condition) argError(L, narg, message)
}

function pushString(L: any, value: string): void {
  lua.lua_pushstring(L, to_luastring(value))
}

function pushBool(L: any, value: boolean): void {
  lua.lua_pushboolean(L, value ? 1 : 0)
}

function pushInt(L: any, value: number): void {
  lua.lua_pushinteger(L, Math.trunc(value))
}

function pushNumber(L: any, value: number): void {
  lua.lua_pushnumber(L, value)
}

/** 表/数组/标量的通用压栈（仅用于简单值；AssEntry 走专用构造） */
function pushJsValue(L: any, value: unknown): void {
  if (value === null || value === undefined) lua.lua_pushnil(L)
  else if (typeof value === 'number') {
    if (Number.isInteger(value)) pushInt(L, value)
    else pushNumber(L, value)
  } else if (typeof value === 'boolean') pushBool(L, value)
  else if (typeof value === 'string') pushString(L, value)
  else if (Array.isArray(value)) {
    lua.lua_newtable(L)
    value.forEach((item, index) => {
      pushJsValue(L, item)
      lua.lua_rawseti(L, -2, index + 1)
    })
  } else if (typeof value === 'object') {
    lua.lua_newtable(L)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      pushJsValue(L, item)
      lua.lua_setfield(L, -2, to_luastring(key))
    }
  } else lua.lua_pushnil(L)
}

function luaToJs(L: any, index: number): unknown {
  const abs = index < 0 ? lua.lua_gettop(L) + index + 1 : index
  switch (lua.lua_type(L, abs)) {
    case lua.LUA_TNIL:
    case lua.LUA_TNONE:
      return null
    case lua.LUA_TBOOLEAN:
      // fengari 的 lua_toboolean 返回 JS 布尔值（非 C API 的 0/1）
      return Boolean(lua.lua_toboolean(L, abs))
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, abs)
    case lua.LUA_TSTRING:
      return to_jsstring(lua.lua_tostring(L, abs))
    case lua.LUA_TTABLE: {
      const result: Record<string, unknown> = {}
      let arrayLike = true
      lua.lua_pushnil(L)
      while (lua.lua_next(L, abs) !== 0) {
        const keyType = lua.lua_type(L, -2)
        if (keyType === lua.LUA_TNUMBER) {
          result[String(lua.lua_tointeger(L, -2))] = luaToJs(L, -1)
        } else if (keyType === lua.LUA_TSTRING) {
          arrayLike = false
          result[to_jsstring(lua.lua_tostring(L, -2))] = luaToJs(L, -1)
        }
        lua.lua_pop(L, 1)
      }
      if (arrayLike) {
        const array: unknown[] = []
        for (let i = 1; i <= Object.keys(result).length; i++) array.push(result[String(i)])
        return array
      }
      return result
    }
    default:
      return null
  }
}

/** lua_for_each：遍历表的所有键值（回调内 stack 为 [.., key, value]） */
function luaForEach(L: any, index: number, cb: () => void): void {
  const abs = index < 0 ? lua.lua_gettop(L) + index + 1 : index
  lua.lua_pushnil(L)
  while (lua.lua_next(L, abs) !== 0) {
    cb()
    lua.lua_pop(L, 1)
  }
}

// ---------------------------------------------------------------------------
// AssEntry 表 → LuaRow（LuaToAssEntry 逐字语义）
// ---------------------------------------------------------------------------

function fieldString(L: any, tableIdx: number, name: string, lineClass: string): string {
  lua.lua_getfield(L, tableIdx, to_luastring(name))
  if (!lua.lua_isstring(L, -1)) {
    lua.lua_pop(L, 1)
    return raiseError(
      L,
      `Invalid or missing field '${name}' in '${lineClass}' class subtitle line (expected string)`,
    ) as unknown as string
  }
  const value = to_jsstring(lua.lua_tostring(L, -1))
  lua.lua_pop(L, 1)
  return value
}

function fieldNumber(L: any, tableIdx: number, name: string, lineClass: string): number {
  lua.lua_getfield(L, tableIdx, to_luastring(name))
  if (!lua.lua_isnumber(L, -1)) {
    lua.lua_pop(L, 1)
    return raiseError(
      L,
      `Invalid or missing field '${name}' in '${lineClass}' class subtitle line (expected number)`,
    ) as unknown as number
  }
  const value = lua.lua_tonumber(L, -1)
  lua.lua_pop(L, 1)
  return value
}

function fieldInt(L: any, tableIdx: number, name: string, lineClass: string): number {
  lua.lua_getfield(L, tableIdx, to_luastring(name))
  if (!lua.lua_isnumber(L, -1)) {
    lua.lua_pop(L, 1)
    return raiseError(
      L,
      `Invalid or missing field '${name}' in '${lineClass}' class subtitle line (expected number)`,
    ) as unknown as number
  }
  const value = Math.trunc(lua.lua_tointeger(L, -1))
  lua.lua_pop(L, 1)
  return value
}

function fieldBool(L: any, tableIdx: number, name: string, lineClass: string): boolean {
  lua.lua_getfield(L, tableIdx, to_luastring(name))
  if (!lua.lua_isboolean(L, -1)) {
    lua.lua_pop(L, 1)
    return raiseError(
      L,
      `Invalid or missing field '${name}' in '${lineClass}' class subtitle line (expected boolean)`,
    ) as unknown as boolean
  }
  const value = Boolean(lua.lua_toboolean(L, -1))
  lua.lua_pop(L, 1)
  return value
}

/** 读表的 extra 字段（lua_for_each：仅字符串键；值经 get_string_or_default） */
function readExtra(L: any, tableIdx: number): Record<string, string> {
  const extra: Record<string, string> = {}
  lua.lua_getfield(L, tableIdx, to_luastring('extra'))
  const type = lua.lua_type(L, -1)
  if (type === lua.LUA_TTABLE) {
    luaForEach(L, -1, () => {
      if (lua.lua_type(L, -2) !== lua.LUA_TSTRING) return
      const key = to_jsstring(lua.lua_tostring(L, -2))
      const value =
        lua.lua_type(L, -1) === lua.LUA_TSTRING
          ? to_jsstring(lua.lua_tostring(L, -1))
          : lua.lua_tolstring(L, -1)
            ? to_jsstring(lua.lua_tolstring(L, -1))
            : '<not a string>'
      extra[key] = value
    })
  } else if (type !== lua.LUA_TNIL) {
    lua.lua_pop(L, 1)
    return raiseError(L, 'dialogue extradata must be a table') as unknown as Record<string, string>
  }
  lua.lua_pop(L, 1)
  return extra
}

/** LuaToAssEntry：tableIdx 处必须是一个 AssEntry 表 */
function luaToRow(L: any, tableIdx: number): LuaRow {
  if (lua.lua_type(L, tableIdx) !== lua.LUA_TTABLE)
    return raiseError(L, "Can't convert a non-table value to AssEntry") as unknown as LuaRow

  lua.lua_getfield(L, tableIdx, to_luastring('class'))
  if (!lua.lua_isstring(L, -1)) {
    lua.lua_pop(L, 1)
    return raiseError(
      L,
      "Table lacks 'class' field, can't convert to AssEntry",
    ) as unknown as LuaRow
  }
  const lineClass = to_jsstring(lua.lua_tostring(L, -1)).toLowerCase()
  lua.lua_pop(L, 1)

  if (lineClass === 'info') {
    return makeInfoRow(
      fieldString(L, tableIdx, 'key', 'info'),
      fieldString(L, tableIdx, 'value', 'info'),
    )
  }
  if (lineClass === 'style') {
    const fields: StyleRowFields = {
      name: fieldString(L, tableIdx, 'name', 'style'),
      fontname: fieldString(L, tableIdx, 'fontname', 'style'),
      fontsize: fieldNumber(L, tableIdx, 'fontsize', 'style'),
      color1: fieldString(L, tableIdx, 'color1', 'style'),
      color2: fieldString(L, tableIdx, 'color2', 'style'),
      color3: fieldString(L, tableIdx, 'color3', 'style'),
      color4: fieldString(L, tableIdx, 'color4', 'style'),
      bold: fieldBool(L, tableIdx, 'bold', 'style'),
      italic: fieldBool(L, tableIdx, 'italic', 'style'),
      underline: fieldBool(L, tableIdx, 'underline', 'style'),
      strikeout: fieldBool(L, tableIdx, 'strikeout', 'style'),
      scale_x: fieldNumber(L, tableIdx, 'scale_x', 'style'),
      scale_y: fieldNumber(L, tableIdx, 'scale_y', 'style'),
      spacing: fieldNumber(L, tableIdx, 'spacing', 'style'),
      angle: fieldNumber(L, tableIdx, 'angle', 'style'),
      borderstyle: fieldInt(L, tableIdx, 'borderstyle', 'style'),
      outline: fieldNumber(L, tableIdx, 'outline', 'style'),
      shadow: fieldNumber(L, tableIdx, 'shadow', 'style'),
      align: fieldInt(L, tableIdx, 'align', 'style'),
      margin_l: fieldInt(L, tableIdx, 'margin_l', 'style'),
      margin_r: fieldInt(L, tableIdx, 'margin_r', 'style'),
      margin_t: fieldInt(L, tableIdx, 'margin_t', 'style'),
      encoding: fieldInt(L, tableIdx, 'encoding', 'style'),
    }
    return makeStyleRow(fields)
  }
  if (lineClass === 'dialogue') {
    const row: LuaDialogueRow = makeDialogueRow({
      comment: fieldBool(L, tableIdx, 'comment', 'dialogue'),
      layer: fieldInt(L, tableIdx, 'layer', 'dialogue'),
      start_time: fieldInt(L, tableIdx, 'start_time', 'dialogue'),
      end_time: fieldInt(L, tableIdx, 'end_time', 'dialogue'),
      style: fieldString(L, tableIdx, 'style', 'dialogue'),
      actor: fieldString(L, tableIdx, 'actor', 'dialogue'),
      margin_l: fieldInt(L, tableIdx, 'margin_l', 'dialogue'),
      margin_r: fieldInt(L, tableIdx, 'margin_r', 'dialogue'),
      margin_t: fieldInt(L, tableIdx, 'margin_t', 'dialogue'),
      effect: fieldString(L, tableIdx, 'effect', 'dialogue'),
      text: fieldString(L, tableIdx, 'text', 'dialogue'),
      extra: {},
    })
    row.extra = readExtra(L, tableIdx)
    return row
  }
  return raiseError(L, `Found line with unknown class: ${lineClass}`) as unknown as LuaRow
}

// ---------------------------------------------------------------------------
// AssEntry → Lua 表（AssEntryToLua）
// ---------------------------------------------------------------------------

function setField(L: any, name: string, push: () => void): void {
  push()
  lua.lua_setfield(L, -2, to_luastring(name))
}

function pushRowTable(L: any, row: LuaRow): void {
  lua.lua_newtable(L)
  if (row.class === 'info') {
    setField(L, 'section', () => pushString(L, row.section))
    setField(L, 'raw', () => pushString(L, row.raw))
    setField(L, 'key', () => pushString(L, row.key))
    setField(L, 'value', () => pushString(L, row.value))
    setField(L, 'class', () => pushString(L, 'info'))
    return
  }
  if (row.class === 'style') {
    setField(L, 'section', () => pushString(L, row.section))
    setField(L, 'raw', () => pushString(L, row.raw))
    setField(L, 'name', () => pushString(L, row.name))
    setField(L, 'fontname', () => pushString(L, row.fontname))
    setField(L, 'fontsize', () => pushNumber(L, row.fontsize))
    setField(L, 'color1', () => pushString(L, row.color1))
    setField(L, 'color2', () => pushString(L, row.color2))
    setField(L, 'color3', () => pushString(L, row.color3))
    setField(L, 'color4', () => pushString(L, row.color4))
    setField(L, 'bold', () => pushBool(L, row.bold))
    setField(L, 'italic', () => pushBool(L, row.italic))
    setField(L, 'underline', () => pushBool(L, row.underline))
    setField(L, 'strikeout', () => pushBool(L, row.strikeout))
    setField(L, 'scale_x', () => pushNumber(L, row.scale_x))
    setField(L, 'scale_y', () => pushNumber(L, row.scale_y))
    setField(L, 'spacing', () => pushNumber(L, row.spacing))
    setField(L, 'angle', () => pushNumber(L, row.angle))
    setField(L, 'borderstyle', () => pushInt(L, row.borderstyle))
    setField(L, 'outline', () => pushNumber(L, row.outline))
    setField(L, 'shadow', () => pushNumber(L, row.shadow))
    setField(L, 'align', () => pushInt(L, row.align))
    setField(L, 'margin_l', () => pushInt(L, row.margin_l))
    setField(L, 'margin_r', () => pushInt(L, row.margin_r))
    setField(L, 'margin_t', () => pushInt(L, row.margin_t))
    setField(L, 'margin_b', () => pushInt(L, row.margin_b))
    setField(L, 'encoding', () => pushInt(L, row.encoding))
    setField(L, 'relative_to', () => pushInt(L, row.relative_to))
    setField(L, 'class', () => pushString(L, 'style'))
    return
  }
  setField(L, 'section', () => pushString(L, row.section))
  setField(L, 'raw', () => pushString(L, row.raw))
  setField(L, 'comment', () => pushBool(L, row.comment))
  setField(L, 'layer', () => pushInt(L, row.layer))
  setField(L, 'start_time', () => pushInt(L, row.start_time))
  setField(L, 'end_time', () => pushInt(L, row.end_time))
  setField(L, 'style', () => pushString(L, row.style))
  setField(L, 'actor', () => pushString(L, row.actor))
  setField(L, 'effect', () => pushString(L, row.effect))
  setField(L, 'margin_l', () => pushInt(L, row.margin_l))
  setField(L, 'margin_r', () => pushInt(L, row.margin_r))
  setField(L, 'margin_t', () => pushInt(L, row.margin_t))
  setField(L, 'margin_b', () => pushInt(L, row.margin_b))
  setField(L, 'text', () => pushString(L, row.text))
  lua.lua_newtable(L)
  for (const [key, value] of Object.entries(row.extra)) {
    pushString(L, value)
    lua.lua_setfield(L, -2, to_luastring(key))
  }
  lua.lua_setfield(L, -2, to_luastring('extra'))
  setField(L, 'class', () => pushString(L, 'dialogue'))
}

// ---------------------------------------------------------------------------
// 错误处理（add_stack_trace）
// ---------------------------------------------------------------------------

function addStackTrace(L2: any): number {
  let level = 1
  if (lua.lua_isnumber(L2, 2)) {
    level = Math.trunc(lua.lua_tointeger(L2, 2))
    lua.lua_pop(L2, 1)
  }
  // 非字符串错误（如表、lightuserdata）原样返回
  if (lua.lua_type(L2, 1) !== lua.LUA_TSTRING) return 1

  let message = to_jsstring(lua.lua_tostring(L2, 1))
  message = message.replace(/^\[string ".*"\]:[0-9]+: /, '')
  const frames: string[] = [message]

  const ar = new lua.lua_Debug()
  while (lua.lua_getstack(L2, level++, ar)) {
    lua.lua_getinfo(L2, 'Snl', ar)
    const what = ar.what ? to_jsstring(ar.what) : ''
    if (what[0] === 't') {
      frames.push('(tail call)')
      continue
    }
    let file = ar.source ? to_jsstring(ar.source) : ''
    // fengari 的 JS 实现 C 函数帧（=[JS] / what='J'）不进 traceback
    if (what[0] === 'J' || file === '=[JS]') continue
    if (file === '=[C]') file = '<C function>'
    const name = ar.name ? to_jsstring(ar.name) : ''
    const namewhat = ar.namewhat ? to_jsstring(ar.namewhat) : ''
    let fn: string
    if (what[0] === 'm') fn = '<main>'
    else if (what[0] === 'C') fn = '?'
    else if (!namewhat)
      fn = `<anonymous function at lines ${ar.linedefined}-${ar.lastlinedefined - 1}>`
    else fn = name
    frames.push(`    File "${file}", line ${ar.currentline}\n${fn}`)
  }
  pushString(L2, frames.reverse().join('\n'))
  return 1
}

// ---------------------------------------------------------------------------
// 运行上下文（project_context + progress sink）
// ---------------------------------------------------------------------------

interface RunContext {
  host: AutomationHost
  model: LuaFileModel
  /** 当前行快照（用于 project_properties 等） */
  rows: LuaRow[]
  /** 0-based 对白序数 */
  selected: number[]
  active: number
  activeLineOrdinal: number | null
  canModify: boolean
  canSetUndo: boolean
  log: string[]
  cancelled: boolean
  /** 宿主取消标记 */
  hostCancelled: boolean
  /** 无进度对话框（validate/isactive/过滤器） */
  silent: boolean
}

const CANCEL_MARKER = {}
const TRACE_LEVEL_FALLBACK = 3

function traceLevel(): number {
  try {
    return getOptionInt('Automation/Trace Level')
  } catch {
    return TRACE_LEVEL_FALLBACK
  }
}

function currentContext(L: any): RunContext | null {
  lua.lua_getfield(L, lua.LUA_REGISTRYINDEX, to_luastring('project_context'))
  const context =
    lua.lua_type(L, -1) === lua.LUA_TLIGHTUSERDATA
      ? (lua.lua_touserdata(L, -1) as RunContext)
      : null
  lua.lua_pop(L, 1)
  return context
}

function setContext(L: any, context: RunContext | null): void {
  lua.lua_pushlightuserdata(L, context)
  lua.lua_setfield(L, lua.LUA_REGISTRYINDEX, to_luastring('project_context'))
}

function makeLog(context: RunContext, message: string): void {
  context.log.push(message)
  context.host.log?.(message)
}

// ---------------------------------------------------------------------------
// subtitles userdata
// ---------------------------------------------------------------------------

/** GetObjPointer(allow_expired=false)：ProcessingComplete/Cancel 之后对象即失效 */
function modelFromUpvalue(L2: any): LuaFileModel {
  const ud = lua.lua_touserdata(L2, lua.lua_upvalueindex(1))
  const model = ud.model as LuaFileModel
  if (!model.valid)
    return raiseError(L2, 'Subtitles object is no longer valid') as unknown as LuaFileModel
  return model
}

const SUBS_METHODS: Record<string, (L2: any) => number> = {
  delete(L2: any) {
    const model = modelFromUpvalue(L2)
    if (!model.canModify)
      return raiseError(L2, 'Attempt to modify subtitles in read-only feature context.')
    const top = lua.lua_gettop(L2)
    if (top === 0) return 0
    const ids: number[] = []
    if (top === 1 && lua.lua_type(L2, 1) === lua.LUA_TTABLE) {
      luaForEach(L2, 1, () => {
        const n = checkUint(L2, -1)
        argCheck(L2, n > 0 && n <= model.rows.length, 1, 'Out of range line index')
        ids.push(n)
      })
    } else {
      let remaining = top
      while (remaining > 0) {
        const n = checkUint(L2, -1)
        argCheck(L2, n > 0 && n <= model.rows.length, remaining, 'Out of range line index')
        ids.push(n)
        lua.lua_pop(L2, 1)
        remaining--
      }
    }
    model.removeAt(ids)
    return 0
  },
  deleterange(L2: any) {
    const model = modelFromUpvalue(L2)
    if (!model.canModify)
      return raiseError(L2, 'Attempt to modify subtitles in read-only feature context.')
    const first = checkUint(L2, 1)
    const last = checkUint(L2, 2)
    model.deleteRange(first, last)
    return 0
  },
  insert(L2: any) {
    const model = modelFromUpvalue(L2)
    if (!model.canModify)
      return raiseError(L2, 'Attempt to modify subtitles in read-only feature context.')
    const before = checkUint(L2, 1)
    argCheck(L2, before > 0 && before <= model.rows.length + 1, 1, 'Out of range line index')
    const top = lua.lua_gettop(L2)
    const newRows: LuaRow[] = []
    for (let i = 2; i <= top; i++) newRows.push(luaToRow(L2, i))
    if (before === model.rows.length + 1) model.appendRows(newRows)
    else model.insertRows(before, newRows)
    return 0
  },
  append(L2: any) {
    const model = modelFromUpvalue(L2)
    if (!model.canModify)
      return raiseError(L2, 'Attempt to modify subtitles in read-only feature context.')
    const top = lua.lua_gettop(L2)
    const newRows: LuaRow[] = []
    for (let i = 1; i <= top; i++) newRows.push(luaToRow(L2, i))
    model.appendRows(newRows)
    return 0
  },
  script_resolution(L2: any) {
    const model = modelFromUpvalue(L2)
    const resolution = model.resolution()
    pushNumber(L2, resolution.width)
    pushNumber(L2, resolution.height)
    return 2
  },
}

function subsIndexRead(L2: any): number {
  const model = modelFromUpvalue(L2)
  const keyType = lua.lua_type(L2, 2)
  if (keyType === lua.LUA_TNUMBER) {
    const idx = Math.trunc(lua.lua_tointeger(L2, 2))
    if (idx <= 0 || idx > model.rows.length)
      return raiseError(L2, `Requested out-of-range line from subtitle file: ${idx}`)
    pushRowTable(L2, model.rows[idx - 1])
    return 1
  }
  if (keyType === lua.LUA_TSTRING) {
    const key = to_jsstring(lua.lua_tostring(L2, 2))
    if (key === 'n') {
      pushNumber(L2, model.rows.length)
      return 1
    }
    const method = SUBS_METHODS[key]
    if (!method) return raiseError(L2, `Invalid indexing in Subtitle File object: '${key}'`)
    lua.lua_pushvalue(L2, lua.lua_upvalueindex(1))
    lua.lua_pushcclosure(L2, method, 1)
    return 1
  }
  return raiseError(
    L2,
    `Attempt to index a Subtitle File object with value of type '${luaTypeName(L2, 2)}'.`,
  )
}

function subsIndexWrite(L2: any): number {
  const model = modelFromUpvalue(L2)
  if (!model.canModify)
    return raiseError(L2, 'Attempt to modify subtitles in read-only feature context.')
  const n = checkInt(L2, 2)
  const isNil = lua.lua_type(L2, 3) === lua.LUA_TNIL

  if (n < 0) {
    const before = -n
    argCheck(L2, before > 0 && before <= model.rows.length + 1, 1, 'Out of range line index')
    model.insertRows(before, [luaToRow(L2, 3)])
    return 0
  }
  if (n === 0) {
    model.appendRows([luaToRow(L2, 3)])
    return 0
  }
  if (!isNil) {
    if (n > model.rows.length)
      return raiseError(L2, `Requested out-of-range line from subtitle file: ${n}`)
    const row = luaToRow(L2, 3)
    model.indexWrite(n, row)
    return 0
  }
  argCheck(L2, n > 0 && n <= model.rows.length, 1, 'Out of range line index')
  model.removeAt([n])
  return 0
}

function subsLen(L2: any): number {
  pushNumber(L2, modelFromUpvalue(L2).rows.length)
  return 1
}

function subsIPairs(L2: any): number {
  lua.lua_pushvalue(L2, lua.lua_upvalueindex(1))
  lua.lua_pushcclosure(L2, subsIterNext, 1)
  lua.lua_pushnil(L2)
  pushInt(L2, 0)
  return 3
}

function subsIterNext(L2: any): number {
  const model = modelFromUpvalue(L2)
  const i = checkUint(L2, 2)
  if (i >= model.rows.length) {
    lua.lua_pushnil(L2)
    return 1
  }
  pushInt(L2, i + 1)
  pushRowTable(L2, model.rows[i])
  return 2
}

/**
 * 创建 subtitles userdata（含元表与 aegisub.parse_karaoke_data / set_undo_point），
 * 返回其绝对栈索引；栈净增 1（userdata）。
 */
function createSubtitlesUserdata(L: any, model: LuaFileModel): number {
  const ud = lua.lua_newuserdata(L, 8)
  ud.model = model
  const udIndex = lua.lua_gettop(L)

  lua.lua_newtable(L)
  const mtIndex = lua.lua_gettop(L)
  const setMeta = (name: string, fn: (L2: any) => number) => {
    lua.lua_pushvalue(L, udIndex)
    lua.lua_pushcclosure(L, fn, 1)
    lua.lua_setfield(L, mtIndex, to_luastring(name))
  }
  setMeta('__index', subsIndexRead)
  setMeta('__newindex', subsIndexWrite)
  setMeta('__len', subsLen)
  setMeta('__gc', () => 0)
  setMeta('__ipairs', subsIPairs)
  lua.lua_setmetatable(L, udIndex)

  lua.lua_getglobal(L, to_luastring('aegisub'))
  lua.lua_pushvalue(L, udIndex)
  lua.lua_pushcclosure(L, parseKaraokeData, 1)
  lua.lua_setfield(L, -2, to_luastring('parse_karaoke_data'))
  lua.lua_pushvalue(L, udIndex)
  lua.lua_pushcclosure(L, setUndoPoint, 1)
  lua.lua_setfield(L, -2, to_luastring('set_undo_point'))
  lua.lua_pop(L, 1)

  return udIndex
}

/** aegisub.parse_karaoke_data（subtitles 表 → 音节表） */
function parseKaraokeData(L2: any): number {
  const row = luaToRow(L2, 1)
  if (row.class !== 'dialogue') return argError(L2, 1, 'Subtitle line must be a dialogue line')
  const dialogue = row as LuaDialogueRow
  const karaoke = karaokeModule.parseKaraokeSyllables(dialogue.text, dialogue.start_time)

  lua.lua_newtable(L2)
  const pushSyllable = (syllable: {
    duration: number
    startTime: number
    endTime: number
    tagType: string
    text: string
    textStripped: string
  }) => {
    lua.lua_newtable(L2)
    setField(L2, 'duration', () => pushInt(L2, syllable.duration))
    setField(L2, 'start_time', () => pushInt(L2, syllable.startTime))
    setField(L2, 'end_time', () => pushInt(L2, syllable.endTime))
    setField(L2, 'tag', () => pushString(L2, syllable.tagType))
    setField(L2, 'text', () => pushString(L2, syllable.text))
    setField(L2, 'text_stripped', () => pushString(L2, syllable.textStripped))
    return 1
  }

  // 2.1.x 兼容：0 号位空音节
  lua.lua_newtable(L2)
  setField(L2, 'duration', () => pushInt(L2, 0))
  setField(L2, 'start_time', () => pushInt(L2, 0))
  setField(L2, 'end_time', () => pushInt(L2, 0))
  setField(L2, 'tag', () => pushString(L2, ''))
  setField(L2, 'text', () => pushString(L2, ''))
  setField(L2, 'text_stripped', () => pushString(L2, ''))
  lua.lua_rawseti(L2, -2, 0)

  let index = 1
  for (const syllable of karaoke) {
    pushSyllable({
      duration: syllable.durationMs,
      startTime: syllable.startMs - dialogue.start_time,
      endTime: syllable.startMs + syllable.durationMs - dialogue.start_time,
      tagType: syllable.tagType,
      // syl.GetText(false)：覆盖标签按偏移插回；syl.text 为去标签的纯文本
      text: karaokeModule.syllableGetText(syllable, false),
      textStripped: syllable.text,
    })
    lua.lua_rawseti(L2, -2, index++)
  }
  return 1
}

/** aegisub.set_undo_point（LuaSetUndoPoint） */
function setUndoPoint(L2: any): number {
  const model = modelFromUpvalue(L2)
  if (!model.canSetUndo)
    return raiseError(
      L2,
      'Attempt to set an undo point in a context where it makes no sense to do so.',
    )
  if (!model.modificationType) return 0
  model.setUndoPoint(checkString(L2, 1))
  return 0
}

// ---------------------------------------------------------------------------
// 进度/日志/对话框（LuaProgressSink）
// ---------------------------------------------------------------------------

interface YieldTask {
  (co: any): Promise<number>
}

function yieldToHost(L: any, task: YieldTask): number {
  lua.lua_pushlightuserdata(L, task)
  return lua.lua_yield(L, 1)
}

/** 宿主取消时抛出（协程被宿主循环直接放弃，不进入 Lua 错误通道） */
function throwCancelled(): never {
  throw new AutomationCancelled('cancelled')
}

function makeProgressSink(L: any): void {
  const setProgress = (L2: any): number => {
    const current = currentContext(L2)
    if (!current) return 0
    current.host.setProgress?.(lua.lua_tonumber(L2, 1))
    return 0
  }
  const setTask = (L2: any): number => {
    const current = currentContext(L2)
    if (!current) return 0
    current.host.setTask?.(checkString(L2, 1))
    return 0
  }
  const setTitle = (L2: any): number => {
    const current = currentContext(L2)
    if (!current) return 0
    current.host.setTitle?.(checkString(L2, 1))
    return 0
  }
  const getCancelled = (L2: any): number => {
    const current = currentContext(L2)
    pushBool(L2, !!current && (current.hostCancelled || (current.host.isCancelled?.() ?? false)))
    return 1
  }
  const debugOut = (L2: any): number => {
    const current = currentContext(L2)
    if (!current) return 0
    if (lua.lua_type(L2, 1) === lua.LUA_TNUMBER) {
      if (Math.trunc(lua.lua_tointeger(L2, 1)) > traceLevel()) return 0
      lua.lua_remove(L2, 1)
    }
    if (lua.lua_gettop(L2) > 1) {
      lua.lua_getglobal(L2, to_luastring('string'))
      lua.lua_getfield(L2, -1, to_luastring('format'))
      lua.lua_remove(L2, -2)
      lua.lua_insert(L2, 1)
      const status = lua.lua_pcall(L2, lua.lua_gettop(L2) - 1, 1, 0)
      if (status !== 0) {
        // format 失败：luaL_where(1) + 错误信息 concat 后抛回脚本
        return raiseError(
          L2,
          lua.lua_type(L2, -1) === lua.LUA_TSTRING
            ? to_jsstring(lua.lua_tostring(L2, -1))
            : 'bad format',
        )
      }
    }
    makeLog(current, checkString(L2, 1))
    return 0
  }
  const displayDialog = (L2: any): number => {
    const current = currentContext(L2)
    if (!current) return raiseError(L2, 'aegisub.dialog.display is not available')
    let spec: DialogSpec
    try {
      spec = parseDialogSpec(luaToJs(L2, 1), luaToJs(L2, 2), luaToJs(L2, 3))
    } catch (error) {
      return raiseError(L2, error instanceof Error ? error.message : String(error))
    }
    return yieldToHost(L2, async (co) => {
      if (!current.host.showDialog) throwCancelled()
      const response = await current.host.showDialog!(spec)
      if (current.hostCancelled) throwCancelled()
      const values = dialogReadBackValues(spec.controls, response.values)
      const button = readBackButton(spec.buttons, response.button)
      pushJsValue(co, button)
      lua.lua_newtable(co)
      spec.controls.forEach((control, index) => {
        pushJsValue(co, values[index])
        lua.lua_setfield(co, -2, to_luastring(control.name))
      })
      return 2
    })
  }
  const displayOpenDialog = (L2: any): number => {
    // C++：参数 1-4 check_wxstring、5 multiple、6 must_exist(toboolean(6) || isnil(6))
    checkString(L2, 1)
    checkString(L2, 2)
    checkString(L2, 3)
    checkString(L2, 4)
    // Web 版无文件系统（wxFileDialog 无对应物）：始终取消
    return yieldToHost(L2, async (co) => {
      lua.lua_pushnil(co)
      return 1
    })
  }
  const displaySaveDialog = (L2: any): number => {
    checkString(L2, 1)
    checkString(L2, 2)
    checkString(L2, 3)
    checkString(L2, 4)
    // Web 版无文件系统：始终取消
    return yieldToHost(L2, async (co) => {
      lua.lua_pushnil(co)
      return 1
    })
  }

  lua.lua_getglobal(L, to_luastring('aegisub'))

  lua.lua_newtable(L)
  lua.lua_pushcfunction(L, setProgress)
  lua.lua_setfield(L, -2, to_luastring('set'))
  lua.lua_pushcfunction(L, setTask)
  lua.lua_setfield(L, -2, to_luastring('task'))
  lua.lua_pushcfunction(L, setTitle)
  lua.lua_setfield(L, -2, to_luastring('title'))
  lua.lua_pushcfunction(L, getCancelled)
  lua.lua_setfield(L, -2, to_luastring('is_cancelled'))
  lua.lua_setfield(L, -2, to_luastring('progress'))

  lua.lua_newtable(L)
  lua.lua_pushcfunction(L, debugOut)
  lua.lua_setfield(L, -2, to_luastring('out'))
  lua.lua_setfield(L, -2, to_luastring('debug'))

  lua.lua_pushcfunction(L, debugOut)
  lua.lua_setfield(L, -2, to_luastring('log'))

  lua.lua_newtable(L)
  lua.lua_pushcfunction(L, displayDialog)
  lua.lua_setfield(L, -2, to_luastring('display'))
  lua.lua_pushcfunction(L, displayOpenDialog)
  lua.lua_setfield(L, -2, to_luastring('open'))
  lua.lua_pushcfunction(L, displaySaveDialog)
  lua.lua_setfield(L, -2, to_luastring('save'))
  lua.lua_setfield(L, -2, to_luastring('dialog'))

  lua.lua_pop(L, 1)
}

/**
 * LuaProgressSink 析构：移除 aegisub.progress / aegisub.debug（以及 registry 的
 * progress_sink），但 aegisub.log 与 aegisub.dialog 保留（源码如此）。
 */
function removeProgressSink(L: any): void {
  lua.lua_getglobal(L, to_luastring('aegisub'))
  lua.lua_pushnil(L)
  lua.lua_setfield(L, -2, to_luastring('progress'))
  lua.lua_pushnil(L)
  lua.lua_setfield(L, -2, to_luastring('debug'))
  lua.lua_pop(L, 1)
  lua.lua_pushnil(L)
  lua.lua_setfield(L, lua.LUA_REGISTRYINDEX, to_luastring('progress_sink'))
}

// ---------------------------------------------------------------------------
// 加载脚本
// ---------------------------------------------------------------------------

/** Lua 5.3 VM 上补 Aegisub（Lua 5.1/LuaJIT）依赖的特性 */
const PRELUDE = `
local __raw_ipairs = ipairs
function ipairs(t)
  local mt = getmetatable(t)
  if type(mt) == 'table' and mt.__ipairs then return mt.__ipairs(t) end
  return __raw_ipairs(t)
end
if not table.getn then table.getn = function(t) return #t end end
if not table.maxn then table.maxn = function(t)
  local m = 0
  for k in pairs(t) do if type(k) == 'number' and k > m then m = k end end
  return m
end end
if not unpack then unpack = table.unpack end
if not loadstring then loadstring = load end
if not string.gfind then string.gfind = string.gmatch end
if not math.mod then math.mod = math.fmod end
if not math.log10 then math.log10 = function(x) return math.log(x, 10) end end
`

function stem(filename: string): string {
  return (
    filename
      .replace(/\.(lua|moon)$/i, '')
      .split(/[\\/]/)
      .pop() || filename
  )
}

function prettyFilename(filename: string): string {
  return filename.split(/[\\/]/).pop() || filename
}

/** UTF-8 BOM（源码 script_reader.cpp L41-45 的 `-17 -69 -65`） */
const UTF8_BOM = 0xfeff

/**
 * 去掉脚本开头的 UTF-8 BOM。
 * 对齐 agi::lua::LoadFile（script_reader.cpp）：luaL_loadbuffer 不认识 BOM，
 * 而 Aegisub 自带的 Lua/MoonScript 脚本大量以 BOM 开头（无此步会报
 * 「unexpected symbol near '<\239>'」）。
 */
function stripLoaderBom(code: string): string {
  return code.charCodeAt(0) === UTF8_BOM ? code.slice(1) : code
}

// ---------------------------------------------------------------------------
// include()：从 VFS 解析（auto4_lua.cpp LuaInclude L645-672 / auto4_base.cpp
// Script 构造 L254-265 的 include_path）
// ---------------------------------------------------------------------------

/**
 * include 文件内容缓存（key = 虚拟绝对路径）。
 * includeFn 是同步 C 函数而 VFS 读取是异步，且脚本加载期 lua_pcall 无协程
 * （yieldToHost 会因「yield from outside a coroutine」报错），故在加载脚本前
 * 一次性预载搜索路径下的全部文本文件。
 */
const includeCache = new Map<string, { mtime: number; code: string }>()

/**
 * 预载 include 搜索路径：脚本自身父目录 + Path/Automation/Include 各目录
 * （auto4_base.cpp L257-264：解码令牌、须为绝对路径且目录存在；web 便携模式下
 * ?user/?data 同根，两个默认目录去重为 /automation/include）。
 * 返回搜索顺序数组（index 0 = 脚本父目录）。
 */
async function refreshIncludeCache(scriptDir: string): Promise<string[]> {
  const dirs: string[] = [scriptDir]
  for (const token of getOptionString('Path/Automation/Include').split('|')) {
    const trimmed = token.trim()
    if (!trimmed) continue
    const decoded = vfsDecode(trimmed)
    if (!decoded.startsWith('/') || dirs.includes(decoded)) continue
    dirs.push(decoded)
  }
  try {
    for (const dir of dirs) {
      // oxlint-disable-next-line no-await-in-loop -- 搜索路径很短，逐个枚举
      if (dir !== '/' && !(await dirExists(dir))) continue
      // oxlint-disable-next-line no-await-in-loop -- 同上
      const entries = await listTree(dir)
      for (const entry of entries) {
        if (entry.directory) continue
        const cached = includeCache.get(entry.path)
        if (cached && cached.mtime === entry.mtime) continue
        // oxlint-disable-next-line no-await-in-loop -- 逐个读取变化文件
        const code = entry.text ?? (await readTextFile(entry.path))
        if (code !== null) includeCache.set(entry.path, { mtime: entry.mtime, code })
      }
    }
  } catch {
    // 无 IndexedDB（Node 单测）：缓存保持为空，include 退化为 not found
  }
  return dirs
}

function testIncludeSeparator(name: string): boolean {
  return name.includes('/') || name.includes('\\')
}

/**
 * LuaInclude L650-661：名称含 '/' 或 '\' 时按脚本父目录相对解析（存在即用，
 * 不做回退）；纯文件名时依次在搜索路径中查找，命中第一个即止。
 */
function resolveIncludePath(name: string, dirs: string[]): string | null {
  if (testIncludeSeparator(name)) {
    const candidate = joinPath(dirs[0], name)
    return includeCache.has(candidate) ? candidate : null
  }
  for (const dir of dirs) {
    const candidate = joinPath(dir, name)
    if (includeCache.has(candidate)) return candidate
  }
  return null
}

function readGlobalString(L: any, name: string): string {
  lua.lua_getglobal(L, to_luastring(name))
  const value = lua.lua_isstring(L, -1) ? to_jsstring(lua.lua_tostring(L, -1)) : ''
  lua.lua_pop(L, 1)
  return value
}

export async function loadAutomationScript(
  code: string,
  filename: string,
): Promise<LoadedAutomationScript> {
  await ensureFengari()
  const L = lauxlib.luaL_newstate()
  const scriptStem = stem(filename)
  const pretty = prettyFilename(filename)
  // filename 现为虚拟绝对路径（/automation/autoload/x.lua）；纯文件名时退回 autoload 目录
  const scriptDir = testIncludeSeparator(filename) ? dirname(filename) : VFS_DIRS.automationAutoload

  const fail = (message: string): LoadedAutomationScript => {
    try {
      lua.lua_close(L)
    } catch {
      /* ignore */
    }
    return {
      stateId: -1,
      name: pretty,
      description: message,
      author: '',
      version: '',
      warnings: [],
      macros: [],
      filters: [],
      loaded: false,
      error: message,
    }
  }

  try {
    lualib.luaL_openlibs(L)
    if (lauxlib.luaL_dostring(L, to_luastring(PRELUDE)) !== 0) {
      const message = to_jsstring(lua.lua_tostring(L, -1))
      return fail(message || 'Failed to initialise Lua runtime')
    }

    // include 内容预载：同步 C 函数无法 await，须在执行脚本本体前完成
    const includeDirs = await refreshIncludeCache(scriptDir)

    const state: ScriptState = {
      id: nextStateId++,
      L,
      filename,
      name: '',
      description: '',
      author: '',
      version: '',
      warnings: [],
      macros: [],
      filters: [],
    }
    states.set(state.id, state)

    // registry: filename / warnings
    pushString(L, scriptStem)
    lua.lua_setfield(L, lua.LUA_REGISTRYINDEX, to_luastring('filename'))
    lua.lua_newtable(L)
    lua.lua_setfield(L, lua.LUA_REGISTRYINDEX, to_luastring('warnings'))

    // ---- aegisub 表（加载期 17 字段）----
    lua.lua_newtable(L)

    const registerMacro = (L2: any): number => {
      const display = checkString(L2, 1)
      const help = checkString(L2, 2)
      if (lua.lua_type(L2, 3) !== lua.LUA_TFUNCTION)
        return raiseError(L2, 'The macro processing function must be a function')
      lua.lua_pushvalue(L2, 3)
      const fnRef = lauxlib.luaL_ref(L2, lua.LUA_REGISTRYINDEX)
      let validateRef: number | null = null
      let isActiveRef: number | null = null
      if (lua.lua_type(L2, 4) === lua.LUA_TFUNCTION) {
        lua.lua_pushvalue(L2, 4)
        validateRef = lauxlib.luaL_ref(L2, lua.LUA_REGISTRYINDEX)
      }
      if (lua.lua_type(L2, 5) === lua.LUA_TFUNCTION) {
        lua.lua_pushvalue(L2, 5)
        isActiveRef = lauxlib.luaL_ref(L2, lua.LUA_REGISTRYINDEX)
      }
      if (state.macros.some((macro) => macro.name === display))
        return raiseError(L2, `A macro named '${display}' is already defined in script '${pretty}'`)
      state.macros.push({ name: display, description: help, help, fnRef, validateRef, isActiveRef })
      return 0
    }

    const registerFilter = (L2: any): number => {
      const name = checkString(L2, 1)
      const description = lua.lua_isstring(L2, 2) ? to_jsstring(lua.lua_tostring(L2, 2)) : ''
      const priority = lua.lua_isnumber(L2, 3) ? Math.trunc(lua.lua_tointeger(L2, 3)) : 0
      if (lua.lua_type(L2, 4) !== lua.LUA_TFUNCTION)
        return raiseError(L2, 'The filter processing function must be a function')
      lua.lua_pushvalue(L2, 4)
      const fnRef = lauxlib.luaL_ref(L2, lua.LUA_REGISTRYINDEX)
      // config 函数可选（LuaExportFilter：has_config = lua_isfunction(L, 5)）
      let configRef: number | null = null
      if (lua.lua_type(L2, 5) === lua.LUA_TFUNCTION) {
        lua.lua_pushvalue(L2, 5)
        configRef = lauxlib.luaL_ref(L2, lua.LUA_REGISTRYINDEX)
      }
      state.filters.push({ name, description, priority, fnRef, configRef })
      return 0
    }

    const textExtents = (L2: any): number => {
      argCheck(L2, lua.lua_type(L2, 1) === lua.LUA_TTABLE, 1, '')
      argCheck(L2, lua.lua_isstring(L2, 2), 2, '')
      lua.lua_getfield(L2, 1, to_luastring('class'))
      const actualClass = lua.lua_isstring(L2, -1)
        ? to_jsstring(lua.lua_tostring(L2, -1)).toLowerCase()
        : ''
      lua.lua_pop(L2, 1)
      if (actualClass !== 'style') return raiseError(L2, 'Not a style entry')
      const row = luaToRow(L2, 1)
      if (row.class !== 'style') return raiseError(L2, 'Not a style entry')
      const text = checkString(L2, 2)
      const context = currentContext(L2)
      const result = context?.host.textExtents?.(row, text) ?? null
      if (!result) return raiseError(L2, 'Some internal error occurred calculating text_extents')
      pushNumber(L2, result.width)
      pushNumber(L2, result.height)
      pushNumber(L2, result.descent)
      pushNumber(L2, result.externalLead)
      return 4
    }

    const frameFromMs = (L2: any): number => {
      const ms = Math.trunc(lua.lua_tointeger(L2, -1))
      lua.lua_pop(L2, 1)
      const context = currentContext(L2)
      const value = context ? context.host.frameFromMs?.(ms) : undefined
      if (value == null) lua.lua_pushnil(L2)
      else pushInt(L2, value)
      return 1
    }
    const msFromFrame = (L2: any): number => {
      const frame = Math.trunc(lua.lua_tointeger(L2, -1))
      lua.lua_pop(L2, 1)
      const context = currentContext(L2)
      const value = context ? context.host.msFromFrame?.(frame) : undefined
      if (value == null) lua.lua_pushnil(L2)
      else pushInt(L2, value)
      return 1
    }
    const videoSize = (L2: any): number => {
      const context = currentContext(L2)
      const size = context?.host.videoSize?.() ?? null
      if (!size) {
        lua.lua_pushnil(L2)
        return 1
      }
      pushInt(L2, size.width)
      pushInt(L2, size.height)
      pushNumber(L2, size.aspectValue)
      pushInt(L2, size.aspectType)
      return 4
    }
    const keyframes = (L2: any): number => {
      const context = currentContext(L2)
      const frames = context?.host.keyframes?.() ?? null
      if (!frames) {
        lua.lua_pushnil(L2)
        return 1
      }
      pushJsValue(L2, frames)
      return 1
    }
    const decodePath = (L2: any): number => {
      const path = checkString(L2, 1)
      const context = currentContext(L2)
      pushString(L2, context?.host.decodePath?.(path) ?? path)
      return 1
    }
    const cancelScript = (L2: any): number => {
      const context = currentContext(L2)
      if (context) context.cancelled = true
      lua.lua_pushlightuserdata(L2, CANCEL_MARKER)
      return lua.lua_error(L2)
    }
    const fileMame = (L2: any): number => {
      const context = currentContext(L2)
      const name = context?.host.fileName?.() ?? null
      if (name) pushString(L2, name)
      else lua.lua_pushnil(L2)
      return 1
    }
    const getText = (L2: any): number => {
      const message = checkString(L2, 1)
      const context = currentContext(L2)
      pushString(L2, context?.host.gettext?.(message) ?? message)
      return 1
    }
    const projectProperties = (L2: any): number => {
      const context = currentContext(L2)
      const properties = context?.host.projectProperties?.() ?? null
      if (!properties) {
        lua.lua_pushnil(L2)
        return 1
      }
      pushJsValue(L2, properties)
      return 1
    }
    const getAudioSelection = (L2: any): number => {
      const context = currentContext(L2)
      const range = context?.host.getAudioSelection?.() ?? null
      if (!range) {
        lua.lua_pushnil(L2)
        return 1
      }
      pushInt(L2, range.start)
      pushInt(L2, range.end)
      return 2
    }
    const setStatusText = (L2: any): number => {
      const context = currentContext(L2)
      if (!context) {
        lua.lua_pushnil(L2)
        return 1
      }
      const text = checkString(L2, 1)
      context.host.setStatusText?.(text)
      return 0
    }
    const raiseWarningOnload = (L2: any): number => {
      lua.lua_getfield(L2, lua.LUA_REGISTRYINDEX, to_luastring('warnings'))
      lua.lua_pushvalue(L2, -2)
      lua.lua_rawseti(L2, -2, lua.lua_rawlen(L2, -2) + 1)
      lua.lua_pop(L2, 2)
      return 0
    }
    const clipboardInit = (L2: any): number => {
      lua.lua_newtable(L2)
      lua.lua_pushcfunction(L2, (L3: any) => {
        const context = currentContext(L3)
        const value = context?.host.clipboardGet
        if (!value) {
          lua.lua_pushnil(L3)
          return 1
        }
        return yieldToHost(L3, async (co) => {
          const text = await context!.host.clipboardGet!()
          if (!text) lua.lua_pushnil(co)
          else pushString(co, text)
          return 1
        })
      })
      lua.lua_setfield(L2, -2, to_luastring('get'))
      lua.lua_pushcfunction(L2, (L3: any) => {
        const context = currentContext(L3)
        const text = checkString(L3, 1)
        return yieldToHost(L3, async (co) => {
          const ok = (await context?.host.clipboardSet?.(text)) ?? false
          pushBool(co, ok)
          return 1
        })
      })
      lua.lua_setfield(L2, -2, to_luastring('set'))
      return 1
    }
    const includeFn = (L2: any): number => {
      const includeName = checkString(L2, 1)
      const filepath = resolveIncludePath(includeName, includeDirs)
      const cached = filepath ? includeCache.get(filepath) : undefined
      if (!filepath || !cached) return raiseError(L2, `Lua include not found: ${includeName}`)
      // LuaInclude L666-671：LoadFile 失败报错；成功则调用（0 参、多返回值）并返回其结果个数
      if (
        lauxlib.luaL_loadbuffer(
          L2,
          to_luastring(stripLoaderBom(cached.code)),
          null,
          to_luastring(filepath),
        ) !== 0
      ) {
        const message = luaErrorText(L2, -1)
        lua.lua_pop(L2, 1)
        return raiseError(L2, `Error loading Lua include "${includeName}":\n${message}`)
      }
      const base = lua.lua_gettop(L2) - 1
      lua.lua_call(L2, 0, lua.LUA_MULTRET)
      return lua.lua_gettop(L2) - base
    }

    const aegisubFields: Array<[string, (L2: any) => number]> = [
      ['register_macro', registerMacro],
      ['register_filter', registerFilter],
      ['text_extents', textExtents],
      ['frame_from_ms', frameFromMs],
      ['ms_from_frame', msFromFrame],
      ['video_size', videoSize],
      ['keyframes', keyframes],
      ['decode_path', decodePath],
      ['cancel', cancelScript],
      ['__init_clipboard', clipboardInit],
      ['__raise_warning', raiseWarningOnload],
      ['file_name', fileMame],
      ['gettext', getText],
      ['project_properties', projectProperties],
      ['get_audio_selection', getAudioSelection],
      ['set_status_text', setStatusText],
    ]
    for (const [name, fn] of aegisubFields) {
      lua.lua_pushcfunction(L, fn)
      lua.lua_setfield(L, -2, to_luastring(name))
    }
    pushInt(L, 4)
    lua.lua_setfield(L, -2, to_luastring('lua_automation_version'))
    lua.lua_setglobal(L, to_luastring('aegisub'))

    // dofile / loadfile / include
    lua.lua_pushnil(L)
    lua.lua_setglobal(L, to_luastring('dofile'))
    lua.lua_pushnil(L)
    lua.lua_setglobal(L, to_luastring('loadfile'))
    lua.lua_pushcfunction(L, includeFn)
    lua.lua_setglobal(L, to_luastring('include'))

    // 执行脚本本体（错误处理器在函数下方：先压 msgh，再 loadbuffer 得到 [msgh, chunk]）
    lua.lua_pushcclosure(L, addStackTrace, 0)
    if (
      lauxlib.luaL_loadbuffer(L, to_luastring(stripLoaderBom(code)), null, to_luastring(pretty)) !==
      0
    ) {
      const message = luaErrorText(L, -1)
      return fail(`Error initialising Lua script "${pretty}":\n\n${message}`)
    }
    if (lua.lua_pcall(L, 0, 0, -2) !== 0) {
      const message = luaErrorText(L, -1)
      return fail(`Error initialising Lua script "${pretty}":\n\n${message}`)
    }
    lua.lua_pop(L, 1)

    // Automation 3 脚本检测
    lua.lua_getglobal(L, to_luastring('version'))
    if (lua.lua_isnumber(L, -1) && Math.trunc(lua.lua_tointeger(L, -1)) === 3) {
      lua.lua_pop(L, 1)
      return fail(
        'Attempted to load an Automation 3 script as an Automation 4 Lua script. Automation 3 is no longer supported.',
      )
    }
    lua.lua_pop(L, 1)

    state.name = readGlobalString(L, 'script_name')
    state.description = readGlobalString(L, 'script_description')
    state.author = readGlobalString(L, 'script_author')
    state.version = readGlobalString(L, 'script_version')
    if (!state.name) state.name = pretty

    lua.lua_getfield(L, lua.LUA_REGISTRYINDEX, to_luastring('warnings'))
    if (!lua.lua_isnil(L, -1)) {
      luaForEach(L, -1, () => {
        state.warnings.push(checkString(L, -1))
      })
    }
    lua.lua_pop(L, 1)

    return {
      stateId: state.id,
      name: state.name,
      description: state.description,
      author: state.author,
      version: state.version,
      warnings: state.warnings,
      macros: state.macros.map((macro) => ({
        id: `automation/lua/${scriptStem}/${macro.name}`,
        scriptName: state.name,
        name: macro.name,
        description: macro.description,
        help: macro.help,
        hasValidate: macro.validateRef !== null,
        hasIsActive: macro.isActiveRef !== null,
      })),
      filters: state.filters.map((filter) => ({
        name: filter.name,
        description: filter.description,
        priority: filter.priority,
        hasConfig: filter.configRef !== null,
      })),
      loaded: true,
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

// ---------------------------------------------------------------------------
// 协程驱动
// ---------------------------------------------------------------------------

async function resumeCoroutine(co: any, L: any, nargs: number): Promise<number> {
  let status = lua.lua_resume(co, L, nargs)
  let hops = 0
  while (status === lua.LUA_YIELD) {
    const task = lua.lua_touserdata(co, -1) as YieldTask
    lua.lua_pop(co, 1)
    // 协程任务必须串行执行：每次 resume 都依赖上一个 yield 的返回值
    // oxlint-disable-next-line no-await-in-loop
    const produced = await task(co)
    status = lua.lua_resume(co, L, produced)
    if (++hops > 100000) throw new Error('Automation script exceeded yield limit')
  }
  return status
}

// ---------------------------------------------------------------------------
// 选区辅助
// ---------------------------------------------------------------------------

function dialogueOrdinals(rows: LuaRow[]): Map<LuaRow, number> {
  const map = new Map<LuaRow, number>()
  let ordinal = 0
  for (const row of rows) if (row.class === 'dialogue') map.set(row, ordinal++)
  return map
}

// ---------------------------------------------------------------------------
// 运行宏
// ---------------------------------------------------------------------------

function findMacro(stateId: number, macroName: string): MacroEntry | undefined {
  return states.get(stateId)?.macros.find((macro) => macro.name === macroName)
}

function prepareRun(
  state: ScriptState,
  rows: LuaRow[],
  selected: number[],
  active: number,
  host: AutomationHost,
  options: { canModify: boolean; canSetUndo: boolean; silent: boolean },
): { context: RunContext; model: LuaFileModel } {
  const model = new LuaFileModel(cloneRows(rows), {
    canModify: options.canModify,
    canSetUndo: options.canSetUndo,
  })
  const context: RunContext = {
    host,
    model,
    rows,
    selected: [...selected].sort((a, b) => a - b),
    active,
    activeLineOrdinal: active >= 0 ? active : null,
    canModify: options.canModify,
    canSetUndo: options.canSetUndo,
    log: [],
    cancelled: false,
    hostCancelled: false,
    silent: options.silent,
  }
  setContext(state.L, context)
  return { context, model }
}

function cloneRows(rows: LuaRow[]): LuaRow[] {
  return rows.map((row) => {
    const copy = { ...row } as LuaRow
    if (copy.class === 'dialogue') copy.extra = { ...copy.extra }
    if (copy.class === 'style') copy.values = copy.values ? { ...copy.values } : undefined
    return copy
  })
}

function cleanupRun(state: ScriptState): void {
  setContext(state.L, null)
}

/**
 * 运行宏（LuaCommand::operator()）。rows 为全空间行（Info + Styles + Dialogue）；
 * selected/active 为 0-based 对白序数（active = -1 表示无活动行）。
 */
export async function runAutomationMacro(
  stateId: number,
  macroName: string,
  rows: LuaRow[],
  selectedDialogueIndexes: number[],
  activeDialogueIndex: number,
  host: AutomationHost = {},
): Promise<AutomationRunResult> {
  if (!fengariModules) throw new Error('Automation runtime is not loaded yet')
  const state = states.get(stateId)
  const entry = findMacro(stateId, macroName)
  if (!state || !entry) throw new Error(`Automation macro "${macroName}" is not loaded`)
  const L = state.L

  const { context, model } = prepareRun(
    state,
    rows,
    selectedDialogueIndexes,
    activeDialogueIndex,
    host,
    {
      canModify: true,
      canSetUndo: true,
      silent: false,
    },
  )

  const originalOffset = rows.length - rows.filter((row) => row.class === 'dialogue').length + 1
  /** 传给脚本的 active 行号（全空间 1-based；无活动行为 0，对应 C++ 的 original_active） */
  const originalActive = activeDialogueIndex >= 0 ? activeDialogueIndex + originalOffset : 0
  /** 主栈基线：无论成功/失败/取消都要还原（替代 C++ 的 LuaStackcheck） */
  const base = lua.lua_gettop(L)

  try {
    // 栈布局对齐 C++：错误处理器在函数下方 → [f, msgh, subs, sel, active]
    lua.lua_pushcclosure(L, addStackTrace, 0)
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, entry.fnRef)
    lua.lua_insert(L, -2)

    createSubtitlesUserdata(L, model)
    pushJsValue(
      L,
      context.selected.map((ordinal) => ordinal + originalOffset),
    )
    pushInt(L, originalActive)

    makeProgressSink(L)

    // 移入协程：[xpcall, f, msgh, subs, sel, active]，nargs = 1 + 1 + 3
    const co = lua.lua_newthread(L)
    lua.lua_insert(L, -6)
    lua.lua_xmove(L, co, 5)
    lua.lua_getglobal(co, to_luastring('xpcall'))
    lua.lua_insert(co, 1)

    const status = await resumeCoroutine(co, L, 5)

    // xpcall 把脚本错误转成 (false, errobj) 正常返回；status !== OK 仅剩逃逸出 xpcall 的错误
    const xpcallFailed =
      status === lua.LUA_OK && lua.lua_type(co, 1) === lua.LUA_TBOOLEAN && !lua.lua_toboolean(co, 1)
    if (status !== lua.LUA_OK || xpcallFailed) {
      // xpcall 失败时栈为 [false, errobj, ...]；status 失败时栈顶即错误对象
      const errorIndex = status !== lua.LUA_OK ? -1 : 2
      const cancelled = context.cancelled || isCancelMarker(co, errorIndex)
      const message = luaErrorText(co, errorIndex)
      if (!cancelled && message) makeLog(context, `\n\nLua reported a runtime error:\n${message}`)
      model.cancel()
      return {
        ok: false,
        error: cancelled ? 'cancelled' : message || 'Script threw an error',
        commits: [],
        selected: null,
        active: null,
        log: context.log,
      }
    }

    // xpcall 返回 (true, res1, res2)：对齐 lua_pcall(3, 2) 的截断/补 nil 语义
    lua.lua_settop(co, 3)

    // 栈顶为 active（数字则采用），其下为选区表；未返回数字时保持 original_active
    let activeIdx = originalActive
    if (lua.lua_type(co, -1) === lua.LUA_TNUMBER) {
      activeIdx = Math.trunc(lua.lua_tointeger(co, -1))
      if (activeIdx < 1 || activeIdx > rows.length) {
        makeLog(context, `Active row ${activeIdx} is out of bounds (must be 1-${rows.length})`)
        activeIdx = originalActive
      }
    }
    lua.lua_pop(co, 1)

    const hasSelectionTable = lua.lua_type(co, -1) === lua.LUA_TTABLE

    const { commits, rows: finalRows } = model.processingComplete(entry.name)
    const ordinals = dialogueOrdinals(finalRows)

    let selectedOrdinals: number[]
    let activeOrdinal: number | null

    if (hasSelectionTable) {
      const result = resolveTableSelection(co, -1, finalRows, ordinals, activeIdx, context)
      selectedOrdinals = result.selected
      activeOrdinal = result.active
    } else {
      lua.lua_pop(co, 1)
      const result = resolveOriginalSelection(context, finalRows, originalOffset)
      selectedOrdinals = result.selected
      activeOrdinal = result.active
    }

    if (selectedOrdinals.length === 0 && ordinals.size > 0) selectedOrdinals = [activeOrdinal ?? 0]
    // 指针悬垂在 web 无法表达：越界（原文档行已不存在）时回退到选区最小行
    if (activeOrdinal !== null && (activeOrdinal < 0 || activeOrdinal >= ordinals.size))
      activeOrdinal = selectedOrdinals.length ? Math.min(...selectedOrdinals) : null

    return {
      ok: true,
      commits: commits.map((commit) => ({ payload: commit.payload, label: commit.label })),
      selected: selectedOrdinals.length ? [...selectedOrdinals].sort((a, b) => a - b) : null,
      active: activeOrdinal,
      log: context.log,
    }
  } catch (error) {
    model.cancel()
    if (error instanceof AutomationCancelled)
      return {
        ok: false,
        error: 'cancelled',
        commits: [],
        selected: null,
        active: null,
        log: context.log,
      }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      commits: [],
      selected: null,
      active: null,
      log: context.log,
    }
  } finally {
    lua.lua_settop(L, base)
    removeProgressSink(L)
    cleanupRun(state)
  }
}

function isCancelMarker(co: any, index: number): boolean {
  if (lua.lua_type(co, index) !== lua.LUA_TLIGHTUSERDATA) return false
  return lua.lua_touserdata(co, index) === CANCEL_MARKER
}

/**
 * 读取栈上错误对象为文本。Lua 错误通常是字符串，但 JS 侧异常（宿主回调抛出、
 * fengari 的 atnativeerror 包装）以 lightuserdata 形式出现，需还原成 JS 异常信息。
 */
function luaErrorText(L: any, index: number): string {
  const type = lua.lua_type(L, index)
  if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, index))
  if (type === lua.LUA_TLIGHTUSERDATA) {
    const value = lua.lua_touserdata(L, index)
    if (value instanceof Error) return `${value.name}: ${value.message}`
    return `userdata: ${String(value)}`
  }
  if (type === lua.LUA_TNUMBER) return String(lua.lua_tonumber(L, index))
  if (type === lua.LUA_TNIL || type === lua.LUA_TNONE) return ''
  return luaTypeName(L, index)
}

/** 表分支：遍历脚本返回的选区表（lua_for_each 语义，遇错 break） */
function resolveTableSelection(
  co: any,
  tableIndex: number,
  finalRows: LuaRow[],
  ordinals: Map<LuaRow, number>,
  activeIdx: number,
  context: RunContext,
): { selected: number[]; active: number | null } {
  const selected = new Set<number>()
  let activeOrdinal: number | null = null
  let activeSet = false

  const abs = tableIndex < 0 ? lua.lua_gettop(co) + tableIndex + 1 : tableIndex
  lua.lua_pushnil(co)
  while (lua.lua_next(co, abs) !== 0) {
    if (lua.lua_type(co, -1) === lua.LUA_TNUMBER) {
      const cur = Math.trunc(lua.lua_tointeger(co, -1))
      if (cur < 1 || cur > finalRows.length) {
        makeLog(context, `Selected row ${cur} is out of bounds (must be 1-${finalRows.length})`)
        lua.lua_pop(co, 2)
        break
      }
      const row = finalRows[cur - 1]
      if (row.class !== 'dialogue') {
        makeLog(context, `Selected row ${cur} is not a dialogue line`)
        lua.lua_pop(co, 2)
        break
      }
      const ordinal = ordinals.get(row)!
      selected.add(ordinal)
      // if (!active_line || active_idx == cur) active_line = diag;
      if (!activeSet || activeIdx === cur) {
        activeOrdinal = ordinal
        activeSet = true
      }
    }
    lua.lua_pop(co, 1)
  }

  // AssDialogue *new_active = c->selectionController->GetActiveLine();
  // if (active_line && (active_idx > 0 || !sel.count(new_active))) new_active = active_line;
  let newActive = context.activeLineOrdinal
  if (activeSet && (activeIdx > 0 || !selected.has(context.activeLineOrdinal ?? -1)))
    newActive = activeOrdinal
  // if (sel.empty()) sel.insert(new_active);
  if (selected.size === 0) selected.add(newActive ?? 0)
  return { selected: [...selected], active: newActive }
}

/** 无表分支：按原始选区行号在最终对白序列上推进迭代器 */
function resolveOriginalSelection(
  context: RunContext,
  finalRows: LuaRow[],
  originalOffset: number,
): { selected: number[]; active: number | null } {
  const dialogueCount = finalRows.filter((row) => row.class === 'dialogue').length
  const selected = new Set<number>()
  let newActive: number | null = null

  let prev = originalOffset
  let it = 0
  for (const row of context.selected) {
    while (row > prev && it < dialogueCount) {
      prev++
      it++
    }
    if (it >= dialogueCount) break
    selected.add(it)
    if (row === context.active + originalOffset) newActive = it
  }

  if (selected.size === 0 && dialogueCount > 0) selected.add(0)
  if (newActive === null || !selected.has(newActive))
    newActive = selected.size ? Math.min(...selected) : null
  return { selected: [...selected], active: newActive }
}

// ---------------------------------------------------------------------------
// validate / isactive
// ---------------------------------------------------------------------------

/**
 * validate / isactive 的公共调用（LuaCommand::Validate / IsActive）。
 * 栈布局对齐源码：[msgh, f, subs, sel, active] → lua_pcall(3, resultCount, -5)。
 * 成功返回 [result..., msgh]（留在栈上由调用方弹出）；失败返回 [err, msgh]。
 */
function prepareFeatureCall(
  state: ScriptState,
  rows: LuaRow[],
  selected: number[],
  active: number | null,
  host: AutomationHost,
  fnRef: number,
  resultCount: number,
): { status: number; context: RunContext } {
  const L = state.L
  const { context, model } = prepareRun(state, rows, selected, active ?? -1, host, {
    canModify: false,
    canSetUndo: false,
    silent: true,
  })
  const originalOffset = rows.length - rows.filter((row) => row.class === 'dialogue').length + 1

  // 错误处理器在函数下方
  lua.lua_pushcclosure(L, addStackTrace, 0)
  lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, fnRef)

  createSubtitlesUserdata(L, model)
  pushJsValue(
    L,
    context.selected.map((ordinal) => ordinal + originalOffset),
  )
  if (active === null) lua.lua_pushnil(L)
  else pushInt(L, active + originalOffset)

  const status = lua.lua_pcall(L, 3, resultCount, -5)
  return { status, context }
}

export async function validateAutomationMacro(
  stateId: number,
  macroName: string,
  rows: LuaRow[],
  selectedDialogueIndexes: number[],
  activeDialogueIndex: number | null,
  host: AutomationHost = {},
): Promise<AutomationValidateResult> {
  if (!fengariModules) throw new Error('Automation runtime is not loaded yet')
  const state = states.get(stateId)
  const entry = findMacro(stateId, macroName)
  if (!state || !entry || entry.validateRef === null) return { ok: true, help: null, log: [] }

  const base = lua.lua_gettop(state.L)
  try {
    const { status, context } = prepareFeatureCall(
      state,
      rows,
      selectedDialogueIndexes,
      activeDialogueIndex,
      host,
      entry.validateRef,
      2,
    )
    if (status !== 0) {
      const message = luaErrorText(state.L, -1)
      makeLog(context, `Runtime error in Lua macro validation function:\n${message}`)
      lua.lua_pop(state.L, 2) // 错误信息 + 错误处理器
      return { ok: false, help: null, log: context.log }
    }
    const result = Boolean(lua.lua_toboolean(state.L, -2))
    const help = lua.lua_isstring(state.L, -1) ? to_jsstring(lua.lua_tostring(state.L, -1)) : ''
    lua.lua_pop(state.L, 3) // 两个返回值 + 错误处理器
    return { ok: result, help: help || null, log: context.log }
  } catch (error) {
    return { ok: false, help: null, log: [error instanceof Error ? error.message : String(error)] }
  } finally {
    lua.lua_settop(state.L, base)
    cleanupRun(state)
  }
}

export async function isActiveAutomationMacro(
  stateId: number,
  macroName: string,
  rows: LuaRow[],
  selectedDialogueIndexes: number[],
  activeDialogueIndex: number | null,
  host: AutomationHost = {},
): Promise<AutomationIsActiveResult> {
  if (!fengariModules) throw new Error('Automation runtime is not loaded yet')
  const state = states.get(stateId)
  const entry = findMacro(stateId, macroName)
  if (!state || !entry || entry.isActiveRef === null) return { ok: true, active: false, log: [] }

  const base = lua.lua_gettop(state.L)
  try {
    const { status, context } = prepareFeatureCall(
      state,
      rows,
      selectedDialogueIndexes,
      activeDialogueIndex,
      host,
      entry.isActiveRef,
      1,
    )
    if (status !== 0) {
      const message = luaErrorText(state.L, -1)
      makeLog(context, `Runtime error in Lua macro IsActive function:\n${message}`)
      lua.lua_pop(state.L, 2) // 错误信息 + 错误处理器
      return { ok: false, active: false, log: context.log }
    }
    const active = Boolean(lua.lua_toboolean(state.L, -1))
    lua.lua_pop(state.L, 2) // 返回值 + 错误处理器
    return { ok: true, active, log: context.log }
  } catch (error) {
    return {
      ok: false,
      active: false,
      log: [error instanceof Error ? error.message : String(error)],
    }
  } finally {
    lua.lua_settop(state.L, base)
    cleanupRun(state)
  }
}

// ---------------------------------------------------------------------------
// 导出过滤器（auto4_lua.cpp LuaExportFilter / ass_export_filter.cpp /
// ass_exporter.cpp / dialog_export.cpp）
// ---------------------------------------------------------------------------

/** 导出对话框里的一项过滤器（AssExportFilterChain 的注册序 + 去重命名结果） */
export interface AutomationFilterDisplayInfo {
  /** 所属脚本状态 id */
  stateId: number
  /** 脚本注册时的原始名（引擎按此查找） */
  name: string
  /** 去重后的展示名（AssExportFilterChain::Register 的 " (n)" 规则） */
  displayName: string
  description: string
  priority: number
  hasConfig: boolean
}

/**
 * 汇总全部脚本的过滤器为导出对话框列表（AssExportFilterChain::Register 语义）：
 * 按优先级降序、同优先级保持注册序；重名按 "%s (%d)" 追加序号（对已用展示名判重）。
 */
export function orderedAutomationFilters(
  scripts: Array<{ stateId: number; filters: AutomationFilterInfo[] }>,
): AutomationFilterDisplayInfo[] {
  const list: AutomationFilterDisplayInfo[] = []
  const used = new Set<string>()
  for (const script of scripts) {
    if (script.stateId < 0) continue
    for (const filter of script.filters) {
      let displayName = filter.name
      let copy = 1
      while (used.has(displayName)) displayName = `${filter.name} (${copy++})`
      used.add(displayName)
      const entry: AutomationFilterDisplayInfo = {
        stateId: script.stateId,
        name: filter.name,
        displayName,
        description: filter.description,
        priority: filter.priority,
        hasConfig: filter.hasConfig,
      }
      // 插到第一个 priority < 自身 的元素之前（同优先级排在其后，保持稳定）
      let index = list.length
      for (let i = 0; i < list.length; i++) {
        if (list[i].priority < filter.priority) {
          index = i
          break
        }
      }
      list.splice(index, 0, entry)
    }
  }
  return list
}

function findFilter(stateId: number, filterName: string): FilterEntry | undefined {
  return states.get(stateId)?.filters.find((filter) => filter.name === filterName)
}

export interface AutomationFilterRunResult {
  ok: boolean
  /** 失败原因（ok = false 时；取消时为 'cancelled'） */
  error?: string
  /** 过滤后的整表负载（应用进导出的文档副本；ok = true 时） */
  payload?: LuaCommitPayload
  log: string[]
}

export interface AutomationFilterConfigResult {
  ok: boolean
  /** 配置对话框 spec（无 config 函数时为 undefined） */
  spec?: DialogSpec
  error?: string
  log: string[]
}

/**
 * 运行导出过滤器（LuaExportFilter::ProcessSubs + LuaThreadedCall）：
 * run(subtitles, config)，can_modify = true、can_set_undo = false（默认参数），
 * 返回值丢弃；成功时以 ProcessingComplete 的最终行集产出整表负载。
 */
export async function runAutomationFilter(
  stateId: number,
  filterName: string,
  rows: LuaRow[],
  config: Record<string, DialogValue> | null,
  host: AutomationHost = {},
): Promise<AutomationFilterRunResult> {
  if (!fengariModules) throw new Error('Automation runtime is not loaded yet')
  const state = states.get(stateId)
  const entry = findFilter(stateId, filterName)
  if (!state || !entry) throw new Error(`Automation filter "${filterName}" is not loaded`)
  const L = state.L

  const { context, model } = prepareRun(state, rows, [], -1, host, {
    canModify: true,
    canSetUndo: false,
    silent: false,
  })
  const base = lua.lua_gettop(L)

  try {
    // 栈布局对齐 C++：[f, subs, config] 上插错误处理器 → [msgh, f, subs, config]
    lua.lua_pushcclosure(L, addStackTrace, 0)
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, entry.fnRef)
    lua.lua_insert(L, -2)

    createSubtitlesUserdata(L, model)
    // 无 config 函数（或未生成配置对话框）时传空表（源码 lua_newtable 分支）
    pushJsValue(L, config ?? {})

    makeProgressSink(L)

    // 移入协程：[xpcall, f, msgh, subs, config]，nargs = 1 + 1 + 2
    const co = lua.lua_newthread(L)
    lua.lua_insert(L, -5)
    lua.lua_xmove(L, co, 4)
    lua.lua_getglobal(co, to_luastring('xpcall'))
    lua.lua_insert(co, 1)

    const status = await resumeCoroutine(co, L, 4)

    const xpcallFailed =
      status === lua.LUA_OK && lua.lua_type(co, 1) === lua.LUA_TBOOLEAN && !lua.lua_toboolean(co, 1)
    if (status !== lua.LUA_OK || xpcallFailed) {
      const errorIndex = status !== lua.LUA_OK ? -1 : 2
      const cancelled = context.cancelled || isCancelMarker(co, errorIndex)
      const message = luaErrorText(co, errorIndex)
      if (!cancelled && message) makeLog(context, `\n\nLua reported a runtime error:\n${message}`)
      model.cancel()
      return {
        ok: false,
        error: cancelled ? 'cancelled' : message || 'Script threw an error',
        log: context.log,
      }
    }

    // LuaThreadedCall(nresults = 0)：脚本返回值全部丢弃；ProcessingComplete 后取最终行集
    const { rows: finalRows } = model.processingComplete(entry.name)
    return {
      ok: true,
      payload: buildReplaceDocumentPayload(finalRows, model.infoTouched),
      log: context.log,
    }
  } catch (error) {
    model.cancel()
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      log: context.log,
    }
  } finally {
    lua.lua_settop(L, base)
    removeProgressSink(L)
    cleanupRun(state)
  }
}

/**
 * 生成过滤器的配置对话框（LuaExportFilter::GenerateConfigDialog）：
 * config(subtitles, stored_options) 以无错误处理器的 lua_pcall(2,1,0) 调用
 * （只读 subtitles、不能 yield）；失败时按源码记录
 * "Runtime error in Lua config dialog function" 并视为无配置对话框。
 */
export async function configureAutomationFilter(
  stateId: number,
  filterName: string,
  rows: LuaRow[],
  host: AutomationHost = {},
): Promise<AutomationFilterConfigResult> {
  if (!fengariModules) throw new Error('Automation runtime is not loaded yet')
  const state = states.get(stateId)
  const entry = findFilter(stateId, filterName)
  if (!state || !entry) throw new Error(`Automation filter "${filterName}" is not loaded`)
  if (entry.configRef === null) return { ok: true, log: [] }

  const L = state.L
  const base = lua.lua_gettop(L)
  try {
    const { context, model } = prepareRun(state, rows, [], -1, host, {
      canModify: false,
      canSetUndo: false,
      silent: true,
    })
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, entry.configRef)
    createSubtitlesUserdata(L, model)
    lua.lua_newtable(L) // 已存设置（源码 TODO：暂为空表）
    const status = lua.lua_pcall(L, 2, 1, 0)
    // 源码无论成败都执行 ProcessingComplete
    model.processingComplete(entry.name)

    if (status !== lua.LUA_OK) {
      const message = luaErrorText(L, -1)
      makeLog(context, `Runtime error in Lua config dialog function:\n${message}`)
      lua.lua_pop(L, 1)
      return { ok: false, error: message, log: context.log }
    }

    let spec: DialogSpec
    try {
      // LuaDialog(L, false)：无按钮、无 labels/ids 表
      spec = parseDialogSpec(luaToJs(L, -1), null, null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      makeLog(context, `Runtime error in Lua config dialog function:\n${message}`)
      lua.lua_pop(L, 1)
      return { ok: false, error: message, log: context.log }
    }
    lua.lua_pop(L, 1)
    return { ok: true, spec, log: context.log }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      log: [error instanceof Error ? error.message : String(error)],
    }
  } finally {
    lua.lua_settop(L, base)
    cleanupRun(state)
  }
}

export { WX_ID }
export type { LuaRow, LuaInfoRow, LuaStyleRow, LuaDialogueRow } from './luaAssFile'
