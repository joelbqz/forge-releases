# Forge — Releases

Public distribution channel for the **Forge** desktop app.

This repository hosts only published release artifacts (the macOS `.dmg` and `.zip`,
the Windows `-setup.exe`, their `.blockmap` files) and the `latest-mac.yml` /
`latest.yml` manifests that the app's auto-updater
([electron-updater](https://www.electron.build/auto-update)) reads. The application
source code lives in a separate, private repository.

## Download

Get Forge from [ui8.ai/forge](https://ui8.ai/forge), or grab the latest installer from the
[**Releases**](https://github.com/joelbqz/forge-releases/releases/latest) page.

Installed copies of Forge check this repo for updates automatically and prompt to
restart when a newer signed build is published here.

## Mirror on downloads.ui8.ai

The download buttons on ui8.ai/forge don't link here: GitHub's release downloads time
out for signed-out visitors during GitHub incidents. They use a copy of each release in
the `forge-downloads` R2 bucket, served at `https://downloads.ui8.ai`:

| Key | What |
| --- | --- |
| `v<version>/<asset>` | Every asset of the release, blockmaps included, plus its feeds |
| `latest/Forge-arm64.dmg` | The newest Mac installer, downloaded as `Forge-<version>-arm64.dmg` |
| `latest/Forge-x64-setup.exe` | The newest Windows installer, downloaded as `Forge-<version>-x64-setup.exe` |
| `latest-mac.yml`, `latest.yml` | The update feeds, with each file pointed at `v<version>/` |

The [Mirror release to R2](.github/workflows/mirror-to-r2.yml) workflow fills it
(`scripts/mirror-release.mjs`). It runs when a release is **published**, never for a
draft, and when the source repo's `distribute-win.mjs` attaches Windows assets to an
already published release. It uploads the versioned files first. Then, per platform and
only once all that platform's files are in, it moves the `latest/` installer and the feed,
and purges them from Cloudflare's cache. It never moves them back to an older version, nor
to a pre-release. Re-running it is safe:

```sh
gh workflow run mirror-to-r2.yml -R joelbqz/forge-releases -f tag=v1.7.1
```

Rolling back a platform: copy `v<old>/latest-mac.yml` (or `latest.yml`) and its installer
over the root feed and the `latest/` file, then purge those URLs.

Locally: `node --test scripts/feed.test.mjs`, and `node scripts/mirror-release.mjs v1.7.1 --dry-run`
prints the plan (and the feeds as they'd be served) without uploading anything.
