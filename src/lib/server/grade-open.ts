import { z } from 'zod';
import { streamChat, type OllamaChatMessage } from './ollama';

const GradeResult = z.object({ correct: z.boolean(), feedback: z.string() });
export type GradeResultT = z.infer<typeof GradeResult>;

const GRADE_JSON_SCHEMA = {
	type: 'object',
	properties: {
		correct: { type: 'boolean' },
		feedback: { type: 'string' }
	},
	required: ['correct', 'feedback']
} as const;

const SYSTEM_PROMPT =
	'Sen bir öğretmen asistanısın. Öğrencinin cevabını referans cevaba göre değerlendir. Kısmi doğruluk kabul edilebilir, tam kelime eşleşmesi aranmaz, kavramsal doğruluk önemlidir. Türkçe, 1-2 cümlelik kısa bir geri bildirim ver.';

/** Skill spec: open questions are graded by the model, clearly labeled in the
 * UI as "model değerlendirmesi" — MC/TF are graded in code, never by the model. */
export async function gradeOpenAnswer(
	question: string,
	referenceAnswer: string,
	studentAnswer: string,
	model: string
): Promise<GradeResultT> {
	const messages: OllamaChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Soru: ${question}\n\nReferans cevap: ${referenceAnswer}\n\nÖğrenci cevabı: ${studentAnswer}`
		}
	];
	let text = '';
	for await (const piece of streamChat(model, messages, false, undefined, {
		format: GRADE_JSON_SCHEMA,
		temperature: 0.2
	})) {
		if (piece.kind === 'content') text += piece.text;
	}

	try {
		const parsed = GradeResult.safeParse(JSON.parse(text));
		if (parsed.success) return parsed.data;
	} catch {
		// fall through
	}
	// Fail closed rather than crash the whole submission on a malformed grader response.
	return { correct: false, feedback: 'Model değerlendirmesi başarısız oldu.' };
}
