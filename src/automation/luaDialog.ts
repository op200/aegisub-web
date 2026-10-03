/**
 * Lua Automation 配置对话框（对应 Aegisub auto4_lua_dialog.cpp）。
 *
 * 纯 JS 层，不依赖 fengari：把 Lua 表转换成可渲染的控件 spec（parseDialogSpec），
 * 并把宿主回读结果（button + 控件值）转换回 Lua 需要的值（dialogReadBackValues）。
 * 字段读取语义逐字对齐 get_field / get_if_right_type（string 宽松接受数字，
 * number 宽松接受数字串，bool 严格 boolean）。
 */

// ---------------------------------------------------------------------------
// 数值边界（auto4_lua_dialog.cpp 使用 climits/cfloat）
// ---------------------------------------------------------------------------

export const INT_MIN = -2147483648
export const INT_MAX = 2147483647
export const DBL_MAX = Number.MAX_VALUE

/** wxWidgets 标准按钮 id（string_to_wx_id）；仅作为语义标记，数值本身不参与逻辑 */
export const WX_ID = {
  ok: 5100,
  cancel: 5101,
  no: 5102,
  yes: 5103,
  save: 5104,
  apply: 5105,
  close: 5106,
  help: 5109,
  context_help: 5110,
} as const

const STRING_TO_WX_ID: Record<string, number> = {
  ok: WX_ID.ok,
  yes: WX_ID.yes,
  save: WX_ID.save,
  apply: WX_ID.apply,
  close: WX_ID.close,
  no: WX_ID.no,
  cancel: WX_ID.cancel,
  help: WX_ID.help,
  context_help: WX_ID.context_help,
}

export const WX_ID_NONE = -1

// ---------------------------------------------------------------------------
// Lua 值适配（get_if_right_type / lua_isstring / lua_isnumber 语义）
// ---------------------------------------------------------------------------

function luaNumberToString(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(value)
}

/** lua_isstring：字符串或数字 */
function isLuaString(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number'
}

/** lua_isnumber：数字或可转数字的字符串 */
function isLuaNumber(value: unknown): boolean {
  return (
    typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))
  )
}

function asLuaString(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? luaNumberToString(value)
      : ''
}

function asLuaNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

function asLuaInteger(value: unknown): number {
  return Math.trunc(asLuaNumber(value))
}

/** get_field<T>：默认值只在字段类型匹配时被覆盖 */
function stringField(raw: Record<string, unknown>, name: string, def = ''): string {
  const value = raw[name]
  return isLuaString(value) ? asLuaString(value) : def
}

function intField(raw: Record<string, unknown>, name: string, def: number): number {
  const value = raw[name]
  return isLuaNumber(value) ? asLuaInteger(value) : def
}

function numberField(raw: Record<string, unknown>, name: string, def: number): number {
  const value = raw[name]
  return isLuaNumber(value) ? asLuaNumber(value) : def
}

function boolField(raw: Record<string, unknown>, name: string, def: boolean): boolean {
  const value = raw[name]
  return typeof value === 'boolean' ? value : def
}

// ---------------------------------------------------------------------------
// 控件 spec
// ---------------------------------------------------------------------------

export type DialogControlKind =
  | 'label'
  | 'edit'
  | 'intedit'
  | 'floatedit'
  | 'textbox'
  | 'dropdown'
  | 'checkbox'
  | 'color'
  | 'coloralpha'

interface DialogControlBase {
  kind: DialogControlKind
  name: string
  hint: string
  x: number
  y: number
  width: number
  height: number
}

export interface LabelControl extends DialogControlBase {
  kind: 'label'
  label: string
}

export interface EditControl extends DialogControlBase {
  kind: 'edit' | 'textbox'
  text: string
}

export interface IntEditControl extends DialogControlBase {
  kind: 'intedit'
  text: string
  value: number
  min: number
  max: number
}

export interface FloatEditControl extends DialogControlBase {
  kind: 'floatedit'
  text: string
  value: number
  min: number
  max: number
  step: number
}

export interface DropdownControl extends DialogControlBase {
  kind: 'dropdown'
  value: string
  items: string[]
}

