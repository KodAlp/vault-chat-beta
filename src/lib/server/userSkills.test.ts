import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	writeSkill,
	readSkillRaw,
	listAllUserSkillFiles,
	resolveSkillFolderPath,
	readSkillSupportingFile,
	deleteSkill
} from './userSkills';

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

/** A folder-skill created directly on disk (as the zip-upload endpoint
 * would create one) rather than through writeSkill, which only ever
 * produces flat files — mirrors how a real zip extraction lands. */
function makeFolderSkill(dir: string, files: Record<string, string>): void {
	fs.mkdirSync(dir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, 'utf-8');
	}
}

// ensureExampleSkills() (userSkills.ts) seeds three disabled _examples/*.md
// skills into a fresh skillsDir on first read — excluded here so these
// tests assert only on what they themselves created.
function nonExampleSkills() {
	return listAllUserSkillFiles().filter((s) => !s.relPath.startsWith('_examples/'));
}

test('folder-skill discovery and path safety', async (t) => {
	await t.test('a SKILL.md + references/ folder is discovered as ONE skill, not two', () => {
		useTmpSkillsDir();
		makeFolderSkill(path.join(process.env.SKILLS_DIR!, 'math-tutor'), {
			'SKILL.md': '---\ndescription: math tutor\n---\nGövde.',
			'references/proofs.md': 'Kanıt notları.'
		});
		const skills = nonExampleSkills();
		assert.equal(skills.length, 1);
		assert.equal(skills[0].name, 'math-tutor');
		assert.equal(skills[0].isFolder, true);
		assert.deepEqual(skills[0].files, ['references/proofs.md']);
	});

	await t.test('a folder without SKILL.md keeps the old "every .md is its own skill" behavior', () => {
		useTmpSkillsDir();
		makeFolderSkill(path.join(process.env.SKILLS_DIR!, 'loose-notes'), {
			'a.md': '---\ndescription: a\n---\nA.',
			'b.md': '---\ndescription: b\n---\nB.'
		});
		const skills = nonExampleSkills();
		assert.equal(skills.length, 2);
		assert.ok(skills.every((s) => !s.isFolder));
	});

	await t.test('resolveSkillFolderPath rejects a traversal attempt', () => {
		useTmpSkillsDir();
		makeFolderSkill(path.join(process.env.SKILLS_DIR!, 'math-tutor'), {
			'SKILL.md': '---\ndescription: math tutor\n---\nGövde.'
		});
		assert.throws(() => resolveSkillFolderPath('math-tutor', '../../evil.md'), /dışına çıkıyor/);
	});

	await t.test('readSkillSupportingFile reads an allowed file and rejects a disallowed extension', () => {
		useTmpSkillsDir();
		makeFolderSkill(path.join(process.env.SKILLS_DIR!, 'math-tutor'), {
			'SKILL.md': '---\ndescription: math tutor\n---\nGövde.',
			'references/proofs.md': 'Kanıt notları.',
			'scripts/run.sh': '#!/bin/sh\necho hi'
		});
		const { content } = readSkillSupportingFile('math-tutor', 'references/proofs.md');
		assert.equal(content, 'Kanıt notları.');
		assert.throws(() => readSkillSupportingFile('math-tutor', 'scripts/run.sh'), /Desteklenmeyen dosya türü/);
	});

	await t.test('deleteSkill on a folder-skill removes the whole directory', () => {
		useTmpSkillsDir();
		const dir = path.join(process.env.SKILLS_DIR!, 'math-tutor');
		makeFolderSkill(dir, {
			'SKILL.md': '---\ndescription: math tutor\n---\nGövde.',
			'references/proofs.md': 'Kanıt notları.'
		});
		assert.ok(deleteSkill('math-tutor'));
		assert.ok(!fs.existsSync(dir));
	});
});
