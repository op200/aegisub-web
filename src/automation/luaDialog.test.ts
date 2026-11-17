import { describe, expect, it } from 'vitest'

import {
  applyDialogSettings,
  inlineStringDecode,
  inlineStringEncode,
  serializeDialogSettings,
  type DialogSpec,
} from './luaDialog'

function control(
  kind: DialogSpec['controls'][number]['kind'],
  name: string,
  extra: Record<string, unknown> = {},
): DialogSpec['controls'][number] {
  return {
    kind,
    name,
    hint: '',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    ...extra,
  } as DialogSpec['controls'][number]
}

describe('automation_settings 序列化', () => {
  it('inlineStringEncode 编码控制字符与分隔符，并可逆', () => {
    const source = 'a:b|c#d\n'
    const encoded = inlineStringEncode(source)
    expect(encoded).toBe('a#3Ab#7Cc#23d#0A')
    expect(inlineStringDecode(encoded)).toBe(source)
  })

  it('按控件类型生成 name:value|... 并跳过 label', () => {
    const spec: DialogSpec = {
      useButtons: false,
      buttons: [],
      controls: [
        control('label', 'title', { label: 'Title' }),
        control('edit', 'text', { text: '' }),
        control('intedit', 'count', { text: '', value: 0, min: 0, max: 10 }),
        control('floatedit', 'scale', { text: '', value: 0, min: 0, max: 10, step: 0.1 }),
        control('checkbox', 'enabled', { label: 'Enabled', value: true }),
        control('dropdown', 'mode', { value: '', items: [] }),
      ],
    }
    const values = ['ignored', 'a:b', 3.9, 1.25, false, 'x|y']
    expect(serializeDialogSettings(spec.controls, values)).toBe(
      'text:a#3Ab|count:3|scale:1.25|enabled:0|mode:x#7Cy',
    )
  })

  it('applyDialogSettings 把已保存值套回默认值', () => {
    const spec: DialogSpec = {
      useButtons: false,
      buttons: [],
      controls: [
        control('edit', 'text', { text: 'default' }),
        control('intedit', 'count', { text: '', value: 0, min: 0, max: 10 }),
        control('floatedit', 'scale', { text: '', value: 0, min: 0, max: 10, step: 0.1 }),
        control('checkbox', 'enabled', { label: 'Enabled', value: false }),
        control('dropdown', 'mode', { value: 'a', items: ['a', 'b'] }),
        control('color', 'color', { value: '#000000', alpha: false }),
      ],
    }
    const defaults = ['default', 0, 0, false, 'a', '#000000']
    const stored = 'text:hello|count:7|scale:2.5|enabled:1|mode:b|color:#23FF0000'
    expect(applyDialogSettings(spec, defaults, stored)).toEqual([
      'hello',
      7,
      2.5,
      true,
      'b',
      '#FF0000',
    ])
  })

  it('未知控件和非法片段被忽略', () => {
    const spec: DialogSpec = {
      useButtons: false,
      buttons: [],
      controls: [control('edit', 'text', { text: 'default' })],
    }
    expect(applyDialogSettings(spec, ['default'], 'unknown:1|broken|text:ok')).toEqual(['ok'])
  })
})
