/// <reference types="node" />
import { existsSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { setOption } from '../config/options'
import { makeDialogueRow, makeInfoRow, makeStyleRow, type LuaRow } from './luaAssFile'
import {
  closeAutomationState,
  loadAutomationScript,
  resetAutomationBackend,
  runAutomationMacro,
} from './luaEngine'

/** public/wasm 是构建产物目录；未构建时跳过，避免 CI 上误报 */
const wasmArtifact = new URL('../../public/wasm/lua55.js', import.meta.url)
const hasWasm = existsSync(wasmArtifact)

function baseRows(): LuaRow[] {
  return [
    makeInfoRow('Title', 'T'),
    makeStyleRow({
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
    }),
    makeDialogueRow({
      comment: false,
      layer: 0,
      start_time: 0,
      end_time: 1000,
      style: 'Default',
      actor: '',
      effect: '',
      margin_l: 0,
      margin_r: 0,
      margin_t: 0,
      text: 'hello',
      extra: {},
    }),
  ]
}

describe.skipIf(!hasWasm)('Lua Automation 运行时（Lua 5.5 WASM）', () => {
  beforeAll(() => {
    setOption('Automation/Backend', 'lua55-wasm')
  })

  afterAll(() => {
    resetAutomationBackend()
    setOption('Automation/Backend', 'fengari')
  })

  it('注册宏、修改行、协程 yield/resume', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "WasmTest"
      aegisub.register_macro("Upper", "Uppercase", function(subs, sel, active)
        aegisub.progress.set(50)
        for i = 1, #subs do
          local line = subs[i]
          if line.class == "dialogue" then
            line.text = line.text:upper()
            subs[i] = line
          end
        end
        aegisub.progress.set(100)
        return sel, active
      end)
      `,
      'test_wasm.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)
    expect(loaded.macros).toHaveLength(1)

    const result = await runAutomationMacro(loaded.stateId, 'Upper', baseRows(), [0], 0)
    expect(result.ok).toBe(true)
    expect(result.commits[0].payload.cues.map((cue) => cue.text)).toEqual(['HELLO'])
    expect(result.selected).toEqual([0])
    closeAutomationState(loaded.stateId)
  })

  it('Lua 错误经桥接抛回并生成 traceback', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "WasmError"
      aegisub.register_macro("Boom", "", function(subs)
        local n = nil
        n.boom()
      end)
      `,
      'test_wasm_error.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)

    const result = await runAutomationMacro(loaded.stateId, 'Boom', baseRows(), [0], 0)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('attempt to index')
    closeAutomationState(loaded.stateId)
  })
})
