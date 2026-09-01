import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { skillsDir } from './env';
import type { UserSkillScope, UserSkillStatus } from '$lib/types';
import { MAX_SKILL_FILE_CHARS as MAX_FILE_CHARS, MAX_SKILL_TOTAL_CHARS as MAX_TOTAL_CHARS } from '$lib/skill-limits';

const SCOPES: UserSkillScope[] = ['chat', 'quiz', 'flashcards', 'mindmap', 'report', 'slides'];

const Frontmatter = z.object({
	name: z.string().min(1).optional(),
	description: z.string().min(1),
	scope: z
		.union([
			z.literal('all'),
			z.array(z.enum(['chat', 'quiz', 'flashcards', 'mindmap', 'report', 'slides']))
		])
		.default('all'),
	enabled: z.boolean().default(true),
	priority: z.number().min(0).max(100).default(50)
});

const TRUNCATE_MARKER = '\n\n[kısaltıldı]';

interface ParsedSkill extends UserSkillStatus {
	absPath: string;
	body: string;
}

const EXAMPLES: { file: string; description: string; body: string }[] = [
	{
		file: 'notation-preference.md',
		description: 'Türev gösteriminde tercih edilen notasyon',
		body: `Türev yazarken $f'(x)$ gösterimini tercih et, $\\frac{df}{dx}$ gösterimini
sadece diferansiyel denklemler bağlamında kullan. Kısmi türevlerde her
zaman $\\partial$ sembolünü kullan.`
	},
	{
		file: 'turkce-terimler.md',
		description: 'Terimlerin İngilizcesini parantez içinde ver',
		body: `Türkçe cevap ver, ama teknik terimlerin ilk geçtiği yerde İngilizce
karşılığını parantez içinde belirt: "yakınsama (convergence)" gibi.
Tekrar eden terimlerde parantezi tekrarlama.`
	},
	{
		file: 'quiz-zorlugu.md',
		description: 'Testleri daha zorlu hazırla',
		body: `Test sorularını hazırlarken notların "level" (seviye) etiketini bir alt
sınır say, üst sınır değil — sorular o seviyenin üst ucunda, gerçek bir
sınavda çıkabilecek zorlukta olsun. Ezber değil, kavrama gerektiren
sorular tercih et.`
	}
];

/** Skill doc: "Ship three commented example files on first run". Runs lazily,
 * once, the first time the loader is touched — not at module import time. */
function ensureExampleSkills(): void {
	const examplesDir = path.join(skillsDir(), '_examples');
	if (fs.existsSync(examplesDir)) return;
	fs.mkdirSync(examplesDir, { recursive: true });
	for (const ex of EXAMPLES) {
		const raw = matter.stringify(ex.body, {
			description: ex.description,
			scope: 'all',
			enabled: false,
			priority: 50
		});
		fs.writeFileSync(path.join(examplesDir, ex.file), raw, 'utf-8');
	}
}

function walk(dir: string, out: string[] = []): string[] {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
	}
	return out;
}

interface CacheEntry {
	mtimeMs: number;
	parsed: ParsedSkill;
}

/** Path → cached parse, invalidated by mtime — cheap stat beats a watcher for
 * a folder this small, per the skill doc's explicit guidance. */
const cache = new Map<string, CacheEntry>();

function parseFile(absPath: string): ParsedSkill {
	const root = skillsDir();
	const relPath = path.relative(root, absPath).split(path.sep).join('/');
	const stem = path.basename(absPath, '.md');

	let raw: string;
	try {
		raw = fs.readFileSync(absPath, 'utf-8');
	} catch (err) {
		return {
			name: stem,
			relPath,
			absPath,
			description: null,
			scope: 'all',
			enabled: false,
			priority: 50,
			charCount: 0,
			truncated: false,
			parseError: err instanceof Error ? err.message : 'Dosya okunamadı',
			body: ''
		};
	}

	let data: unknown;
	let content: string;
	try {
		const parsed = matter(raw);
		data = parsed.data;
		content = parsed.content.trim();
	} catch (err) {
		return {
			name: stem,
			relPath,
			absPath,
			description: null,
			scope: 'all',
			enabled: false,
			priority: 50,
			charCount: 0,
			truncated: false,
			parseError: err instanceof Error ? err.message : 'Frontmatter ayrıştırılamadı',
			body: ''
		};
	}

	const result = Frontmatter.safeParse(data);
	if (!result.success) {
		return {
			name: stem,
			relPath,
			absPath,
			description: null,
			scope: 'all',
			enabled: false,
			priority: 50,
			charCount: content.length,
			truncated: false,
			parseError: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
			body: ''
		};
	}

	const fm = result.data;
	const truncated = content.length > MAX_FILE_CHARS;
	const body = truncated ? content.slice(0, MAX_FILE_CHARS) + TRUNCATE_MARKER : content;

	return {
		name: fm.name ?? stem,
		relPath,
		absPath,
		description: fm.description,
		scope: fm.scope,
		enabled: fm.enabled,
		priority: fm.priority,
		charCount: content.length,
		truncated,
		parseError: null,
		body
	};
}

