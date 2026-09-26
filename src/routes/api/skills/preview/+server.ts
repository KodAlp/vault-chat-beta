import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { renderUserSkillsBlock, ALL_SCOPES } from '$lib/server/userSkills';
import { fail } from '$lib/server/app-error';
import { coreIntro, DEFAULT_ALLOWED_LANGUAGES, CORE_INVARIANTS } from '$lib/server/prompt';
import { buildSystemPrompt as buildQuizPrompt } from '$lib/server/generate-quiz';
import { buildSystemPrompt as buildCardsPrompt } from '$lib/server/generate-cards';
import { buildSystemPrompt as buildReportPrompt } from '$lib/server/generate-report';
import { buildSystemPrompt as buildMindMapPrompt } from '$lib/server/generate-mindmap';
import { buildSystemPrompt as buildSlidesPrompt } from '$lib/server/generate-slides';
import type { UserSkillScope } from '$lib/types';

const PLACEHOLDER_CONTEXT = '(örnek bağlam — gerçek üretimde burada kaynak parçaları olur)';

/**
 * Debugging tool from the user-skills skill doc: shows the exact assembled
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
		prompt = [coreIntro(DEFAULT_ALLOWED_LANGUAGES), skillsBlock, CORE_INVARIANTS].filter(Boolean).join('\n\n');
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