export interface CheckboxControl extends DialogControlBase {
  kind: 'checkbox'
  label: string
  value: boolean
}

export interface ColorControl extends DialogControlBase {
  kind: 'color' | 'coloralpha'
  /** #RRGGBB（color）或 #RRGGBBAA（coloralpha），见 Color::GetHexFormatted */
  value: string
  alpha: boolean
}

export type DialogControl =
  | LabelControl
  | EditControl
  | IntEditControl
  | FloatEditControl
  | DropdownControl
  | CheckboxControl
  | ColorControl

export interface DialogButton {
  /** WX_ID 之一，或 WX_ID_NONE（未知 id 串） */
  id: number
  label: string
}

export interface DialogSpec {
  controls: DialogControl[]
  buttons: DialogButton[]
  useButtons: boolean
}

export type DialogValue = string | number | boolean | null

export interface DialogResponse {
  /** 按钮下标；-1 表示对话框被关闭（Esc/关闭按钮） */
  button: number
  /** 按控件顺序的回读值 */
  values: DialogValue[]
}

/** 遍历 Lua 表（lua_for_each：数组部分 + 哈希部分的值） */
function forEachValue(value: unknown, cb: (item: unknown, key: unknown) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => cb(item, index + 1))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) cb(item, key)
  }
}

/** read_string_array：仅收集 lua_isstring 的项 */
function readStringArray(value: unknown): string[] {
  const result: string[] = []
  forEachValue(value, (item) => {
    if (isLuaString(item)) result.push(asLuaString(item))
  })
  return result
}

function parseControl(raw: unknown): DialogControl {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('bad control table entry')
  const record = raw as Record<string, unknown>
  const controlClass = typeof record.class === 'string' ? record.class.toLowerCase() : ''
  const base = {
    name: stringField(record, 'name'),
    hint: stringField(record, 'hint'),
    x: intField(record, 'x', 0),
    y: intField(record, 'y', 0),
    width: intField(record, 'width', 1),
    height: intField(record, 'height', 1),
  }

  if (controlClass === 'label')
    return { ...base, kind: 'label', label: stringField(record, 'label') }
  if (controlClass === 'edit' || controlClass === 'alpha')
    return { ...base, kind: 'edit', text: editText(record) }
  if (controlClass === 'textbox') return { ...base, kind: 'textbox', text: editText(record) }
  if (controlClass === 'intedit') {
    let min = intField(record, 'min', INT_MIN)
    let max = intField(record, 'max', INT_MAX)
    if (min >= max) {
      max = INT_MAX
      min = INT_MIN
    }
    return {
      ...base,
      kind: 'intedit',
      text: editText(record),
      value: intField(record, 'value', 0),
      min,
      max,
    }
  }
  if (controlClass === 'floatedit') {
    let min = numberField(record, 'min', -DBL_MAX)
    let max = numberField(record, 'max', DBL_MAX)
    const step = numberField(record, 'step', 0.0)
    if (min >= max) {
      max = DBL_MAX
      min = -DBL_MAX
    }
    if (step !== 0.0) {
      min = min === -DBL_MAX ? 0.0 : min
      max = max === DBL_MAX ? 100.0 : max
    }
    return {
      ...base,
      kind: 'floatedit',
      text: editText(record),
      value: numberField(record, 'value', 0.0),
      min,
      max,
      step,
    }
  }
  if (controlClass === 'dropdown')
    return {
      ...base,
      kind: 'dropdown',
      value: stringField(record, 'value'),
      items: readStringArray(record.items),
    }
  if (controlClass === 'checkbox')
    return {
      ...base,
      kind: 'checkbox',
      label: stringField(record, 'label'),
      value: boolField(record, 'value', false),
    }
  if (controlClass === 'color')
    return { ...base, kind: 'color', value: stringField(record, 'value'), alpha: false }
  if (controlClass === 'coloralpha')
    return { ...base, kind: 'coloralpha', value: stringField(record, 'value'), alpha: true }

  throw new Error('bad control table entry')
}

/** Edit：text = value，随后被 text 字段覆盖（未文档化行为） */
function editText(record: Record<string, unknown>): string {
  const text = stringField(record, 'value')
  return stringField(record, 'text', text)
}

