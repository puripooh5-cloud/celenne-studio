# What Celenne Studio sends over the network

Celenne Studio edits files on your computer. Documents, images, layer names, text and file names are never sent anywhere by the app itself.

The app makes these network requests:

## Update checks (desktop app, release builds)

- **When:** 20 seconds after start, then every 6 hours, and whenever you choose Help ▸ Check for Updates. Turn automatic checks off in Preferences ▸ Updates & Privacy.
- **What is requested:** the release information (`latest.yml`, `celenne-update.json` and its signature) and, when there is a new version, the installer. The requests go to the update address built into the app.
- **What the server sees:** what any web request shows, which is your IP address and a browser-style user agent. Nothing else is added: no account and no document data.
- **Portable copy** (earlier local builds only): it only checks, and links to the setup download.
- **Microsoft Store copies:** they are updated by the Store and make no update requests themselves.
- **Builds without an update address:** they make no update requests.

## Error reports (desktop app, only with your consent)

- **When:** only after you agree. When something goes wrong, the app saves a report on your computer (`%APPDATA%\Celenne Studio\Reports`). It is sent only if you choose **Send** when asked, or set **Always send** (Help ▸ Error Reports, or Preferences ▸ Updates & Privacy). With **Never send**, reports stay on your computer.
- **Where to:** the report destination built into the app (a Sentry or GlitchTip server). Builds without a destination never send reports.
- **What a report contains:**
  - the error type and message;
  - the code locations of the error inside the app;
  - which process failed, and for crashes, the reason and exit code;
  - the app, Electron, Chrome and Windows versions, and the processor architecture;
  - the display renderer;
  - the open document's file type, colour mode and bit depth.
- **What is removed:** before a report is saved, every message and code location is cleaned:
  - folder and file paths and file names;
  - anything in quotation marks (which is where layer names and other document text appear in error messages);
  - e-mail addresses and the query part of web addresses;
  - your Windows user name and computer name.
- **What you can check:** Help ▸ Error Reports ▸ View shows exactly what would be sent.
- **Crash dumps:** files of process memory from native crashes are written to the local crash-dump folder only. They are never uploaded, because memory can contain document data.
- **Local log:** a diagnostic log (`%APPDATA%\Celenne Studio\logs\main.log`) stays on your computer.

## Other

- **AI features:** these contact a cloud service only if you set one up under Preferences ▸ AI. The default is local.
- **Plugins:** they run in a sandbox without network access.
- **Links:** links you click, such as a download link, open in your web browser.
