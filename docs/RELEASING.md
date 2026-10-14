# Releasing Celenne Studio

`npm run release` turns the source into a published release. It runs the typecheck and tests, builds the installer, code-signs it (when a certificate is configured), writes the signed update manifest, and uploads everything in a safe order.

Installed copies then find the release, download it in the background, check it against the signed manifest, and install it when the user quits.

`npm run dist` still makes a plain local build. That build cannot update itself.

## One-time setup

### 1. Release key (required for auto-update)

```bash
npm run release:keygen
```

This creates two files:

- **Private key:** `%USERPROFILE%\.celenne-release\update-signing.key`. Keep it **outside the repository**.
- **Public key:** `build/update-signing.pub.pem`. Commit it; it is built into the app.

Installed copies only accept updates whose manifest is signed with this private key. **Back the private key up**, for example in a password manager. If it is lost, installed copies cannot be updated automatically and people have to reinstall by hand.

To keep the key somewhere else, set `CELENNE_RELEASE_KEY` to its path.

### 2. Where releases are hosted

Set `updateUrl` to an HTTPS folder, in `celenne.release.local.json` (git-ignored, so your address stays out of the public repository and out of other people's builds; its values win over `celenne.release.json`). Each release puts these files there:

- `latest.yml`
- `Celenne-Studio-<version>-setup.exe` and its `.blockmap`
- `celenne-update.json` and `celenne-update.json.sig`

Keep older versions' files on the server: they let an update download only the parts that changed.

| Hosting | `updateUrl` | Upload with |
|---|---|---|
| Cloudflare R2 (free tier: 10 GB, no download fees) | the bucket's public URL, e.g. `https://downloads.example.com/celenne` or `https://pub-….r2.dev` | `--to s3` |
| GitHub Releases (free for public repositories) | `https://github.com/<owner>/<repo>/releases/latest/download` | `--to github` (needs the `gh` CLI, signed in) |
| Any HTTPS web space | its URL | `--to dir:<folder>`, then upload the folder |

Notes on the free addresses:

- **Cloudflare `r2.dev`:** these addresses are rate-limited.
- **GitHub `latest/download`:** this always serves the newest release, so updates cannot download only the changed parts there. Every update is a full download.

The address is built into every installed copy. A domain of your own lets you move hosting later without stranding old copies.

**`--to s3` settings** (environment variables):

- `CELENNE_S3_ENDPOINT`, e.g. `https://<account>.r2.cloudflarestorage.com`
- `CELENNE_S3_BUCKET`
- `CELENNE_S3_PREFIX` (optional folder)
- `CELENNE_S3_ACCESS_KEY_ID` and `CELENNE_S3_SECRET_ACCESS_KEY`, from an R2 API token with write access to that bucket only
- `CELENNE_S3_REGION` (`auto` for R2)

### 3. Error reports (optional)

Set `reportDsn` in `celenne.release.local.json` to a Sentry or GlitchTip DSN (`https://<key>@<host>/<project>`).

- **Sentry:** create a project of type *Electron*. Under *Settings ▸ Security & Privacy*, turn on **Prevent Storing of IP Addresses**.
- **GlitchTip:** self-hosted on a small Linux server; the same DSN format works.

Without a DSN, reports stay on the user's computer. Help ▸ Error Reports can open the folder. What a report contains is described in [PRIVACY.md](PRIVACY.md).

### 4. Code signing (recommended)

Signing removes "Unknown publisher". It is also the start of building SmartScreen reputation: a new certificate can still show the warning until enough people have run the app.

When signing is on, installed copies also require each update to carry the same publisher name.

Set the variables in the shell that runs the release:

| Certificate | Variables |
|---|---|
| **Certificate in the Windows certificate store.** This covers USB tokens and the cloud services that install a certificate into Windows (SSL.com eSigner CKA, Certum SimplySign, DigiCert KeyLocker). | `CELENNE_SIGN=certstore`, `CELENNE_SIGN_SHA1=<thumbprint>` |
| **Microsoft Trusted Signing** | `CELENNE_SIGN=azure`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `CELENNE_AZURE_ENDPOINT`, `CELENNE_AZURE_ACCOUNT`, `CELENNE_AZURE_PROFILE` |
| **.pfx file** (older certificates only; new ones are issued on hardware) | `CELENNE_SIGN=pfx`, `CSC_LINK`, `CSC_KEY_PASSWORD` |

For every option, also set `CELENNE_PUBLISHER_NAME` to the name on the certificate (its CN), exactly as written.

The script checks every signature after the build. With no `CELENNE_SIGN`, the release is unsigned and the script warns.

**Never change the publisher name between releases.** Copies installed from signed releases refuse updates signed under a different name.

## Making a release

1. Set `"version"` in `package.json` (and run `npm install --package-lock-only`).
2. Add a `## <version>` section to `CHANGELOG.md`. Installed copies show it as the release notes (plain text).
3. Run:

   ```bash
   npm run release -- --to s3
   ```

   (or `--to github` / `--to dir:<folder>` / `--to none`)

Files are uploaded in this order: installers and blockmap, then the signed manifest, then `latest.yml`. Installed copies never see a release whose files are missing.

Installed copies check 20 seconds after start and then every 6 hours. Users can turn automatic checks off, or check by hand with Help ▸ Check for Updates.

## Testing an update on this computer

```bash
# two test builds that look for updates on http://127.0.0.1:8765 (allowed only in test builds)
npm run release -- --version 0.9.0 --test-server 8765 --to dir:release/test-old --skip-tests
npm run release -- --version 0.9.1 --test-server 8765 --to dir:release/test-feed --skip-tests
npm run release:serve -- release/test-feed 8765
```

Then:

1. Install `release/test-old/Celenne-Studio-0.9.0-setup.exe`.
2. Start it and open Help ▸ Check for Updates.

`CELENNE_SMOKE_UPDATE=1` runs the same steps without the UI and prints each one.

To test without touching your real key, set `CELENNE_RELEASE_KEY` and `CELENNE_UPDATE_PUBLIC_KEY_FILE` to a throwaway pair made with `npm run release:keygen`.

`CELENNE_SMOKE_REPORT=1` checks error reports: it raises an error, crashes the editor, and sends the reports to the build's destination.

## Microsoft Store (optional)

The Store signs the app and delivers updates, so neither a certificate nor update hosting is needed for Store users. Store copies never use the built-in updater.

1. Register as a developer in Partner Center (free for individuals at the time of writing; check).
2. Reserve the name, then copy the values from *Product identity* into these variables:
   - `CELENNE_STORE_IDENTITY`
   - `CELENNE_STORE_PUBLISHER` (`CN=…`)
   - `CELENNE_STORE_PUBLISHER_DISPLAY`
3. Run:

   ```bash
   npm run release -- --store
   ```

   Then upload the `.appx` from `release/<version>-store/`.

Building the package needs Microsoft's packaging tool from the **Windows SDK**. Install it with `winget install Microsoft.WindowsSDK.10.0.26100`. On the build PC without the SDK, `makeappx` fails with "side-by-side configuration is incorrect".

## Things that are permanent after the first auto-update release

- **App ID:** `appId` in `package.json`, currently `app.celenne.studio`. Changing it creates a different app as far as Windows and the updater are concerned.
- **Product name:** it sets the install folder and the settings folder.
- **Update address:** built into every installed copy. A later release can switch to a new address, but copies that never installed that release keep checking the old one.
- **Release key and publisher name:** see above.
