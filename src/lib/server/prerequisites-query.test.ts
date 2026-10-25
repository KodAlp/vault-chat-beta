import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
	findPrerequisiteCycles,
	getPrerequisiteChain,
	getPrerequisites,
	hasPrerequisitesColumn,
	loadPrerequisiteGraph
} from './prerequisites-query';

function indexWith(rows: [string, string][]): Database.Database {
	const db = new Database(':memory:');
	db.exec("CREATE TABLE files (path TEXT PRIMARY KEY, prerequisites_json TEXT NOT NULL DEFAULT '[]')");
	const ins = db.prepare('INSERT INTO files (path, prerequisites_json) VALUES (?, ?)');
	for (const [p, json] of rows) ins.run(p, json);
	return db;
}

test('an index built before the prerequisite column has no column, and every reader says null rather than "no prerequisites"', () => {
	const db = new Database(':memory:');
	db.exec('CREATE TABLE files (path TEXT PRIMARY KEY)');
	db.prepare('INSERT INTO files (path) VALUES (?)').run('wiki/a/heaps.md');
	assert.equal(hasPrerequisitesColumn(db), false);
	assert.equal(loadPrerequisiteGraph(db), null);
	assert.equal(getPrerequisites(db, 'wiki/a/heaps.md'), null);
	assert.equal(getPrerequisiteChain(db, 'wiki/a/heaps.md'), null);
	assert.equal(findPrerequisiteCycles(db), null);
});

test('names resolve to paths by file name when the graph is read', () => {
	const db = indexWith([
		['wiki/algorithms/approximation.md', '["np-completeness","Linear-Programming"]'],
		['wiki/theory/np-completeness.md', '[]'],
		['wiki/math/linear-programming.md', '[]']
	]);
	assert.equal(hasPrerequisitesColumn(db), true);
	assert.deepEqual(getPrerequisites(db, 'wiki/algorithms/approximation.md'), {
		resolved: ['wiki/theory/np-completeness.md', 'wiki/math/linear-programming.md'],
		unresolved: [],
		ambiguous: []
	});
});

test('a target added or moved AFTER its dependant was indexed is picked up with no re-index', () => {
	const db = indexWith([['wiki/a/needs-heaps.md', '["heaps"]']]);
	assert.deepEqual(getPrerequisites(db, 'wiki/a/needs-heaps.md')!.unresolved, ['heaps']);
	db.prepare('INSERT INTO files (path) VALUES (?)').run('wiki/dsa/heaps.md');
	assert.deepEqual(getPrerequisites(db, 'wiki/a/needs-heaps.md')!.resolved, ['wiki/dsa/heaps.md']);
	db.prepare('UPDATE files SET path = ? WHERE path = ?').run('wiki/other/heaps.md', 'wiki/dsa/heaps.md');
	assert.deepEqual(getPrerequisites(db, 'wiki/a/needs-heaps.md')!.resolved, ['wiki/other/heaps.md']);
});

test('unresolved and ambiguous names are reported per note, not guessed', () => {
	const db = indexWith([
		['wiki/a/x.md', '["missing","sorting"]'],
		['wiki/b/sorting.md', '[]'],
		['wiki/c/sorting.md', '[]']
	]);
	const g = loadPrerequisiteGraph(db)!;
	assert.deepEqual(g.unresolved.get('wiki/a/x.md'), ['missing']);
	assert.deepEqual(g.ambiguous.get('wiki/a/x.md'), ['sorting']);
	assert.deepEqual(g.edges.get('wiki/a/x.md'), []);
});

test('a note that is not indexed has no prerequisites; a corrupt cell is empty, not an exception', () => {
	const db = indexWith([['wiki/a/broken.md', 'not json'], ['wiki/a/odd.md', '{"a":1}']]);
	assert.deepEqual(getPrerequisites(db, 'wiki/none.md'), { resolved: [], unresolved: [], ambiguous: [] });
	assert.deepEqual(getPrerequisites(db, 'wiki/a/broken.md'), { resolved: [], unresolved: [], ambiguous: [] });
	assert.deepEqual(getPrerequisites(db, 'wiki/a/odd.md'), { resolved: [], unresolved: [], ambiguous: [] });
});

test('the chain is transitive, nearest first, and a cycle neither loops nor hides', () => {
	const db = indexWith([
		['wiki/a.md', '["b"]'],
		['wiki/b.md', '["c"]'],
		['wiki/c.md', '["a"]'],
		['wiki/top.md', '["a"]']
	]);
	assert.deepEqual(getPrerequisiteChain(db, 'wiki/top.md'), ['wiki/a.md', 'wiki/b.md', 'wiki/c.md']);
	const cycles = findPrerequisiteCycles(db)!;
	assert.equal(cycles.length, 1);
	assert.deepEqual([...cycles[0]].sort(), ['wiki/a.md', 'wiki/b.md', 'wiki/c.md']);
});
