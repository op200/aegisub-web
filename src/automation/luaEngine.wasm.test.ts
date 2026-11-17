/// <reference types="node" />
import { existsSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { setOption } from '../config/options'
import { makeDialogueRow, makeInfoRow, makeStyleRow, type LuaRow } from './luaAssFile'
import {
  closeAutomationState,
  loadAutomationScript,
  resetAutomationBackend,
  runAutomationFilter,
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

  it('并发加载的脚本状态互不共享全局（后端只实例化一次）', async () => {
    // App 用 Promise.all 并发加载脚本：WASM 后端若被并发初始化会创建两个 VM 实例，
    // 状态句柄只在实例内有效，两个实例的同号句柄会指向彼此的状态（全局互相覆盖）。
    resetAutomationBackend()
    const count = 6
    const loaded = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        loadAutomationScript(
          `
          script_name = "Concurrent${i}"
          script_version = "${i}"
          aegisub.register_macro("Who", "", function(subs, sel)
            aegisub.log(script_name .. "/" .. script_version)
            return sel, 0
          end)
          `,
          `concurrent_${i}.lua`,
        ),
      ),
    )
    const results = await Promise.all(
      loaded.map((script) => runAutomationMacro(script.stateId, 'Who', baseRows(), [0], 0)),
    )
    for (let i = 0; i < count; i++) {
      expect(loaded[i].loaded, loaded[i].error).toBe(true)
      expect(loaded[i].name).toBe(`Concurrent${i}`)
      expect(results[i].ok, results[i].error).toBe(true)
      // 每个脚本状态必须看到自己写入的全局，而不是另一个实例同号状态的
      expect(results[i].log.join('')).toContain(`Concurrent${i}/${i}`)
      closeAutomationState(loaded[i].stateId)
    }
  })

  it('lpeg：编译进 wasm 的 C 模块可直接 require', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "WasmLpeg"
      local lpeg = require 'lpeg'
      assert(type(lpeg.P) == 'function' and type(lpeg.match) == 'function')
      assert(_G.lpeg == lpeg)
      local word = lpeg.C(lpeg.R('az') ^ 1)
      aegisub.register_macro("Lpeg", "", function(subs, sel)
        aegisub.log(tostring(word:match('hello world')))
        return sel, 0
      end)
      `,
      'test_wasm_lpeg.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)

    const result = await runAutomationMacro(loaded.stateId, 'Lpeg', baseRows(), [0], 0)
    expect(result.ok, result.error).toBe(true)
    expect(result.log.join('')).toContain('hello')
    closeAutomationState(loaded.stateId)
  })

  it('luabins：序列化/反序列化往返（保留废弃提示包装）', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "WasmLuabins"
      local luabins = require 'luabins'
      assert(_G.luabins == luabins)
      aegisub.register_macro("Roundtrip", "", function(subs, sel)
        local data = luabins.save({ 1, 'x', true })
        assert(type(data) == 'string')
        local ok, value = luabins.load(data)
        assert(ok == true)
        assert(value[1] == 1 and value[2] == 'x' and value[3] == true)
        aegisub.log('roundtrip')
        return sel, 0
      end)
      `,
      'test_wasm_luabins.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)

    const result = await runAutomationMacro(loaded.stateId, 'Roundtrip', baseRows(), [0], 0)
    expect(result.ok, result.error).toBe(true)
    expect(result.log.join('')).toContain('roundtrip')
    closeAutomationState(loaded.stateId)
  })

  it('lfs：WASM 后端的 VFS 快照与目录操作', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "WasmLfs"
      local lfs = require 'lfs'
      assert(lfs.currentdir() == '/')
      assert(lfs.mkdir('/web-test/dir'))
      assert(lfs.touch('/web-test/dir/a.txt'))
      assert(lfs.attributes('/web-test/dir/a.txt', 'mode') == 'file')
      local names = {}
      for name in lfs.dir('/web-test/dir') do names[#names + 1] = name end
      assert(#names == 1 and names[1] == 'a.txt')
      aegisub.register_macro("Ok", "", function(subs, sel) return sel, 0 end)
      `,
      'test_wasm_lfs.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)

    const result = await runAutomationMacro(loaded.stateId, 'Ok', baseRows(), [0], 0)
    expect(result.ok, result.error).toBe(true)
    closeAutomationState(loaded.stateId)
  })

  it('导出过滤器：register_filter 的 run 函数跑在 WASM VM 上', async () => {
    const loaded = await loadAutomationScript(
      `
      script_name = "WasmFilter"
      aegisub.register_filter("UpperFilter", "uppercases text", 0, function(subs, config)
        for i = 1, #subs do
          local line = subs[i]
          if line.class == 'dialogue' then
            line.text = line.text:upper()
            subs[i] = line
          end
        end
      end)
      `,
      'test_wasm_filter.lua',
    )
    expect(loaded.loaded, loaded.error).toBe(true)
    expect(loaded.filters).toHaveLength(1)

    const result = await runAutomationFilter(loaded.stateId, 'UpperFilter', baseRows(), null)
    expect(result.ok, result.error).toBe(true)
    expect(result.payload?.cues.map((cue) => cue.text)).toEqual(['HELLO'])
    closeAutomationState(loaded.stateId)
  })

  it('MoonScript：.moon 脚本经 vendored 编译器在 WASM VM 内运行', async () => {
    const loaded = await loadAutomationScript(
      `
script_name = "WasmMoon"
aegisub.register_macro "Moon", "moon macro", (subs, sel) ->
  line = subs[3]
  line.text = "moon"
  subs[3] = line
  return sel, 0
      `,
      'test_wasm_moon.moon',
    )
    expect(loaded.loaded, loaded.error).toBe(true)

    const result = await runAutomationMacro(loaded.stateId, 'Moon', baseRows(), [0], 0)
    expect(result.ok, result.error).toBe(true)
    expect(result.commits[0].payload.cues.map((cue) => cue.text)).toEqual(['moon'])
    closeAutomationState(loaded.stateId)
  })

  it('MoonScript：编译错误经 lpeg 路径美化（errors.lua）', async () => {
    const loaded = await loadAutomationScript(
      `script_name = "Broken"
if
`,
      'test_wasm_moon_error.moon',
    )
    expect(loaded.loaded).toBe(false)
    expect(loaded.error).toBeTruthy()
  })
})
