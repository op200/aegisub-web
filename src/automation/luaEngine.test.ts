import { describe, expect, it } from 'vitest'

import { loadAutomationScript, runAutomationMacro, type LuaRow } from './luaEngine'

const baseRows: LuaRow[] = [
  { class: 'info', key: 'Title', value: 'T', raw: '' },
  { class: 'style', name: 'Default', raw: '' },
  {
    class: 'dialogue',
    layer: 0,
    start_time: 0,
    end_time: 1000,
    style: 'Default',
    actor: '',
    margin_l: 0,
    margin_r: 0,
    margin_t: 0,
    margin_b: 0,
    effect: '',
    comment: false,
    text: 'hello',
    raw: '',
  },
  {
    class: 'dialogue',
    layer: 0,
    start_time: 1000,
    end_time: 2000,
    style: 'Default',
    actor: '',
    margin_l: 0,
    margin_r: 0,
    margin_t: 0,
    margin_b: 0,
    effect: '',
    comment: false,
    text: 'world',
    raw: '',
  },
]

function dialogues(rows: LuaRow[]): LuaRow[] {
  return rows.filter((row) => row.class === 'dialogue')
}

describe('Lua Automation 运行时（fengari）', () => {
  it('register_macro + 修改行 + 返回选区', async () => {
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
    expect(loaded.name).toBe('Test')
    expect(loaded.macros).toHaveLength(1)
    expect(loaded.macros[0].id).toBe('automation/lua/test/Upper')

    const result = runAutomationMacro(loaded.stateId, 'Upper', baseRows, [0], 0, {
      width: 640,
      height: 480,
    })
    const lines = dialogues(result.rows)
    expect(lines[0].text).toBe('HELLO')
    expect(lines[1].text).toBe('WORLD')
    // 返回的新选区换算回对白索引 0（全空间 1-based 3 → 0）
    expect(result.selected).toEqual([3])
    expect(result.active).toBe(3)
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
    const result = runAutomationMacro(loaded.stateId, 'Mutate', baseRows, [0], 0, {
      width: 640,
      height: 480,
    })
    const lines = dialogues(result.rows)
    expect(lines).toHaveLength(4)
    expect(lines[0].text).toBe('first')
    expect(lines[1].text).toBe('hello')
    expect(lines[2].text).toBe('new')
    expect(lines[3].text).toBe('last')
  })

  it('脚本错误向外抛出', async () => {
    const loaded = await loadAutomationScript(
      `aegisub.register_macro("Bad", "", function() error("boom") end)`,
      'bad.lua',
    )
    expect(() =>
      runAutomationMacro(loaded.stateId, 'Bad', baseRows, [0], 0, { width: 640, height: 480 }),
    ).toThrow(/boom/)
  })
})
