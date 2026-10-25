import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { renderUserSkillsBlock, ALL_SCOPES } from '#lib/server/userSkills.js';
import { fail } from '#lib/server/app-error.js';
import { coreIntro, DEFAULT_ALLOWED_LANGUAGES, CORE_INVARIANTS } from '#lib/server/prompt.js';
import { buildSystemPrompt as buildQuizPrompt } from '#lib/server/generate-quiz.js';
import { buildSystemPrompt as buildCardsPrompt } from '#lib/server/generate-cards.js';
import { buildSystemPrompt as buildReportPrompt } from '#lib/server/generate-report.js';
import { buildSystemPrompt as buildMindMapPrompt } from '#lib/server/generate-mindmap.js';
import { buildSystemPrompt as buildSlidesPrompt } from '#lib/server/generate-slides.js';
import type { UserSkillScope } from '#lib/types.js';

const PLACEHOLDER_CONTEXT = '(örnek bağlam — gerçek üretimde burada kaynak parçaları olur)';

/**
 * Debugging tool: shows the exact assembled
 * system prompt for a scope, without a real model call or retrieval — the
 * ordering (intro → user skills → non-overridable invariants) is the whole
 * point, not the placeholder task numbers.
 */
export const GET: RequestHandler = async ({ url }) => {
	const scope = url.searchParams.get('scope') as UserSkillScope | null;
	if (!scope || !ALL_SCOPES.includes(scope)) {
		fail('SKILL_PREVIEW_SCOPE_INVALID', { allowed: ALL_SCOPES.join(', ') });
	}

	const skillsBlock = await renderUserSkillsBlock(scope);

	let prompt: string;
	if (scope === 'chat') {
		// 'match' is the app-wide default (LibrarySettings.responseLanguage) — this preview has no
		// real vault context to read a per-vault override from, so it shows the same default a
		// brand-new vault's chat would actually use.
		prompt = [coreIntro(DEFAULT_ALLOWED_LANGUAGES, 'match'), skillsBlock, CORE_INVARIANTS].filter(Boolean).join('\n\n');
	} else if (scope === 'quiz') {
		prompt = buildQuizPrompt({ mc: 6, tf: 2, open: 2 }, PLACEHOLDER_CONTEXT, skillsBlock);
	} else if (scope === 'flashcards') {
		prompt = buildCardsPrompt(10, PLACEHOLDER_CONTEXT, skillsBlock);
	} else if (scope === 'report') {
		prompt = buildReportPrompt(PLACEHOLDER_CONTEXT, skillsBlock);
	} else if (scope === 'mindmap') {
		// The mind-map prompt states its output language explicitly (a buried
		// language bullet was being ignored outright). The preview has no vault
		// in hand, so it shows the same default chat falls back to.
		prompt = buildMindMapPrompt(PLACEHOLDER_CONTEXT, skillsBlock, DEFAULT_ALLOWED_LANGUAGES[0]);
	} else {
		prompt = buildSlidesPrompt(PLACEHOLDER_CONTEXT, skillsBlock);
	}

	return json({ scope, prompt });
};
