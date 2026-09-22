'use strict'

const Comparator = require('../../classes/comparator')
const compare = require('../../functions/compare')
const { remember, toRange } = require('./shared')
const parseOptions = require('../../internal/parse-options')

// Containment check that shares its semantics with satisfies/intersect/
// minSatisfying.  A comparator conjunction is modelled as:
//
//   * a release-version interval [lowRel, highRel], and
//   * a set of [major, minor, patch] tuples whose prereleases are admitted.
//
// `sub` is a subset of `dom` iff its release interval is contained and every
// tuple whose prereleases `sub` admits is also admitted by `dom`.  In
// includePrerelease mode the tuple set is "every tuple" on both sides, so
// only the interval containment matters.

const NEG = -1
const POS = 1

// `<x.y.z-0` is the standard desugaring of "every release below x.y.z"; it
// is an exclusive release boundary, not a prerelease admission carrier.
const isSentinelUpper = (semver, operator) =>
  operator === '<' &&
  semver.prerelease.length === 1 &&
  semver.prerelease[0] === 0

// Boundary of the *release* interval.
// Returns { version, inclusive } or null for an unbounded side.
const lowerBound = (simple) => {
  let best = null
  for (const c of simple) {
    if (c.semver === Comparator.ANY) {
      continue
    }
    if (c.operator === '>' || c.operator === '>=') {
      let v = c.semver
      let inclusive = c.operator === '>='
      if (v.prerelease.length) {
        // prerelease boundaries live inside the previous release tuple:
        // >=1.2.3-alpha starts admitting releases at 1.2.3
        v = releaseOf(v)
        inclusive = true
      }
      if (!best || compare(v, best.version) > 0 ||
          (compare(v, best.version) === 0 && !inclusive && best.inclusive)) {
        best = { version: v, inclusive }
      }
    } else if (c.operator === '') {
      const v = c.semver.prerelease.length ? releaseOf(c.semver) : c.semver
      const cand = { version: v, inclusive: true }
      if (!best || compare(cand.version, best.version) > 0 ||
          (compare(cand.version, best.version) === 0 &&
           cand.inclusive && !best.inclusive)) {
        best = cand
      }
    }
  }
  return best
}

const upperBound = (simple) => {
  let best = null
  for (const c of simple) {
    if (c.semver === Comparator.ANY) {
      continue
    }
    if (c.operator === '<' || c.operator === '<=') {
      let v = c.semver
      let inclusive = c.operator === '<='
      if (v.prerelease.length) {
        if (isSentinelUpper(c.semver, c.operator)) {
          // <x.y.z-0 admits every release below x.y.z
          v = releaseOf(v)
          inclusive = false
        } else {
          // a real prerelease upper bound (eg <1.5.0-rc) admits no release
          // at or above its tuple, so the release interval ends at the
          // preceding release tuple and excludes the boundary one.
          v = releaseOf(v)
          inclusive = false
        }
      }
      if (!best || compare(v, best.version) < 0 ||
          (compare(v, best.version) === 0 && !inclusive && best.inclusive)) {
        best = { version: v, inclusive }
      }
    } else if (c.operator === '') {
      const v = c.semver.prerelease.length ? releaseOf(c.semver) : c.semver
      const cand = { version: v, inclusive: true }
      if (!best || compare(cand.version, best.version) < 0 ||
          (compare(cand.version, best.version) === 0 &&
           cand.inclusive && !best.inclusive)) {
        best = cand
      }
    }
  }
  return best
}

const releaseOf = (semver) => {
  const clone = new semver.constructor(
    `${semver.major}.${semver.minor}.${semver.patch}`)
  return clone
}

const pinsOf = (simple) => {
  const pins = []
  for (const c of simple) {
    if (c.semver !== Comparator.ANY && c.operator === '') {
      pins.push(c.semver)
    }
  }
  return pins
}

