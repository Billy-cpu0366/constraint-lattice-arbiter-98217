'use strict'

const Comparator = require('../../classes/comparator')
const SemVer = require('../../classes/semver')
const {
  remember,
  toRange,
  canonicalComparators,
} = require('./shared')

// Merge two AND-ed comparator lists.
//
// The conjunction keeps the tightest lower/upper bounds and (at most one)
// exact pin.  Prerelease admission follows exactly the rule Range#test
// uses: a tuple's prereleases pass only when some comparator carries a real
// prerelease on that tuple AND that carried version satisfies every bound.
// When intersecting, both operands must admit the tuple.  The desugared
// `<x.y.z-0` sentinel is only an exclusive upper bound and admits nothing.

const tupleKey = (semver) =>
  `${semver.major}.${semver.minor}.${semver.patch}`

// `<x.y.z-0` is the standard desugaring for "every release before x.y.z",
// not an explicit invitation to that tuple's prereleases.
const isRealPrerelease = (semver, operator) => {
  if (!semver.prerelease.length) {
    return false
  }
  if (operator === '<' &&
      semver.prerelease.length === 1 &&
      semver.prerelease[0] === 0) {
    return false
  }
  return true
}

const highestLower = (lowers) => {
  let best = null
  for (const c of lowers) {
    if (!best) {
      best = c
      continue
    }
    const cmp = c.semver.compare(best.semver)
    if (cmp > 0 ||
        (cmp === 0 && c.operator === '>' && best.operator === '>=')) {
      best = c
    }
  }
  return best
}

const lowestUpper = (uppers) => {
  let best = null
  for (const c of uppers) {
    if (!best) {
      best = c
      continue
    }
    const cmp = c.semver.compare(best.semver)
    if (cmp < 0 ||
        (cmp === 0 && c.operator === '<' && best.operator === '<=')) {
      best = c
    }
  }
  return best
}

// Release immediately preceding a tuple, spelled x.y.(patch-1); callers
// only use this when patch is known to be greater than zero (a real
// prerelease upper like <2.0.0-beta always excludes releases of 2.0.0
// while the floor already sits below it).
const precedingRelease = (semver) =>
  `${semver.major}.${semver.minor}.${semver.patch - 1}`

// Does every comparator in `all` pass this version?
const passesAll = (all, version) => {
  for (const c of all) {
    if (c.semver === Comparator.ANY) {
      continue
    }
    if (!c.test(version)) {
      return false
    }
  }
  return true
}

// Collect, per admitted tuple, the strongest real-prerelease carrier from
// each source group.  A carrier counts only when its version already passes
// every bound of the merged conjunction.
const collectCarriers = (groups, bounds) => {
  // groups: array of comparator arrays (one per operand)
  const byGroup = groups.map(() => new Map())
  groups.forEach((group, gi) => {
    for (const c of group) {
      if (c.semver === Comparator.ANY ||
          !isRealPrerelease(c.semver, c.operator)) {
        continue
      }
      if (!passesAll(bounds, c.semver)) {
        continue
      }
      const key = tupleKey(c.semver)
      const prev = byGroup[gi].get(key)
      if (!prev || c.semver.compare(prev.semver) > 0) {
        byGroup[gi].set(key, c)
      }
    }
  })

  // a tuple survives only when every operand admits it
  const carriers = new Map()
  const first = byGroup[0]
  for (const [key, carrier] of first) {
    let admitted = true
    let strongest = carrier
    for (let gi = 1; gi < byGroup.length; gi++) {
      const other = byGroup[gi].get(key)
      if (!other) {
        admitted = false
        break
      }
      if (other.semver.compare(strongest.semver) > 0) {
        strongest = other
      }
    }
    if (admitted) {
      carriers.set(key, strongest)
    }
  }
  return carriers
}

