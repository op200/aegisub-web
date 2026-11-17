import { describe, expect, it } from 'vitest'

import type { CoreCommand, CoreState, SubtitleCue } from '../core/types'
import { COMMAND_REGISTRY, type CommandApi, type CommandContext } from './commandRegistry'

function cue(id: string, startMs: number, endMs: number, text: string): SubtitleCue {
  return {
    id,
    layer: 0,
    startMs,
    endMs,
    style: 'Default',
    actor: '',
    marginL: 0,
    marginR: 0,
    marginV: 0,
    effect: '',
    text,
    comment: false,
    extra: {},
  }
}

/** 运行 edit/line/recombine，并按命令模拟 CoreState 供选区恢复 */
async function runRecombine(cues: SubtitleCue[], selected: string[]) {
  const applied: CoreCommand[] = []
  const selections: string[][] = []
  const statuses: string[] = []
  const api = {
    apply: async (commands: CoreCommand[]) => {
      applied.push(...commands)
      const removed = new Set(
        commands.flatMap((command) => (command.type === 'deleteCues' ? command.ids : [])),
      )
      const next = cues
        .filter((item) => !removed.has(item.id))
        .map((item) => {
          const update = commands.find(
            (command) => command.type === 'updateCue' && command.id === item.id,
          )
          return update && update.type === 'updateCue' ? { ...item, ...update.patch } : item
        })
      return { document: { cues: next } } as unknown as CoreState
    },
    selectLines: (ids: string[]) => selections.push(ids),
    setStatus: (message: string) => statuses.push(message),
  } as unknown as CommandApi
  const ctx = { core: { document: { cues } }, selected } as unknown as CommandContext
  await COMMAND_REGISTRY['edit/line/recombine'].run(ctx, api)
  return { applied, selections, statuses }
}

describe('edit/line/recombine', () => {
  it('folds duplicate text and keeps the later line expanded', async () => {
    const result = await runRecombine(
      [cue('a', 0, 1000, 'hello'), cue('b', 1000, 2000, 'hello')],
      ['a', 'b'],
    )
    expect(result.applied).toEqual([
      { type: 'updateCue', id: 'b', patch: { startMs: 0, endMs: 2000, text: 'hello' } },
      { type: 'deleteCues', ids: ['a'] },
    ])
    expect(result.selections).toEqual([['b']])
  })

  it('splits complementary prefix text after trimming', async () => {
    const result = await runRecombine(
      [cue('a', 0, 1000, ' Hello '), cue('b', 1000, 2000, 'Hello world')],
      ['a', 'b'],
    )
    expect(result.applied).toEqual([
      { type: 'updateCue', id: 'a', patch: { startMs: 0, endMs: 2000, text: 'Hello' } },
      { type: 'updateCue', id: 'b', patch: { startMs: 1000, endMs: 2000, text: 'world' } },
    ])
    expect(result.selections).toEqual([['a', 'b']])
  })

  it('deletes a trailing empty line', async () => {
    const result = await runRecombine(
      [cue('a', 0, 1000, 'Hello'), cue('b', 1000, 2000, '  ')],
      ['a', 'b'],
    )
    expect(result.applied).toEqual([{ type: 'deleteCues', ids: ['b'] }])
    expect(result.selections).toEqual([['a']])
  })

  it('reports when nothing can be merged', async () => {
    const result = await runRecombine(
      [cue('a', 0, 1000, 'Hello'), cue('b', 1000, 2000, 'World')],
      ['a', 'b'],
    )
    expect(result.applied).toEqual([])
    expect(result.statuses).toEqual(['No recombination possibilities found'])
  })
})

describe('edit/line/join/as_karaoke', () => {
  it('uses integer-truncated centisecond durations like combine_karaoke', async () => {
    const truncating = cue('b', 1000, 2059, 'world')
    const applied: CoreCommand[] = []
    const api = {
      apply: async (commands: CoreCommand[]) => {
        applied.push(...commands)
        return { document: { cues: [cue('a', 0, 1059, 'hello')] } } as unknown as CoreState
      },
      selectLines: () => undefined,
    } as unknown as CommandApi
    const ctx = {
      core: { document: { cues: [cue('a', 0, 1059, 'hello'), truncating] } },
      selected: ['a', 'b'],
    } as unknown as CommandContext
    await COMMAND_REGISTRY['edit/line/join/as_karaoke'].run(ctx, api)
    expect(applied[0]).toEqual({
      type: 'updateCue',
      id: 'a',
      patch: { text: '{\\k105}hello{\\k105}world', endMs: 2059 },
    })
    expect(applied[1]).toEqual({ type: 'deleteCues', ids: ['b'] })
  })
})