// Compare a boundary against another: -1/0/1 on version then inclusivity.
const boundBelow = (a, b, dir) => {
  const cmp = compare(a.version, b.version)
  if (cmp !== 0) {
    return dir === NEG ? cmp < 0 : cmp > 0
  }
  // equal versions: an exclusive boundary is "tighter".  For lower bounds
  // >x sits inside >=x; for upper bounds <x sits inside <=x.
  if (dir === NEG) {
    // a below b means a is the stricter lower bound (exclusive wins)
    return !a.inclusive && b.inclusive
  }
  return !a.inclusive && b.inclusive
}

// Is simple range `sub` contained in simple range `dom`?
const simpleSubset = (sub, dom, options) => {
  const subPins = pinsOf(sub)
  const domPins = pinsOf(dom)

  // two distinct pins describe the null set, a subset of everything
  if (subPins.length > 1) {
    return true
  }

  // An exact pin is contained only if that one version actually passes dom.
  if (subPins.length === 1) {
    const pin = subPins[0]
    for (const c of dom) {
      if (c.semver === Comparator.ANY) {
        continue
      }
      if (!c.test(pin)) {
        return false
      }
    }
    if (pin.prerelease.length && !options.includePrerelease) {
      if (!domPins.some((p) => p.compare(pin) === 0) &&
          !admitsTuple(dom, pin)) {
        return false
      }
    }
    return true
  }

  // A pinned dom admits only that one version; any interval that is not
  // exactly that pin cannot be contained.
  if (domPins.length === 1) {
    return false
  }
  if (domPins.length > 1) {
    return true // null dom
  }

  const subLow = lowerBound(sub)
  const subHigh = upperBound(sub)
  const domLow = lowerBound(dom)
  const domHigh = upperBound(dom)

  // contradictory sub interval (empty set) is a subset of everything
  if (subLow && subHigh) {
    const cmp = compare(subLow.version, subHigh.version)
    if (cmp > 0 ||
        (cmp === 0 && (!subLow.inclusive || !subHigh.inclusive))) {
      return true
    }
  }

  // release interval containment
  if (domLow) {
    if (!subLow) {
      return false
    }
    const cmp = compare(subLow.version, domLow.version)
    if (cmp < 0) {
      return false
    }
    if (cmp === 0 && domLow.inclusive === false && subLow.inclusive) {
      return false
    }
  }
  if (domHigh) {
    if (!subHigh) {
      return false
    }
    const cmp = compare(subHigh.version, domHigh.version)
    if (cmp > 0) {
      return false
    }
    if (cmp === 0 && domHigh.inclusive === false && subHigh.inclusive) {
      return false
    }
  }

  // prerelease tuples admitted by sub must be admitted by dom too
  if (!options.includePrerelease) {
    for (const entry of admittedTuples(sub)) {
      if (!admitsTuple(dom, entry) ||
          !admitsPrereleaseVersion(dom, entry.carrier.semver)) {
        return false
      }
    }
  }

  return true
}

const tupleKey = (semver) =>
  `${semver.major}.${semver.minor}.${semver.patch}`

const carriesPrerelease = (comp) => {
  if (comp.semver === Comparator.ANY || !comp.semver.prerelease.length) {
    return false
  }
  return !isSentinelUpper(comp.semver, comp.operator)
}

// Tuples whose prereleases are explicitly admitted by this simple range.
const admittedTuples = (simple) => {
  const tuples = new Map()
  for (const c of simple) {
    if (!carriesPrerelease(c)) {
      continue
    }
    const key = tupleKey(c.semver)
    const prev = tuples.get(key)
    if (!prev || c.semver.compare(prev.semver) > 0) {
      tuples.set(key, c)
    }
  }
  return [...tuples.entries()].map(([key, carrier]) => {
    const [major, minor, patch] = key.split('.').map((n) => +n)
    return { major, minor, patch, key, carrier }
  })
}

