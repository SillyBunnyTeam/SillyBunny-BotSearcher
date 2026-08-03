# SillyBunny BotSearcher

BotSearcher adds a character-card browser to SillyBunny. It can search supported card sites, show the details each site provides, and import a selected card.

The frontend extension and server plugin are both required. Search requests go through your SillyBunny server directly to the selected source. BotSearcher does not use a public relay.

## Requirements

- A working SillyBunny installation
- Server plugins enabled in SillyBunny
- The BotSearcher frontend extension and server plugin from this repository

## Installation

Install the frontend extension from SillyBunny's extension manager. Use this repository URL:

```text
https://github.com/platberlitz/SillyBunny-BotSearcher
```

From your SillyBunny directory, install the server plugin:

```bash
bun plugins.js install https://github.com/platberlitz/SillyBunny-BotSearcher
```

Set these values in `config.yaml`:

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

Restart SillyBunny after installing or updating either component.

`enableServerPluginsAutoUpdate` controls updates for server plugins. It defaults to `true`, which runs `git pull` for each plugin when SillyBunny starts. Setting it to `false` lets you review and apply server-plugin updates yourself. The frontend extension has its own update setting.

## Usage

Open the character import screen and select **Find cards online**, or use the slash command:

```text
/botsearch [search term]
```

Choose a source, enter a search term, and open a result to review its details. An empty search shows the source's default or newest results where supported.

The details shown before import come from the selected source. A source may omit fields or report incomplete information. For imports that the BotSearcher server downloads, the server also validates the downloaded card and reports the contents it found in those bytes.

## Screenshots

### Desktop

![BotSearcher card details on desktop](docs/screenshots/card-detail-desktop.png)

### Mobile

<img src="docs/screenshots/card-detail-mobile.png" alt="BotSearcher card details on mobile" width="390">

## Request routing and privacy

For search and detail requests, the browser contacts the BotSearcher plugin on your SillyBunny server. The server then contacts only the selected source through a fixed source adapter.

- BotSearcher does not send searches through a public relay.
- The selected source receives the search query and sees the SillyBunny server's outgoing IP address.
- If SillyBunny runs on your computer or home network, the server's public IP may be the same public IP used by your browser.
- BotSearcher does not provide a route that fetches an arbitrary URL supplied by the frontend. Each adapter defines the hosts it may contact.

Thumbnail routing depends on the **Thumbnails** setting:

| Mode | Behavior |
|---|---|
| Through SillyBunny server | The browser requests thumbnails from your SillyBunny server. The image host sees the server's outgoing IP address. |
| Direct from card site | The browser requests thumbnails from an allowed image host. That host sees the browser connection and its IP address. |
| No thumbnails | BotSearcher shows letter tiles and does not request thumbnail images. |

Opening a source-page link leaves SillyBunny and contacts that site in the browser. Importing can also make additional requests through SillyBunny's importer or the BotSearcher server, depending on the import mode.

## Sources and imports

| Source | Default | Import mode | Thumbnail notes |
|---|---:|---|---|
| Botbooru | Yes | Native | 320 or 640 pixel previews |
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

## Card contents and import risks

Character cards are third-party documents. In addition to visible fields, a card can contain lorebook entries, alternate greetings, system prompts, post-history instructions, depth prompts, regex scripts, embedded assets, and external URLs. These fields can change model input or message processing after import.

The **Card contents** panel reports what the source says about a listing. "Not reported" means BotSearcher does not have enough information to claim that a field is present or absent.

For downloaded and assembled imports, BotSearcher validates the actual card bytes and reports additional contents found during import. Native imports use SillyBunny's importer and do not receive the same byte-derived report from BotSearcher.

Review the card description and contents before starting a chat. Structural validation confirms that downloaded data is a supported card format; it does not determine whether the card's instructions are safe or appropriate.

## Security scope

BotSearcher applies the following controls:

- Server requests are limited to hosts declared by each source adapter.
- Source records are rebuilt from an allowed set of fields and normalized before they reach the frontend.
- Untrusted source text is not parsed as HTML. The frontend writes it through text properties and uses safe properties or attributes where needed.
- Source links, image URLs, and native import URLs are checked against the source's allowed client hosts before use.
- Card files downloaded by the BotSearcher server are size-limited and structurally validated before import.
- Card descriptions are shown as plain text, not rendered as Markdown or HTML.

These controls do not make third-party card instructions safe. They also do not hide a query from the selected source or hide the server's outgoing IP address from that source.

## Settings

| Setting | Default | Description |
|---|---|---|
| Sources | Tiers 0, 1, and 2 | Selects the sites shown in the source list. |
| Thumbnails | Through SillyBunny server | Controls whether images load through the server, directly in the browser, or not at all. |
| SFW only by default | On | Requests an SFW filter where the selected source supports one. |
| Blur sensitive thumbnails | On | Blurs thumbnails marked as sensitive until selected. |
| Show the Card contents panel | On | Shows content details reported by the source. The short import notice remains visible. |
| Results per page | 24 | Requests 12, 24, or 48 results at a time. |

## Troubleshooting

### Server plugin not found

Confirm that the server plugin is installed, `enableServerPlugins` is `true`, and SillyBunny has been restarted.

### Server plugin unavailable

Restart SillyBunny and check the server-plugin logs. If the plugin route exists but returns an error, the frontend cannot search until that error is fixed.

### Frontend and server are incompatible

Update both components from the same release, then restart SillyBunny. Updating only the frontend extension or only the server plugin can leave their protocol versions out of sync.

### A source is unavailable

Try another source. BotSearcher temporarily removes a source from the current browser session after a failed request and lets you retry it.

### SFW filtering is unavailable

Some sources do not provide a reliable SFW filter. BotSearcher disables the control for those sources rather than claiming to filter their results.

## Development

Node.js 18 or newer is required for the test suite.

```bash
npm test
node scripts/probe-sources.mjs
node scripts/probe-sources.mjs chub wyvern
```

The tests use Node's built-in test runner. Server contract tests also import packages supplied by SillyBunny, including Express, `node-fetch`, and `rate-limiter-flexible`, so run them where those dependencies are available.

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
