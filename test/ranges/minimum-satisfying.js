'use strict'

const t = require('tap')
const minimumSatisfying = require('../../ranges/minimum-satisfying')
const satisfies = require('../../functions/satisfies')

const min = (range, options) => minimumSatisfying(range, options)

t.equal(min('>=1.2.3 <2.0.0').version.version, '1.2.3')
t.equal(min('*').version.version, '0.0.0')
t.equal(min('>=1.5.0').version.version, '1.5.0')
t.equal(min('>1.2.3').version.version, '1.2.4')
t.equal(min('>1.2.3-alpha.2').version.version, '1.2.3-alpha.2.0')
t.equal(min('1.4.2').version.version, '1.4.2')
t.equal(min('^1.2.0').version.version, '1.2.0')
t.equal(min('^1.2.3-beta.2').version.version, '1.2.3-beta.2')
t.equal(min('>=2.0.0-alpha <2.0.1').version.version, '2.0.0-alpha')

// the reported minimum really passes, and prereleases follow one gate
const caret = min('^1.2.3-beta.2')
t.ok(satisfies(caret.version, '^1.2.3-beta.2'))
t.notOk(satisfies('1.2.4-alpha', '^1.2.3-beta.2'))
t.notOk(satisfies('2.0.0-alpha', '>=1.0.0 <2.0.0'))

// includePrerelease reopens the gate
const opened = min('^1.0.0', { includePrerelease: true })
t.ok(opened.satisfies)

// unsatisfiable ranges name the blocking comparator and version segment
const blocked = min('>=3.0.0 <2.0.0 || <0.0.0')
t.notOk(blocked.satisfies)
t.equal(blocked.version, null)
t.equal(blocked.blocked.segment, 'major')
t.equal(blocked.blocked.comparator, '<2.0.0')
t.equal(blocked.blocked.version.version, '3.0.0')
t.equal(blocked.blocked.setIndex, 0)

const tight = min('>=2.0.0 <2.0.0')
t.notOk(tight.satisfies)
t.equal(tight.blocked.segment, 'patch')
t.equal(tight.blocked.comparator, '<2.0.0')

// cache: same range/options hits, different options never mix
t.equal(min('>=1.0.0').cache, 'miss')
t.equal(min('>=1.0.0').cache, 'hit')
t.equal(min('>=1.0.0').cached, true)
t.equal(min('>=1.0.0', { loose: true }).cache, 'miss')
t.equal(min('>=1.0.0', { includePrerelease: true }).cache, 'miss')
t.equal(min('>=1.0.0', { includePrerelease: true }).cache, 'hit')

// bad input is null rather than a throw
t.equal(min('garbage!!!'), null)
t.equal(min('1.x.5'), null)
