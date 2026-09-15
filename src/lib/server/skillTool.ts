import type { ToolDefinition } from './providers/types';
import { readSkillSupportingFile } from './userSkills';

/**
 * The one tool the chat route attaches when a tool-capable model is active
 * and at least one enabled folder-skill has fetchable supporting files (see
 * registry.ts's modelCaps and userSkills.ts's hasFetchableFolderSkills).
 * Never executes anything — reads a supporting file's text content and
 * returns it, full stop. Which skills/paths are actually available is told
 * to the model via renderUserSkillsBlock's per-skill "Ek dosyalar" note, not
 * repeated here (this description stays generic on purpose).
 */
export const READ_SKILL_FILE_TOOL: ToolDefinition = {
	name: 'read_skill_file',
	description:
		'Aktif bir kullanıcı skill\'inin ek dosyasını oku. Sadece o skill\'in ' +
		'gövdesinde "Ek dosyalar" notuyla adı geçen bir dosya için kullan — ' +
		'uydurma bir dosya adı deneme.',
	parameters: {
		type: 'object',
		properties: {
			skill: { type: 'string', description: 'Skill adı (örn. "math-tutor")' },
			path: { type: 'string', description: 'Skill klasörüne göre göreli dosya yolu (örn. "references/proofs.md")' }
		},
		required: ['skill', 'path']
	}
};

export type ReadSkillFileResult = { ok: true; content: string; truncated: boolean } | { ok: false; error: string };

/** Never throws — every failure mode (unknown skill, path traversal,
 * disallowed extension, missing file) comes back as {ok:false, error} so
 * the chat route can always feed SOMETHING back to the model as the tool
 * result, never let a bad tool call crash the route. */
export function executeReadSkillFile(args: { skill?: unknown; path?: unknown }): ReadSkillFileResult {
	const skill = typeof args.skill === 'string' ? args.skill : '';
	const relPath = typeof args.path === 'string' ? args.path : '';
	if (!skill || !relPath) {
		return { ok: false, error: 'skill ve path parametreleri gerekli' };
	}
	try {
		const { content, truncated } = readSkillSupportingFile(skill, relPath);
		return { ok: true, content, truncated };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Dosya okunamadı' };
	}
}
