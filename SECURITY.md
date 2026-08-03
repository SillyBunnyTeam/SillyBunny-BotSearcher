# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Report it through the repository's [private security advisory form](https://github.com/platberlitz/SillyBunny-BotSearcher/security/advisories/new) with reproduction steps, impact, and affected version or commit.

Reports are acknowledged as soon as practical. Please allow time for a fix and coordinated disclosure before publishing details.

## Supported versions

Security fixes are made on the latest released version and the default branch. Deployments should use a verified immutable release tag or commit for both the frontend extension and server plugin.

BotSearcher's automatic server-plugin update requires SillyBunny's admin-only exact-release updater. It accepts no repository URL or Git ref from the browser, rejects dirty or externally managed checkouts, installs dependencies with lifecycle scripts disabled, and preserves only release-declared runtime paths. Hosts without that capability fall back to visible manual commands.
