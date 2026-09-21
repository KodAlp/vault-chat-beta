/**
 * Prints the learner profile of a vault (F1b): what the quiz answers and card reviews say about each domain and note.
 *
 *   npx tsx scripts/learner-report.ts [--vault <id>] [--notes <n>] [--json] [--snapshot]
 *
 * Read-only by default. Opening a vault's study.db creates the learner tables and any column added since it was made (that is how
 * every study.db is upgraded), but no row is written. `--snapshot` is the one explicit write: it appends the current numbers to the
 * append-only history (skill_state), and writes nothing when they have not changed since the last snapshot.
 * Point it at a copy with DATA_DIR=<dir> (and INDEX_DB_PATH is not needed: the vault's index is resolved from DATA_DIR too).
 */
import process from 'node:process';
import { resolveVault } from '../src/lib/server/vaults';
import { computeLearnerProfile } from '../src/lib/server/learner-store';
import { appendSkillSnapshot, closeVaultStudyDb } from '../src/lib/server/study-db';
import type { MasteryEstimate, RetentionEstimate, SkillNode } from '../src/lib/learner-model';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
	const i = argv.indexOf(name);
	return i !== -1 ? argv[i + 1] : undefined;
};

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);

function quizText(e: MasteryEstimate): string {
	if (e.count === 0) return 'no answers';
	if (!e.reliable || e.mastery === null) return `not enough data (${e.count} answered, weight ${e.weight.toFixed(1)})`;
	return `${pct(e.mastery)}  ${e.count} answered, ${e.confidence} confidence${e.lastAt ? `, last ${e.lastAt.slice(0, 10)}` : ''}`;
}

function cardText(e: RetentionEstimate): string {
	if (e.cards === 0) return '';
	if (!e.reliable || e.retention === null) return `not enough data (${e.cards} cards reviewed)`;
	return `${pct(e.retention)}  ${e.cards} cards reviewed`;
}

function print(node: SkillNode, indent = '  ') {
	console.log(`${indent}${node.name}`);
	console.log(`${indent}  quiz   ${quizText(node.quiz)}`);
	const cards = cardText(node.retention);
	if (cards) console.log(`${indent}  cards  ${cards}`);
	if (node.bands) {
		console.log(`${indent}  basic  ${quizText(node.bands.basic)}`);
		console.log(`${indent}  applied ${quizText(node.bands.applied)}`);
	}
}

const v = resolveVault(value('--vault'));
try {
	const profile = computeLearnerProfile(v);
	if (flag('--json')) {
		console.log(JSON.stringify(profile, null, 2));
	} else {
		console.log(`vault: ${v.name} (${v.id})   computed ${profile.generatedAt}`);
		const overall = profile.nodes.find((n) => n.kind === 'overall');
		if (overall) {
			console.log('\n== everything ==');
			print({ ...overall, name: 'all evidence' });
		}
		console.log('\n== domains ==');
		for (const n of profile.nodes.filter((x) => x.kind === 'domain')) print(n);
		const top = Number(value('--notes') ?? 10);
		console.log(`\n== notes (${top} with the most evidence) ==`);
		for (const n of profile.nodes.filter((x) => x.kind === 'note').slice(0, top)) print(n);
	}
	if (flag('--snapshot')) {
		const r = appendSkillSnapshot(v, profile);
		console.error(`snapshot: ${r.written} written, ${r.skipped} unchanged`);
	}
} finally {
	closeVaultStudyDb(v.id);
}
