// node --test scripts/feed.test.mjs
// The fixtures are the real feeds from the v1.7.0 and v1.7.1 releases.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  compareVersions,
  parseFeed,
  PLATFORMS,
  platformStatus,
  rewriteFeed,
} from './feed.mjs'

const fixture = (version, name) =>
  readFileSync(
    new URL(`./fixtures/v${version}/${name}`, import.meta.url),
    'utf8',
  )

const [MAC, WINDOWS] = PLATFORMS
const ASSETS_171 = [
  'Forge-1.7.1-arm64-mac.zip',
  'Forge-1.7.1-arm64-mac.zip.blockmap',
  'Forge-1.7.1-arm64.dmg',
  'Forge-1.7.1-arm64.dmg.blockmap',
  'Forge-1.7.1-x64-setup.exe',
  'Forge-1.7.1-x64-setup.exe.blockmap',
  'latest-mac.yml',
  'latest.yml',
]

test('reads the real feeds', () => {
  const mac = parseFeed(fixture('1.7.0', 'latest-mac.yml'))
  assert.equal(mac.version, '1.7.0')
  assert.deepEqual(mac.files, [
    'Forge-1.7.0-arm64-mac.zip',
    'Forge-1.7.0-arm64.dmg',
  ])
  assert.equal(
    mac.sha512.get('Forge-1.7.0-arm64.dmg'),
    '+zclZ9kum6NGHIuNHM2BaDa2ibYLOUAMz0cLeLEDdeoF2nzJpdS1hm0XeBm31Epbpfn85UPj+PbWpd/DDalqVg==',
  )
  const windows = parseFeed(fixture('1.7.1', 'latest.yml'))
  assert.equal(windows.version, '1.7.1')
  assert.deepEqual(windows.files, ['Forge-1.7.1-x64-setup.exe'])
  assert.equal(windows.sha512.size, 1)
})

test('points latest-mac.yml at the versioned folder, keeping the rest', () => {
  const original = fixture('1.7.0', 'latest-mac.yml')
  const rewritten = rewriteFeed(original, '1.7.0')
  assert.equal(
    rewritten,
    original
      .replace(
        '- url: Forge-1.7.0-arm64-mac.zip',
        '- url: v1.7.0/Forge-1.7.0-arm64-mac.zip',
      )
      .replace(
        '- url: Forge-1.7.0-arm64.dmg',
        '- url: v1.7.0/Forge-1.7.0-arm64.dmg',
      )
      .replace(
        '\npath: Forge-1.7.0-arm64-mac.zip',
        '\npath: v1.7.0/Forge-1.7.0-arm64-mac.zip',
      ),
  )
  // exactly three lines changed: two urls and the path
  const before = original.split('\n')
  const after = rewritten.split('\n')
  assert.equal(after.length, before.length)
  assert.equal(after.filter((line, i) => line !== before[i]).length, 3)
  // and it still parses, to the moved names, with the same hashes
  const parsed = parseFeed(rewritten)
  assert.deepEqual(parsed.files, [
    'v1.7.0/Forge-1.7.0-arm64-mac.zip',
    'v1.7.0/Forge-1.7.0-arm64.dmg',
  ])
  assert.equal(parsed.sha512.size, 2)
})

test('points latest.yml at the versioned folder', () => {
  const rewritten = rewriteFeed(fixture('1.7.1', 'latest.yml'), '1.7.1')
  assert.match(
    rewritten,
    /^ {2}- url: v1\.7\.1\/Forge-1\.7\.1-x64-setup\.exe$/m,
  )
  assert.match(rewritten, /^path: v1\.7\.1\/Forge-1\.7\.1-x64-setup\.exe$/m)
  assert.match(rewritten, /^releaseDate: '2026-11-09T14:09:38.103Z'$/m)
})

test('rewriting twice changes nothing more', () => {
  const once = rewriteFeed(fixture('1.7.1', 'latest-mac.yml'), '1.7.1')
  assert.equal(rewriteFeed(once, '1.7.1'), once)
})

test('handles quoted names and CRLF line ends', () => {
  const text =
    'version: 1.8.0\r\nfiles:\r\n  - url: \'Forge-1.8.0-arm64-mac.zip\'\r\n    sha512: abc=\r\npath: "Forge-1.8.0-arm64-mac.zip"\r\n'
  const rewritten = rewriteFeed(text, '1.8.0')
  assert.equal(
    rewritten,
    'version: 1.8.0\r\nfiles:\r\n  - url: \'v1.8.0/Forge-1.8.0-arm64-mac.zip\'\r\n    sha512: abc=\r\npath: "v1.8.0/Forge-1.8.0-arm64-mac.zip"\r\n',
  )
})

test('refuses a file name that is a path or a URL', () => {
  assert.throws(() =>
    rewriteFeed('version: 1.0.0\nfiles:\n  - url: ../evil.zip\n', '1.0.0'),
  )
  assert.throws(() =>
    rewriteFeed('version: 1.0.0\npath: https://x.test/a.zip\n', '1.0.0'),
  )
  assert.throws(() => parseFeed('files: []\n'))
})

test('a platform is ready only with its feed, its files and its installer', () => {
  const mac = parseFeed(fixture('1.7.1', 'latest-mac.yml'))
  const windows = parseFeed(fixture('1.7.1', 'latest.yml'))
  assert.deepEqual(platformStatus(MAC, '1.7.1', ASSETS_171, mac), {
    ready: true,
    missing: [],
  })
  assert.deepEqual(platformStatus(WINDOWS, '1.7.1', ASSETS_171, windows), {
    ready: true,
    missing: [],
  })

  // published before Windows was attached
  const macOnly = ASSETS_171.filter((name) => !/x64|latest\.yml/.test(name))
  assert.deepEqual(platformStatus(MAC, '1.7.1', macOnly, mac), {
    ready: true,
    missing: [],
  })
  assert.deepEqual(platformStatus(WINDOWS, '1.7.1', macOnly, undefined), {
    ready: false,
    missing: ['latest.yml'],
  })

  // a feed naming a file that isn't attached
  const noDmg = ASSETS_171.filter((name) => name !== 'Forge-1.7.1-arm64.dmg')
  assert.deepEqual(platformStatus(MAC, '1.7.1', noDmg, mac), {
    ready: false,
    missing: ['Forge-1.7.1-arm64.dmg'],
  })

  // a feed from another version
  assert.throws(() => platformStatus(MAC, '1.7.2', ASSETS_171, mac))
})

test('compares versions like semver', () => {
  assert.equal(compareVersions('1.7.1', '1.7.0'), 1)
  assert.equal(compareVersions('1.7.0', '1.7.1'), -1)
  assert.equal(compareVersions('1.7.0', '1.7.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), -1)
  assert.equal(compareVersions('2.0.0-beta.2', '2.0.0-beta.10'), -1)
  assert.equal(compareVersions('2.0.0-alpha', '2.0.0-beta'), -1)
})
