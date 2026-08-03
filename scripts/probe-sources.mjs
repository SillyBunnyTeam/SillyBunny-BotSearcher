/**
 * Liveness prober. Run by hand, never at server start.
 *
 *   node scripts/probe-sources.mjs            # every source
 *   node scripts/probe-sources.mjs chub wyvern
 *
 * These APIs are undocumented and change without notice — several of the sites
 * CleanBotBrowser ships are already dead. This is what turns "is that source
 * still alive?" from a guess into a measurement, and its output is what decides
 * a source's tier.
 *
 * It goes through the real http.js, so a source that fails here fails in
 * production for the same reason.
 *
 * Exits non-zero if any tier 0-2 source is broken; tier 3 failures are reported
 * but tolerated, since those ship off by default.
 */

import process from 'node:process';

import { SOURCES } from '../server/registry.js';
import { contextFor } from '../server/http.js';

const SEARCH_TERM = 'elf';
const TIER_THAT_MUST_WORK = 2;

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const ids = requested.length > 0 ? requested : Object.keys(SOURCES);

const unknown = ids.filter((id) => !Object.prototype.hasOwnProperty.call(SOURCES, id));
if (unknown.length > 0) {
    console.error(`Unknown source(s): ${unknown.join(', ')}`);
    console.error(`Known: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(2);
}

/** @param {() => Promise<any>} fn */
async function timed(fn) {
    const startedAt = Date.now();
    try {
        const value = await fn();
        return { ok: true, ms: Date.now() - startedAt, value };
    } catch (error) {
        return { ok: false, ms: Date.now() - startedAt, error: error?.code ?? error?.message ?? String(error) };
    }
}

const results = [];

for (const id of ids) {
    const adapter = SOURCES[id];
    const ctx = contextFor(adapter);

    const probe = await timed(() => adapter.probe(ctx));

    const search = await timed(() => adapter.search(ctx, {
        query: SEARCH_TERM,
        offset: 0,
        limit: 3,
        sort: adapter.capabilities.sorts[0],
        sfwOnly: adapter.capabilities.sfwToggle,
        hideAi: false,
    }));

    const items = search.ok && Array.isArray(search.value?.items) ? search.value.items : [];
    const first = items[0];

    // A search that returns nothing is not necessarily broken, but a search
    // returning cards with no name means the mapping has drifted.
    const mappingOk = items.length === 0 || items.every((item) => typeof item.name === 'string' && item.name !== '');

    let detail = null;
    if (first && adapter.capabilities.detail) {
        detail = await timed(() => adapter.getDetail(ctx, first.id));
    }

    results.push({
        id,
        tier: adapter.tier,
        probe: probe.ok && probe.value === true,
        probeNote: probe.ok ? '' : probe.error,
        search: search.ok,
        searchNote: search.ok ? '' : search.error,
        items: items.length,
        total: search.ok ? search.value?.total ?? null : null,
        mappingOk,
        detail: detail === null ? null : detail.ok,
        detailNote: detail === null || detail.ok ? '' : detail.error,
        ms: probe.ms + search.ms + (detail?.ms ?? 0),
        first: first?.name ?? '',
    });
}

const mark = (value) => (value === null ? ' - ' : value ? ' ok' : 'FAIL');

console.log('');
console.log('id            tier  probe  search  detail  items  total     ms   first result');
console.log('------------  ----  -----  ------  ------  -----  -------  -----  ------------------------');
for (const r of results) {
    console.log([
        r.id.padEnd(12),
        String(r.tier).padStart(4),
        mark(r.probe).padStart(6),
        mark(r.search).padStart(7),
        mark(r.detail).padStart(7),
        String(r.items).padStart(6),
        String(r.total ?? '-').padStart(8),
        String(r.ms).padStart(6),
        `  ${r.first.slice(0, 24)}`,
    ].join(''));
}
console.log('');

for (const r of results) {
    for (const [label, note] of [['probe', r.probeNote], ['search', r.searchNote], ['detail', r.detailNote]]) {
        if (note) {
            console.log(`  ${r.id}: ${label} failed with ${note}`);
        }
    }
    if (!r.mappingOk) {
        console.log(`  ${r.id}: search returned items with no name — the field mapping has drifted`);
    }
}

const broken = results.filter((r) => r.tier <= TIER_THAT_MUST_WORK && (!r.search || r.detail === false || !r.mappingOk));

if (broken.length > 0) {
    console.log('');
    console.log(`${broken.length} source(s) at tier <= ${TIER_THAT_MUST_WORK} are broken: ${broken.map((r) => r.id).join(', ')}`);
    console.log('Either fix the adapter or move it to tier 3 so it ships off by default.');
    process.exit(1);
}

const degraded = results.filter((r) => r.tier > TIER_THAT_MUST_WORK && !r.search);
if (degraded.length > 0) {
    console.log(`Opt-in source(s) currently down (not a failure): ${degraded.map((r) => r.id).join(', ')}`);
}

console.log('All required sources responded.');
