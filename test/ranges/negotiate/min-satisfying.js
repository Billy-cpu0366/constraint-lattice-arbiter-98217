'use strict'

const t = require('tap')
const { negotiate } = require('../../..')
const { minSatisfying, clearCache, cacheStats } = negotiate

const SemVer = require('../../../classes/semver')

t.beforeEach(() => clearCache())

t.test('returns the smallest passing version', (t) => {
  const cases = [
    ['*', '0.0.0'],
    ['^1.2.3', '1.2.3'],
    ['>=1.2.0 <1.8.0', '1.2.0'],
    ['>1.2.3', '1.2.4'],
    ['1.2.3', '1.2.3'],
    ['1.2 - 1.4', '1.2.0'],
    ['^1.2.3-alpha.1', '1.2.3-alpha.1'],
    ['>=1.0.0-alpha <2.0.0', '1.0.0-alpha'],
    ['1.x || >=2.0.0', '1.0.0'],
  ]
  for (const [range, expected] of cases) {
    const result = minSatisfying(range)
    t.equal(result.satisfies, true, `${range} satisfies`)
    t.equal(result.version, expected, `${range} minimum`)
    // the reported answer really passes the shared gate
    t.ok(negotiate.isPrereleaseAllowed(range, result.version),
      `${range} answer passes the shared gate`)
    // every immediately smaller release does not pass
    if (!new SemVer(result.version).prerelease.length) {
      const smaller = new SemVer(result.version)
      smaller.patch -= 1
      if (smaller.patch >= 0) {
        const smallerVersion = smaller.format()
        t.equal(negotiate.isPrereleaseAllowed(range, smallerVersion), false,
          `${range}: ${smallerVersion} does not pass`)
      }
    }
    t.equal(result.blocker, null, `${range} has no blocker`)
  }
  t.end()
})

t.test('unreachable ranges name the blocking comparator and segment', (t) => {
  const cases = [
    ['>=2.0.0 <1.0.0', 'major'],
    ['>=1.2.0 <1.1.0', 'minor'],
    ['>=1.2.3 <1.2.2', 'patch'],
    ['1.2.3 1.2.4', null],
  ]
  for (const [range, segment] of cases) {
    const result = minSatisfying(range)
    t.equal(result.satisfies, false, `${range} cannot satisfy`)
    t.equal(result.version, null, `${range} has no version`)
    t.ok(result.blocker, `${range} reports a blocker`)
    if (segment) {
      t.equal(result.blocker.segment, segment, `${range} blocked segment`)
      t.ok(result.blocker.comparator, `${range} reports comparator`)
      t.ok(result.blocker.version, `${range} reports boundary`)
    }
  }
  t.end()
})

t.test('bad input fails soft without taking the chain down', (t) => {
  for (const bad of ['garbage', '1.2.3.4', null, undefined]) {
    const result = minSatisfying(bad)
    t.equal(result.satisfies, false)
    t.equal(result.version, null)
    t.equal(result.reason, 'invalid-range')
  }
  t.end()
})

t.test('same range and options are cached, different options are not', (t) => {
  const first = minSatisfying('^1.0.0')
  t.equal(first.cached, false, 'first call is a miss')
  t.equal(cacheStats().misses, 1)
  const second = minSatisfying('^1.0.0')
  t.equal(second.cached, true, 'same options hit the cache')
  t.equal(cacheStats().hits, 1)
  t.equal(second.version, first.version)

  const other = minSatisfying('^1.0.0', { includePrerelease: true })
  t.equal(other.cached, false, 'different options do not reuse the slot')
  t.equal(cacheStats().misses, 2)

  clearCache()
  t.equal(cacheStats().hits, 0)
  t.equal(cacheStats().misses, 0)
  t.equal(cacheStats().size, 0)
  t.end()
})
