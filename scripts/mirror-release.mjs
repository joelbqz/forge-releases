#!/usr/bin/env node
// Copies a published release's assets to the forge-downloads R2 bucket,
// served at https://downloads.ui8.ai: the website's download buttons
// (ui8.ai/forge/download redirects there) and, later, the app's updater.
// Run by .github/workflows/mirror-to-r2.yml; see the README.
//
//   node scripts/mirror-release.mjs v1.7.1             # mirror it
//   node scripts/mirror-release.mjs v1.7.1 --dry-run   # print the plan only
//
// What lands in the bucket, in this order:
//   1. v<version>/<asset>  every asset (installers, zips, blockmaps), plus the
//      feeds pointed at that folder (a copy to roll back to).
//   2. Per platform, only once all its files are in:
//        latest/Forge-arm64.dmg, latest/Forge-x64-setup.exe  the installer
//          under a stable name, downloaded as Forge-<version>-<arch>.<ext>
//        latest-mac.yml, latest.yml  the update feeds, at the bucket root
//      skipped for a pre-release, and when the bucket already serves a
//      newer version (a backfill of an old tag never moves them back).
//   3. A Cloudflare cache purge of every public URL that changed, and of the
//      stable names and feeds it serves (so a re-run repairs a failed purge).
//
// Safe to re-run: an object whose bytes are already there (same sha512 in
// its metadata, same headers) isn't uploaded again or purged. Drafts are
// refused. Every installer is checked against the sha512 in its feed before
// it's uploaded.
//
// Environment (the workflow maps the repository secrets onto these):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   R2 S3 API access
//   R2_BUCKET               default forge-downloads
//   PUBLIC_ORIGIN           default https://downloads.ui8.ai
//   CLOUDFLARE_ZONE_ID, CLOUDFLARE_PURGE_TOKEN   cache purge on that zone
//   RELEASE_REPO            default $GITHUB_REPOSITORY, else joelbqz/forge-releases
//   R2_ENDPOINT             testing only: an S3 endpoint to use instead of R2
//   CLOUDFLARE_API          testing only: a stand-in for the Cloudflare API
//   GH_TOKEN                for gh (the workflow's own token is enough)
// Needs the gh and aws CLIs (both preinstalled on GitHub's Ubuntu runners).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  contentTypeOf,
  compareVersions,
  FEEDS,
  parseFeed,
  PLATFORMS,
  platformStatus,
  rewriteFeed,
  SAFE_NAME,
  VERSION,
} from './feed.mjs'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const TAG = args.find((arg) => !arg.startsWith('--'))
if (!TAG || !/^v/.test(TAG) || !VERSION.test(TAG.slice(1))) {
  fail(
    `usage: node scripts/mirror-release.mjs v<version> [--dry-run] (got ${TAG ?? 'nothing'})`,
  )
}
const VERSION_ = TAG.slice(1)

const REPO =
  process.env.RELEASE_REPO ||
  process.env.GITHUB_REPOSITORY ||
  'joelbqz/forge-releases'
const BUCKET = process.env.R2_BUCKET || 'forge-downloads'
const ORIGIN = (
  process.env.PUBLIC_ORIGIN || 'https://downloads.ui8.ai'
).replace(/\/+$/, '')

// Versioned files never change once a release is out (a re-uploaded asset
// is purged); the stable names and the feeds move with every release.
const CACHE_VERSIONED = 'public, max-age=86400'
const CACHE_ALIAS = 'public, max-age=300'
const CACHE_FEED = 'public, max-age=60'

