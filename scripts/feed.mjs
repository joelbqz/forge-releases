// Pure helpers for mirror-release.mjs: reading electron-builder's update
// feeds (latest-mac.yml, latest.yml), pointing them at the versioned
// folder in the bucket, and comparing versions. No I/O, no dependencies;
// tested by feed.test.mjs (`node --test scripts/feed.test.mjs`).

/** A version as electron-builder writes it ("1.7.0", "1.8.0-beta.1"). */
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** An asset name safe to use in a bucket key, a URL path and a header. */
export const SAFE_NAME = /^[A-Za-z0-9][\w.-]*$/

/**
 * The two platforms. `feed` is the updater feed on the release; `alias` is
 * the installer the website's download button gets, under a stable key.
 */
export const PLATFORMS = [
  {
    id: 'mac',
    feed: 'latest-mac.yml',
    alias: {
      key: 'latest/Forge-arm64.dmg',
      file: (version) => `Forge-${version}-arm64.dmg`,
    },
  },
  {
    id: 'windows',
    feed: 'latest.yml',
    alias: {
      key: 'latest/Forge-x64-setup.exe',
      file: (version) => `Forge-${version}-x64-setup.exe`,
    },
  },
]

export const FEEDS = new Set(PLATFORMS.map((platform) => platform.feed))

// `  - url: Forge-1.7.0-arm64-mac.zip` (a files entry) and the top-level,
// legacy `path: Forge-1.7.0-arm64-mac.zip`. Values may be quoted.
const URL_LINE = /^(\s*-\s*url:\s*)(['"]?)([^'"\s]+)\2(\s*)$/
const PATH_LINE = /^(path:\s*)(['"]?)([^'"\s]+)\2(\s*)$/

/**
 * What a feed says: its version, the files it names (`files[].url`, plus
 * the top-level `path`) and each file's sha512 (base64). Line-based: the
 * shape electron-builder writes is fixed, and a YAML parser isn't worth a
 * dependency here. Throws on a feed without a valid version.
 */
export function parseFeed(text) {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1]
  if (!version || !VERSION.test(version)) {
    throw new Error(`feed has no valid version:\n${text}`)
  }
  const files = []
  const sha512 = new Map()
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const url = URL_LINE.exec(line)
    if (url) {
      current = url[3]
      files.push(current)
      continue
    }
    const path = PATH_LINE.exec(line)
    if (path) {
      if (!files.includes(path[3])) files.push(path[3])
      current = null
      continue
    }
    // an entry's sha512 is indented under its `- url:`; the top-level one
    // (for `path`) isn't, and ends the files list
    const hash = /^(\s*)sha512:\s*['"]?([A-Za-z0-9+/=]+)/.exec(line)
    if (hash && current && hash[1].length > 0 && !sha512.has(current)) {
      sha512.set(current, hash[2])
    }
    if (/^\S/.test(line) && !line.startsWith('files:')) current = null
  }
  return { version, files, sha512 }
}

/**
 * The feed with every file it names (`files[].url` and `path`) moved into
 * the version's folder: `Forge-1.7.0-arm64-mac.zip` becomes
 * `v1.7.0/Forge-1.7.0-arm64-mac.zip`. electron-updater's generic provider
 * resolves these against its base URL (https://downloads.ui8.ai/), and
 * finds each file's blockmap next to it. Everything else (sha512, size,
 * releaseDate, …) is kept byte for byte. Running it twice changes nothing.
 * Throws on a name that isn't a plain file name.
 */
export function rewriteFeed(text, version) {
  const prefix = `v${version}/`
  const move = (name) => {
    if (name.startsWith(prefix)) return name
    if (!SAFE_NAME.test(name)) {
      throw new Error(`feed names a file that isn't a plain name: ${name}`)
    }
    return prefix + name
  }
  return text
    .split('\n')
    .map((line) => {
      const url = URL_LINE.exec(line.replace(/\r$/, ''))
      if (url) {
        return line.replace(URL_LINE, (_, head, q, name, tail) => {
          return `${head}${q}${move(name)}${q}${tail}`
        })
      }
      const path = PATH_LINE.exec(line.replace(/\r$/, ''))
      if (path) {
        return line.replace(PATH_LINE, (_, head, q, name, tail) => {
          return `${head}${q}${move(name)}${q}${tail}`
        })
      }
      return line
    })
    .join('\n')
}

/** Like semver: -1, 0 or 1. A pre-release sorts before its release. */
export function compareVersions(a, b) {
  const [coreA, preA] = splitVersion(a)
  const [coreB, preB] = splitVersion(b)
  for (let i = 0; i < 3; i++) {
    if (coreA[i] !== coreB[i]) return coreA[i] < coreB[i] ? -1 : 1
  }
  if (preA === preB) return 0
  if (preA === null) return 1
  if (preB === null) return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i]
    const y = partsB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) return nx < ny ? -1 : 1
    if (nx !== null) return -1
    if (ny !== null) return 1
    return x < y ? -1 : 1
  }
  return 0
}

function splitVersion(version) {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`)
  const dash = version.indexOf('-')
  const core = (dash === -1 ? version : version.slice(0, dash))
    .split('.')
    .map(Number)
  return [core, dash === -1 ? null : version.slice(dash + 1)]
}

/** The Content-Type an asset is stored with. */
export function contentTypeOf(name) {
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (name.endsWith('.zip')) return 'application/zip'
  if (name.endsWith('.exe'))
    return 'application/vnd.microsoft.portable-executable'
  if (name.endsWith('.yml')) return 'text/yaml; charset=utf-8'
  return 'application/octet-stream'
}

/**
 * Per platform, whether the release has everything it needs to become the
 * one the website and the updater serve: its feed, every file the feed
 * names, and the installer the download button gets. `missing` lists what
 * isn't on the release yet (an empty list with `ready: false` means the
 * platform's feed itself isn't there).
 */
export function platformStatus(platform, version, assetNames, feed) {
  const names = new Set(assetNames)
  if (!names.has(platform.feed)) {
    return { ready: false, missing: [platform.feed] }
  }
  if (!feed) throw new Error(`${platform.feed} wasn't read`)
  if (feed.version !== version) {
    throw new Error(
      `${platform.feed} on v${version} says version ${feed.version}`,
    )
  }
  const needed = [...feed.files, platform.alias.file(version)]
  const missing = [...new Set(needed)].filter((name) => !names.has(name))
  return { ready: missing.length === 0, missing }
}
