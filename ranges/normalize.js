'use strict'

const Range = require('../classes/range')

// Normalize any supported range spelling (unions, hyphen ranges,
// wildcards/x-ranges, tildes, carets, primitive comparators) into one
// canonical comparator spelling.
//
// Build metadata never participates in comparisons, so it is stripped.
// Invalid input yields null instead of throwing, so a bad range can never
// take the whole dependency reconciliation chain down.
//
// The result is stable: normalizing repeatedly, or normalizing a Range
// instance, always produces the same string.
const normalizeRange = (range, options) => {
  try {
    if (range instanceof Range) {
      // a Range is already normalized, but make sure the option flags match
      const sameOptions =
        range.loose === !!get(options, 'loose') &&
        range.includePrerelease === !!get(options, 'includePrerelease')
      if (sameOptions) {
        return range.range || '*'
      }
      range = range.raw
    }

    if (typeof range !== 'string') {
      return null
    }

    return new Range(range, options).range || '*'
  } catch (er) {
    return null
  }
}

const get = (options, key) => options ? options[key] : undefined

module.exports = normalizeRange
