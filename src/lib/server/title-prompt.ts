import { decideResponseLanguage } from './response-language';

/**
 * Builds the system prompt for chat-title generation. The title must be in the language of the
 * user's question (not a hard-coded one), so the language is decided with the same detector the
 * chat answer uses (response-language.ts) and named explicitly in an English instruction, which
 * small local models follow more reliably than an implicit "same language" request.
 *
 * `primaryLanguage` is the vault's primary language; it is only the fallback when the question is
 * too short or ambiguous to detect.
 */
export function buildTitleSystemPrompt(question: string, primaryLanguage = 'Türkçe'): string {
	const { englishName } = decideResponseLanguage(question, [], primaryLanguage);
	return (
		`Turn the user's question into a short title of 3-6 words. ` +
		`Write the title in ${englishName}, the same language as the question. ` +
		`Output only the title, with no quotation marks, no punctuation at the end and no explanation.`
	);
}
