import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommandLogStore } from './commandLog'

beforeEach(() => {
  useCommandLogStore.setState({ past: [], future: [], batching: null })
})

function cmd(label: string, undo = vi.fn(), redo = vi.fn()) {
  return { label, undo, redo }
}

describe('commandLog', () => {
  it('undo calls the top command\'s undo and moves it to future', async () => {
    const c = cmd('rename α')
    useCommandLogStore.getState().push(c)
    await useCommandLogStore.getState().undo()
    expect(c.undo).toHaveBeenCalledTimes(1)
    expect(useCommandLogStore.getState().past).toEqual([])
    expect(useCommandLogStore.getState().future).toEqual([c])
  })

  it('redo calls the top future command\'s redo and moves it back to past', async () => {
    const c = cmd('rename α')
    useCommandLogStore.getState().push(c)
    await useCommandLogStore.getState().undo()
    await useCommandLogStore.getState().redo()
    expect(c.redo).toHaveBeenCalledTimes(1)
    expect(useCommandLogStore.getState().past).toEqual([c])
    expect(useCommandLogStore.getState().future).toEqual([])
  })

  it('undo/redo on an empty stack is a no-op', async () => {
    await expect(useCommandLogStore.getState().undo()).resolves.toBeUndefined()
    await expect(useCommandLogStore.getState().redo()).resolves.toBeUndefined()
  })

  it('a new push clears the redo stack', async () => {
    const a = cmd('a')
    const b = cmd('b')
    useCommandLogStore.getState().push(a)
    await useCommandLogStore.getState().undo()
    expect(useCommandLogStore.getState().future).toEqual([a])
    useCommandLogStore.getState().push(b)
    expect(useCommandLogStore.getState().future).toEqual([])
    expect(useCommandLogStore.getState().past).toEqual([b])
  })

  it('undo/redo replay commands in LIFO order across several steps', async () => {
    const order: string[] = []
    const a = cmd(
      'a',
      vi.fn(() => {
        order.push('undo a')
      }),
      vi.fn(() => {
        order.push('redo a')
      }),
    )
    const b = cmd(
      'b',
      vi.fn(() => {
        order.push('undo b')
      }),
      vi.fn(() => {
        order.push('redo b')
      }),
    )
    useCommandLogStore.getState().push(a)
    useCommandLogStore.getState().push(b)
    await useCommandLogStore.getState().undo()
    await useCommandLogStore.getState().undo()
    expect(order).toEqual(['undo b', 'undo a'])
    await useCommandLogStore.getState().redo()
    await useCommandLogStore.getState().redo()
    expect(order).toEqual(['undo b', 'undo a', 'redo a', 'redo b'])
  })

  it('bounds the log depth, dropping the oldest command first', () => {
    for (let i = 0; i < 205; i++) {
      useCommandLogStore.getState().push(cmd(`cmd-${i}`))
    }
    const past = useCommandLogStore.getState().past
    expect(past).toHaveLength(200)
    expect(past[0]?.label).toBe('cmd-5')
    expect(past[past.length - 1]?.label).toBe('cmd-204')
  })

  it('clear resets past, future and any in-progress batch', async () => {
    useCommandLogStore.getState().push(cmd('a'))
    await useCommandLogStore.getState().undo()
    useCommandLogStore.getState().clear()
    expect(useCommandLogStore.getState()).toMatchObject({ past: [], future: [], batching: null })
  })

  describe('batch', () => {
    it('collects every push during the batch into a single combined command', async () => {
      const order: string[] = []
      // eslint-disable-next-line @typescript-eslint/require-await -- batch()'s fn must return Promise<T>; this test body is synchronous
      await useCommandLogStore.getState().batch('create + justify', async () => {
        useCommandLogStore.getState().push(
          cmd(
            'create',
            vi.fn(() => order.push('undo create')),
            vi.fn(() => order.push('redo create')),
          ),
        )
        useCommandLogStore.getState().push(
          cmd(
            'justify',
            vi.fn(() => order.push('undo justify')),
            vi.fn(() => order.push('redo justify')),
          ),
        )
      })

      expect(useCommandLogStore.getState().past).toHaveLength(1)
      expect(useCommandLogStore.getState().past[0]?.label).toBe('create + justify')

      await useCommandLogStore.getState().undo()
      expect(order).toEqual(['undo justify', 'undo create'])

      await useCommandLogStore.getState().redo()
      expect(order).toEqual(['undo justify', 'undo create', 'redo create', 'redo justify'])
    })

    it('pushes nothing when the batch never pushes a command', async () => {
      await useCommandLogStore.getState().batch('no-op', async () => {})
      expect(useCommandLogStore.getState().past).toEqual([])
    })

    it('returns the wrapped function\'s result', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await -- batch()'s fn must return Promise<T>; this test body is synchronous
      const result = await useCommandLogStore.getState().batch('x', async () => 42)
      expect(result).toBe(42)
    })

    it('a nested batch call joins the outer batch rather than creating its own command', async () => {
      await useCommandLogStore.getState().batch('outer', async () => {
        useCommandLogStore.getState().push(cmd('one'))
        // eslint-disable-next-line @typescript-eslint/require-await -- batch()'s fn must return Promise<T>; this test body is synchronous
        await useCommandLogStore.getState().batch('inner', async () => {
          useCommandLogStore.getState().push(cmd('two'))
        })
      })
      expect(useCommandLogStore.getState().past).toHaveLength(1)
      expect(useCommandLogStore.getState().past[0]?.label).toBe('outer')
    })

    it('still clears batching state when the wrapped function throws', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/require-await -- batch()'s fn must return Promise<T>; this test body is synchronous
        useCommandLogStore.getState().batch('boom', async () => {
          useCommandLogStore.getState().push(cmd('partial'))
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect(useCommandLogStore.getState().past).toEqual([])
      expect(useCommandLogStore.getState().batching).toBeNull()
    })
  })
})