// Does this simple range admit prereleases of the given tuple?
// A real prerelease-bearing comparator on the tuple admits them, provided
// the tuple also lies within the release bounds.
const admitsTuple = (simple, tuple) => {
  let strongest = null
  for (const c of simple) {
    if (c.semver === Comparator.ANY) {
      continue
    }
    if ((carriesPrerelease(c) ||
         (c.operator === '' && c.semver.prerelease.length)) &&
        tupleKey(c.semver) === tuple.key) {
      if (!strongest || c.semver.compare(strongest.semver) > 0) {
        strongest = c
      }
    }
  }
  if (!strongest) {
    return false
  }
  // the tuple's release must still be inside the release interval
  const release = `${tuple.major}.${tuple.minor}.${tuple.patch}`
  const low = lowerBound(simple)
  if (low) {
    const cmp = compare(release, low.version)
    if (cmp < 0 || (cmp === 0 && !low.inclusive)) {
      return false
    }
  }
  const high = upperBound(simple)
  if (high) {
    const cmp = compare(release, high.version)
    if (cmp > 0 || (cmp === 0 && !high.inclusive)) {
      return false
    }
  }
  return true
}

// Does this simple range admit the specific prerelease version `ver`?
// Used to compare two carriers of the same tuple: the admitted band always
// starts at the strongest carrier (eg >=1.2.3-beta does not admit -alpha).
const admitsPrereleaseVersion = (simple, ver) => {
  for (const c of simple) {
    if (c.semver === Comparator.ANY) {
      continue
    }
    if (!c.test(ver)) {
      return false
    }
  }
  return true
}

const releaseIntervals = (simple) => {
  const pins = pinsOf(simple)
  if (pinsOf(simple).length === 1 && pinsOf(simple)[0].prerelease.length) {
    // an exact prerelease pin covers no release versions
    return []
  }
  const pin = pins[0]
  if (pin) {
    return [{ low: { version: pin, inclusive: true },
      high: { version: pin, inclusive: true } }]
  }
  return [{ low: lowerBound(simple), high: upperBound(simple) }]
}

const releaseUnion = (arms) => {
  const spans = []
  for (const arm of arms) {
    for (const { low, high } of releaseIntervals(arm)) {
      spans.push({ low, high })
    }
  }
  return spans
}

// Infinity/-infinity release stand-ins for interval arithmetic.
const MINF = { neg: true }
const PINF = { pos: true }

const cmpPoint = (a, b) => {
  if (a === MINF) {
    return b === MINF ? 0 : -1
  }
  if (a === PINF) {
    return b === PINF ? 0 : 1
  }
  if (b === MINF) {
    return 1
  }
  if (b === PINF) {
    return -1
  }
  return compare(a, b)
}

// Normalise a span to closed numeric endpoints with a flag for each open
// side, then merge overlapping/abutting spans into a disjoint union.
const mergeSpans = (spans) => {
  const norm = spans.map(({ low, high }) => ({
    lv: low ? low.version : MINF,
    lOpen: low ? !low.inclusive : false,
    hv: high ? high.version : PINF,
    hOpen: high ? !high.inclusive : false,
  })).filter((s) => {
    const cmp = cmpPoint(s.lv, s.hv)
    // a span with equal open edges (eg >1.2.3 <1.2.4) covers releases only
    // when it spans strictly more than the shared point; cmp<0 keeps genuine
    // intervals, and an equal closed point keeps exact pins.
    return cmp < 0 || (cmp === 0 && !s.lOpen && !s.hOpen)
  }).sort((a, b) => {
    const cmp = cmpPoint(a.lv, b.lv)
    if (cmp !== 0) {
      return cmp
    }
    // closed lower edge sorts before the open one at the same version
    return (a.lOpen ? 1 : 0) - (b.lOpen ? 1 : 0)
  })

  const merged = []
  for (const s of norm) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push(s)
      continue
    }
    const cmp = cmpPoint(s.lv, last.hv)
    let adjacent = false
    if (cmp < 0) {
      adjacent = true
    } else if (cmp === 0) {
      // touching edges join unless both exclude the shared version
      adjacent = !(s.lOpen && last.hOpen)
    }
    if (adjacent) {
      const hc = cmpPoint(s.hv, last.hv)
      if (hc > 0 ||
          (hc === 0 && !s.hOpen && last.hOpen)) {
        last.hv = s.hv
        last.hOpen = s.hOpen
      }
    } else {
      merged.push(s)
    }
  }
  return merged
}

