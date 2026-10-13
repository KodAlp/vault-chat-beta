import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { domainStats } from './domain-stats';

function db(rows: [string, number, string[]][]) {
	const d = new Database(':memory:');
	d.exec('CREATE TABLE files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, domains_json TEXT NOT NULL DEFAULT \'[]\')');
	const ins = d.prepare('INSERT INTO files (path, mtime, domains_json) VALUES (?, ?, ?)');
	for (const [p, m, doms] of rows) ins.run(p, m, JSON.stringify(doms));
	return d;
}

test('counts notes per domain (case-insensitive), multi-domain notes count under each, newest mtime wins', () => {
	const d = db([
		['wiki/a.md', 1000, ['Math']],
		['wiki/b.md', 3000, ['math', 'physics']],
		['wiki/c.md', 2000, ['physics']],
		['wiki/d.md', 500, []],
		['cards/x.md', 9000, ['math']]
	]);
	const s = domainStats(d, ['cards']);
	assert.equal(s.totalNotes, 4);
	assert.equal(s.noDomain, 1);
	assert.deepEqual(s.domains, [
		{ domain: 'Math', notes: 2, lastUpdated: new Date(3000).toISOString() },
		{ domain: 'physics', notes: 2, lastUpdated: new Date(3000).toISOString() }
	]);
});

test('empty index and malformed domains_json do not throw', () => {
	assert.deepEqual(domainStats(db([])), { domains: [], noDomain: 0, totalNotes: 0 });
	const d = db([['a.md', 1, []]]);
	d.prepare("UPDATE files SET domains_json = 'not json'").run();
	assert.equal(domainStats(d).noDomain, 1);
});
