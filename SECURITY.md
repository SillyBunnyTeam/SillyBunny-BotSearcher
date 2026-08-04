# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Report it through the repository's [private security advisory form](https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher/security/advisories/new) with reproduction steps, impact, and affected version or commit.

Reports are acknowledged as soon as practical. Please allow time for a fix and coordinated disclosure before publishing details.

## Supported versions

Security fixes are made on the latest released version and the default branch. Deployments should use a verified immutable release tag or commit for both the frontend extension and server plugin.

BotSearcher's automatic server-plugin update requires SillyBunny's admin-only exact-release updater. It accepts no repository URL or Git ref from the browser, rejects dirty or externally managed checkouts, installs dependencies with lifecycle scripts disabled, and preserves only release-declared runtime paths. Hosts without that capability fall back to visible manual commands.

## BotBooru accounts

BotBooru login is optional and is used only for account-visible results. The password passes from the browser to the SillyBunny server and then to BotBooru during login; it is never retained. Remote SillyBunny deployments must use HTTPS so that password is protected on the browser-to-server hop.

The BotBooru bearer is a full account token, not a BotSearcher-scoped credential. BotSearcher keeps it in server-process memory, isolated by SillyBunny profile, and never writes it to settings, disk, backups, URLs, logs, or browser storage. It disappears on logout, restart, crash, or plugin replacement. JavaScript strings cannot be reliably erased from process memory, and a compromised or untrusted SillyBunny server operator can access credentials while they are processed.

Authenticated searches are visible to BotBooru as activity from that account and the SillyBunny server's outgoing IP address. The NSFW control changes the BotBooru account preference across devices. BotSearcher reports and honors the account's NSFL state without silently changing it. Logout deletes BotSearcher's local bearer reference; BotBooru exposes no upstream token-revocation operation, so logout does not revoke the token there.
