/**
 * Lua Automation 运行时（对应 Aegisub auto4_lua*.cpp 的最小可用子集）。
 *
 * 基于 fengari（浏览器 Lua 5.3 VM）。支持：
 * - aegisub.register_macro(name, description, processing_fn, validation_fn?)
 * - subtitles 表：1-based 索引（Info + Styles + Dialogue 全空间）、负索引插入、
 *   0 追加、nil 删除、delete/deleterange/insert/append/#/.n
 * - processing(subtitles, selected, active) 的返回值（新选区/新活动行）
 * - aegisub.debug.out / log / progress / gettext / set_undo_point / file_name /
 *   lua_automation_version / parse_karaoke_data / text_extents
 * - aegisub.dialog.display：用 window.prompt 序列模拟（同步）
 *
 * 修改在脚本结束后由宿主整表重放（replaceCues，单步 undo，描述 = 宏名）。
 *
 * fengari 按需动态加载：只有第一次加载脚本时才会拉取 Lua VM（约 300KB）。
 */

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

export interface LuaRow {
  class: string
  [key: string]: unknown
}

export interface AutomationMacroInfo {
  /** 命令 id：automation/lua/<脚本名>/<宏名> */
  id: string
  scriptName: string
  name: string
  description: string
}

export interface AutomationRunResult {
  rows: LuaRow[]
  /** 全空间 1-based 行号 */
  selected: number[] | null
  active: number | null
}

interface MacroEntry {
  name: string
  description: string
  fnRef: number
  validateRef: number | null
}

interface ScriptState {
  id: number
  L: any
  filename: string
  name: string
  description: string
  macros: MacroEntry[]
}

let nextStateId = 1
const states = new Map<number, ScriptState>()

export function getAutomationState(stateId: number): ScriptState | undefined {
  return states.get(stateId)
}

// ---------------------------------------------------------------------------
// Lua ↔ JS 值转换
// ---------------------------------------------------------------------------

function luaToJs(L: any, index: number): unknown {
  // 相对索引转绝对：后续 push/pop 会让负索引漂移
  const abs = index < 0 ? lua.lua_gettop(L) + index + 1 : index
  switch (lua.lua_type(L, abs)) {
    case lua.LUA_TNIL:
    case lua.LUA_TNONE:
      return null
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, abs) !== 0
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, abs)
    case lua.LUA_TSTRING:
      return to_jsstring(lua.lua_tostring(L, abs))
    case lua.LUA_TTABLE: {
      // 数组或哈希表：先探测连续整数键
      const count = lua.lua_rawlen(L, abs)
      const isArray = count > 0
      if (isArray) {
        const array: unknown[] = []
        for (let i = 1; i <= count; i++) {
          lua.lua_rawgeti(L, abs, i)
          array.push(luaToJs(L, -1))
          lua.lua_pop(L, 1)
        }
        // 检查是否存在额外哈希键
        const extra = luaToJsHash(L, abs, count)
        return extra ? Object.assign(array, extra) : array
      }
      return luaToJsHash(L, abs, 0) ?? {}
    }
    default:
      return null
  }
}

function luaToJsHash(L: any, index: number, arrayCount: number): Record<string, unknown> | null {
  const result: Record<string, unknown> = {}
  let hasKeys = false
  lua.lua_pushnil(L)
  while (lua.lua_next(L, index) !== 0) {
    const key =
      lua.lua_type(L, -2) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -2)) : null
    if (key && !(typeof key === 'string' && /^\d+$/.test(key) && Number(key) <= arrayCount)) {
      result[key] = luaToJs(L, -1)
      hasKeys = true
    }
    lua.lua_pop(L, 1)
  }
  return hasKeys ? result : null
}

function pushJsValue(L: any, value: unknown): void {
  if (value === null || value === undefined) {
    lua.lua_pushnil(L)
  } else if (typeof value === 'number') {
    lua.lua_pushnumber(L, value)
  } else if (typeof value === 'boolean') {
    lua.lua_pushboolean(L, value ? 1 : 0)
  } else if (typeof value === 'string') {
    lua.lua_pushstring(L, to_luastring(value))
  } else if (Array.isArray(value)) {
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
  } else {
    lua.lua_pushnil(L)
  }
}