function parseButtons(labels: unknown, ids: unknown): DialogButton[] {
  const buttons: DialogButton[] = []
  forEachValue(labels, (label) => {
    if (!isLuaString(label)) throw new Error('string expected, got ' + typeof label)
    buttons.push({ id: WX_ID_NONE, label: asLuaString(label) })
  })

  if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
    for (const [idName, label] of Object.entries(ids as Record<string, unknown>)) {
      const button = buttons.find((item) => item.label === asLuaString(label))
      if (!button) throw new Error(`Invalid button for id ${idName}`)
      button.id = STRING_TO_WX_ID[idName] ?? WX_ID_NONE
    }
  }

  if (buttons.length === 0) {
    buttons.push({ id: WX_ID.ok, label: '' }, { id: WX_ID.cancel, label: '' })
  }
  return buttons
}

/**
 * LuaDialog 构造（include_buttons = true）：解析控件表 + 按钮表。
 * 与源码一致：非表 → Cannot create config dialog from something non-table。
 * 注意：Lua 的数组式表经 luaToJs 会转成 JS 数组，它仍是合法表（forEachValue 支持），不应拒绝。
 */
export function parseDialogSpec(config: unknown, labels: unknown, ids: unknown): DialogSpec {
  if (!config || typeof config !== 'object')
    throw new Error('Cannot create config dialog from something non-table')
  const controls: DialogControl[] = []
  forEachValue(config, (item) => controls.push(parseControl(item)))
  return { controls, buttons: parseButtons(labels, ids), useButtons: true }
}

/** LuaDialog::LuaReadBack 的按钮部分：取消/关闭 → false，其它 → 按钮标签 */
export function readBackButton(buttons: DialogButton[], pushed: number): string | false {
  if (pushed < 0 || pushed >= buttons.length || buttons[pushed].id === WX_ID.cancel) return false
  return buttons[pushed].label
}

/** 单个控件的回读类型强制（LuaReadBack：label→nil、edit·textbox·dropdown→string、
 *  intedit→integer、floatedit→number、checkbox→boolean、color→#RRGGBB[A]） */
export function dialogReadBackValues(
  controls: DialogControl[],
  values: DialogValue[],
): DialogValue[] {
  return controls.map((control, index) => {
    const value = values[index]
    switch (control.kind) {
      case 'label':
        return null
      case 'edit':
      case 'textbox':
      case 'dropdown':
      case 'color':
      case 'coloralpha':
        return typeof value === 'string'
          ? value
          : value == null
            ? control.kind === 'color' || control.kind === 'coloralpha'
              ? control.value
              : ''
            : asLuaString(value)
      case 'intedit':
        return asLuaInteger(value)
      case 'floatedit':
        return asLuaNumber(value)
      case 'checkbox':
        return value === true
      default:
        return null
    }
  })
}

/** 控件自身的初始值（LuaDialog 构造时各控件默认值） */
function controlDefault(control: DialogControl): DialogValue {
  switch (control.kind) {
    case 'edit':
    case 'textbox':
      return control.text
    case 'intedit':
    case 'floatedit':
      return control.value
    case 'dropdown':
    case 'color':
    case 'coloralpha':
      return control.value
    case 'checkbox':
      return control.value
    default:
      return null
  }
}

/** 控件默认值列表（宿主渲染初始 state）：经回读类型强制，与用户操作后的值同态 */
export function defaultDialogValues(spec: DialogSpec): DialogValue[] {
  return dialogReadBackValues(spec.controls, spec.controls.map(controlDefault))
}

/**
 * LuaReadBack 的表部分（无按钮形态）：{ [control.name] = 回读值 }。
 * 导出过滤器 run 的 config 参数与 LuaDialog 回读表均为此形态。
 */
export function dialogConfigTable(
  spec: DialogSpec,
  values: DialogValue[],
): Record<string, DialogValue> {
  const readBack = dialogReadBackValues(spec.controls, values)
  const table: Record<string, DialogValue> = {}
  spec.controls.forEach((control, index) => {
    table[control.name] = readBack[index]
  })
  return table
}
