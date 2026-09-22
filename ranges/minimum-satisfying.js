'use strict'

const Range = require('../classes/range')
const SemVer = require('../classes/semver')
const compare = require('../functions/compare')
const LRU = require('../internal/lrucache')
const { FLAG_INCLUDE_PRERELEASE, FLAG_LOOSE } = require('../internal/constants')

// Results are cached per (range spelling, option flags).  Different option
// sets never share an entry, and every response says whether the cache was
// hit or missed.
const cache = new LRU()

// Return the smallest version that satisfies the range.
//
// The answer is always verified through the same range/prerelease layer used
// everywhere else, so a reported version really passes and nothing smaller
// can pass.  When nothing passes, the response names the comparator and the
// version segment (major/minor/patch/prerelease) that blocked it.
//
// Bad input yields null instead of throwing.
//
// shape:
// {
//   version: SemVer | null,
//   satisfies: boolean,
//   blocked: { segment, comparator, version, setIndex } | null,
//   cached: boolean,   // this answer came from the cache
//   cache: 'hit' | 'miss',
// }
const minimumSatisfying = (range, options) => {
  if (Array.isArray(range)) {
    return minimumSatisfyingFromList(range, options)
  }

  let rangeObj
  try {
    rangeObj = new Range(range, options)
  } catch (er) {
    return null
  }

  const flags =
    (rangeObj.includePrerelease && FLAG_INCLUDE_PRERELEASE) |
    (rangeObj.loose && FLAG_LOOSE)
  const memoKey = flags + ':' + rangeObj.raw

  const cachedEntry = cache.get(memoKey)
  if (cachedEntry) {
    return { ...cachedEntry, cached: true, cache: 'hit' }
  }

  const result = computeMinimum(rangeObj, options)
  cache.set(memoKey, result)
  return { ...result, cached: false, cache: 'miss' }
}

const computeMinimum = (rangeObj, options) => {
  let minimum = null
  let nearestBlock = null

  for (let setIndex = 0; setIndex < rangeObj.set.length; setIndex++) {
    const comparators = rangeObj.set[setIndex]

    if (isNullSet(comparators)) {
      nearestBlock = considerBlocker(nearestBlock, {
        setIndex,
        segment: null,
        comparator: '<0.0.0-0',
        version: null,
      }, options)
      continue
    }

    // with no lower bound the floor is 0.0.0
    const candidate = lowerBound(comparators) || new SemVer('0.0.0')

    if (candidate && rangeObj.test(candidate)) {
      if (!minimum || compare(candidate, minimum, options) < 0) {
        minimum = candidate
      }
      continue
    }

    // candidate passes every comparator but is kept out by the prerelease
    // gate (same tuple is not explicitly admitted by this simple range)
    if (candidate && candidate.prerelease.length &&
        comparators.every(c =>
          c.semver === ComparatorANY || c.test(candidate))) {
      nearestBlock = considerBlocker(nearestBlock, {
        setIndex,
        segment: 'prerelease',
        comparator: null,
        version: new SemVer(candidate.version),
      }, options)
      continue
    }

    // this simple range cannot produce a version; record what stopped it
    const blocker = findBlocker(comparators, candidate)
    if (blocker) {
      nearestBlock = considerBlocker(
        nearestBlock,
        { ...blocker, setIndex },
        options
      )
    }
  }

  if (minimum) {
    return {
      version: minimum,
      satisfies: true,
      blocked: null,
    }
  }

  return {
    version: null,
    satisfies: false,
    blocked: nearestBlock,
  }
}

// keep the block from the simple range whose lower bound is highest;
// that is the section that got closest to actually being satisfiable.
const considerBlocker = (current, next, options) => {
  if (!current) {
    return next
  }
  if (!current.version) {
    return next.version ? next : current
  }
  if (!next.version) {
    return current
  }
  return compare(next.version, current.version, options) > 0 ? next : current
}

// smallest version allowed by the lower bounds ('', >=, >) of a simple range
const lowerBound = (comparators) => {
  let candidate = null
  for (const comparator of comparators) {
    if (comparator.semver === ComparatorANY) {
      continue
    }
    if (comparator.operator === '<' || comparator.operator === '<=') {
      continue
    }

    let bound = new SemVer(comparator.semver.version)
    if (comparator.operator === '>') {
      if (bound.prerelease.length === 0) {
        bound = new SemVer(
          `${bound.major}.${bound.minor}.${bound.patch + 1}`
        )
      } else {
        bound = new SemVer(bound.version + '.0')
      }
    }

    if (!candidate || compare(bound, candidate) > 0) {
      candidate = bound
    }
  }

  // an exact ('') comparator pins the version
  for (const comparator of comparators) {
    if (comparator.operator === '' && comparator.semver !== ComparatorANY) {
      return new SemVer(comparator.semver.version)
    }
  }

  return candidate
}

// find the first comparator that rejects the candidate, and say which
// version segment of the boundary it hit
const findBlocker = (comparators, candidate) => {
  for (const comparator of comparators) {
    if (comparator.semver === ComparatorANY) {
      continue
    }
    if (candidate && comparator.test(candidate)) {
      continue
    }

    return {
      segment: blockerSegment(candidate, comparator.semver),
      comparator: comparator.value,
      version: candidate ? new SemVer(candidate.version) : null,
    }
  }
  return null
}

const blockerSegment = (candidate, boundary) => {
  if (!candidate) {
    return null
  }
  if (candidate.major !== boundary.major) {
    return 'major'
  }
  if (candidate.minor !== boundary.minor) {
    return 'minor'
  }
  if (candidate.patch !== boundary.patch) {
    return 'patch'
  }
  if (candidate.prerelease.length === 0) {
    // a release sitting exactly on an exclusive boundary is blocked at that
    // patch version itself, not in prerelease space
    return 'patch'
  }
  return 'prerelease'
}

// list form: smallest of the supplied versions that satisfies the range
const minimumSatisfyingFromList = (versions, options) => {
  let rangeObj
  try {
    rangeObj = new Range(options && options.range ? options.range : null)
  } catch (er) {
    return null
  }

  const parsed = []
  for (const version of versions) {
    try {
      parsed.push(new SemVer(version, options))
    } catch (er) {
      // bad versions in the list are simply ignored
    }
  }
  parsed.sort((a, b) => compare(a, b, options))

  for (const version of parsed) {
    if (rangeObj.test(version)) {
      return {
        version,
        satisfies: true,
        blocked: null,
        cached: false,
        cache: 'miss',
      }
    }
  }

  const smallest = parsed[0] || null
  const blocker = smallest ? findBlockerList(rangeObj, smallest) : null
  return {
    version: null,
    satisfies: false,
    blocked: blocker,
    cached: false,
    cache: 'miss',
  }
}

const findBlockerList = (rangeObj, version) => {
  for (let setIndex = 0; setIndex < rangeObj.set.length; setIndex++) {
    for (const comparator of rangeObj.set[setIndex]) {
      if (comparator.semver !== ComparatorANY && !comparator.test(version)) {
        return {
          segment: blockerSegment(version, comparator.semver),
          comparator: comparator.value,
          version: new SemVer(version.version),
          setIndex,
        }
      }
    }
  }
  return null
}

const Comparator = require('../classes/comparator')
const ComparatorANY = Comparator.ANY

const isNullSet = comparators =>
  comparators.length === 1 && comparators[0].value === '<0.0.0-0'

module.exports = minimumSatisfying
