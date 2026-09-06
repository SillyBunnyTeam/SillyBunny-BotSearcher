# SillyBunny BotSearcher

BotSearcher adds a character-card browser to SillyBunny. It can search supported card sites, show the details each site provides, and import a selected card.

The frontend extension and server plugin are both required. Search requests go through your SillyBunny server directly to the selected source, except where a source refuses connections from your server and is requested from your browser instead. BotSearcher does not use a public relay in either case. See [Request routing and privacy](#request-routing-and-privacy).

## Requirements

- A working SillyBunny installation
- Server plugins enabled in SillyBunny
- The BotSearcher frontend extension and server plugin from this repository
- Node.js 22, 24, or 26 for the server plugin
- Playwright's Chromium browser and a usable desktop/display on the SillyBunny host for the JannyAI browser bridge (optional)
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
# Optional: install the browser used by JannyAI's Cloudflare-aware importer.
npm --prefix plugins/SillyBunny-BotSearcher exec -- playwright install chromium
```

The JannyAI bridge is headful by design: Cloudflare clearance is kept in a
persistent profile and a real browser window must be able to start on the
SillyBunny host. On a Linux host without a desktop session, configure a
display service or use the manual card-file fallback. Set
`SBBS_JANNY_PROFILE_DIR` if the default profile location is not suitable.
By default it is `.sillybunny-janny-profile` inside the server-plugin directory
so the host updater preserves it with the plugin.

Adjust the frontend extension path for the SillyBunny user you run. If you use the extension manager or plugin installer initially, immediately check out the same verified release in both resulting directories and install the server package's production dependencies as above.

Set these values in `config.yaml`:

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

Restart SillyBunny after installing or updating either component. If JannyAI settings recovery is pending, complete it before stopping or restarting the server; see [JannyAI settings recovery](#jannyai-settings-recovery).

`enableServerPluginsAutoUpdate` controls the legacy mutable-branch updater. It defaults to `true`, which runs `git pull` for each unpinned plugin when SillyBunny starts. Setting it to `false` prevents that path from changing BotSearcher. BotSearcher's manifest disables frontend auto-update too; keep both checkouts on the same verified release.

## Updating the server plugin

BotSearcher shows the active server-plugin version in **Extensions > BotSearcher**. When the server is older than the frontend, a SillyBunny 1.7.0-or-newer build exposing `/api/server-admin/server-plugins/capabilities` offers **Update server plugin and restart** to administrators.

After installing a SillyBunny release that introduces this updater, stop and start the top-level launcher or service once. An ordinary in-app restart cannot add the updater protocol to a supervisor process that was already running older host code.

The host-owned updater accepts only BotSearcher's installed directory and the frontend's exact `vX.Y.Z` release. It verifies no tracked Git changes and a matching repository, installs locked production dependencies with lifecycle scripts disabled, preserves `.cursor-key` and the Janny browser profile, replaces the plugin only after graceful shutdown, and keeps the old directory as a rollback backup. It will not install a missing plugin, downgrade a newer server, or replace symlinked development checkouts. Other untracked state is not copied into the active release; it remains in the rollback backup.

Older SillyBunny versions and non-admin users can use the guided fallback below only when the installed server is a stable older release. Do not use it to override an automatic updater refusal. Resolve dirty, wrong-remote, downgrade, or externally managed installations through their owner or deployment process instead.

Stop SillyBunny completely, then run the complete block in Git Bash (including on Windows). It stops unless the plugin directory is the canonical Git checkout root, the official remote matches with or without its `.git` suffix, tracked status is clean, and the installed version is a stable release older than `RELEASE`. If checkout or dependency installation fails, it attempts to restore the prior commit and dependencies:

```bash
set -eu
PLUGIN=plugins/SillyBunny-BotSearcher
RELEASE=v0.8.0
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

The card inspection routes accept a raw body up to the card size limit. Include them when sizing that boundary.

## Usage

Open the character import screen and select **Find cards online**, or use the slash command:

```text
/botsearch [search term]
```

The browser immediately loads the saved or default source's catalogue. Enter a search term to narrow it, then open a result to review its details. Each source remembers its own sort choice.

**All sources** in the source list searches every enabled site at once, up to eight, and interleaves the results one from each site in turn. Results are not ranked against each other: no source returns a relevance score, and the counts they do return mean different things, so any merged ordering would be invented. Each card shows which site it came from, and a card that exists on more than one of them is shown once, from whichever site is listed first.

Source-specific sort and filter controls are hidden while searching all sources. The sites share no sort vocabulary, and a filter only some of them support would silently narrow part of the list. Each source keeps the sort it was last given individually. If a site does not answer, it is named below the search bar and the other sites' results are still shown. Retry that source separately without discarding the results from sites that answered.

**Filters** opens the additional controls the selected source supports. These vary by source, because they are the filters that source's own API accepts; a source that offers none shows no Filters button rather than controls that would be ignored. Filters are cleared when you change source, since the same tag rarely means the same thing on two different sites.

| Source | Filters |
|---|---|
| Botbooru | Included tags, excluded tags, writer, character, franchise, minimum and maximum tokens, upload date range, original characters only |
| Chub | Tags, excluded tags, creator, minimum and maximum tokens |
| All other sources | None yet |

In a tag box, press Enter or type a comma to commit a tag, and Backspace on an empty box to remove the last one. Multiple tags narrow to cards carrying *all* of them.

Botbooru tag boxes also suggest matching names from its tag catalogue. Suggestions are loaded once when that source is selected, kept only for the open dialog, and are not required for manual tag entry.

Botbooru sends ordinary words to its name and description search. Its exact query syntax can be used in the main search box too: for example, `-male` excludes a tag and `writer:name` selects a writer. Exact values entered through filter controls have spaces converted to underscores.

Botbooru's public catalogue is SFW-only. To search its account-visible catalogue, log in under **Extensions > BotSearcher > BotBooru account**, enable **Allow NSFW results**, then turn off **SFW only** in the browser. The NSFW control changes the BotBooru account preference on every device using that account. BotSearcher does not change the account's NSFL settings; when NSFL is active, non-SFW searches may include NSFL content and the settings panel says so.

Results update shortly after you stop typing, from three characters onward; pressing Enter or the search button skips the wait. Repeating a recent search uses results held in memory for five minutes, until the dialog closes. **Refresh results** requests the current search again instead of using those saved results.

Search history is off by default. If you enable it, up to 20 submitted search terms are stored in SillyBunny profile settings and may be included in server backups; card names and filters are not stored. Clear saved terms under **Extensions > BotSearcher > Search history**, or turn history off to delete them.

**Named searches** have a separate, explicit opt-in. Enabling search history does not enable named searches. A named search stores its name, query, source, supported filters, sort choices and content restrictions in your profile settings, with a maximum of 20 entries. Saving an existing name replaces it without regard to letter case. Names, queries and filter values may be sensitive and may appear in profile backups; card URLs, account credentials and card contents are not saved. Delete individual searches or clear the list; turning named-search saving off deletes all its records.

Each result shows the name, creator, token count, the source's own one-line summary, the popularity figures that source reported, and up to four tags. Where the source supports tag filtering, clicking a tag adds it to the filters; on other sources the tags are shown but are not clickable. Figures a source does not report are omitted rather than shown as zero, and the labels follow that source's own meaning. Chub's download count is its star count.

**Select cards** above the results switches the grid into a selection mode: clicking a card marks it instead of opening it, **Select all** marks every loaded card, and **Import selected** imports the marked cards one after another on a single screen. See [Importing several cards at once](#importing-several-cards-at-once).

The **Shortlist** keeps cards across searches within the open browse dialog, separately from the current selection. Review it for import or clear it when finished. It is session-only: closing the dialog discards it, and it is not saved in profile settings.

The dialog can be worked from the keyboard. Arrow keys move between result cards, Home and End jump to the first and last, and Down from the last row lands on **Load more**. Enter opens the focused card (or marks it, in selection mode). `/` puts the cursor back in the search box from anywhere in the results. Esc steps back: out of a card, out of the review screen, out of selection mode, and finally out of the dialog.

The details shown before import come from the selected source. A source may omit fields or report incomplete information. JannyAI's public index has no reliable per-card detail endpoint, so its detail pane uses the cropped description and metadata from the search listing. For imports that the BotSearcher server downloads, the server also validates the downloaded card and reports the contents it found in those bytes.

### URL imports

Paste a **Saucepan.ai** or **JannyAI/JanitorAI** character URL straight into
the search box and press Enter. The dialog recognises the address, states which
source will fetch it, and opens the same review and exact/clean import screen
as every other card. A URL whose source is switched off, or that no source
supports, gets a message saying so instead of a search. Pasted URLs are never
stored in the search history.

Saucepan.ai requires a handle/password login or bearer token, either under
**Extensions > BotSearcher > Saucepan.ai account** or in the login form the
review screen shows when a login is missing. It is an import backend, not a
searchable catalogue in BotSearcher.

JannyAI imports try SillyBunny's own downloader first, which needs no setup.
When that download is blocked (commonly by Cloudflare on hosted servers) the
import falls back to the browser bridge: a persistent Playwright session on the
server host. Only SillyBunny administrators can use this shared session. Log in
to JanitorAI and complete any Cloudflare check in that window before importing.
Public cards are read directly. Private cards use the JAR-style
browser chat capture when JanitorAI exposes the assembled definition; if that
capture fails, download the card manually and use **Inspect a card file**.

## Screenshots

### Desktop

![BotSearcher card details on desktop](docs/screenshots/card-detail-desktop.png)

### Mobile

<img src="docs/screenshots/card-detail-mobile.png" alt="BotSearcher card details on mobile" width="390">

## Request routing and privacy

For search and detail requests, the browser contacts the BotSearcher plugin on your SillyBunny server. The server then contacts only the selected source through a fixed source adapter.

Opening BotSearcher immediately requests the selected source's default catalogue, even when the search field is empty. This means opening the browser contacts that source through your SillyBunny server.

- BotSearcher does not send searches through a public relay.
- The selected source receives the search query and sees the SillyBunny server's outgoing IP address.
- If SillyBunny runs on your computer or home network, the server's public IP may be the same public IP used by your browser.
- BotSearcher does not provide a route that fetches an arbitrary URL supplied by the frontend. Each adapter defines the hosts it may contact.

### BotBooru account requests

BotBooru login is optional. The browser sends the entered username and password to the BotSearcher plugin on the SillyBunny server. The server forwards them to BotBooru's fixed login endpoint, discards the password, verifies the returned bearer, and keeps that bearer only in server-process memory for the current SillyBunny profile. It is not saved to profile settings, disk, backups, URLs, browser storage, or logs.

Use HTTPS when the browser connects to a remote SillyBunny server. Without it, the password is not protected on that hop. The SillyBunny server operator and a process-level compromise can access the password while login is in progress and the full BotBooru bearer afterward.

SFW Botbooru searches and public detail requests remain anonymous. Non-SFW searches and account-visible detail requests use the bearer, so BotBooru can associate them with the account and the SillyBunny server's outgoing IP address. Account-visible thumbnails are session-checked when proxied, but the preview fetch itself is anonymous; direct thumbnail requests are also credential-free. Sessions are isolated by SillyBunny profile and disappear on logout, server restart, crash, or plugin replacement.

The NSFW switch in BotSearcher updates BotBooru's account-wide `show_nsfw` preference. BotSearcher's status also reports whether NSFL is enabled and active, but does not change either NSFL preference. Logging out removes BotSearcher's in-memory bearer; it does not revoke the token at BotBooru because BotBooru exposes no revocation endpoint.

### JannyAI search requests

JannyAI search uses the read-only public search key published by JannyAI's own web clients. BotSearcher keeps that value server-side and sends it only for an exact `POST` to `search.jannyai.com/multi-search`; it is not accepted from the browser, sent to other paths, or replayed across redirects. The request uses no relay and does not forge an `Origin` or `Referer` header. If JannyAI rotates the public key, the adapter must be updated before searches work again.

### Saucepan and JannyAI URL imports

Saucepan credentials are sent only to Saucepan's fixed sign-in endpoint. A
bearer supplied by login or the token field stays in server-process memory,
scoped to the current SillyBunny profile, and is not written to extension
settings, URLs, or logs. Saucepan's fragment proof and ordering are checked
before the card is assembled.

The JannyAI bridge launches a persistent, visible browser profile on the
SillyBunny host. This session is shared, not isolated by SillyBunny profile;
browser status, login, logout and bridge imports require a SillyBunny
administrator. Cookies and Cloudflare clearance stay in the host's browser
profile. The frontend receives validated card bytes, not browser credentials.
Private-card capture creates a temporary chat and attempts to delete it after
capture. It also temporarily changes JanitorAI API and generation settings,
then attempts to restore them. Failed restoration blocks further private
capture and logout until recovery succeeds. The recovery copy stays only in
server memory, not in the persistent browser profile. See
[JannyAI settings recovery](#jannyai-settings-recovery) before restarting.

The bridge accepts only JannyAI/JanitorAI character URLs. Saucepan companion
URLs use a separate account route; neither route is a general URL proxy.

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
- The response is read, filtered and normalised by the server in both cases. Moving the request does not change what reaches the page.
- Browser-direct API requests carry no SillyBunny cookies, credentials, or referrer.
- The browse dialog states which source has moved to this route, and why, while it is in effect.
- Turning the setting off does not make such a source work through the server. It stays in the source list and reports that the server was refused, with a **Reload** option.

Thumbnail routing depends on the **Thumbnails** setting:

| Mode | Behaviour |
|---|---|
| Through SillyBunny server | The browser requests thumbnails from your SillyBunny server. The image host sees the server's outgoing IP address. |
| Direct from card site | The browser requests thumbnails from an allowed image host. That host sees the browser connection and its IP address. |
| No thumbnails | BotSearcher shows letter tiles and does not request thumbnail images. |

Opening a source-page link leaves SillyBunny and contacts that site in the browser. Opening the intake screen fetches the card, through SillyBunny's importer or the BotSearcher server depending on the import mode, so reviewing a card contacts its source even if you then decide not to import it.

Direct browser thumbnails can follow image-host redirects and use browser image-fetch behaviour. Use **Through SillyBunny server** or **No thumbnails** when final-hop image routing or third-party cookie behaviour must not leave the server.

## Sources and imports

| Source | Default | Import mode | Thumbnail notes |
|---|---:|---|---|
| Botbooru | Yes | Native | Public catalogue is SFW-only; optional account login unlocks account-visible results |
| Chub | Yes | Native | Preview images |
| Pygmalion | Yes | Native | Full-size images; no preview endpoint |
| RisuRealm | Yes | Native | Full-size images; data comes from SvelteKit page data |
| JannyAI | Yes | Native | Preview images; listing metadata only |
| Saucepan.ai | No | URL assembled | Requires a Saucepan account or bearer token |
| Wyvern | Yes | Assembled | Resized CDN images |
| Character Tavern | Yes | Assembled | Thumbnails are unavailable through the server |
| Quillgen | No | Downloaded | Limited public catalogue |

Import modes describe where the card file comes from. All three are reported on by the intake screen before anything is imported.

- **Native:** SillyBunny's existing downloader fetches the card from a source URL and returns it to the browser. BotSearcher makes no request to the source.
- **Downloaded:** The BotSearcher server downloads and validates a card file.
- **Assembled:** The source provides card data but no downloadable card file. The BotSearcher server builds and validates a card from that data.

Sources with tiers 0, 1, and 2 are enabled by default. Tier 3 sources are opt-in under **Extensions > BotSearcher > Sources**. Source APIs can change without notice; use `node scripts/probe-sources.mjs` to check their current status.

Botbooru native imports use its documented bare `/download/png/<id>` URL. BotSearcher never puts the bearer in an import URL.

JannyAI native imports are delegated to SillyBunny's existing Janny downloader through a JanitorAI-hosted URL containing the card UUID. The downloader may still be blocked by Cloudflare, especially when SillyBunny runs on a hosted or data-centre IP address.

## Card intake

Character cards are third-party documents. In addition to visible fields, a card can contain lorebook entries, alternate greetings, system prompts, post-history instructions, depth prompts, regex scripts, macros, HTML, embedded assets, and external URLs. These fields can change model input or message processing after import.

Every import goes through the intake screen first. **Review and import** on a card's details opens it, and nothing is added to your collection until you choose an import there.

The screen reports what is in the card's own bytes, not what the listing claimed:

- The name, creator and card version recorded in the card. Where the card's creator differs from the one the listing advertised, both are shown.
- Card format, file size and SHA-256 hash.
- Whether characters of that name are already in your collection, and which fields differ from the installed copy you select.
- **Token cost**, measured with SillyBunny's own tokeniser, split by when each part is actually in context: what is there for every request, the opening message, the example messages, and the embedded lorebook. Always-on lorebook entries are counted separately from the ceiling the keyword entries could reach.
- **Behaviour:** regex scripts, system prompt, post-history instructions, depth prompt, macros, HTML, embedded scripts or iframes, and extension data SillyBunny does not recognise.
- **Contents:** lorebook entries, alternate greetings, embedded assets, tags, and the hosts of any external URLs.
- **Worth checking:** details that look personal rather than intended for publication, including email addresses, API keys, access tokens, file paths containing a user name, and Discord invites. These are reported by category and location with the value redacted. Fields that are the wrong type or outside the card format are also reported.

Counts and flags are reported. Lorebook text, script bodies and macro arguments are the card's own content and are not reproduced on the screen.

Inspection has limits on how much text and nested data it checks. A report states whether inspection completed and records the reasons when it did not. An incomplete or unreported check means some contents are unknown, not absent; reported counts are not an all-clear. Such cards require review, cannot be automatically imported by a batch, and cannot use **Clean import**. You can still explicitly choose an exact import after reviewing the warning.

Measuring the token cost needs the text itself, since only SillyBunny's tokeniser can produce a number that matches the rest of the app. The card's text, including its lorebook, is sent from the plugin to your browser, counted there, and discarded. It is not displayed on the page.

### Where the bytes come from

BotSearcher does not download native-source cards itself. It asks SillyBunny to download the card and hand the bytes back, then inspects those. The card you are shown is therefore the card that would be imported, the fork's own per-site downloaders still do the downloading, and no additional request is made to the source.

If SillyBunny cannot download the card because a source refuses your server or presents a Cloudflare challenge, the screen says the card was not inspected and offers the ordinary unscanned import as an explicit choice. An empty report is not presented as an all-clear.

### Inspecting a card file

**Inspect a card file** is a separate control in the browse dialog, outside **Filters**. It opens a PNG or JSON card from your own machine, and dropping a card file onto the dialog does the same. Cards obtained anywhere else can be reported on and imported through the same screen. Dropping a card onto the BotSearcher dialog inspects it instead of importing it; SillyBunny's usual drag-and-drop import is unaffected everywhere else.

### Exact and clean import

**Import exactly** imports the card as downloaded.

**Clean import** removes the parts that act on their own and states what it will remove from that particular card before you choose it:

| | |
|---|---|
| Removed | Regex scripts, extension blocks SillyBunny does not read, fields outside the card format, and personal details (replaced in place) |
| Kept | Lorebook, alternate greetings, system prompt, post-history instructions, depth prompt, HTML formatting, external URLs |

HTML and external URLs are reported but not removed, because they are frequently the author's own formatting and artwork.

A cleaned PNG is spliced, not re-encoded: only the text chunks carrying card data are rebuilt, and the image itself is copied through unchanged. Where a card carries both a `chara` and a `ccv3` chunk, both are rewritten, so no uncleaned copy is left behind in the one your reader does not use.

Clean import is refused if the cleaner cannot finish within its processing limits. It does not return a partly cleaned file as a successful result.

When a card name matches your collection, choose **Add a new copy** or **Replace an installed copy**. If several installed cards share the name, select the exact installed file to compare and replace; BotSearcher does not silently choose the first match. Replacement is unavailable if that file cannot be verified. A replacement overwrites the selected copy, keeps its chats and has no Undo.

### Import confirmation and Undo

BotSearcher uses the host's import receipt, which identifies the installed filename, to confirm a write. A failed character-list refresh does not turn a confirmed import into a failed one. If the response is lost or does not identify a valid destination, the result is unconfirmed: check your collection before trying again. BotSearcher does not automatically retry an unconfirmed write or offer Undo for it.

After a confirmed addition, **Undo import** removes only the verified new file and leaves chats alone. Undo requires a successful collection check before import and a readable installed PNG afterwards. BotSearcher records a SHA-256 fingerprint of that file, including its portrait, and compares it again before deletion. If the file changed or cannot be checked, Undo refuses to remove it. Replacements use the same file-revision check before writing.

These checks detect changes made before the final check. They do not close the remaining race between checking and writing or deleting: another tab or process can still change the file in that interval. The host does not provide a conditional write or deletion tied to the checked revision. Avoid editing a character elsewhere while replacing it or undoing its import. Imports, replacements and Undo are also refused while a reply is being generated.

Review the card description and contents before starting a chat. Structural validation confirms that data is a supported card format; it does not determine whether the card's instructions are safe or appropriate.

### Importing without the review

**Import without the review screen** under **Extensions > BotSearcher** skips review when the card has a complete inspection and no same-name match in a successfully checked collection. The card's button then reads **Import**, and a pasted URL imports on Enter. Same-name matches, an unavailable collection check or incomplete inspection still open the review. **Inspect a card file** always opens review. The confirmation offers **Open character** and, when the installed file can be verified, **Undo import**.

### Importing several cards at once

**Import selected** lists the queued cards and exact-import policy before **Start import**. Each card is fetched, validated, inspected and checked against the collection before writing. Same-name matches, unavailable collection checks and incomplete inspections wait for **Review card**, where you can make an individual decision or choose clean import when available. A damaged file is refused. Download rate limits display the wait before retrying.

**Stop after current card** lets the current card finish and leaves the batch screen open. Its results, import receipts and available Undo actions remain there. **Continue remaining** processes cards not yet started; **Retry failed cards** retries failures without re-importing confirmed successes. Unconfirmed writes require a collection check rather than an automatic retry. Reviewing an individual row and returning to the batch retains its outcome and Undo eligibility.

Batch Undo removes only confirmed additions whose installed files still match their recorded revisions. Replacements, skipped cards and unconfirmed writes are not included. If one file changed or a deletion fails, the batch reports it and keeps the other outcomes. Batch state is held only for that screen; it is not a persistent import log.

### Source-reported contents

The **Card contents** panel on the details pane is separate, and reports what the *source* says about a listing before anything is downloaded. 'Not reported' means BotSearcher does not have enough information to claim that a field is present or absent.

## Security scope

BotSearcher applies the following controls:

- Server requests are limited to hosts declared by each source adapter.
- Source records are rebuilt from an allowed set of fields and normalised before they reach the frontend.
- Untrusted source text is not parsed as HTML. The frontend writes it through text properties and uses safe properties or attributes where needed.
- Source links and native import URLs are checked against source-specific hosts before use. Browser-direct API requests use a narrower direct-fetch host list.
- BotBooru account credentials are accepted only by fixed same-origin account routes. Bearer authorisation is restricted to the exact BotBooru host and is rejected across redirects.
- Card files downloaded by the BotSearcher server are size-limited and structurally validated before import.
- Card bytes sent for inspection are size-limited as they arrive, structurally validated, and answered with a description only. The inspection route returns nothing that can be imported and makes no outbound request.
- Card descriptions are shown as plain text, not rendered as Markdown or HTML.

These controls do not make third-party card instructions safe. They also do not hide a query from the selected source, or hide the outgoing IP address of the server or browser that made the request.

## Settings

| Setting | Default | Description |
|---|---|---|
| Sources | Tiers 0, 1, and 2 | Selects the sites shown in the source list. |
| Thumbnails | Through SillyBunny server | Controls whether images load through the server, directly in the browser, or not at all. |
| SFW only by default | On | Requests an SFW filter where the selected source supports one. |
| Hide AI-generated cards | Off | Requests this filter only from Botbooru, the source that supports it. |
| Blur sensitive and unrated thumbnails | On | Blurs thumbnails marked sensitive or lacking a reported rating until revealed. Rating labels remain visible when blur is off. |
| Show the Card contents panel | On | Shows the source-reported content details on the details pane. The intake screen is not affected by this setting; it reports on every import. |
| Import without the review screen | Off | Skips review only after a complete inspection and a successful collection check with no same-name match. |
| Request a source from this browser when the server cannot reach it | Off | Applies when a source refuses connections from your server. The source then sees your browser's IP address instead of the server's. With this off, such a source stays listed but cannot return results. |
| Results per page | 24 | Requests 12, 24, or 48 results at a time. |
| Save search history in SillyBunny profile settings | Off | Stores up to 20 search terms for suggestions. Disable it to clear saved terms. |
| Save named searches in SillyBunny profile settings | Off | Separately stores up to 20 named searches with their query choices. Disable it to delete all named searches. |

The **BotBooru account** section is server state rather than a saved setting. It provides login, logout, the account-wide NSFW preference, and read-only NSFL status. The password is discarded after login and the bearer is retained only until logout or server restart.

## Troubleshooting

### Server plugin not found

Confirm that the server plugin is installed, `enableServerPlugins` is `true`, and SillyBunny has been restarted.

### Server plugin unavailable

Check the server-plugin logs. If the plugin route exists but returns an error, the frontend cannot search until that error is fixed. Restart SillyBunny if needed, but resolve any pending JannyAI settings recovery first; a restart loses its in-memory recovery copy.

### The server-plugin Git remote does not match its declared repository

The updater compares the plugin checkout's `origin` against the repository declared in its `package.json`, and refuses to replace a checkout that came from somewhere else.

This repository moved to the `SillyBunnyTeam` organisation. A checkout cloned from the earlier `platberlitz/SillyBunny-BotSearcher` address still works for ordinary Git operations, because GitHub redirects the old location silently, so the mismatch stays invisible until the updater checks it. The guided fallback below refuses the same checkout, with a bare `test` failure rather than a message.

Confirm what the checkout points at:

```bash
git -C plugins/SillyBunny-BotSearcher remote get-url origin
```

If that is anything other than the address below, point it at the current one and try the update again:

```bash
git -C plugins/SillyBunny-BotSearcher remote set-url origin https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher.git
```

Do the same for the frontend extension's checkout, which is a separate clone with its own remote.

Change only the remote. If the checkout also has tracked local changes, or is a symlink to a development checkout, resolve those separately; the updater reports each refusal distinctly.

### Frontend and server are incompatible

The frontend extension and server plugin are one protocol release and must be updated together. If the server is older, use **Update server plugin and restart** or the displayed matching-tag commands. If the server is newer, update the frontend instead; BotSearcher does not offer server downgrades.

Protocol 8 adds the inspection coverage contract, `inside.scan = { complete, reasons }`, and changes the merged-search cursor format. Both components must use protocol 8; older cursors cannot be continued, so start the search again after updating. This protocol change does not change the `0.8.0` release version or create a release tag. If both components show the same release number but different protocols, install both from the same verified commit.

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

If the settings panel says NSFL is active, BotSearcher honours that BotBooru account setting and non-SFW searches may include NSFL content. Change the NSFL setting on BotBooru itself if that is not wanted.

### JannyAI settings recovery

Use **Extensions > BotSearcher > JannyAI browser import** as a SillyBunny administrator. A browser request failure (`janny_browser_request_failed`) is not proof that login or logout succeeded. Check the host's browser window for a login or Cloudflare check, then choose **Refresh status**.

If settings restoration failed (`janny_restore_failed`), the warning remains even when the account is logged in. **Refresh status** retries restoring the saved JanitorAI API and generation settings. If the browser window closed, choose **Open JannyAI login window**, sign in to the same JanitorAI account, complete any Cloudflare check, then refresh status again. Do not switch accounts during recovery.

Do not restart or replace the SillyBunny server process until recovery succeeds. The recovery copy is memory-only; persistent browser cookies do not preserve it. If a crash or forced restart loses that copy, manually restore the API and generation settings on JanitorAI itself before another private import. A later status check cannot recover a copy that was lost with the old server process. Successful logout clears the browser session and reports that you are signed out; a failed logout keeps the warning and does not claim success.

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
