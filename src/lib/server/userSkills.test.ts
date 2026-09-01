import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSkill, readSkillRaw } from './userSkills';

/** Same isolation pattern as vaults.test.ts: userSkills.ts re-reads
 * process.env.SKILLS_DIR (via env.ts) on every call rather than caching it
 * at import time, so pointing it at a fresh temp dir per test is enough —
 * no module reset needed. Nested under one top-level test so Node's test
 * runner can't interleave sibling tests racing the same env var. */
function useTmpSkillsDir(): void {
	process.env.SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'user-skills-test-'));
}

const VALID_SKILL = '---\ndescription: test skill\n---\nGövde metni.';

test('userSkills path safety', async (t) => {
	await t.test('a name containing a path separator is rejected outright', () => {
		useTmpSkillsDir();
		assert.throws(() => writeSkill('../../pwned', VALID_SKILL), /Geçersiz skill adı/);
		assert.throws(() => writeSkill('..\\..\\pwned', VALID_SKILL), /Geçersiz skill adı/);
		assert.throws(() => writeSkill('sub/dir', VALID_SKILL), /Geçersiz skill adı/);
	});

	await t.test('the rejected write never touches the filesystem outside skillsDir', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-skills-test-'));
		process.env.SKILLS_DIR = dir;
		const outside = path.join(path.dirname(dir), 'pwned.md');
		assert.throws(() => writeSkill('../pwned', VALID_SKILL));
		assert.ok(!fs.existsSync(outside));
	});

	await t.test('an ordinary name still writes and reads back normally', () => {
		useTmpSkillsDir();
		writeSkill('normal-name', VALID_SKILL);
		const raw = readSkillRaw('normal-name');
		assert.ok(raw?.includes('Gövde metni.'));
	});

	await t.test('an empty name is rejected', () => {
		useTmpSkillsDir();
		assert.throws(() => writeSkill('', VALID_SKILL), /Geçersiz skill adı/);
	});
});
