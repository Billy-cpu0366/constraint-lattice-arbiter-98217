'use strict'

const t = require('tap')
const intersectRanges = require('../../ranges/intersect')
const normalizeRange = require('../../ranges/normalize')
const satisfies = require('../../functions/satisfies')

t.equal(intersectRanges(['^1.0.0', '>=1.5.0']), '>=1.5.0 <2.0.0-0')
t.equal(intersectRanges(['^1.0.0', '>=2.0.0']), null)
t.equal(
  intersectRanges(['^1.0.0 || ^2.0.0', '>=1.5.0 <2.5.0']),
  '>=1.5.0 <2.0.0-0||>=2.0.0 <2.5.0'
)
t.equal(intersectRanges(['1.x']), '>=1.0.0 <2.0.0-0')
t.equal(
  intersectRanges(['^1.0.0', '>=1.2.0 <1.5.0', '1.4.x']),
  '>=1.4.0 <1.5.0-0'
)
t.equal(intersectRanges(['>=2.0.0', '<1.0.0']), null)
t.equal(intersectRanges(['>1.0.0', '>=1.0.0 <=1.0.0']), null)
t.equal(intersectRanges(['>=1.0.0', '<=1.0.0']), '1.0.0')
t.equal(intersectRanges(['1.2.3', '1.2.3']), '1.2.3')
t.equal(intersectRanges(['*', '*']), '*')
t.equal(intersectRanges(['>1.0.0-alpha', '<=1.0.0-alpha']), null)
t.equal(intersectRanges(['>=1.0.0-alpha', '<=1.0.0-alpha']), '1.0.0-alpha')

// argument order never matters
t.equal(
  intersectRanges(['^1.0.0', '^1.2.0']),
  intersectRanges(['^1.2.0', '^1.0.0'])
)
t.equal(
  intersectRanges(['^1.0.0 || ^2.0.0', '^1.5.0']),
  intersectRanges(['^1.5.0', '^1.0.0 || ^2.0.0'])
)

// intersecting a range with itself is exactly that range
t.equal(intersectRanges(['1.x', '1.x']), normalizeRange('1.x'))
t.equal(
  intersectRanges(['1.2.x || 2.x', '1.2.x || 2.x', '1.2.x || 2.x']),
  normalizeRange('1.2.x || 2.x')
)

// the result feeds back through normalization unchanged
const result = intersectRanges(['^1.0.0 || ^2.0.0', '>=1.5.0'])
t.equal(normalizeRange(result), result)

// intersection can only narrow, never widen
for (const version of ['1.0.0', '1.1.9', '1.2.0', '1.9.9']) {
  t.equal(
    satisfies(version, intersectRanges(['^1.0.0', '^1.2.0'])),
    satisfies(version, '^1.2.0')
  )
}
t.ok(satisfies('1.5.0', result))
t.notOk(satisfies('1.4.0', result))

// prereleases in a higher tuple are blocked by the intersected range
const withPrereleaseOption = intersectRanges(
  ['^1.0.0'],
  { includePrerelease: false }
)
t.notOk(satisfies('2.0.0-alpha', withPrereleaseOption))
t.notOk(satisfies('1.5.0-alpha', withPrereleaseOption))
const includingPrereleases = intersectRanges(
  ['^1.0.0'],
  { includePrerelease: true }
)
t.ok(satisfies('1.5.0-alpha', includingPrereleases, { includePrerelease: true }))

// bad input never throws
t.equal(intersectRanges([]), null)
t.equal(intersectRanges(['^1.0.0', 'garbage!!!']), null)
t.equal(intersectRanges(['1.x.5', '^1.0.0']), null)
