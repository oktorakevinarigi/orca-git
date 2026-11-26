import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemo } from './cache.ts'

test('a second ask while the first still runs shares its answer', async () => {
  const memo = createMemo<number>(4)
  let calls = 0
  const compute = () => new Promise<number>((resolve) => setTimeout(() => resolve(++calls), 5))
  const [a, b] = await Promise.all([memo.get('k', compute), memo.get('k', compute)])
  assert.equal(a, 1)
  assert.equal(b, 1)
  assert.equal(await memo.get('k', compute), 1)
  assert.equal(calls, 1)
})

test('a failed answer is forgotten so the next ask tries again', async () => {
  const memo = createMemo<string>(4)
  await assert.rejects(memo.get('k', () => Promise.reject(new Error('boom'))))
  assert.equal(await memo.get('k', async () => 'ok'), 'ok')
})

test('keeps only the newest keys, a reused key counting as new', async () => {
  const memo = createMemo<string>(2)
  let calls = 0
  const compute = (value: string) => async () => {
    calls++
    return value
  }
  await memo.get('a', compute('a'))
  await memo.get('b', compute('b'))
  await memo.get('a', compute('a'))
  await memo.get('c', compute('c'))
  assert.equal(calls, 3)
  await memo.get('a', compute('a'))
  assert.equal(calls, 3, 'a was used recently and stayed')
  await memo.get('b', compute('b'))
  assert.equal(calls, 4, 'b was the oldest and went')
})

test('an entry expires after its time to live', async () => {
  const memo = createMemo<number>(4, 10)
  let calls = 0
  const compute = async () => ++calls
  await memo.get('k', compute)
  await memo.get('k', compute)
  assert.equal(calls, 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await memo.get('k', compute), 2)
})

test('clear forgets every answer', async () => {
  const memo = createMemo<number>(4)
  let calls = 0
  await memo.get('k', async () => ++calls)
  memo.clear()
  assert.equal(await memo.get('k', async () => ++calls), 2)
})
