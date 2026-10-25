import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { skillsDir } from './env';
import type { UserSkillScope, UserSkillStatus } from '#lib/types.js';
import { MAX_SKILL_FILE_CHARS as MAX_FILE_CHARS, MAX_SKILL_TOTAL_CHARS as MAX_TOTAL_CHARS } from '#lib/skill-limits.js';
import { AppError } from './app-error';

const SCOPES: UserSkillScope[] = ['chat', 'quiz', 'flashcards', 'mindmap', 'report', 'slides'];

export const Frontmatter = z.object({
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

type SkillEntry = { kind: 'file'; absPath: string } | { kind: 'folder'; dir: string; skillMdPath: string };

/**
 * Only looks at skillsDir()'s IMMEDIATE children, unlike walk() (which still
 * exists and is reused below for the two back-compat cases). A folder-skill
 * (zip-uploaded, data/skills/<name>/SKILL.md) is ONE skill entry — its
 * supporting files must never be picked up by walk() as independent skills,
 * which is exactly what unconditional recursion did before this existed.
 */
function collectSkillEntries(): SkillEntry[] {
	const root = skillsDir();
	const out: SkillEntry[] = [];
	if (!fs.existsSync(root)) return out;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(root, entry.name);
		if (entry.isFile() && entry.name.endsWith('.md')) {
			out.push({ kind: 'file', absPath: full });
			continue;
		}
		if (!entry.isDirectory()) continue;
		if (entry.name === '_examples') {
			// Unchanged back-compat: every .md under _examples is its own flat
			// skill, exactly as before this feature existed.
			for (const absPath of walk(full)) out.push({ kind: 'file', absPath });
			continue;
		}
		const skillMdPath = path.join(full, 'SKILL.md');
		if (fs.existsSync(skillMdPath) && fs.statSync(skillMdPath).isFile()) {
			out.push({ kind: 'folder', dir: full, skillMdPath });
		} else {
			// A hand-made subfolder with no SKILL.md — not the new folder-skill
			// mechanism, preserve the old "every .md anywhere is its own skill"
			// behavior for it (back-compat, low-priority edge case).
			for (const absPath of walk(full)) out.push({ kind: 'file', absPath });
		}
	}
	return out;
}

/** Recursively lists every file under a folder-skill's directory (relative,
 * "/"-separated, SKILL.md itself excluded) — always recomputed fresh, never
 * mtime-cached like the parsed SKILL.md body is (see parseAll()'s doc
 * comment on why: a nested file changing doesn't reliably bump the top
 * folder's own mtime on every filesystem, so caching this would risk a
 * stale file list). Cheap enough (a skill folder is a handful of files) that
 * this is a non-issue in practice. */
function listSupportingFiles(dir: string): string[] {
	const out: string[] = [];
	function rec(d: string) {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) {
				rec(full);
				continue;
			}
			const rel = path.relative(dir, full).split(path.sep).join('/');
			if (rel !== 'SKILL.md') out.push(rel);
		}
	}
	if (fs.existsSync(dir)) rec(dir);
	return out;
}

interface CacheEntry {
	/** statSig() of the file when parsed: mtime alone misses a rewrite inside one timestamp tick. */
	sig: string;
	parsed: ParsedSkill;
}

/** Path → cached parse, invalidated by mtime — cheap stat beats a watcher for
 * a folder this small, per the skill doc's explicit guidance. */
const cache = new Map<string, CacheEntry>();

function statSig(stat: fs.Stats): string {
	return `${stat.mtimeMs}|${stat.ctimeMs}|${stat.size}`;
}

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
			parseError: err instanceof Error ? err.message : 'SKILL_FILE_UNREADABLE',
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
			parseError: err instanceof Error ? err.message : 'SKILL_FRONTMATTER_INVALID',
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

/** Same shape as parseFile, sourced from a folder-skill's SKILL.md instead
 * of a flat file — name defaults to the FOLDER's name (not "SKILL", which
 * parseFile's stem-based fallback would otherwise produce), and absPath
 * points at SKILL.md itself so resolvePath/readSkillRaw/writeSkill/the
 * settings-page editor all keep working unmodified. `files` is always an
 * empty placeholder here — parseAll() overwrites it fresh on every call,
 * see listSupportingFiles()'s doc comment. */
