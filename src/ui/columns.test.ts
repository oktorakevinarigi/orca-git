import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN_COLUMN_WIDTH, MIN_SUBJECT_WIDTH, resizeColumns, validColumnWidths } from './columns.ts'

const start = { author: 150, date: 150, hash: 80 }

test('dragging a border widens the column before it and narrows the one after it', () => {
  assert.deepEqual(resizeColumns(start, 'author', 30, 500), { author: 180, date: 120, hash: 80 })
  assert.deepEqual(resizeColumns(start, 'date', -20, 500), { author: 150, date: 130, hash: 100 })
  // Subject takes the rest of the width: its border only changes Author.
  assert.deepEqual(resizeColumns(start, 'subject', -50, 500), { author: 200, date: 150, hash: 80 })
  assert.deepEqual(resizeColumns(start, 'subject', 40, 500), { author: 110, date: 150, hash: 80 })
})

test('no column gets narrower than its minimum, and the start widths are left untouched', () => {
  assert.equal(resizeColumns(start, 'author', 1000, 500).date, MIN_COLUMN_WIDTH)
  assert.equal(resizeColumns(start, 'author', -1000, 500).author, MIN_COLUMN_WIDTH)
  assert.equal(resizeColumns(start, 'date', 1000, 500).hash, MIN_COLUMN_WIDTH)
  assert.equal(resizeColumns(start, 'subject', 1000, 500).author, MIN_COLUMN_WIDTH)
  // Subject keeps at least its minimum: Author can only take what Subject can spare.
  assert.equal(resizeColumns(start, 'subject', -1000, 300).author, 150 + (300 - MIN_SUBJECT_WIDTH))
  assert.deepEqual(start, { author: 150, date: 150, hash: 80 })
})

test('saved widths are used only when every one is a usable number', () => {
  assert.deepEqual(validColumnWidths({ author: 100, date: 120, hash: 70 }), { author: 100, date: 120, hash: 70 })
  assert.equal(validColumnWidths(undefined), null)
  assert.equal(validColumnWidths({ author: 100, date: 'wide', hash: 70 }), null)
  assert.equal(validColumnWidths({ author: 100, date: 120, hash: 0 }), null)
  assert.equal(validColumnWidths({ author: Number.NaN, date: 120, hash: 70 }), null)
})
