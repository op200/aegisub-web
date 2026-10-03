import { describe, expect, it } from 'vitest'

import { makeDialogueRow, makeInfoRow, makeStyleRow, type LuaRow } from './luaAssFile'
import { defaultDialogValues, dialogConfigTable } from './luaDialog'
import {
  closeAutomationState,
  configureAutomationFilter,
  isActiveAutomationMacro,
  loadAutomationScript,
  orderedAutomationFilters,
  runAutomationFilter,
  runAutomationMacro,
  validateAutomationMacro,
} from './luaEngine'

function defaultStyle(): LuaRow {
  return makeStyleRow({
    name: 'Default',
    fontname: 'Arial',
    fontsize: 20,
    color1: '&H00FFFFFF&',
    color2: '&H000000FF&',
    color3: '&H00000000&',
    color4: '&H00000000&',
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    scale_x: 100,
    scale_y: 100,
    spacing: 0,
    angle: 0,
    borderstyle: 1,
    outline: 2,
    shadow: 2,
    align: 2,
    margin_l: 10,
    margin_r: 10,
    margin_t: 10,
    encoding: 1,
  })
}

function dialogue(text: string, start: number, end: number): LuaRow {
  return makeDialogueRow({
    comment: false,
    layer: 0,
    start_time: start,
    end_time: end,
    style: 'Default',
    actor: '',
    effect: '',
    margin_l: 0,
    margin_r: 0,
    margin_t: 0,
    text,
    extra: {},
  })
}

/** [Info, Style, Dialogue, Dialogue]：对白全空间起点为 3（1-based） */
function baseRows(): LuaRow[] {
  return [
    makeInfoRow('Title', 'T'),
    defaultStyle(),
    dialogue('hello', 0, 1000),
    dialogue('world', 1000, 2000),
  ]
}