// ---------------------------------------------------------------------------
// subtitles 表 bootstrap（纯 Lua 实现 delete/insert/append/deleterange）
// ---------------------------------------------------------------------------

const SUBS_BOOTSTRAP = `
return function(t, res)
  local methods = {}
  function methods.delete(...)
    local args = {...}
    if type(args[1]) == 'table' then args = args[1] end
    table.sort(args, function(a, b) return a > b end)
    for _, i in ipairs(args) do
      if i >= 1 and i <= #t then table.remove(t, i) end
    end
  end
  function methods.deleterange(a, b)
    for i = b, a, -1 do
      if i >= 1 and i <= #t then table.remove(t, i) end
    end
  end
  function methods.insert(before, ...)
    local items = {...}
    for k = #items, 1, -1 do
      table.insert(t, before, items[k])
    end
  end
  function methods.append(...)
    local items = {...}
    for _, item in ipairs(items) do
      local last = 0
      for i = 1, #t do
        if t[i].class == item.class then last = i end
      end
      table.insert(t, last + 1, item)
    end
  end
  function methods.script_resolution()
    return res.width, res.height
  end
  local mt = {
    __index = function(tt, k)
      if type(k) == 'number' then return rawget(tt, k) end
      if k == 'n' then return #tt end
      return methods[k]
    end,
    __newindex = function(tt, k, v)
      if type(k) == 'number' then
        if k == 0 then
          rawset(tt, #tt + 1, v)
        elseif k < 0 then
          table.insert(tt, -k, v)
        elseif v == nil then
          table.remove(tt, k)
        else
          rawset(tt, k, v)
        end
      else
        rawset(tt, k, v)
      end
    end,
    __len = function(tt) return rawlen(tt) end,
  }
  return setmetatable(t, mt)
end
`

// ---------------------------------------------------------------------------
// 加载脚本
// ---------------------------------------------------------------------------

function stem(filename: string): string {
  return (
    filename
      .replace(/\.(lua|moon)$/i, '')
      .split(/[\\/]/)
      .pop() || filename
  )
}

function readGlobalString(L: any, name: string): string | null {
  lua.lua_getglobal(L, to_luastring(name))
  const value =
    lua.lua_type(L, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -1)) : null
  lua.lua_pop(L, 1)
  return value
}

export interface LoadedAutomationScript {
  stateId: number
  name: string
  description: string
  author: string
  version: string
  macros: AutomationMacroInfo[]
}

