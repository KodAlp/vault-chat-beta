/**
 * The cognitive level a quiz question targets (spec sections 24-25, reduced from six to four). EXPERIMENTAL and off by default
 * (Settings.quizLevelLabels): it asks a small model to write each question FOR a level, and measured on a 8B local model the
 * labels did not reliably describe the question that came out.
 *
 * Six levels (recall, understanding, application, analysis, synthesis, transfer) were tried first: an independent blind
 * re-labelling of 40 generated questions agreed with the generator only 40% of the time (chance 17%) and the upper three were
 * mostly recall or understanding questions under a fancier label. So the upper three are one level here.
 *
 *   recall        remembering a definition, a fact, a formula or a name
 *   understanding explaining a concept in your own words, interpreting a cause or a relation
 *   application   using a known method on a concrete problem (calculating, solving step by step)
 *   higher        analysing (taking a situation apart, comparing, finding the fault) or transferring / building
 *                 (carrying a principle to a different case, putting parts into a new solution)
 *
 * Client-safe and dependency-free on purpose: the grammar, the database row types, the learner model and the progress page
 * all name the same four values.
 */
export const COGNITIVE_LEVELS = ['recall', 'understanding', 'application', 'higher'] as const;
export type CognitiveLevel = (typeof COGNITIVE_LEVELS)[number];

export function isCognitiveLevel(v: unknown): v is CognitiveLevel {
	return typeof v === 'string' && (COGNITIVE_LEVELS as readonly string[]).includes(v);
}

export type LevelKind = 'multiple_choice' | 'true_false' | 'open';

/**
 * Which levels a question type can honestly measure, in the order they are dealt out. A true/false statement can test recall or
 * understanding but not "apply a method"; an open question is where application and higher-order work live.
 * A multiple-choice question has no "higher": it was dealt one in each quiz and measured twice on 60 generated questions, an
 * independent judge agreed with 1 of 6 and 0 of 5 of them (and called all five recall or understanding), while for open questions
 * assigned "higher" it agreed 64-91% of the time. A small model writes "which statement is true about X?" whatever the label says.
 */
export const LEVEL_MENU: Record<LevelKind, readonly CognitiveLevel[]> = {
	multiple_choice: ['recall', 'understanding', 'application'],
	true_false: ['recall', 'understanding'],
	open: ['application', 'higher', 'understanding']
};

/**
 * The target level of each of `count` questions of `kind`, cycling through the menu so a quiz covers what its type can.
 *
 * `supports[i]` says whether the source part question i is pinned to has material one can APPLY (computation, code, steps;
 * chunk-signals.ts). The first version dealt levels blind to the part, so "application" landed on definition paragraphs and the
 * model wrote a definition question under that label (measured: 15 of the 18 "application" questions sat on parts without such
 * material). A part without it is never dealt "application". Omit `supports` and every part counts as able.
 */
export function assignLevels(kind: LevelKind, count: number, supports?: readonly boolean[]): CognitiveLevel[] {
	const menu = LEVEL_MENU[kind];
	const out: CognitiveLevel[] = [];
	let pointer = 0;
	for (let i = 0; i < Math.max(0, count); i++) {
		const canApply = supports ? supports[i] === true : true;
		let picked: CognitiveLevel = menu[pointer % menu.length];
		for (let step = 0; step < menu.length; step++) {
			const level = menu[(pointer + step) % menu.length];
			if (level !== 'application' || canApply) {
				picked = level;
				pointer = (pointer + step + 1) % menu.length;
				break;
			}
		}
		out.push(picked);
	}
	return out;
}