function parseAll(): ParsedSkill[] {
	ensureExampleSkills();
	return walk(skillsDir()).map((absPath) => {
		const stat = fs.statSync(absPath);
		const cached = cache.get(absPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
		const parsed = parseFile(absPath);
		cache.set(absPath, { mtimeMs: stat.mtimeMs, parsed });
		return parsed;
	});
}

function matchesScope(fmScope: 'all' | UserSkillScope[], scope: UserSkillScope): boolean {
	return fmScope === 'all' || fmScope.includes(scope);
}

/** Full status of every *.md file under data/skills/, valid or not — feeds
 * the settings page list (name, warnings, char budget, everything). */
export function listAllUserSkillFiles(): UserSkillStatus[] {
	return parseAll().map(({ absPath: _absPath, body: _body, ...status }) => status);
}

/**
 * Enabled, scope-matched, budgeted, priority-ascending — ready for prompt
 * assembly. Ascending priority means the highest-priority skill ends up
 * LAST in the rendered block, which is deliberate: local models weight
 * later instructions more heavily, so "higher priority = stronger" only
 * holds if it's also "later".
 */
export function loadUserSkills(scope: UserSkillScope): { name: string; body: string }[] {
	const candidates = parseAll()
		.filter((s) => !s.parseError && s.enabled && matchesScope(s.scope, scope))
		.sort((a, b) => a.priority - b.priority);

	const kept: ParsedSkill[] = [];
	let total = 0;
	// Drop lowest-priority first once the total budget is exceeded — walk
	// descending priority to decide inclusion, but the final list stays
	// ascending (see doc comment above) for rendering.
	for (const s of [...candidates].sort((a, b) => b.priority - a.priority)) {
		if (total + s.body.length > MAX_TOTAL_CHARS) continue;
		total += s.body.length;
		kept.push(s);
	}
	kept.sort((a, b) => a.priority - b.priority);
	return kept.map(({ name, body }) => ({ name, body }));
}

export async function renderUserSkillsBlock(scope: UserSkillScope): Promise<string> {
	const skills = loadUserSkills(scope);
	if (skills.length === 0) return '';
	return skills.map((s) => `## Kullanıcı kuralı: ${s.name}\n${s.body}`).join('\n\n');
}

function resolvePath(name: string): string | undefined {
	const match = parseAll().find((s) => s.name === name);
	return match?.absPath;
}

export function readSkillRaw(name: string): string | undefined {
	const absPath = resolvePath(name);
	if (!absPath) return undefined;
	return fs.readFileSync(absPath, 'utf-8');
}

/** Re-validates frontmatter before writing — never lets a broken file land
 * silently (skill doc: "malformed frontmatter ... never a crash", extended
 * here to "never a silent write" for the settings-page save path). */
/**
 * `name` reaches here straight from the URL path parameter in
 * PUT /api/skills/[name], with nothing sanitizing it before this. SvelteKit
 * decodes a %2F in that segment into a literal `/` in params.name rather than
 * treating it as a route boundary — verified live:
 * `GET /api/skills/..%2f..%2fpwned` reaches this module's own 404 handler
 * (application/json body), not SvelteKit's routing-level 404, so
 * params.name really can contain `../../pwned`. For an EXISTING skill this
 * is harmless (resolvePath only matches names already found by scanning
 * skillsDir()), but writeSkill's fallback path for a NEW name —
 * `path.join(skillsDir(), name + '.md')` — would happily write outside the
 * skills folder with attacker-controlled content.
 *
 * A legitimate skill name is a single filename component, never a path, so
 * any path separator is rejected outright. The post-write containment check
 * (same shape as library-read.ts's resolveLibraryPath) is defense in depth
 * for anything this character check didn't anticipate — a null byte, a
 * Windows device name, a future Node path-parsing quirk.
 */
function assertSafeSkillName(name: string): void {
	if (!name || /[\\/]/.test(name)) {
		throw new Error('Geçersiz skill adı');
	}
}

export function writeSkill(name: string, raw: string): void {
	assertSafeSkillName(name);
	const parsed = matter(raw);
	const result = Frontmatter.safeParse(parsed.data);
	if (!result.success) {
		throw new Error(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
	}
	const existing = resolvePath(name);
	const absPath = existing ?? path.join(skillsDir(), `${name}.md`);

	const root = skillsDir();
	const withSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (!absPath.startsWith(withSep)) {
		throw new Error('Geçersiz skill adı (dizin dışına çıkıyor)');
	}

	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, raw, 'utf-8');
	cache.delete(absPath);
}

/** Quick-toggle path for the settings list (enable switch, priority number
 * input) — separate from writeSkill's full-text save so the list doesn't
 * need to round-trip the whole file body through the client just to flip
 * one field. Still goes through the same frontmatter validation. */
export function patchSkillFrontmatter(
	name: string,
	patch: Partial<{ enabled: boolean; priority: number }>
): void {
	const absPath = resolvePath(name);
	if (!absPath) throw new Error('Skill bulunamadı');
	const raw = fs.readFileSync(absPath, 'utf-8');
	const parsed = matter(raw);
	const nextData = { ...parsed.data, ...patch };
	const result = Frontmatter.safeParse(nextData);
	if (!result.success) {
		throw new Error(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
	}
	const nextRaw = matter.stringify(parsed.content.trim(), nextData);
	fs.writeFileSync(absPath, nextRaw, 'utf-8');
	cache.delete(absPath);
}

export function deleteSkill(name: string): boolean {
	const absPath = resolvePath(name);
	if (!absPath) return false;
	fs.unlinkSync(absPath);
	cache.delete(absPath);
	return true;
}

export const ALL_SCOPES = SCOPES;