export async function loadAutomationScript(
  code: string,
  filename: string,
): Promise<LoadedAutomationScript> {
  await ensureFengari()
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const scriptStem = stem(filename)
  const stateId = nextStateId++
  const state: ScriptState = { id: stateId, L, filename, name: '', description: '', macros: [] }
  states.set(stateId, state)

  // ---- aegisub 表 ----
  const setAegisubField = (name: string, pusher: () => void) => {
    pusher()
    lua.lua_setfield(L, -2, to_luastring(name))
  }
  const pushNilFunction = () => {
    lua.lua_pushcfunction(L, (L2: any) => {
      lua.lua_pushnil(L2)
      return 1
    })
  }
  lua.lua_newtable(L) // aegisub（栈顶）

  const macroId = (macroName: string) => `automation/lua/${scriptStem}/${macroName}`

  // register_macro(name, description, processing_fn, validation_fn?)
  setAegisubField('register_macro', () =>
    lua.lua_pushcfunction(L, (L2: any) => {
      const name = to_jsstring(lauxlib.luaL_checkstring(L2, 1))
      const description = to_jsstring(lauxlib.luaL_checkstring(L2, 2))
      if (lua.lua_type(L2, 3) !== lua.LUA_TFUNCTION) {
        lauxlib.luaL_error(L2, to_luastring('The macro processing function must be a function'))
      }
      lua.lua_pushvalue(L2, 3)
      const fnRef = lauxlib.luaL_ref(L2, lua.LUA_REGISTRYINDEX)
      let validateRef: number | null = null
      if (lua.lua_type(L2, 4) === lua.LUA_TFUNCTION) {
        lua.lua_pushvalue(L2, 4)
        validateRef = lauxlib.luaL_ref(L2, lua.LUA_REGISTRYINDEX)
      }
      if (!state.macros.some((macro) => macro.name === name)) {
        state.macros.push({ name, description, fnRef, validateRef })
      }
      return 0
    }),
  )

  setAegisubField(
    'set_undo_point',
    () => lua.lua_pushcfunction(L, () => 0), // 修改在结束时以宏名整表提交
  )
  setAegisubField('cancel', () =>
    lua.lua_pushcfunction(L, (L2: any) => lauxlib.luaL_error(L2, to_luastring('script cancelled'))),
  )
  setAegisubField('lua_automation_version', () => lua.lua_pushinteger(L, 4))
  setAegisubField('file_name', () =>
    lua.lua_pushcfunction(L, (L2: any) => {
      lua.lua_pushnil(L2)
      return 1
    }),
  )
  setAegisubField('gettext', () => lua.lua_pushcfunction(L, () => 1)) // 返回栈上第一个参数
  setAegisubField('debug', () => {
    lua.lua_newtable(L)
    lua.lua_pushcfunction(L, (L2: any) => {
      const parts: string[] = []
      const top = lua.lua_gettop(L2)
      for (let i = 1; i <= top; i++) parts.push(String(luaToJs(L2, i)))
      console.log('[automation]', ...parts)
      return 0
    })
    lua.lua_setfield(L, -2, to_luastring('out'))
    return 1
  })
  setAegisubField('log', () =>
    lua.lua_pushcfunction(L, (L2: any) => {
      console.log('[automation]', String(luaToJs(L2, 1)))
      return 0
    }),
  )
  setAegisubField('progress', () => {
    lua.lua_newtable(L)
    lua.lua_pushcfunction(L, () => 0)
    lua.lua_setfield(L, -2, to_luastring('set'))
    lua.lua_pushcfunction(L, () => 0)
    lua.lua_setfield(L, -2, to_luastring('task'))
    lua.lua_pushcfunction(L, () => 0)
    lua.lua_setfield(L, -2, to_luastring('title'))
    lua.lua_pushcfunction(L, (L2: any) => {
      lua.lua_pushboolean(L2, 0)
      return 1
    })
    lua.lua_setfield(L, -2, to_luastring('is_cancelled'))
    return 1
  })
  setAegisubField('clipboard', () => {
    lua.lua_newtable(L)
    lua.lua_pushcfunction(L, (L2: any) => {
      lua.lua_pushnil(L2)
      return 1
    })
    lua.lua_setfield(L, -2, to_luastring('get'))
    lua.lua_pushcfunction(L, () => 0)
    lua.lua_setfield(L, -2, to_luastring('set'))
    return 1
  })
  setAegisubField('text_extents', () =>
    lua.lua_pushcfunction(L, (L2: any) => {
      // Web 版无法测量样式字体：返回占位
      lua.lua_pushnumber(L2, 0)
      lua.lua_pushnumber(L2, 0)
      lua.lua_pushnumber(L2, 0)
      lua.lua_pushnumber(L2, 0)
      return 4
    }),
  )
  setAegisubField('frame_from_ms', () => pushNilFunction())
  setAegisubField('ms_from_frame', () => pushNilFunction())
  setAegisubField('video_size', () => pushNilFunction())
  setAegisubField('keyframes', () => pushNilFunction())
  setAegisubField(
    'decode_path',
    () => lua.lua_pushcfunction(L, () => 1), // 原样返回参数
  )
  setAegisubField('project_properties', () =>
    lua.lua_pushcfunction(L, (L2: any) => {
      lua.lua_newtable(L2)
      return 1
    }),
  )
  setAegisubField('get_audio_selection', () => pushNilFunction())
  // dialog.display：window.prompt 序列（同步最小实现）
  setAegisubField('dialog', () => {
    lua.lua_newtable(L)
    lua.lua_pushcfunction(L, (L2: any) => displayDialog(L2))
    lua.lua_setfield(L, -2, to_luastring('display'))
    return 1
  })
  setAegisubField('parse_karaoke_data', () =>
    lua.lua_pushcfunction(L, (L2: any) => {
      const line = luaToJs(L2, 1) as { text?: string; start_time?: number }
      const { parseKaraokeSyllables } = karaokeModule
      const syllables = parseKaraokeSyllables(String(line.text ?? ''), Number(line.start_time ?? 0))
      lua.lua_newtable(L2)
      lua.lua_pushnil(L2)
      lua.lua_rawseti(L2, -2, 0) // 0 号位空占位
      syllables.forEach((syl, i) => {
        pushJsValue(L2, {
          duration: syl.durationMs,
          start_time: syl.startMs - Number(line.start_time ?? 0),
          end_time: syl.startMs - Number(line.start_time ?? 0) + syl.durationMs,
          tag: syl.tagType,
          text: `{${syl.tagType}${Math.floor((syl.durationMs + 5) / 10)}}${syl.text}`,
          text_stripped: syl.text,
        })
        lua.lua_rawseti(L2, -2, i + 1)
      })
      return 1
    }),
  )
  lua.lua_setglobal(L, to_luastring('aegisub'))

  // include：Web 版不支持外部文件
  lua.lua_pushcfunction(L, (L2: any) =>
    lauxlib.luaL_error(L2, to_luastring('include() is not supported in the web build')),
  )
  lua.lua_setglobal(L, to_luastring('include'))

  // 运行脚本本体
  const loaded = lauxlib.luaL_loadbuffer(L, to_luastring(code), to_luastring(`@${filename}`))
  const ran = loaded === 0 ? lua.lua_pcall(L, 0, 0, 0) : loaded
  if (ran !== 0) {
    const message =
      lua.lua_type(L, -1) === lua.LUA_TSTRING
        ? to_jsstring(lua.lua_tostring(L, -1))
        : 'unknown error'
    lua.lua_close(L)
    states.delete(stateId)
    throw new Error(message)
  }

  state.name = readGlobalString(L, 'script_name') || scriptStem
  state.description = readGlobalString(L, 'script_description') ?? ''
  const author = readGlobalString(L, 'script_author') ?? ''
  const version = readGlobalString(L, 'script_version') ?? ''
  void author
  void version

  return {
    stateId,
    name: state.name,
    description: state.description,
    author,
    version,
    macros: state.macros.map((macro) => ({
      id: macroId(macro.name),
      scriptName: state.name,
      name: macro.name,
      description: macro.description,
    })),
  }
}

