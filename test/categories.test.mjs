import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYER1, LAYER2 } from '../hooks/pre-prompt-guard.mjs';
import { LAYER1_CATEGORIES, LAYER2_CATEGORIES } from '../src/categories.mjs';

// src/categories.mjs duplicates the category ids from LAYER1/LAYER2 rather
// than importing them, to avoid a circular import (hooks/pre-prompt-guard.mjs
// already imports src/config.mjs, which needs the category lists to validate
// project exceptions). This test is the guard against the two drifting apart.

test('LAYER1_CATEGORIES matches the actual LAYER1 rule categories', () => {
  assert.deepEqual(
    [...LAYER1_CATEGORIES].sort(),
    LAYER1.map((r) => r.category).sort(),
  );
});

test('LAYER2_CATEGORIES matches the actual LAYER2 rule categories', () => {
  assert.deepEqual(
    [...LAYER2_CATEGORIES].sort(),
    LAYER2.map((r) => r.category).sort(),
  );
});

test('no category id appears in both lists', () => {
  const overlap = LAYER1_CATEGORIES.filter((c) => LAYER2_CATEGORIES.includes(c));
  assert.deepEqual(overlap, []);
});