let failed = false
const summary = []
const say = (line) => {
  console.log(line)
  summary.push(line)
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function run(command, commandArgs, { input, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  if (result.error) fail(`${command} couldn't start: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(
      `${command} ${commandArgs.join(' ')} exited with ${result.status}:\n${result.stderr}`,
    )
  }
  return result
}

// --- the release ------------------------------------------------------------

const release = JSON.parse(
  run('gh', [
    'release',
    'view',
    TAG,
    '--repo',
    REPO,
    '--json',
    'isDraft,isPrerelease,tagName,assets',
  ]).stdout,
)
if (release.isDraft) {
  fail(
    `${TAG} on ${REPO} is a draft: only published releases are mirrored. Publish it first.`,
  )
}
const assetNames = release.assets.map((asset) => asset.name)
for (const name of assetNames) {
  if (!SAFE_NAME.test(name)) fail(`asset name isn't a plain file name: ${name}`)
}
say(
  `${TAG} on ${REPO}${release.isPrerelease ? ' (pre-release)' : ''}: ${assetNames.join(', ')}`,
)

const dir = mkdtempSync(join(tmpdir(), 'forge-mirror-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

// A dry run reads only the feeds; a real one fetches every asset.
run('gh', [
  'release',
  'download',
  TAG,
  '--repo',
  REPO,
  '--dir',
  dir,
  ...(DRY_RUN
    ? [...FEEDS]
        .filter((feed) => assetNames.includes(feed))
        .flatMap((feed) => ['--pattern', feed])
    : []),
])

const feeds = new Map()
for (const platform of PLATFORMS) {
  if (!assetNames.includes(platform.feed)) continue
  const text = readFileSync(join(dir, platform.feed), 'utf8')
  feeds.set(platform.id, {
    text,
    parsed: parseFeed(text),
    rewritten: rewriteFeed(text, VERSION_),
  })
}

// --- checks -----------------------------------------------------------------

const sha512Hex = new Map()
async function hashOf(name) {
  if (!sha512Hex.has(name)) {
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(join(dir, name)))
      hash.update(chunk)
    sha512Hex.set(name, hash.digest('hex'))
  }
  return sha512Hex.get(name)
}

// Which platforms can move to this release, and which files are known bad.
const bad = new Set()
const statuses = new Map()
for (const platform of PLATFORMS) {
  const feed = feeds.get(platform.id)
  const status = platformStatus(platform, VERSION_, assetNames, feed?.parsed)
  if (feed && !DRY_RUN) {
    for (const [name, base64] of feed.parsed.sha512) {
      if (!assetNames.includes(name)) continue
      const expected = Buffer.from(base64, 'base64').toString('hex')
      if ((await hashOf(name)) !== expected) {
        console.error(
          `::error::${name} doesn't match the sha512 in ${platform.feed}`,
        )
        bad.add(name)
        status.ready = false
        failed = true
      }
    }
  }
  statuses.set(platform.id, status)
}

// --- the bucket ---------------------------------------------------------------

const endpoint = () => {
  // a local S3 server, for testing this script
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT
  const account = process.env.R2_ACCOUNT_ID
  if (!account || !/^[0-9a-f]{32}$/i.test(account))
    fail('R2_ACCOUNT_ID is missing or malformed')
  return `https://${account}.r2.cloudflarestorage.com`
}
const awsEnv = () => {
  for (const name of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!process.env[name]) fail(`${name} is missing`)
  }
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: 'auto',
    // R2 doesn't take every checksum header newer AWS CLIs send by default
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
    AWS_PAGER: '',
  }
}

function aws(commandArgs, options = {}) {
  const result = spawnSync(
    'aws',
    [...commandArgs, '--endpoint-url', endpoint()],
    {
      encoding: 'utf8',
      env: awsEnv(),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.error) fail(`aws couldn't start: ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    fail(
      `aws ${commandArgs.slice(0, 2).join(' ')} exited with ${result.status}:\n${result.stderr}`,
    )
  }
  return result
}

/** The object's metadata, or null when it doesn't exist. */
function head(key) {
  const result = aws(
    ['s3api', 'head-object', '--bucket', BUCKET, '--key', key],
    { allowFailure: true },
  )
  if (result.status !== 0) {
    if (/\b(404|Not Found|NoSuchKey)\b/.test(result.stderr)) return null
    fail(`aws s3api head-object ${key} failed:\n${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

/** The bucket's current feed for a platform, parsed, or null. */
function currentFeed(platform) {
  const out = join(dir, `current-${platform.feed}`)
  const result = aws(
    ['s3', 'cp', `s3://${BUCKET}/${platform.feed}`, out, '--only-show-errors'],
    {
      allowFailure: true,
    },
  )
  if (result.status !== 0) {
    if (/\b(404|Not Found|NoSuchKey|does not exist)\b/.test(result.stderr))
      return null
    fail(`reading ${platform.feed} from the bucket failed:\n${result.stderr}`)
  }
  try {
    return parseFeed(readFileSync(out, 'utf8'))
  } catch {
    return null
  }
}

// Public URLs to purge from Cloudflare's cache.
const changed = new Set()

/**
 * Uploads `file` to `key` unless the bucket already holds the same bytes
 * with the same headers. Multipart for big files (the aws CLI's default).
 */
async function put(
  key,
  file,
  { contentType, cacheControl, disposition, version },
) {
  if (DRY_RUN) {
    say(`  would upload ${key}${disposition ? ` (${disposition})` : ''}`)
    return
  }
  const sha512 = await hashOf(file)
  const metadata = { sha512, ...(version ? { version } : {}) }
  const existing = head(key)
  if (
    existing &&
    existing.Metadata?.sha512 === sha512 &&
    (existing.Metadata?.version ?? undefined) === (version ?? undefined) &&
    existing.ContentType === contentType &&
    existing.CacheControl === cacheControl &&
    (existing.ContentDisposition ?? undefined) === (disposition ?? undefined)
  ) {
    say(`  unchanged ${key}`)
    return
  }
  aws([
    's3',
    'cp',
    join(dir, file),
    `s3://${BUCKET}/${key}`,
    '--only-show-errors',
    '--content-type',
    contentType,
    '--cache-control',
    cacheControl,
    ...(disposition ? ['--content-disposition', disposition] : []),
    '--metadata',
    JSON.stringify(metadata),
  ])
  say(`  uploaded ${key}`)
  changed.add(`${ORIGIN}/${key}`)
}

// hashOf() reads files from `dir`; the rewritten feeds go there too, under
// a name no asset can have.
function writeLocal(name, text) {
  const file = `rewritten-${name}`
  writeFileSync(join(dir, file), text)
  return file
}

// 1. Every asset, under v<version>/. The feeds go in rewritten.
say(`\nVersioned files (v${VERSION_}/):`)
for (const name of assetNames) {
  if (bad.has(name)) {
    say(`  SKIPPED ${name}: sha512 mismatch`)
    continue
  }
  if (FEEDS.has(name)) continue
  await put(`v${VERSION_}/${name}`, name, {
    contentType: contentTypeOf(name),
    cacheControl: CACHE_VERSIONED,
  })
}
for (const platform of PLATFORMS) {
  const feed = feeds.get(platform.id)
  if (!feed) continue
  await put(
    `v${VERSION_}/${platform.feed}`,
    writeLocal(platform.feed, feed.rewritten),
    {
      contentType: contentTypeOf(platform.feed),
      cacheControl: CACHE_VERSIONED,
      version: VERSION_,
    },
  )
}

// 2. Per platform, the stable installer name and the feed.
for (const platform of PLATFORMS) {
  const status = statuses.get(platform.id)
  say(`\n${platform.id}:`)
  if (!status.ready) {
    say(
      status.missing.length > 0
        ? `  not moved to ${VERSION_}: the release lacks ${status.missing.join(', ')} (re-run once they're attached)`
        : `  not moved to ${VERSION_}: see the errors above`,
    )
    if (feeds.has(platform.id) && status.missing.length > 0) failed = true
    continue
  }
  if (release.isPrerelease) {
    say(
      `  not moved: ${TAG} is a pre-release (its files are under v${VERSION_}/)`,
    )
    continue
  }
  const current =
    DRY_RUN && !process.env.R2_ACCOUNT_ID && !process.env.R2_ENDPOINT
      ? null
      : currentFeed(platform)
  if (current && compareVersions(current.version, VERSION_) > 0) {
    say(
      `  not moved: the bucket already serves ${current.version}, newer than ${VERSION_}`,
    )
    continue
  }
  const installer = platform.alias.file(VERSION_)
  await put(platform.alias.key, installer, {
    contentType: contentTypeOf(installer),
    cacheControl: CACHE_ALIAS,
    disposition: `attachment; filename="${installer}"`,
    version: VERSION_,
  })
  const feed = feeds.get(platform.id)
  if (DRY_RUN) {
    say(
      `  ${platform.feed} as it would be served:\n${feed.rewritten.replace(/^/gm, '    | ')}`,
    )
  }
  await put(platform.feed, writeLocal(platform.feed, feed.rewritten), {
    contentType: contentTypeOf(platform.feed),
    cacheControl: CACHE_FEED,
    version: VERSION_,
  })
  if (!DRY_RUN) {
    changed.add(`${ORIGIN}/${platform.alias.key}`)
    changed.add(`${ORIGIN}/${platform.feed}`)
  }
  const was =
    current && current.version !== VERSION_ ? ` (was ${current.version})` : ''
  say(`  ${DRY_RUN ? 'would serve' : 'serving'} ${VERSION_}${was}`)
}

// 3. Purge from Cloudflare's cache.
const purge = [...changed]
if (purge.length > 0) {
  const zone = process.env.CLOUDFLARE_ZONE_ID
  const token = process.env.CLOUDFLARE_PURGE_TOKEN
  if (!zone || !token) {
    console.error(
      '::error::CLOUDFLARE_ZONE_ID / CLOUDFLARE_PURGE_TOKEN missing: nothing purged',
    )
    failed = true
  } else {
    say(`\nPurging ${purge.length} URLs from the cache...`)
    // up to 30 URLs per call on every plan
    for (let i = 0; i < purge.length; i += 30) {
      const files = purge.slice(i, i + 30)
      const response = await fetch(
        `${process.env.CLOUDFLARE_API || 'https://api.cloudflare.com/client/v4'}/zones/${encodeURIComponent(zone)}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files }),
        },
      ).catch((error) => ({
        ok: false,
        status: 0,
        text: async () => String(error),
      }))
      const body = await response.text()
      let success = false
      try {
        success = JSON.parse(body).success === true
      } catch {}
      if (!response.ok || !success) {
        console.error(
          `::error::cache purge failed (${response.status}): ${body.slice(0, 500)}`,
        )
        failed = true
      }
    }
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Mirror ${TAG}\n\n\`\`\`\n${summary.join('\n')}\n\`\`\`\n`,
  )
}
if (failed) {
  console.error(
    '\nFinished with errors (see above). Fix them, then re-run the workflow for this tag.',
  )
  process.exit(1)
}
console.log(DRY_RUN ? '\nDry run: nothing uploaded.' : '\nDone.')
