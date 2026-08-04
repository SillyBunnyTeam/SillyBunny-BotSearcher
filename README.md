# SillyBunny BotSearcher

BotSearcher adds a character-card browser to SillyBunny. It can search supported card sites, show the details each site provides, and import a selected card.

The frontend extension and server plugin are both required. Search requests go through your SillyBunny server directly to the selected source, except where a source refuses connections from your server and is requested from your browser instead. BotSearcher does not use a public relay in either case. See [Request routing and privacy](#request-routing-and-privacy).

## Requirements

- A working SillyBunny installation
- Server plugins enabled in SillyBunny
- The BotSearcher frontend extension and server plugin from this repository
- Node.js 22, 24, or 26 for the server plugin
- A reverse proxy or host configuration that rejects oversized plugin requests before JSON or multipart parsing

## Installation

Install both components from the same verified immutable release tag or full commit. Do not track a mutable branch for either privileged component.

```bash
RELEASE=<verified-release-tag-or-full-commit>
REPO=https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher.git

git clone "$REPO" data/default-user/extensions/SillyBunny-BotSearcher
git -C data/default-user/extensions/SillyBunny-BotSearcher checkout "$RELEASE"

git clone "$REPO" plugins/SillyBunny-BotSearcher
git -C plugins/SillyBunny-BotSearcher checkout "$RELEASE"
npm --prefix plugins/SillyBunny-BotSearcher ci --omit=dev --ignore-scripts --no-audit --no-fund
```

Adjust the frontend extension path for the SillyBunny user you run. If you use the extension manager or plugin installer initially, immediately check out the same verified release in both resulting directories and install the server package's production dependencies as above.

Set these values in `config.yaml`:

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

Restart SillyBunny after installing or updating either component.

`enableServerPluginsAutoUpdate` controls the legacy mutable-branch updater. It defaults to `true`, which runs `git pull` for each unpinned plugin when SillyBunny starts. Setting it to `false` prevents that path from changing BotSearcher. BotSearcher's manifest disables frontend auto-update too; keep both checkouts on the same verified release.

## Updating the server plugin

BotSearcher shows the active server-plugin version in **Extensions > BotSearcher**. When the server is older than the frontend, a SillyBunny 1.7.0-or-newer build exposing `/api/server-admin/server-plugins/capabilities` offers **Update server plugin and restart** to administrators.

After installing a SillyBunny release that introduces this updater, stop and start the top-level launcher or service once. An ordinary in-app restart cannot add the updater protocol to a supervisor process that was already running older host code.

The host-owned updater accepts only BotSearcher's installed directory and the frontend's exact `vX.Y.Z` release. It verifies no tracked Git changes and a matching repository, installs locked production dependencies with lifecycle scripts disabled, preserves `.cursor-key`, replaces the plugin only after graceful shutdown, and keeps the old directory as a rollback backup. It will not install a missing plugin, downgrade a newer server, or replace symlinked development checkouts. Other untracked state is not copied into the active release; it remains in the rollback backup.

Older SillyBunny versions and non-admin users can use the guided fallback below only when the installed server is a stable older release. Do not use it to override an automatic updater refusal. Resolve dirty, wrong-remote, downgrade, or externally managed installations through their owner or deployment process instead.

Stop SillyBunny completely, then run the complete block in Git Bash (including on Windows). It stops unless the plugin directory is the canonical Git checkout root, the official remote matches with or without its `.git` suffix, tracked status is clean, and the installed version is a stable release older than `RELEASE`. If checkout or dependency installation fails, it attempts to restore the prior commit and dependencies:

```bash
set -eu
PLUGIN=plugins/SillyBunny-BotSearcher
RELEASE=v0.3.0
REPO=https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher.git
test ! -L "$PLUGIN"
PLUGIN_ROOT="$(cd "$PLUGIN" && pwd -P)"
GIT_ROOT="$(git -C "$PLUGIN_ROOT" rev-parse --show-toplevel)"
GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"
test "$GIT_ROOT" = "$PLUGIN_ROOT"
REMOTE="$(git -C "$PLUGIN_ROOT" remote get-url origin)"
REPO_NO_SUFFIX="${REPO%.git}"
test "$REMOTE" = "$REPO" || test "$REMOTE" = "$REPO_NO_SUFFIX"
STATUS="$(git -C "$PLUGIN_ROOT" status --porcelain --untracked-files=no)"
test -z "$STATUS"
CURRENT="$(node -e 'process.stdout.write(require(process.argv[1] + "/package.json").version)' "$PLUGIN_ROOT")"
node -e 'const p=v=>/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)?v.split(".").map(Number):null;const [a,b]=process.argv.slice(1).map(p);let c=0;if(a&&b){for(let i=0;i<3&&!c;i++)c=Math.sign(a[i]-b[i]);}if(!a||!b||c>=0){console.error("Installed version is not a stable older release; refusing replacement.");process.exit(1);}' "$CURRENT" "${RELEASE#v}"
OLD_COMMIT="$(git -C "$PLUGIN_ROOT" rev-parse HEAD)"
rollback() { git -C "$PLUGIN_ROOT" checkout --detach "$OLD_COMMIT"; npm --prefix "$PLUGIN_ROOT" ci --omit=dev --ignore-scripts --no-audit --no-fund; }
trap rollback ERR
git -C "$PLUGIN_ROOT" fetch --depth 1 "$REPO" "refs/tags/$RELEASE"
git -C "$PLUGIN_ROOT" checkout --detach FETCH_HEAD
TARGET="$(node -e 'process.stdout.write(require(process.argv[1] + "/package.json").version)' "$PLUGIN_ROOT")"
test "$TARGET" = "${RELEASE#v}"
npm --prefix "$PLUGIN_ROOT" ci --omit=dev --ignore-scripts --no-audit --no-fund
trap - ERR
```

Restart SillyBunny after a manual update. Never substitute a branch name or `latest` for the matching immutable release tag.

### Deployment limits

The plugin validates its own request shapes and byte limits, but SillyBunny's global body parsers run before plugin routes. Configure the reverse proxy or host to authenticate and reject oversized, chunked, and decompressed bodies before parsing the BotSearcher route prefix. Plugin-level limits are a secondary control, not protection against parser memory or disk exhaustion.

## Usage

Open the character import screen and select **Find cards online**, or use the slash command:

```text
/botsearch [search term]
```

The browser immediately loads the saved or default source's catalog. Enter a search term to narrow it, then open a result to review its details. Each source remembers its own sort choice.

**All sources** in the source list searches several sites at once, up to four, and interleaves the results one from each site in turn. Results are not ranked against each other: no source returns a relevance score, and the counts they do return mean different things, so any merged ordering would be invented. Each card shows which site it came from, and a card that exists on more than one of them is shown once, from whichever site is listed first.

Sort and filter controls are hidden while searching all sources. The sites share no sort vocabulary, and a filter only some of them support would silently narrow part of the list. Each source keeps the sort it was last given individually. If a site does not answer, it is named below the search bar and the other sites' results are still shown.

**Filters** opens the additional controls the selected source supports. These vary by source, because they are the filters that source's own API accepts; a source that offers none shows no Filters button rather than controls that would be ignored. Filters are cleared when you change source, since the same tag rarely means the same thing on two different sites.

| Source | Filters |
|---|---|
| Botbooru | Included tags, excluded tags, writer, character, franchise, minimum and maximum tokens, upload date range, original characters only |
| Chub | Tags, excluded tags, creator, minimum and maximum tokens |
| All other sources | None yet |

In a tag box, press Enter or type a comma to commit a tag, and Backspace on an empty box to remove the last one. Multiple tags narrow to cards carrying *all* of them.

Botbooru tag boxes also suggest matching names from its tag catalogue. Suggestions are loaded once when that source is selected, kept only for the open dialog, and are not required for manual tag entry.

Botbooru sends ordinary words to its name and description search. Its exact query syntax can be used in the main search box too: for example, `-male` excludes a tag and `writer:name` selects a writer. Exact values entered through filter controls have spaces converted to underscores.

Botbooru's public catalog is SFW-only. To search its account-visible catalog, log in under **Extensions > BotSearcher > BotBooru account**, enable **Allow NSFW results**, then turn off **SFW only** in the browser. The NSFW control changes the BotBooru account preference on every device using that account. BotSearcher does not change the account's NSFL settings; when NSFL is active, non-SFW searches may include NSFL content and the settings panel says so.

Results update shortly after you stop typing, from three characters onward; pressing Enter or the search button skips the wait. Repeating a search you already ran — clearing a filter, switching back to a source you were just looking at — is answered from memory rather than by asking the site again. That memory lasts five minutes and is discarded when the dialog closes.

Search history is off by default. If you enable it, terms are stored in SillyBunny profile settings and may be included in server backups; card names and filters are not stored. Clear saved terms under **Extensions > BotSearcher > Search history**.

Each result shows the name, creator, token count, the source's own one-line summary, the popularity figures that source reported, and up to four tags. Where the source supports tag filtering, clicking a tag adds it to the filters; on other sources the tags are shown but are not clickable. Figures a source does not report are omitted rather than shown as zero, and the labels follow that source's own meaning — Chub's download count is its star count.

The details shown before import come from the selected source. A source may omit fields or report incomplete information. For imports that the BotSearcher server downloads, the server also validates the downloaded card and reports the contents it found in those bytes.

## Screenshots

### Desktop

![BotSearcher card details on desktop](docs/screenshots/card-detail-desktop.png)

### Mobile

<img src="docs/screenshots/card-detail-mobile.png" alt="BotSearcher card details on mobile" width="390">

## Request routing and privacy

For search and detail requests, the browser contacts the BotSearcher plugin on your SillyBunny server. The server then contacts only the selected source through a fixed source adapter.

Opening BotSearcher immediately requests the selected source's default catalog, even when the search field is empty. This means opening the browser contacts that source through your SillyBunny server.

- BotSearcher does not send searches through a public relay.
- The selected source receives the search query and sees the SillyBunny server's outgoing IP address.
- If SillyBunny runs on your computer or home network, the server's public IP may be the same public IP used by your browser.
- BotSearcher does not provide a route that fetches an arbitrary URL supplied by the frontend. Each adapter defines the hosts it may contact.

### BotBooru account requests

BotBooru login is optional. The browser sends the entered username and password to the BotSearcher plugin on the SillyBunny server. The server forwards them to BotBooru's fixed login endpoint, discards the password, verifies the returned bearer, and keeps that bearer only in server-process memory for the current SillyBunny profile. It is not saved to profile settings, disk, backups, URLs, browser storage, or logs.

Use HTTPS when the browser connects to a remote SillyBunny server. Without it, the password is not protected on that hop. The SillyBunny server operator and a process-level compromise can access the password while login is in progress and the full BotBooru bearer afterward.

SFW Botbooru searches and public detail requests remain anonymous. Non-SFW searches and account-visible detail requests use the bearer, so BotBooru can associate them with the account and the SillyBunny server's outgoing IP address. Account-visible thumbnails are session-checked when proxied, but the preview fetch itself is anonymous; direct thumbnail requests are also credential-free. Sessions are isolated by SillyBunny profile and disappear on logout, server restart, crash, or plugin replacement.

The NSFW switch in BotSearcher updates BotBooru's account-wide `show_nsfw` preference. BotSearcher's status also reports whether NSFL is enabled and active, but does not change either NSFL preference. Logging out removes BotSearcher's in-memory bearer; it does not revoke the token at BotBooru because BotBooru exposes no revocation endpoint.

### When a source refuses your server

Some sites accept connections from home networks but refuse them from hosting providers. A SillyBunny running on a VPS or cloud instance can receive a refusal from such a site on every request, while the same request from your own browser succeeds.

If the selected source supports it, BotSearcher can request that source from your browser instead of from the server, and sends the response back to the server to be read. This is controlled by **Request a source from this browser when the server cannot reach it**, which is off by default and requires an explicit opt-in.

| | Through SillyBunny server | From this browser |
|---|---|---|
| Who connects to the source | Your SillyBunny server | Your browser |
| Address the source sees | The server's outgoing IP address | Your browser's IP address |
| Who reads the response | The BotSearcher server | The BotSearcher server |
| Thumbnails for that source | Follow the **Thumbnails** setting | Load in the browser, unless **Thumbnails** is set to **No thumbnails** |

Details that apply to both:

- The URL is built by the server from the adapter's fixed base. The frontend does not construct it, re-checks it against the source's browser-direct host list, rejects redirects, and applies a time and byte limit.
- The response is read, filtered and normalized by the server in both cases. Moving the request does not change what reaches the page.
- Browser-direct API requests carry no SillyBunny cookies, credentials, or referrer.
- The browse dialog states which source has moved to this route, and why, while it is in effect.
- Turning the setting off does not make such a source work through the server. It stays in the source list and reports that the server was refused, with a **Reload** option.

Thumbnail routing depends on the **Thumbnails** setting:

| Mode | Behavior |
|---|---|
| Through SillyBunny server | The browser requests thumbnails from your SillyBunny server. The image host sees the server's outgoing IP address. |
| Direct from card site | The browser requests thumbnails from an allowed image host. That host sees the browser connection and its IP address. |
| No thumbnails | BotSearcher shows letter tiles and does not request thumbnail images. |

Opening a source-page link leaves SillyBunny and contacts that site in the browser. Importing can also make additional requests through SillyBunny's importer or the BotSearcher server, depending on the import mode.

Direct browser thumbnails can follow image-host redirects and use browser image-fetch behavior. Use **Through SillyBunny server** or **No thumbnails** when final-hop image routing or third-party cookie behavior must not leave the server.

## Sources and imports

| Source | Default | Import mode | Thumbnail notes |
|---|---:|---|---|
| Botbooru | Yes | Native | Public catalog is SFW-only; optional account login unlocks account-visible results |
| Chub | Yes | Native | Preview images |
| Pygmalion | Yes | Native | Full-size images; no preview endpoint |
| RisuRealm | Yes | Native | Full-size images; data comes from SvelteKit page data |
| Wyvern | Yes | Assembled | Resized CDN images |
| Character Tavern | Yes | Assembled | Thumbnails are unavailable through the server |
| Quillgen | No | Downloaded | Limited public catalog |

Import modes:

- **Native:** BotSearcher gives a source URL to SillyBunny's existing importer.
- **Downloaded:** The BotSearcher server downloads and validates a card file before passing it to SillyBunny's importer.
- **Assembled:** The source provides card data but no downloadable card file. The BotSearcher server builds and validates a card from that data.

Sources with tiers 0, 1, and 2 are enabled by default. Tier 3 sources are opt-in under **Extensions > BotSearcher > Sources**. Source APIs can change without notice; use `node scripts/probe-sources.mjs` to check their current status.

Botbooru native imports use its documented bare `/download/png/<id>` URL. BotSearcher never puts the bearer in an import URL.

## Card contents and import risks

Character cards are third-party documents. In addition to visible fields, a card can contain lorebook entries, alternate greetings, system prompts, post-history instructions, depth prompts, regex scripts, embedded assets, and external URLs. These fields can change model input or message processing after import.

The **Card contents** panel reports what the source says about a listing. "Not reported" means BotSearcher does not have enough information to claim that a field is present or absent.

For downloaded and assembled imports, BotSearcher first validates the actual card bytes and shows any additional contents before the separate import confirmation. Native imports use SillyBunny's importer and do not receive the same byte-derived report from BotSearcher.

Review the card description and contents before starting a chat. Structural validation confirms that downloaded data is a supported card format; it does not determine whether the card's instructions are safe or appropriate.

## Security scope

BotSearcher applies the following controls:

- Server requests are limited to hosts declared by each source adapter.
- Source records are rebuilt from an allowed set of fields and normalized before they reach the frontend.
- Untrusted source text is not parsed as HTML. The frontend writes it through text properties and uses safe properties or attributes where needed.
- Source links and native import URLs are checked against source-specific hosts before use. Browser-direct API requests use a narrower direct-fetch host list.
- BotBooru account credentials are accepted only by fixed same-origin account routes. Bearer authorization is restricted to the exact BotBooru host and is rejected across redirects.
- Card files downloaded by the BotSearcher server are size-limited and structurally validated before import.
- Card descriptions are shown as plain text, not rendered as Markdown or HTML.

These controls do not make third-party card instructions safe. They also do not hide a query from the selected source, or hide from that source the outgoing IP address of whichever component made the request — the server, or your browser when a source is being requested from it.

## Settings

| Setting | Default | Description |
|---|---|---|
| Sources | Tiers 0, 1, and 2 | Selects the sites shown in the source list. |
| Thumbnails | Through SillyBunny server | Controls whether images load through the server, directly in the browser, or not at all. |
| SFW only by default | On | Requests an SFW filter where the selected source supports one. |
| Hide AI-generated cards | Off | Requests this filter only from Botbooru, the source that supports it. |
| Blur sensitive and unrated thumbnails | On | Blurs thumbnails marked sensitive or lacking a reported rating until revealed. Rating labels remain visible when blur is off. |
| Show the Card contents panel | On | Shows content details reported by the source. The short import notice remains visible. |
| Request a source from this browser when the server cannot reach it | Off | Applies when a source refuses connections from your server. The source then sees your browser's IP address instead of the server's. With this off, such a source stays listed but cannot return results. |
| Results per page | 24 | Requests 12, 24, or 48 results at a time. |
| Save search history in SillyBunny profile settings | Off | Stores search terms for suggestions. Disable it to clear saved terms. |

The **BotBooru account** section is server state rather than a saved setting. It provides login, logout, the account-wide NSFW preference, and read-only NSFL status. The password is discarded after login and the bearer is retained only until logout or server restart.

## Troubleshooting

### Server plugin not found

Confirm that the server plugin is installed, `enableServerPlugins` is `true`, and SillyBunny has been restarted.

### Server plugin unavailable

Restart SillyBunny and check the server-plugin logs. If the plugin route exists but returns an error, the frontend cannot search until that error is fixed.

### Frontend and server are incompatible

The frontend extension and server plugin are one protocol release and must be updated together. If the server is older, use **Update server plugin and restart** or the displayed matching-tag commands. If the server is newer, update the frontend instead; BotSearcher does not offer server downgrades.

### A source is unavailable

The source stays in the list and stays selected. BotSearcher explains what happened and offers **Reload &lt;source&gt;**, which clears the server's cooldown for that source and searches again.

The cooldown is why the button exists: after a failed request the server stops contacting that site for a while and answers immediately instead, so simply searching again would not reach it. A source already in that state when you open the browser is shown as **(unavailable)** in the list and can still be selected and reloaded.

### A source works on one machine but not another

A site can accept your home connection and refuse your server's. This is common when SillyBunny runs on a VPS or cloud instance, and it usually appears as the source disappearing from the list rather than as an error.

To confirm it, run this on the machine hosting SillyBunny and compare it with the same command run at home. A `403` on one and a `200` on the other is this case:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  "https://gateway.chub.ai/search?namespace=characters&first=1&page=1&sort=default&asc=false&nsfw=false&count=false"
```

For sources that support it, BotSearcher handles this by requesting the source from your browser. See [When a source refuses your server](#when-a-source-refuses-your-server).

### SFW filtering is unavailable

Some sources do not provide a reliable SFW filter. BotSearcher disables the control for those sources rather than claiming to filter their results.

### BotBooru asks for a login

Botbooru requires an account for non-SFW results. Log in under **Extensions > BotSearcher > BotBooru account**, enable **Allow NSFW results**, then turn off **SFW only** in the browser. If the session expired or SillyBunny restarted, log in again.

If the settings panel says NSFL is active, BotSearcher honors that BotBooru account setting and non-SFW searches may include NSFL content. Change the NSFL setting on BotBooru itself if that is not wanted.

## Development

Node.js 22, 24, or 26 is supported. Runtime dependencies are installed separately from development tooling.

```bash
npm ci
npm run lint
npm test
npm run test:coverage
npm run probe
npm run probe -- chub wyvern
```

The tests use Node's built-in test runner plus jsdom for browser interaction coverage. CI runs lint, tests, and a production dependency audit on Node.js 22, 24, and 26.

The source probe contacts live external services. It exits with a nonzero status if a required source in tiers 0, 1, or 2 fails. Run it deliberately before a release.

To work on the frontend extension and server plugin from one checkout, link this directory into a SillyBunny checkout:

```bash
ln -s "$PWD" /path/to/SillyBunny/plugins/SillyBunny-BotSearcher
ln -s "$PWD" /path/to/SillyBunny/data/default-user/extensions/SillyBunny-BotSearcher
```

### Adding a source

Copy the closest adapter in `server/sources/`, then register it in `server/registry.js`. The shared adapter tests in `tests/sources.test.js` run against every registered source.

Each adapter declares `allowedHosts` for server requests and `linkHosts` for links or import URLs that the plugin does not fetch. Do not widen either list outside the adapter.

## License

BotSearcher is licensed under the GNU Affero General Public License, version 3. See [LICENSE](LICENSE).