function pushNilFunctionPlaceholder(): void {
  // 已由 loadAutomationScript 内的 pushNilFunction 取代；frame/ms 换算在无视频时返回 nil
}
void pushNilFunctionPlaceholder

/** dialog.display：用 window.prompt 序列模拟（取消返回 false） */
function displayDialog(L: any): number {
  const dialog = luaToJs(L, 1) as Array<{
    class?: string
    name?: string
    label?: string
    hint?: string
    value?: unknown
    text?: unknown
    items?: string[]
    min?: number
    max?: number
  }>
  const buttons =
    lua.lua_type(L, 2) === lua.LUA_TTABLE ? (luaToJs(L, 2) as string[]) : ['OK', 'Cancel']
  const results: Record<string, unknown> = {}
  for (const control of dialog) {
    if (!control?.name || control.class === 'label') continue
    const label = [control.label, control.hint].filter(Boolean).join('\n') || control.name
    const fallback = control.text ?? control.value ?? ''
    const answer = window.prompt(label, String(fallback))
    if (answer === null) {
      lua.lua_pushboolean(L, 0)
      return 1
    }
    switch (control.class) {
      case 'intedit':
        results[control.name] = Number.parseInt(answer, 10) || 0
        break
      case 'floatedit':
        results[control.name] = Number.parseFloat(answer) || 0
        break
      case 'checkbox':
        results[control.name] = /^(1|y|yes|true)$/i.test(answer.trim())
        break
      case 'dropdown':
        results[control.name] = control.items?.includes(answer) ? answer : (control.value ?? answer)
        break
      default:
        results[control.name] = answer
    }
  }
  const button = window.prompt(`Buttons (${buttons.join(' / ')})`, buttons[0]) ?? buttons[0]
  if (/^cancel$/i.test(button)) {
    lua.lua_pushboolean(L, 0)
    return 1
  }
  lua.lua_pushstring(L, to_luastring(button))
  pushJsValue(L, results)
  return 2
}

