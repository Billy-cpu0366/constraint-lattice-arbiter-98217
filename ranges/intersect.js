'use strict'

const Range = require('../classes/range')
const Comparator = require('../classes/comparator')
const compare = require('../functions/compare')

// Intersect any number of ranges.
//
// Each input range is a union (||) of simple ranges.  The intersection is
// computed pairwise over the simple ranges: a simple range of the running
// result only survives if it overlaps a simple range of the next input.
// Any simple range that cannot overlap produces nothing, and an entirely
// empty intersection returns null - it is never silently widened back to
// something satisfiable.
//
// The returned string is in the same canonical spelling produced by
// normalizeRange(), so it can be fed straight back through that layer.
// Invalid input returns null instead of throwing.
const intersectRanges = (ranges, options) => {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return null
  }

  try {
    const parsed = ranges.map(range => new Range(range, options))

    // R ∩ R ∩ ... ∩ R === R, and must spell exactly like R
    const firstRaw = parsed[0].raw
    if (parsed.every(range => range.raw === firstRaw)) {
      return formatRange(parsed[0])
    }

    let current = parsed[0].set
    for (let i = 1; i < parsed.length; i++) {
      const next = parsed[i].set
      const intersected = intersectTwo(current, next, options)
      if (intersected === null) {
        return null
      }
      current = intersected
    }

    return formatSets(current)
  } catch (er) {
    return null
  }
}

// intersect two range sets (arrays of simple ranges)
const intersectTwo = (a, b, options) => {
  const simpleRanges = []
  const seen = new Set()

  for (const setA of a) {
    for (const setB of b) {
      const simple = intersectSimple(setA, setB, options)
      if (simple) {
        const key = simpleKey(simple)
        if (!seen.has(key)) {
          seen.add(key)
          simpleRanges.push({ comparators: simple, key })
        }
      }
    }
  }

  if (simpleRanges.length === 0) {
    return null
  }

  // canonical ordering makes the result independent of argument order
  simpleRanges.sort((sa, sb) => sa.key < sb.key ? -1 : sa.key > sb.key ? 1 : 0)
  return simpleRanges.map(s => s.comparators)
}

// intersect two simple (AND-ed comparator) ranges
const intersectSimple = (setA, setB, options) => {
  const all = setA.concat(setB)
  const exact = []
  const lower = []
  const upper = []
  for (const comp of all) {
    if (isAny(comp)) {
      continue
    }
    if (isNullSet(comp) || comp.value === '<0.0.0') {
      return null
    }
    if (comp.operator === '' || comp.operator === '=') {
      exact.push(comp)
    } else if (comp.operator === '>' || comp.operator === '>=') {
      lower.push(comp)
    } else {
      upper.push(comp)
    }
  }

  // an exact version pins the whole simple range to that version
  if (exact.length) {
    const version = exact[0].semver
    for (const eq of exact) {
      if (compare(eq.semver, version, options) !== 0) {
        return null
      }
    }
    for (const bound of lower.concat(upper)) {
      if (!bound.test(version)) {
        return null
      }
    }
    return [exact[0]]
  }

  let gt = null
  for (const comp of lower) {
    if (!gt || higherGT(gt, comp, options) === comp) {
      gt = comp
    }
  }

  let lt = null
  for (const comp of upper) {
    if (!lt || lowerLT(lt, comp, options) === comp) {
      lt = comp
    }
  }

  if (gt && lt && !boundsOverlap(gt, lt, options)) {
    return null
  }

  // >=1.2.3 <=1.2.3 pins the range to exactly 1.2.3
  if (gt && lt &&
      gt.operator === '>=' && lt.operator === '<=' &&
      compare(gt.semver, lt.semver, options) === 0) {
    return [new Comparator(gt.semver.version, options)]
  }

  const result = []
  if (gt) {
    result.push(gt)
  }
  if (lt) {
    result.push(lt)
  }
  return result
}

const isNullSet = c => c.value === '<0.0.0-0'
const isAny = c => c.value === ''

// does a lower bound still allow anything below the upper bound?
// done on the raw version numbers so prerelease gate rules used by
// Comparator.intersects do not leak in (e.g. >=1.5.0 vs <2.0.0-0 clearly
// overlaps at every 1.x release).
const boundsOverlap = (gt, lt, options) => {
  const cmp = compare(gt.semver, lt.semver, options)
  if (cmp < 0) {
    return true
  }
  if (cmp > 0) {
    return false
  }
  // equal boundaries only overlap when both ends are inclusive
  return gt.operator === '>=' && lt.operator === '<='
}

// >=1.2.3 is lower than >1.2.3
const higherGT = (a, b, options) => {
  const comp = compare(a.semver, b.semver, options)
  return comp > 0 ? a
    : comp < 0 ? b
    : b.operator === '>' && a.operator === '>=' ? b
    : a
}

// <=1.2.3 is higher than <1.2.3
const lowerLT = (a, b, options) => {
  const comp = compare(a.semver, b.semver, options)
  return comp < 0 ? a
    : comp > 0 ? b
    : b.operator === '<' && a.operator === '<=' ? b
    : a
}

// stable, canonical spelling for a simple range
const simpleKey = (comparators) => comparators
  .slice()
  .sort(comparatorSort)
  .map(c => c.value)
  .join(' ') || '*'

const comparatorSort = (a, b) => {
  const rank = c => {
    if (c.operator === '' || c.operator === '=') {
      return 0
    }
    if (c.operator === '>' || c.operator === '>=') {
      return 1
    }
    return 2
  }
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) {
    return ra - rb
  }
  const byVersion = compare(a.semver, b.semver)
  if (byVersion !== 0) {
    return byVersion
  }
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
}

const formatRange = range => range.range || '*'

const formatSets = sets => sets
  .map(comparators => simpleKey(comparators))
  .join('||') || '*'

module.exports = intersectRanges
