/**
 * Language-independent signals that a source part contains material one can APPLY (compute, trace, solve): math, code, numeric
 * expressions, numbered steps. Structure only, no word lists, so it works for a note in any language.
 *
 * Measured on the real index: 368 of 2161 parts (17%) have it, by domain 0% (os) to 60% (math) of the parts a topical query returns.
 * That is why a question level or an "answer with a concrete result" instruction cannot be dealt blind to the part: most parts
 * are definitions and explanations. The threshold is a heuristic, not a classifier — validated only indirectly (open questions
 * on parts it marks had far fewer prose answers, 27% vs 51%).
 * Known limit: indented code counts only lines indented exactly one level (4 spaces or a tab), three of them for one signal;
 * deeper-nested lines are not counted. Kept as measured rather than widened without a measurement.
 */
export function appSignals(text: string) {
	return {
		math: (text.match(/\$[^$\n]+\$/g) || []).length + (text.match(/\$\$/g) || []).length,
		code: (text.match(/```/g) || []).length / 2 + (text.match(/^( {4}|\t)\S/gm) || []).length / 3,
		numexpr: (text.match(/\d\s*[-+*/=^×]\s*\d/g) || []).length,
		steps: (text.match(/^\s*\d+[.)]\s+\S/gm) || []).length
	};
}

export function chunkSupportsApplication(text: string): boolean {
	const s = appSignals(text);
	return s.math >= 2 || s.code >= 1 || s.numexpr >= 2 || s.steps >= 3;
}
