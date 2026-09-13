import { describe, expect, it } from 'vitest'

import { commandForShortcut, primaryShortcut } from './commands'

describe('Aegisub shortcut registry', () => {
  it('resolves default application shortcuts', () => {
    expect(commandForShortcut('Ctrl-O', 'Default')).toBe('subtitle/open')
    expect(commandForShortcut('Ctrl-Shift-S', 'Default')).toBe('subtitle/save/as')
    expect(primaryShortcut('edit/line/delete')).toBe('Ctrl-Delete')
  })

  it('gives focused Aegisub contexts priority over defaults', () => {
    expect(commandForShortcut('Right', 'Subtitle Grid')).toBe('video/frame/next')
    expect(commandForShortcut('Space', 'Audio')).toBe('audio/play/selection')
    expect(commandForShortcut('Enter', 'Subtitle Edit Box')).toBe('grid/line/next/create')
    expect(commandForShortcut('Ctrl-O', 'Audio')).toBe('subtitle/open')
    expect(commandForShortcut('Ctrl-O', 'Subtitle Grid')).toBe('subtitle/open')
  })

  it('keeps audio, video tool and numeric keypad bindings', () => {
    expect(commandForShortcut('Q', 'Audio')).toBe('audio/play/selection/before')
    expect(commandForShortcut('J', 'Video')).toBe('video/tool/vector_clip')
    expect(commandForShortcut('KP_5', 'Default')).toBeNull()
  })
})
