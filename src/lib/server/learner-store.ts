import Database from 'better-sqlite3';
import { buildProfile, type CardPoint, type LearnerProfile } from '../learner-model';
import { pickEvidence, type AnswerRow } from './learner-evidence';
import { buildWeakSpots, type CardErrorPoint, type WeakSpot } from './learner-errors';
import { getAnswerEvidenceRows, getCardsForErrors, getCardsForLearner } from './study-db';
import type { VaultContext } from './vaults';

/**
 * note path -> the domains it belongs to, from the vault's index (read-only, opened for this call only so it never contends with
 * the indexer). A vault that was never indexed, or an index from before `domains_json`, just gives an empty map: every note then
 * lands in the "unknown" domain and the numbers are still right, only ungrouped.
 */
export function loadDomainsByPath(v: VaultContext): Map<string, string[]> {
	const map = new Map<string, string[]>();
	let db: Database.Database | undefined;
	try {
		db = new Database(v.indexDbPath, { readonly: true, fileMustExist: true });
		for (const row of db.prepare('SELECT path, domains_json FROM files').all() as { path: string; domains_json: string }[]) {
			try {
				const parsed: unknown = JSON.parse(row.domains_json);
				map.set(row.path, Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : []);
			} catch {
				map.set(row.path, []);
			}
		}
	} catch {
		// no index (yet): see above
	} finally {
		db?.close();
	}
	return map;
}

function parseOptions(optionsJson: string | null): string[] | null {
	if (!optionsJson) return null;
	try {
		const parsed: unknown = JSON.parse(optionsJson);
		return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : null;
	} catch {
		return null;
	}
}

function loadAnswerRows(v: VaultContext): AnswerRow[] {
	return getAnswerEvidenceRows(v).map((r) => ({
		itemId: r.item_id,
		quizId: r.quiz_id,
		answeredAt: r.answered_at,
		given: r.given,
		isCorrect: r.is_correct === 1,
		type: r.type,
		question: r.question,
		sourcePath: r.source_path,
		headingPath: r.heading_path,
		correctAnswer: r.correct_answer,
		modelFeedback: r.model_feedback,
		flaggedAt: r.flagged_at,
		cognitiveLevel: r.cognitive_level,
		options: parseOptions(r.options_json)
	}));
}

/** The learner profile of a vault, computed from what is stored right now. Read-only: it writes nothing. */
export function computeLearnerProfile(v: VaultContext, now: Date = new Date()): LearnerProfile {
	const domains = loadDomainsByPath(v);
	const domainsOf = (sourcePath: string) => domains.get(sourcePath) ?? [];

	const points = pickEvidence(loadAnswerRows(v), domainsOf);

	const cards: CardPoint[] = getCardsForLearner(v).map((c) => {
		const known = domainsOf(c.source_path);
		return {
			sourcePath: c.source_path,
			// the index is the authority; a card's own domain is only the fallback for a note the index no longer has
			domains: known.length > 0 ? known : c.domain ? [c.domain] : [],
			intervalDays: c.interval_days,
			dueAt: c.due_at,
			reps: c.reps,
			lapses: c.lapses
		};
	});
	return buildProfile({ points, cards, now });
}

/** The weak-spot list of a vault, computed fresh from the same stored answers and cards as the learner model.
 * Read-only: it writes nothing. */
export function computeWeakSpots(v: VaultContext): WeakSpot[] {
	const domains = loadDomainsByPath(v);
	const domainsOf = (sourcePath: string) => domains.get(sourcePath) ?? [];

	const cards: CardErrorPoint[] = getCardsForErrors(v).map((c) => {
		const known = domainsOf(c.source_path);
		return {
			id: c.id,
			front: c.front,
			back: c.back,
			sourcePath: c.source_path,
			headingPath: c.heading_path,
			domains: known.length > 0 ? known : c.domain ? [c.domain] : [],
			intervalDays: c.interval_days,
			lapses: c.lapses,
			dueAt: c.due_at
		};
	});
	return buildWeakSpots({ answers: loadAnswerRows(v), cards, domainsOf });
}