function parseFolderSkill(dir: string, skillMdPath: string): ParsedSkill {
	const root = skillsDir();
	const relPath = path.relative(root, skillMdPath).split(path.sep).join('/');
	const folderName = path.basename(dir);

	let raw: string;
	try {
		raw = fs.readFileSync(skillMdPath, 'utf-8');
	} catch (err) {
		return {
			name: folderName,
			relPath,
			absPath: skillMdPath,
			description: null,
			scope: 'all',
			enabled: false,
			priority: 50,
			charCount: 0,
			truncated: false,
			parseError: err instanceof Error ? err.message : 'SKILL_FILE_UNREADABLE',
			body: '',
			isFolder: true,
			files: []
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
			name: folderName,
			relPath,
			absPath: skillMdPath,
			description: null,
			scope: 'all',
			enabled: false,
			priority: 50,
			charCount: 0,
			truncated: false,
			parseError: err instanceof Error ? err.message : 'SKILL_FRONTMATTER_INVALID',
			body: '',
			isFolder: true,
			files: []
		};
	}

	const result = Frontmatter.safeParse(data);
	if (!result.success) {
		return {
			name: folderName,
			relPath,
			absPath: skillMdPath,
			description: null,
			scope: 'all',
			enabled: false,
			priority: 50,
			charCount: content.length,
			truncated: false,
			parseError: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
			body: '',
			isFolder: true,
			files: []
		};
	}

	const fm = result.data;
	const truncated = content.length > MAX_FILE_CHARS;
	const body = truncated ? content.slice(0, MAX_FILE_CHARS) + TRUNCATE_MARKER : content;

	return {
		name: fm.name ?? folderName,
		relPath,
		absPath: skillMdPath,
		description: fm.description,
		scope: fm.scope,
		enabled: fm.enabled,
		priority: fm.priority,
		charCount: content.length,
		truncated,
		parseError: null,
		body,
		isFolder: true,
		files: []
	};
}

