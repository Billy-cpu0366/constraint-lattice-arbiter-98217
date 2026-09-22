'use strict'

const t = require('tap')
const normalizeRange = require('../../ranges/normalize')

t.equal(normalizeRange('1.x'), '>=1.0.0 <2.0.0-0')
t.equal(normalizeRange('1'), '>=1.0.0 <2.0.0-0')
t.equal(normalizeRange('1.*'), '>=1.0.0 <2.0.0-0')
t.equal(normalizeRange('^1.0.0'), '>=1.0.0 <2.0.0-0')
t.equal(normalizeRange('~1.2'), '>=1.2.0 <1.3.0-0')
t.equal(normalizeRange('1.0.0 - 1.x'), '>=1.0.0 <2.0.0-0')
t.equal(normalizeRange('1.2.3 || 1.x'), '1.2.3||>=1.0.0 <2.0.0-0')
t.equal(normalizeRange('*'), '*')
t.equal(normalizeRange(''), '*')

// all the equivalent spellings collapse to the same result
for (const spelling of ['1', '1.x', '1.*', '^1.0.0']) {
  t.equal(normalizeRange(spelling), '>=1.0.0 <2.0.0-0')
}

// idempotent: normalizing repeatedly never changes the spelling
let stable = '1.2.x || >=2.0.0 <3.0.0'
for (let i = 0; i < 3; i++) {
  stable = normalizeRange(stable)
}
t.equal(stable, '>=1.2.0 <1.3.0-0||>=2.0.0 <3.0.0')
t.equal(normalizeRange(stable), stable)

// build metadata never participates
t.equal(normalizeRange('>=1.2.3+build.1 <2.0.0+sha.abc'), '>=1.2.3 <2.0.0')
t.equal(normalizeRange('1.2.3+build'), '1.2.3')

// bad input is "no result", not a throw
t.equal(normalizeRange('garbage!!!'), null)
t.equal(normalizeRange('1.x.5'), null)
t.equal(normalizeRange(42), null)
t.equal(normalizeRange(null), null)

// options are honored and isolated
t.equal(
  normalizeRange('~1', { includePrerelease: true }),
  '>=1.0.0-0 <2.0.0-0'
)
t.equal(normalizeRange('notvalid', { loose: false }), null)
t.equal(
  normalizeRange('>=1.2.3 || >=2.0.0', { loose: true }),
  '>=1.2.3||>=2.0.0'
)

// Range instances pass straight through, mismatched options re-parse
const Range = require('../../classes/range')
const range = new Range('1.x')
t.equal(normalizeRange(range), '>=1.0.0 <2.0.0-0')
t.equal(
  normalizeRange(range, { includePrerelease: true }),
  '>=1.0.0-0 <2.0.0-0'
)
