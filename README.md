# SillyBunny-BotSearcher

lorum ipsum

## Installing

Two halves, both from this repo.

**Frontend extension** — in SillyBunny: Extensions ▸ Install extension, paste:

```
https://github.com/platberlitz/SillyBunny-BotSearcher
```

**Server plugin** — from your SillyBunny directory:

```bash
bun plugins.js install https://github.com/platberlitz/SillyBunny-BotSearcher
```

Then in `config.yaml`:

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false
```

Restart SillyBunny. `enableServerPluginsAutoUpdate` defaults to `true`, which means every start does a `git pull` on each plugin and then runs the result. Setting it to `false` is recommended: update deliberately, and read the diff first.

Both halves are needed. The extension alone opens to install instructions.

## Why there is a server half

lorum ipsum

## Sources

| Source | Tier | Import | Thumbnails | Notes |
|---|---|---|---|---|
| Botbooru | 0 | native | yes (320/640 previews) | |
| Chub | 1 | native | yes | |
| Pygmalion | 1 | native | full-size (~1.3 MB each) | no preview endpoint |
| RisuRealm | 1 | native | full-size (~1.4 MB each) | data comes from SvelteKit page data; fragile by nature |
| Wyvern | 2 | assembled | yes (CDN resize) | no downloadable card file |
| Character Tavern | 2 | assembled | none | image CDN returns 403 to non-browser requests |
| Quillgen | 3 | download | full-size | **off by default**: public API returns 1 card total |

"native" means SillyBunny's own importer does the download. "download" means this plugin fetches and validates a card file. "assembled" means the site publishes card data but no file, so the card is built from it and validated the same way.

Tier 0–2 are on by default. Tier 3 is opt-in, in the extension settings.

### Not included, and why

| Source | Reason |
|---|---|
| JanitorAI | Search needs a bearer token lifted from their frontend plus forged `Origin` and `Referer` headers. This project does not store credentials and does not forge headers to get past a site's own access control. |
| Xoul | Works, but its images are full-size animated GIFs — one measured 19 MB — with no resize support. |
| bot3, PolyBuzz | CleanBotBrowser reaches these only through `r.jina.ai`, a third-party relay. Excluded by the same rule as any other relay. |
| Saucepan | `api.saucepan.ai` no longer resolves. |
| Sakura.fm | Its documented endpoint returns 404. |
| CAIBotList | Cloudflare bot wall. Evading it is an arms race. |
| Harpy.chat | Disabled in CleanBotBrowser's own source; needs an external Supabase project and key. |

Checked 2026-08-03. Re-run `node scripts/probe-sources.mjs` to see the current state.

## Security

lorum ipsum

### What is actually guaranteed

- No third party ever sees a search. There is no CORS relay anywhere in this project.
- No URL supplied by the browser is ever fetched by the server. The client names a *source*; the server owns every address.
- Text from a card site can never become HTML, an attribute, or a URL. It is rebuilt field by field against a whitelist on the server and written with `textContent` in the browser.
- Downloaded card bytes are structurally validated before they reach the character importer.
- In the default thumbnail mode, a browse session makes no request to any address other than your own server.

### What is not, and cannot be

lorum ipsum

A character card is a document written by a stranger. Cards carry lorebooks that fire on ordinary words, prompts that override your own, and regex scripts that rewrite messages in flight. The format exists to be partly executed. No browser extension makes that safe.

What this does instead is show you what a card contains — lorebook entries, prompt overrides, regex scripts, images that load from other sites — before you import it, and again afterwards if the card turned out to hold something its listing never mentioned.

## Settings

| Setting | Default | |
|---|---|---|
| Sources | tier 0–2 | which sites appear in the picker |
| Thumbnails | through your own server | `direct` is faster but shows the site your IP address; `off` uses letter tiles |
| SFW only by default | on | only applied where a source can really filter; the toggle is disabled where it cannot |
| Blur adult thumbnails | on | |
| "What's inside this card" panel | on | the one-line note below Import cannot be turned off |
| Results per page | 24 | |

## Development

```bash
npm test                          # no dependencies; uses node --test
node scripts/probe-sources.mjs    # check every source against the live sites
node scripts/probe-sources.mjs chub wyvern
```

The prober exits non-zero if a tier 0–2 source is broken. Run it before a release: these APIs change without notice.

To work on both halves at once, symlink this directory into a SillyBunny checkout:

```bash
ln -s "$PWD" /path/to/SillyBunny/plugins/SillyBunny-BotSearcher
ln -s "$PWD" /path/to/SillyBunny/data/default-user/extensions/SillyBunny-BotSearcher
```

### Adding a source

Copy the closest existing adapter in `server/sources/` and add it to `server/registry.js`. The tests in `tests/sources.test.js` apply to every adapter automatically and will tell you what is missing.

An adapter declares which hosts it may contact (`allowedHosts`) separately from which may merely appear in a link (`linkHosts`). Nothing else in the project may widen either.

## Licence

AGPL-3.0, matching SillyBunny.
