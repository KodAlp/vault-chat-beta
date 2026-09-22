import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { computeReviewBlock, deriveStaleDomains } from './review-mode';
import { closeVaultStudyDb, createDeck, getDeckCards, updateCardSchedule } from './study-db';
import type { VaultContext } from './vaults';
import type { LearnerProfile, MasteryEstimate, SkillNode } from '../learner-model';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const mastery = (over: Partial<MasteryEstimate> = {}): MasteryEstimate => ({
	mastery: 0.5, count: 5, weight: 4, confidence: 'moderate', reliable: true, lastAt: daysAgo(1), ...over
});
const domainNode = (name: string, over: Partial<SkillNode> = {}): SkillNode => ({
	id: `domain:${name}`, kind: 'domain', name, quiz: mastery(), bands: null, retention: { retention: null, cards: 0, reliable: false }, ...over
});
const profile = (nodes: SkillNode[]): LearnerProfile => ({ generatedAt: NOW.toISOString(), nodes });

test('a reliable domain last answered long ago is stale, with days-since computed', () => {
	const out = deriveStaleDomains(profile([domainNode('math', { quiz: mastery({ lastAt: daysAgo(30) }) })]), 21, NOW);
	assert.deepEqual(out, [{ name: 'math', daysSince: 30 }]);
});

test('a domain answered recently, not reliable, or never answered is not stale', () => {
	const nodes = [
		domainNode('recent', { quiz: mastery({ lastAt: daysAgo(1) }) }),
		domainNode('unreliable', { quiz: mastery({ lastAt: daysAgo(30), reliable: false }) }),
		domainNode('never', { quiz: mastery({ lastAt: null }) })
	];
	assert.deepEqual(deriveStaleDomains(profile(nodes), 21, NOW), []);
});

test('only domain-kind nodes are considered', () => {
	const overall: SkillNode = { id: 'overall', kind: 'overall', name: 'overall', quiz: mastery({ lastAt: daysAgo(30) }), bands: null, retention: { retention: null, cards: 0, reliable: false } };
	assert.deepEqual(deriveStaleDomains(profile([overall]), 21, NOW), []);
});

test('stale domains sort staleest first and are capped', () => {
	const nodes = ['a', 'b', 'c', 'd'].map((name, i) => domainNode(name, { quiz: mastery({ lastAt: daysAgo(21 + (4 - i) * 10) }) }));
	const out = deriveStaleDomains(profile(nodes), 21, NOW);
	assert.equal(out.length, 3);
	assert.deepEqual(out.map((d) => d.name), ['a', 'b', 'c']);
});

/** Mirrors learner-store.test.ts's withVault helper. */
function withVault(fn: (v: VaultContext) => void, opts: { index?: Record<string, string[]> | null } = { index: {} }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-mode-'));
	const v: VaultContext = { id: `t-${Math.random().toString(36).slice(2)}`, name: 't', dir, libraryRoot: dir, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
	if (opts.index) {
		const idx = new Database(v.indexDbPath);
		idx.exec("CREATE TABLE files (path TEXT PRIMARY KEY, domains_json TEXT NOT NULL DEFAULT '[]')");
		for (const [p, d] of Object.entries(opts.index)) idx.prepare('INSERT INTO files (path, domains_json) VALUES (?, ?)').run(p, JSON.stringify(d));
		idx.close();
	}
	try {
		fn(v);
	} finally {
		closeVaultStudyDb(v.id);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * computeReviewBlock is declared async for interface consistency with computeMemoryBlock, but neither has a real
 * internal `await` — the SQLite reads run synchronously, so the returned promise is already settled by the time
 * withVault's callback returns. It's captured inside the callback (while the temp study.db is still open) and
 * awaited only after withVault has cleaned up — safe because we're unwrapping an already-resolved value, not
 * doing new work on a closed DB.
 */
test('end to end: a due card shows up in the block', async () => {
	let result!: Promise<string>;
	withVault((v) => {
		const deck = createDeck(v, 'd', {}, 'm', [{ front: 'Bir B-ağacının yüksekliği neye bağlıdır?', back: 'b', source_path: 'wiki/db/a.md', heading_path: 'A', domain: 'db', level: 'basic' }]);
		const cards = getDeckCards(v, deck);
		updateCardSchedule(v, cards[0].id, { ease: 2.5, interval_days: 1, due_at: daysAgo(0), reps: 1, lapses: 0 });
		result = computeReviewBlock(v, NOW);
	});
	assert.match(await result, /Vadesi gelen kartlar:.*B-ağacının/);
});

test('end to end: a vault with no evidence at all still resolves to the "nothing to review" line, never an empty string', async () => {
	let result!: Promise<string>;
	withVault((v) => {
		result = computeReviewBlock(v, NOW);
	});
	const out = await result;
	assert.notEqual(out, '');
	assert.match(out, /şu anda belirgin bir öncelik yok/);
});
