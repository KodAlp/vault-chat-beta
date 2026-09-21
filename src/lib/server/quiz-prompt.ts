import type { CognitiveLevel } from '../cognitive-levels';
import type { QuizItemType } from './quiz-batch';

/**
 * The user-side prompt of ONE quiz batch, kept apart from generate-quiz.ts (which pulls in $env and cannot run under `tsx --test`)
 * so that one guarantee is a tested fact and not a promise: with `levels` omitted the text is exactly what it was before cognitive
 * levels existed. Levels are opt-in (Settings.quizLevelLabels) and a user who never turned them on must not get a different prompt.
 */
export const TYPE_TR: Record<QuizItemType, string> = { multiple_choice: 'çoktan seçmeli', true_false: 'doğru/yanlış', open: 'açık uçlu' };

/**
 * What the four levels mean, written to be followed. Each question's level is ASSIGNED (quiz-schema.ts pins it), so this only has to
 * say what a question at that level looks like. Every level stays inside the <context> rule: "higher" carries a principle to another
 * case using what the context contains, never outside knowledge. Used only when levels are on.
 */
export const LEVEL_GUIDE = `Düzeyler:
- recall: bir tanımı, olguyu, formülü ya da adı hatırlamak
- understanding: bir kavramı kendi sözleriyle açıklamak, bir nedeni ya da ilişkiyi yorumlamak
- application: bilinen bir yöntemi verilen somut bir probleme uygulamak (hesaplamak, adım adım çözmek)
- higher: bir durumu parçalarına ayırıp karşılaştırmak ya da hatayı bulmak; ya da bir ilkeyi farklı bir örnek duruma taşıyıp yeni bir çözüm kurmak (gereken bilgi yine <context> içinde olmalı)
Soru, kendisine atanan düzeyi GERÇEKTEN ölçmeli; düzeye uymayan bir soru yazma.`;

export function buildBatchUserPrompt(userPrompt: string, kind: QuizItemType, slots: readonly string[], levels?: readonly CognitiveLevel[]): string {
	const perQuestion = slots.map((id, i) => `${i + 1}. soru ${id}${levels ? ` (${levels[i]} düzeyinde)` : ''}`).join(', ');
	return (
		`${userPrompt}\n\nBu partideki TÜM sorular ${TYPE_TR[kind]} türünde olmalı.` +
		`\n\nHer sorunun kaynağı sabittir; sırayla: ${perQuestion}. ` +
		`Her soruyu YALNIZCA kendi kimliğinin içeriğinden üret ve source_id alanına o kimliği yaz.` +
		(levels ? `\n\nHer sorunun cognitive_level alanına belirtilen düzeyi yaz.\n\n${LEVEL_GUIDE}` : '')
	);
}