const spanContains = (outer, inner) => {
  const lc = cmpPoint(inner.lv, outer.lv)
  if (lc < 0) {
    return false
  }
  // at the same lower version an exclusive inner edge starts later, so it
  // still fits inside the outer edge; only an exclusive outer edge fails to
  // contain an inclusive inner edge.
  if (lc === 0 && !inner.lOpen && outer.lOpen) {
    return false
  }
  const hc = cmpPoint(inner.hv, outer.hv)
  if (hc > 0) {
    return false
  }
  // at the same upper version an exclusive inner edge ends earlier and still
  // fits; only an inclusive inner edge escapes an exclusive outer edge.
  if (hc === 0 && !inner.hOpen && outer.hOpen) {
    return false
  }
  return true
}

// Every sub release span must lie wholly inside one merged dom span.
const releaseCoveredByUnion = (subArms, domArms) => {
  const dom = mergeSpans(releaseUnion(domArms))
  const sub = mergeSpans(releaseUnion(subArms))
  return sub.every((span) => dom.some((d) => spanContains(d, span)))
}

// One sub arm against the whole OR-joined dom: release coverage may be
// spread across abutting dom arms, while each admitted prerelease tuple
// must be wholly accepted by a single dom arm.
const isReleaseEmpty = (simple) => {
  const low = lowerBound(simple)
  const high = upperBound(simple)
  if (!low || !high) {
    return false
  }
  const cmp = compare(low.version, high.version)
  if (cmp > 0) {
    return true
  }
  if (cmp === 0) {
    return !(low.inclusive && high.inclusive)
  }
  // the smallest release strictly at/above the lower edge must still be
  // below the upper edge
  const first = firstReleaseAtOrAbove(low)
  if (!first) {
    return false
  }
  const fc = compare(first, high.version)
  return fc > 0 || (fc === 0 && !high.inclusive)
}

// Smallest release tuple that satisfies a lower release boundary.
const firstReleaseAtOrAbove = (low) =>
  low.inclusive ? low.version : nextRelease(low.version)

// Next release tuple immediately after a version's tuple.
const nextRelease = (semver) => {
  const SemVer = semver.constructor
  return new SemVer(`${semver.major}.${semver.minor}.${semver.patch + 1}`)
}

const simpleSubsetOfUnion = (sub, domArms, options) => {
  if (pinsOf(sub).length > 1) {
    return true // null set
  }

  if (pinsOf(sub).length === 1) {
    // one exact version must pass some dom arm outright (incl. gate)
    return domArms.some((dom) => simpleSubset(sub, dom, options))
  }

  // a pinless arm with no prerelease carrier is empty whenever its bounds
  // admit no release version (eg >1.2.3 <1.2.4): semver has no release
  // number strictly between two consecutive tuples.
  if (!options.includePrerelease && admittedTuples(sub).length === 0 &&
      isReleaseEmpty(sub)) {
    return true
  }

  if (!options.includePrerelease && admittedTuples(sub).length) {
    for (const entry of admittedTuples(sub)) {
      const ok = domArms.some((dom) =>
        admitsTuple(dom, entry) &&
        admitsPrereleaseVersion(dom, entry.carrier.semver))
      if (!ok) {
        return false
      }
    }
  }

  return releaseCoveredByUnion([sub], domArms)
}

// Is every version admitted by `sub` also admitted by `dom`?
// Every OR arm of sub must be a null set or fall inside some arm of dom.
const isSubset = (sub, dom, options) => {
  if (sub === dom) {
    return true
  }
  options = parseOptions(options)
  const subRange = toRange(sub, options)
  const domRange = toRange(dom, options)
  if (!subRange || !domRange) {
    return false
  }
  return remember('subset',
    [subRange.range || String(sub), domRange.range || String(dom)],
    options, () => {
      for (const simpleSub of subRange.set) {
        if (pinsOf(simpleSub).length > 1) {
          continue // null set
        }
        if (!simpleSubsetOfUnion(simpleSub, domRange.set, options)) {
          return false
        }
      }
      return true
    }).value
}

module.exports = isSubset