// Return the canonical comparator list, or null when contradictory.
const mergeComparators = (groups, options) => {
  const pins = new Map()
  const lowers = []
  const uppers = []
  const all = []

  for (const group of groups) {
    for (const c0 of group) {
      const c = c0 instanceof Comparator
        ? c0
        : new Comparator(c0, options)
      all.push(c)
      if (c.semver === Comparator.ANY) {
        continue
      }
      if (c.operator === '') {
        pins.set(c.semver.version, c)
      } else if (c.operator === '>' || c.operator === '>=') {
        lowers.push(c)
      } else if (c.operator === '<' || c.operator === '<=') {
        uppers.push(c)
      }
    }
  }

  // two distinct exact pins can never share a version
  if (pins.size > 1) {
    return null
  }

  const low = highestLower(lowers)
  const high = lowestUpper(uppers)

  if (low && high) {
    const cmp = low.semver.compare(high.semver)
    if (cmp > 0) {
      return null
    }
    if (cmp === 0 && (low.operator === '>' || high.operator === '<')) {
      return null
    }
  }

  // every pin has to satisfy the tightest bounds
  for (const pin of pins.values()) {
    if (low && !low.test(pin.semver)) {
      return null
    }
    if (high && !high.test(pin.semver)) {
      return null
    }
  }

  // An exact pin is the whole conjunction: only that one version passes,
  // so bounds and carriers add nothing.
  if (pins.size === 1) {
    return [...pins.values()]
  }

  const bounds = []
  if (low) {
    bounds.push(low)
  }
  if (high) {
    bounds.push(high)
  }

  // Tuples every operand admits.  Bounds alone never admit prereleases, so
  // the result is release bounds plus one explicit carrier per tuple.
  const carriers = collectCarriers(groups, bounds.length ? bounds : all)

  const result = []
  if (low) {
    if (low.semver.prerelease.length &&
        !carriers.has(tupleKey(low.semver))) {
      // a one-sided prerelease lower bound tightens only the release floor
      result.push(new Comparator(
        `>=${low.semver.major}.${low.semver.minor}.${low.semver.patch}`,
        options))
    } else {
      result.push(low)
    }
  }

  const boundTuples = new Set()
  for (const c of result) {
    if (c.semver !== Comparator.ANY && c.semver.prerelease.length) {
      boundTuples.add(tupleKey(c.semver))
    }
  }
  if (high && high.semver.prerelease.length) {
    boundTuples.add(tupleKey(high.semver))
  }
  for (const [key, carrier] of carriers) {
    if (!boundTuples.has(key)) {
      result.push(carrier)
    }
  }

  if (high) {
    const highSentinel = high.semver.prerelease.length === 1 &&
      high.semver.prerelease[0] === 0
    if (high.semver.prerelease.length &&
        !highSentinel &&
        !carriers.has(tupleKey(high.semver))) {
      // a one-sided real prerelease upper bound (eg <2.0.0-beta) admits no
      // release at or above its tuple, so the release edge is the sentinel
      // above the preceding release tuple.
      result.push(new Comparator(
        `<${precedingRelease(high.semver)}`,
        options))
    } else {
      result.push(high)
    }
  }

  if (!result.length) {
    return [new Comparator('', options)]
  }

  return canonicalComparators(result, options)
}

const intersectSimple = (a, b, options) => {
  const merged = mergeComparators([a, b], options)
  if (!merged) {
    return null
  }
  return merged
}

const distribute = (simple, sets, options) => {
  const out = []
  for (const other of sets) {
    const merged = intersectSimple(simple, other, options)
    if (merged) {
      out.push(merged)
    }
  }
  return out
}

const spell = (simple, options) =>
  canonicalComparators(simple, options).map((c) => c.value).join(' ') || '*'

// Intersect any number of ranges.  Order-independent, idempotent against
// self, never wider than an operand; a contradictory pairing contributes
// nothing instead of silently widening the answer.
const intersect = (ranges, options) => {
  let list
  if (Array.isArray(ranges)) {
    list = ranges
  } else {
    const args = [...arguments]
    list = args.slice()
    if (list.length && typeof list[list.length - 1] === 'object' &&
        list[list.length - 1] !== null &&
        !list[list.length - 1].set) {
      options = list.pop()
    }
  }
  if (!list.length) {
    return null
  }
  const { value } = remember('intersect', list, options, () => {
    const parsed = []
    for (const r of list) {
      const rr = toRange(r, options)
      if (!rr) {
        return null
      }
      parsed.push(rr.set)
    }

    // Each accumulator arm also remembers which source arms it came from so
    // carriers can be intersected (every operand must admit a tuple).
    let acc = parsed[0].map((simple) => ({ groups: [simple] }))
    for (let i = 1; i < parsed.length; i++) {
      const next = parsed[i]
      const produced = []
      for (const arm of acc) {
        for (const other of next) {
          const groups = [...arm.groups, other]
          const merged = mergeComparators(groups, options)
          if (merged) {
            produced.push({ groups, merged })
          }
        }
      }
      if (!produced.length) {
        return null
      }
      acc = produced
    }

    const spellings = acc
      .map((arm) => spell(arm.merged, options))
      .filter((spelling) => spelling !== '<0.0.0-0')
    if (!spellings.length) {
      return null
    }
    return [...new Set(spellings.sort())].join('||')
  })
  return value
}

module.exports = intersect