function parseAll(): ParsedSkill[] {
	ensureExampleSkills();
	return collectSkillEntries().map((entry) => {
		if (entry.kind === 'file') {
			const stat = fs.statSync(entry.absPath);
			const cached = cache.get(entry.absPath);
			if (cached && cached.sig === statSig(stat)) return cached.parsed;
			const parsed = parseFile(entry.absPath);
			cache.set(entry.absPath, { sig: statSig(stat), parsed });
			return parsed;
		}
		const stat = fs.statSync(entry.skillMdPath);
		const cached = cache.get(entry.skillMdPath);
		const base =
			cached && cached.sig === statSig(stat) ? cached.parsed : parseFolderSkill(entry.dir, entry.skillMdPath);
		if (!cached || cached.sig !== statSig(stat)) {
			cache.set(entry.skillMdPath, { sig: statSig(stat), parsed: base });
		}
		// files always recomputed fresh, never taken from the cached parse —
		// see listSupportingFiles()'s doc comment.
		return { ...base, files: listSupportingFiles(entry.dir) };
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
export function loadUserSkills(
	scope: UserSkillScope
): { name: string; body: string; isFolder: boolean; files: string[] }[] {
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
	return kept.map(({ name, body, isFolder, files }) => ({
		name,
		body,
		isFolder: !!isFolder,
		files: files ?? []
	}));
}

/** True when at least one enabled, in-scope skill is a folder-skill with
 * supporting files — the chat route's gate for whether it's worth attaching
 * the read_skill_file tool to a request at all (on top of the model itself
 * needing tool-calling support, see registry.ts's modelCaps). */
export function hasFetchableFolderSkills(scope: UserSkillScope): boolean {
	return loadUserSkills(scope).some((s) => s.isFolder && s.files.length > 0);
}

export async function renderUserSkillsBlock(
	scope: UserSkillScope,
	opts?: { includeFileNotes?: boolean; /** Header/note language; 'en' is for the #28 A/B only. */ language?: 'tr' | 'en' }
): Promise<string> {
	const en = opts?.language === 'en';
	const skills = loadUserSkills(scope);
	if (skills.length === 0) return '';
	return skills
		.map((s) => {
			// Only appended when the tool is actually being attached this
			// request (opts.includeFileNotes) — otherwise this would point the
			// model at files it has no way to fetch (e.g. a non-tool-capable
			// model, or a cloud provider — see registry.ts's modelCaps).
			const note =
				opts?.includeFileNotes && s.isFolder && s.files.length > 0
					? en
						? `\n\n_Extra files: ${s.files.join(', ')} — read them with read_skill_file when needed (skill: "${s.name}")._`
						: `\n\n_Ek dosyalar: ${s.files.join(', ')} — gerekirse read_skill_file ile oku (skill: "${s.name}")._`
					: '';
			return `## ${en ? 'User rule' : 'Kullanıcı kuralı'}: ${s.name}\n${s.body}${note}`;
		})
		.join('\n\n');
}

function resolvePath(name: string): string | undefined {
	const match = parseAll().find((s) => s.name === name);
	return match?.absPath;
}

function findFolderSkill(name: string): ParsedSkill {
	const skill = parseAll().find((s) => s.name === name && s.isFolder);
	if (!skill) throw new Error(`Klasör skill bulunamadı: ${name}`);
	return skill;
}

/** Same shape/intent as library-read.ts's resolveLibraryPath — scopes
 * relPath to one folder-skill's own directory, rejecting anything that
 * resolves outside it (../, absolute paths, drive-letter escapes). Purely
 * lexical (path.resolve) — readSkillSupportingFile adds a realpath check on
 * top of this for a symlink planted inside the folder. */
export function resolveSkillFolderPath(name: string, relPath: string): string {
	const root = path.dirname(findFolderSkill(name).absPath);
	const resolved = path.resolve(root, relPath);
	const withSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(withSep)) {
		throw new Error('Geçersiz yol (skill klasörü dışına çıkıyor)');
	}
	return resolved;
}

const READABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv']);

/**
 * What the read_skill_file tool actually calls. Every failure mode throws a
 * plain Error with a Turkish message and NEVER touches the filesystem
 * outside the skill's own folder — the caller (the chat route's tool
 * hop-loop) always catches this and feeds the message back to the model as
 * a "HATA: ..." tool-result string, never lets it become a route crash.
 */
export function readSkillSupportingFile(name: string, relPath: string): { content: string; truncated: boolean } {
	const root = path.dirname(findFolderSkill(name).absPath);
	const resolved = resolveSkillFolderPath(name, relPath);

	const ext = path.extname(resolved).toLowerCase();
	if (!READABLE_EXTENSIONS.has(ext)) {
		throw new Error(`Desteklenmeyen dosya türü: ${ext || '(uzantısız)'}`);
	}

	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved); // follows symlinks; ENOENT if the target is missing
	} catch {
		throw new Error('Dosya bulunamadı');
	}
	if (!stat.isFile()) throw new Error('Dosya bulunamadı');

	// Defense in depth: resolveSkillFolderPath's containment check is purely
	// lexical, so a symlink planted INSIDE the folder pointing outside it
	// would pass it. Re-contain the REAL path against the folder's real path.
	const realResolved = fs.realpathSync(resolved);
	const realRoot = fs.realpathSync(root);
	const realWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
	if (realResolved !== realRoot && !realResolved.startsWith(realWithSep)) {
		throw new Error('Geçersiz yol (symlink skill klasörü dışına çıkıyor)');
	}

	const raw = fs.readFileSync(realResolved, 'utf-8');
	const truncated = raw.length > MAX_FILE_CHARS;
	return { content: truncated ? raw.slice(0, MAX_FILE_CHARS) + TRUNCATE_MARKER : raw, truncated };
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
export function assertSafeSkillName(name: string): void {
	if (!name || /[\\/]/.test(name)) {
		throw new AppError('SKILL_NAME_INVALID');
	}
}

export function writeSkill(name: string, raw: string): void {
	assertSafeSkillName(name);
	const parsed = matter(raw);
	const result = Frontmatter.safeParse(parsed.data);
	if (!result.success) {
		throw new AppError('SKILL_FRONTMATTER_INVALID', {
			detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
		});
	}
	const existing = resolvePath(name);
	const absPath = existing ?? path.join(skillsDir(), `${name}.md`);

	const root = skillsDir();
	const withSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (!absPath.startsWith(withSep)) {
		throw new AppError('SKILL_NAME_INVALID');
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
	if (!absPath) throw new AppError('NOT_FOUND', { entity: 'skill' }, 404);
	const raw = fs.readFileSync(absPath, 'utf-8');
	const parsed = matter(raw);
	const nextData = { ...parsed.data, ...patch };
	const result = Frontmatter.safeParse(nextData);
	if (!result.success) {
		throw new AppError('SKILL_FRONTMATTER_INVALID', {
			detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
		});
	}
	const nextRaw = matter.stringify(parsed.content.trim(), nextData);
	fs.writeFileSync(absPath, nextRaw, 'utf-8');
	cache.delete(absPath);
}

export function deleteSkill(name: string): boolean {
	const skill = parseAll().find((s) => s.name === name);
	if (!skill) return false;
	if (skill.isFolder) {
		fs.rmSync(path.dirname(skill.absPath), { recursive: true, force: true });
	} else {
		fs.unlinkSync(skill.absPath);
	}
	cache.delete(skill.absPath);
	return true;
}

export const ALL_SCOPES = SCOPES;
