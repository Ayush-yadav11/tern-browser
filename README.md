# Tern

A light, customizable desktop browser on the Chromium engine, with built-in ad and tracker
blocking and no AI features. Built with Electron, so the whole interface is ours to change.

## Install it

Download `Tern-Setup-x.y.z.exe` from the [latest release](https://github.com/Ayush-yadav11/tern-browser/releases/latest)
and run it. It installs for your Windows account only, without needing admin rights. Because the
installer isn't code-signed yet, Windows SmartScreen may warn you: choose **More info**, then **Run anyway**.

## Hiding your IP

An IP address can't be faked, because a website has to send its reply somewhere. Tern can route traffic
through another computer instead, so sites see that computer's address.

- **Tor tab** (Ctrl+Shift+N, or the onion button by the tabs): free, and needs no account. Traffic goes through
  the Tor network. It's slow, some sites block it, and Tern keeps no history for it. Cookies and cache are
  wiped when you close your last Tor tab.
- **Proxy** (Customize > Privacy): sends all normal tabs through a `socks5://` or `http://` server you provide.
  A VPN app installed on Windows also works, with no Tern settings needed.

Both fail closed: if Tor or the proxy can't be reached, pages fail instead of connecting without it. WebRTC, which
can reveal your real IP, is limited to proxied traffic. "Check what websites see" in Customize > Privacy shows the
result, and contacts api.ipify.org only when pressed.

This hides your IP, not who you are. Signing in or typing your details tells a site who you are, and sites can
still recognize a browser by its setup. Tern's own update checks go directly to GitHub, not through Tor or the proxy.

## Updates

The installed app checks for new versions when it starts and every 6 hours. It downloads them in the
background and installs them when you press **Restart to update** or close Tern. A download whose
checksum doesn't match the published one is refused. You can turn this off in Customize.

A GitHub workflow ([release.yml](.github/workflows/release.yml)) runs every Monday. If Electron, Tor or the
ad-block engine has a new version, it updates to it, runs all the tests, and publishes a release only
if they pass. To release by hand, raise the version in `package.json`, push, and run the workflow from
the Actions tab. GitHub emails the repo owner if a run fails, and that's worth acting on, because
it means security updates have stopped.

Tern runs behind Chrome by design. Electron only ships even-numbered Chromium versions, a new major
every 8 weeks, and adds security fixes to its supported lines afterwards. On 6 November 2026 Tern
was on Chromium 156 (Electron 45.2.3) while Chrome stable was on 158. That means fixes can arrive
later than they do in Chrome, so Tern is not as tightly patched as Chrome or Brave.

Filter lists also refresh on their own: once they are a week old, Tern downloads new ones from
Ghostery's CDN in the background and uses them from the next launch.

## Develop it

```bash
npm install
```

```bash
npm run fetch-tor
```

```bash
npm start
```

| Command | What it does |
| --- | --- |
| `npm test` | Tests the browser from source |
| `npm run package` | Builds `out/Tern-win32-x64/Tern.exe` |
| `npm run test:packaged` | Tests that build |
| `npm run test:update` | Installs, updates and uninstalls a separate test copy for real |
| `npm run installer` | Builds the installer in `out/installer` |

## How it's put together

| Path | What it does |
| --- | --- |
| `src/main/app.js` | Starts the browser: window, keyboard shortcuts, permissions, messages from the UI |
| `src/main/tabs.js` | Tabs, including putting unused ones to sleep to free memory |
| `src/main/adblock.js` | Ad and tracker blocking, per-site switch, filter refresh |
| `src/page/youtube-preload.js` | Removes YouTube's ad data before the page reads it |
| `src/main/flags.js` | Chromium switches that turn off AI features and background services |
| `src/main/library.js` | Bookmarks, history and address bar matching |
| `src/main/downloads.js` | Saving files, pause, resume, cancel, and the warning before opening programs |
| `src/main/tor.js` | Runs Tor while Tor tabs are open |
| `scripts/fetch-tor.js` | Downloads Tor and checks its signature and checksum |
| `src/main/updater.js` | Checks for, downloads and installs new versions |
| `src/main/settings.js` | Saved settings, with every value checked on load |
| `src/main/url.js` | Works out whether address bar text is an address or a search |
| `src/shell/` | The browser interface itself (HTML, CSS and JavaScript) |
| `test/e2e.js` | Tests the browser from source. `TERN_LIVE=1` adds a real website |
| `test/packaged.js` | Tests the built `Tern.exe`, including clicks through the real interface |
| `test/update.js` | Full install, update and uninstall using a separate test copy |

To add a theme, add a `body[data-theme="name"]` block in `src/shell/shell.css`, then add the name
to `THEMES` in both `src/shell/shell.js` and `src/main/settings.js`.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+T / Ctrl+W | New tab / close tab |
| Ctrl+Shift+N | New Tor tab |
| Ctrl+Shift+T | Reopen closed tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+1 to Ctrl+9 | Jump to a tab |
| Ctrl+L | Address bar |
| Ctrl+F | Find in page |
| Ctrl+D | Bookmark this page, or remove the bookmark |
| Ctrl+Shift+B | Show or hide the bookmarks bar |
| Ctrl+Shift+O / Ctrl+H / Ctrl+J | Bookmarks / history / downloads |
| Ctrl+R or F5 | Reload |
| Alt+Left / Alt+Right | Back / forward |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom in / out / reset |
| F11 / F12 | Fullscreen / developer tools |

## Known limits

- No sync or password manager yet.
- Bookmarks have no folders yet, and can't be imported from another browser.
- History keeps the last 90 days, up to 5,000 pages. There's no private window yet.
- Downloads can't be picked up again after Tern is closed.
- Netflix-style protected video will not play, because Electron ships without Widevine.
- No Chrome Web Store extension support.
- Google blocks sign-in on its own sites, because it refuses embedded browser frameworks like Electron.
- The app is not code-signed, so Windows SmartScreen may warn people who install it. Updates are checked by checksum against the release, so the security of updates rests on the GitHub account that publishes them.
- No-AI covers the browser. Websites can still have their own AI features.

## Credits

IP hiding uses [Tor](https://www.torproject.org/). Licenses are in `resources/tor/docs` of the installed app.
Ad blocking uses [@ghostery/adblocker](https://github.com/ghostery/adblocker) (MPL-2.0).
Runs on [Electron](https://www.electronjs.org/) and Chromium.