// 惰性引入 karaoke 解析（避免循环依赖：karaoke.ts 不依赖引擎）
import * as karaokeModule from '../core/karaoke'

// ---------------------------------------------------------------------------
// 运行宏
// ---------------------------------------------------------------------------

export function macroEntry(stateId: number, macroName: string): MacroEntry | undefined {
  return states.get(stateId)?.macros.find((macro) => macro.name === macroName)
}

/**
 * 运行宏。rows 为全空间行（info+style+dialogue）；selected/active 为对白 0-based 索引。
 */
export function runAutomationMacro(
  stateId: number,
  macroName: string,
  rows: LuaRow[],
  selectedDialogueIndexes: number[],
  activeDialogueIndex: number,
  scriptResolution: { width: number; height: number },
): AutomationRunResult {
  if (!fengariModules) throw new Error('Automation runtime is not loaded yet')
  const state = states.get(stateId)
  const entry = macroEntry(stateId, macroName)
  if (!state || !entry) throw new Error(`Automation macro "${macroName}" is not loaded`)
  const L = state.L

  // 构造 subtitles 表并套上元表（delete/insert/append/...）
  lua.lua_newtable(L)
  rows.forEach((row, index) => {
    pushJsValue(L, row)
    lua.lua_rawseti(L, -2, index + 1)
  })
  const rawIndex = lua.lua_gettop(L)
  const bootstrapStatus = lauxlib.luaL_dostring(L, to_luastring(SUBS_BOOTSTRAP))
  if (bootstrapStatus !== 0) {
    const message = to_jsstring(lua.lua_tostring(L, -1))
    throw new Error(`Automation bootstrap failed: ${message}`)
  }
  lua.lua_pushvalue(L, rawIndex)
  pushJsValue(L, { width: scriptResolution.width, height: scriptResolution.height })
  if (lua.lua_pcall(L, 2, 1, 0) !== 0) {
    const message = to_jsstring(lua.lua_tostring(L, -1))
    throw new Error(`Automation bootstrap failed: ${message}`)
  }
  const proxyIndex = lua.lua_gettop(L)
  lua.lua_pushvalue(L, proxyIndex)
  const subsRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX)

  // selected/active：全空间 1-based（offset = info + style 数）
  const offset = rows.length - countDialogueRows(rows)
  pushJsValue(
    L,
    selectedDialogueIndexes.map((index) => offset + index + 1),
  )
  const selectedIndex = lua.lua_gettop(L)

  // 调用宏：processing(subtitles, selected, active)
  lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, entry.fnRef)
  lua.lua_pushvalue(L, proxyIndex)
  lua.lua_pushvalue(L, selectedIndex)
  lua.lua_pushinteger(L, activeDialogueIndex >= 0 ? offset + activeDialogueIndex + 1 : 0)
  const status = lua.lua_pcall(L, 3, 2, 0)
  if (status !== 0) {
    const message =
      lua.lua_type(L, -1) === lua.LUA_TSTRING
        ? to_jsstring(lua.lua_tostring(L, -1))
        : 'unknown error'
    lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, subsRef)
    lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, selectedIndex)
    throw new Error(message)
  }

  // 返回值：栈顶 -1 = new_active，-2 = new_selection
  let newActive: number | null = null
  let newSelected: number[] | null = null
  if (lua.lua_type(L, -1) === lua.LUA_TNUMBER) newActive = lua.lua_tonumber(L, -1)
  lua.lua_pop(L, 1)
  if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
    const array = luaToJs(L, -1) as number[]
    if (Array.isArray(array)) newSelected = array
  }
  lua.lua_pop(L, 1)

  // 读回最终行（raw 访问绕过元表）
  lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, subsRef)
  const finalRows = luaToJs(L, -1) as LuaRow[]
  lua.lua_pop(L, 1)
  lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, subsRef)
  lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, selectedIndex)

  return {
    rows: Array.isArray(finalRows) ? finalRows : [],
    selected: newSelected,
    active: newActive,
  }
}

function countDialogueRows(rows: LuaRow[]): number {
  return rows.filter((row) => row.class === 'dialogue').length
}

export function closeAutomationState(stateId: number): void {
  const state = states.get(stateId)
  if (state) {
    lua.lua_close(state.L)
    states.delete(stateId)
  }
}