describe('Lua Automation 运行时（fengari）', () => {
  it('register_macro + 修改行 + 返回选区表', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "Test"
      aegisub.register_macro("Upper", "Uppercase", function(subs, sel, active)
        for i = 1, #subs do
          local line = subs[i]
          if line.class == "dialogue" then
            line.text = line.text:upper()
            subs[i] = line
          end
        end
        return sel, active
      end)
      `,
      'test.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)
    expect(loaded.name).toBe('Test')
    expect(loaded.macros).toHaveLength(1)
    expect(loaded.macros[0].id).toBe('automation/lua/test/Upper')

    const result = await runAutomationMacro(loaded.stateId, 'Upper', baseRows(), [0], 0)
    expect(result.ok).toBe(true)
    expect(result.commits).toHaveLength(1)
    expect(result.commits[0].label).toBe('Upper')
    expect(result.commits[0].payload.cues.map((cue) => cue.text)).toEqual(['HELLO', 'WORLD'])
    // 脚本回传的选区表（全空间 3）换算回对白序数 0
    expect(result.selected).toEqual([0])
    expect(result.active).toBe(0)
    closeAutomationState(loaded.stateId)
  })

  it('subtitles.delete / append / 负索引插入', async () => {
    const loaded = await loadAutomationScript(
      `
      aegisub.register_macro("Mutate", "", function(subs)
        subs.delete(4)
        subs[-3] = {class="dialogue", layer=0, start_time=0, end_time=100, style="Default",
          actor="", margin_l=0, margin_r=0, margin_t=0, margin_b=0, effect="", comment=false, text="first"}
        subs.append({class="dialogue", layer=0, start_time=2000, end_time=3000, style="Default",
          actor="", margin_l=0, margin_r=0, margin_t=0, margin_b=0, effect="", comment=false, text="new"})
        subs[0] = {class="dialogue", layer=0, start_time=0, end_time=100, style="Default",
          actor="", margin_l=0, margin_r=0, margin_t=0, margin_b=0, effect="", comment=false, text="last"}
      end)
      `,
      'mutate.lua',
    )
    const result = await runAutomationMacro(loaded.stateId, 'Mutate', baseRows(), [0], 0)
    expect(result.ok).toBe(true)
    const texts = result.commits.at(-1)?.payload.cues.map((cue) => cue.text)
    expect(texts).toEqual(['first', 'hello', 'new', 'last'])
    closeAutomationState(loaded.stateId)
  })

  it('脚本运行时错误 → ok:false 并记录运行时错误日志', async () => {
    const loaded = await loadAutomationScript(
      `aegisub.register_macro("Bad", "", function() error("boom") end)`,
      'bad.lua',
    )
    const result = await runAutomationMacro(loaded.stateId, 'Bad', baseRows(), [0], 0)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/boom/)
    expect(result.log.join('\n')).toContain('Lua reported a runtime error')
    closeAutomationState(loaded.stateId)
  })

  it('validate / isactive 返回动态帮助与勾选态', async () => {
    const loaded = await loadAutomationScript(
      `
      aegisub.register_macro("Toggle", "desc",
        function() end,
        function(subs, sel, active) return true, "dynamic help" end,
        function(subs, sel, active) return true end)
      `,
      'toggle.lua',
    )
    const validated = await validateAutomationMacro(loaded.stateId, 'Toggle', baseRows(), [0], 0)
    expect(validated.ok).toBe(true)
    expect(validated.help).toBe('dynamic help')

    const active = await isActiveAutomationMacro(loaded.stateId, 'Toggle', baseRows(), [0], 0)
    expect(active.ok).toBe(true)
    expect(active.active).toBe(true)
    closeAutomationState(loaded.stateId)
  })

  it('register_filter：run 修改行集 → payload（can_set_undo=false）', async () => {
    const loaded = await loadAutomationScript(
      `
      aegisub.register_filter("Upper", "Uppercase", 100, function(subs, config)
        for i = 1, #subs do
          local line = subs[i]
          if line.class == "dialogue" then
            line.text = line.text:upper()
            subs[i] = line
          end
        end
      end)
      `,
      'filter.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)
    expect(loaded.filters).toHaveLength(1)
    expect(loaded.filters[0]).toMatchObject({ name: 'Upper', priority: 100, hasConfig: false })

    const result = await runAutomationFilter(loaded.stateId, 'Upper', baseRows(), null)
    expect(result.ok).toBe(true)
    expect(result.payload?.cues.map((cue) => cue.text)).toEqual(['HELLO', 'WORLD'])
    // styles 保留、info 未触碰（与 replaceDocument 负载语义一致）
    expect(result.payload?.info).toBeUndefined()
    expect(result.payload?.styles?.map((style) => style.name)).toEqual(['Default'])
    closeAutomationState(loaded.stateId)
  })

  it('register_filter：config 生成 spec，回读表传入 run；config 报错按源码文案记录', async () => {
    const loaded = await loadAutomationScript(
      `
      aegisub.register_filter("Configured", "with config", 50,
        function(subs, config)
          if config.upper then
            for i = 1, #subs do
              local line = subs[i]
              if line.class == "dialogue" then
                line.text = line.text:upper()
                subs[i] = line
              end
            end
          end
        end,
        function(subs)
          return { { class = "checkbox", name = "upper", label = "Uppercase", value = false } }
        end)
      aegisub.register_filter("Broken", "bad config", 40, function() end,
        function() error("cfg boom") end)
      `,
      'configured.lua',
    )
    expect(loaded.filters.map((filter) => filter.hasConfig)).toEqual([true, true])

    const spec = await configureAutomationFilter(loaded.stateId, 'Configured', baseRows())
    expect(spec.ok, spec.error).toBe(true)
    expect(spec.spec?.controls[0]).toMatchObject({ kind: 'checkbox', name: 'upper' })
    expect(defaultDialogValues(spec.spec!)).toEqual([false])

    // 默认（未配置）→ config.upper 为 false，行不变
    const untouched = await runAutomationFilter(
      loaded.stateId,
      'Configured',
      baseRows(),
      dialogConfigTable(spec.spec!, defaultDialogValues(spec.spec!)),
    )
    expect(untouched.payload?.cues.map((cue) => cue.text)).toEqual(['hello', 'world'])
    // 回读表（用户勾选）→ 行被改为大写
    const applied = await runAutomationFilter(
      loaded.stateId,
      'Configured',
      baseRows(),
      dialogConfigTable(spec.spec!, [true]),
    )
    expect(applied.payload?.cues.map((cue) => cue.text)).toEqual(['HELLO', 'WORLD'])

    const broken = await configureAutomationFilter(loaded.stateId, 'Broken', baseRows())
    expect(broken.ok).toBe(false)
    expect(broken.log.join('\n')).toContain('Runtime error in Lua config dialog function')
    closeAutomationState(loaded.stateId)
  })

  it('脚本开头的 UTF-8 BOM 被剥离（script_reader.cpp LoadFile 语义）', async () => {
    const loaded = await loadAutomationScript(
      `\uFEFFaegisub.register_macro("Bom", "", function() end)`,
      'bom.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)
    expect(loaded.macros.map((macro) => macro.id)).toEqual(['automation/lua/bom/Bom'])
    closeAutomationState(loaded.stateId)
  })

  it('orderedAutomationFilters：优先级降序 + 重名去重 + 跳过加载失败脚本', async () => {
    const loaded = await loadAutomationScript(
      `
      aegisub.register_filter("Low", "low", 1, function() end)
      aegisub.register_filter("High", "high", 100, function() end)
      aegisub.register_filter("High", "dup", 50,
        function() end,
        function() return {} end)
      `,
      'ordered.lua',
    )
    const ordered = orderedAutomationFilters([{ stateId: -1, filters: loaded.filters }, loaded])
    expect(ordered.map((filter) => filter.displayName)).toEqual(['High', 'High (1)', 'Low'])
    expect(ordered.map((filter) => filter.hasConfig)).toEqual([false, true, false])
    expect(ordered.every((filter) => filter.stateId === loaded.stateId)).toBe(true)
    closeAutomationState(loaded.stateId)
  })
})
