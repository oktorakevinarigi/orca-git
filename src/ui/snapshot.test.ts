import assert from 'node:assert/strict'
import { test } from 'node:test'
import { viewKey } from './snapshot.ts'

test('the panel has one saved view and each tab one per repository', () => {
  assert.equal(viewKey('panel', '/a'), viewKey('panel', '/b'))
  assert.notEqual(viewKey('editor', '/a'), viewKey('editor', '/b'))
  assert.equal(viewKey('editor', '/a'), viewKey('editor', '/a'))
})
