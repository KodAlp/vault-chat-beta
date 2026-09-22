import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORE_INVARIANTS, DEFAULT_ALLOWED_LANGUAGES, buildPromptMessages, coreIntro } from './prompt';
import { closeVaultStudyDb } from './study-db';
import type { VaultContext } from './vaults';
import type { ChatMessage, RetrievedChunk } from '$lib/types';

/**
 * F9 — a regression test for prompt.ts, which had none despite F3/F6/F7/F8 all editing it this session
 * (memory/review blocks, two new CORE_INVARIANTS bullets, the mode parameter). No database, no Ollama:
 * memoryBlock is forced empty via CHAT_MEMORY_GATE=0 (F3's own kill switch, checked before any DB read — never
 * touches the chats.db singleton), skillsBlock via an empty SKILLS_DIR (same isolation userSkills.test.ts uses),
 * and reviewBlock either via mode='free_chat' (never computed at all, per prompt.ts's own guard) or a fresh
 * throwaway vault's own study.db (per-vault Map in study-db.ts, not a global singleton — safe to open per test,
 * same withVault pattern as learner-store.test.ts).
 */

const ORIGINAL_CORE_INVARIANTS = `Kurallar:
- Tüm matematiği kesinlikle $...$ (satır içi) veya $$...$$ (blok) içinde yaz.
  Asla \\( \\) ya da \\[ \\] kullanma, asla çıplak LaTeX komutu yazma.
- Bir formülü yazmaya başladıysan yarım bırakma: her \\frac{}{}, \\sqrt{},
  üst/alt simge gibi yapının açtığı parantez/süslü parantezi kapat ve
  formülü tamamla, sonra $ veya $$ ile kapat.
- Aşağıdaki <context> bloğundaki notları kullandığında kaynağını topic başlığıyla belirt.
- <context> soruyu kapsamıyorsa bunu açıkça söyle; kapsamayan bir konuda uydurma cevap verme.
- Selamlaşma, sohbet, argo, hakaret, teşekkür ya da deneme gibi mesajlara yalnızca o mesajın kendisine karşılık ver; notlardan hiç söz etme.
- Bilginin kaynağını köşeli parantez etiketiyle değil cümlenin kendisiyle belli et: nottan
  geliyorsa öyle söyle, mantıksal bir çıkarımsa ayrı belirt, öğretici bir örnek ya da benzetme
  kuruyorsan bunu açıkça söyle ve benzetmenin nerede kırıldığını da ekle, henüz doğrulanmamış
  bir şeyi kesinmiş gibi sunma.
- Kaynağın kendi kesinlik derecesini koru: "genellikle", "bazı durumlarda" diyen bir kaynağı
  kesinmiş gibi aktarma, istisnalarını düşürme.`;

test('CORE_INVARIANTS is exactly what it was when this test was written', () => {
	assert.equal(CORE_INVARIANTS, ORIGINAL_CORE_INVARIANTS);
});

test('coreIntro: single language, no secondary-language note', () => {
	const out = coreIntro(['Türkçe']);
	assert.match(out, /Her zaman Türkçe dilinde cevap ver\.$/);
	assert.ok(!out.includes('Gerektiğinde'));
});

test('coreIntro: extra languages add the secondary-language note', () => {
	const out = coreIntro(['Türkçe', 'Korece']);
	assert.match(out, /Türkçe dilinde cevap ver\. Gerektiğinde şu dillerden kelime\/örnek de kullanabilirsin: Korece\./);
});

test('coreIntro: an empty list falls back to DEFAULT_ALLOWED_LANGUAGES', () => {
	assert.equal(coreIntro([]), coreIntro(DEFAULT_ALLOWED_LANGUAGES));
});

function useEmptySkillsDir(): void {
	process.env.SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-skills-'));
}

const userMessage = (content: string): ChatMessage => ({ id: 'm1', role: 'user', content });

test('free_chat, no memory notes, no skills, no chunks: the system prompt is exactly coreIntro + CORE_INVARIANTS', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Merhaba')], [], ['Türkçe'], v, 'free_chat');
		const system = messages[0];
		assert.equal(system.role, 'system');
		assert.equal(system.content, `${coreIntro(['Türkçe'])}\n\n${CORE_INVARIANTS}`);
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('the last message carries the <context> block built from the given chunks, above the question', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	const chunk: RetrievedChunk = { path: 'wiki/os/scheduling.md', heading_path: 'A > B', display_text: 'İçerik burada.', topic: 'Scheduling', depth: 'undergrad', domains: ['os'], distance: 0.3 };
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Zamanlayıcı nedir?')], [chunk], ['Türkçe'], v, 'free_chat');
		const last = messages[messages.length - 1];
		assert.equal(last.role, 'user');
		assert.match(last.content, /^<context>\n\[Scheduling \| A > B\] \(wiki\/os\/scheduling\.md, depth: undergrad\)\nİçerik burada\.\n<\/context>\n\nZamanlayıcı nedir\?$/);
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('no chunks: no <context> block, the question is sent as-is', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Selam')], [], ['Türkçe'], v, 'free_chat');
		assert.equal(messages[messages.length - 1].content, 'Selam');
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('prior turns are carried between the system message and the final question, in order', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	const history: ChatMessage[] = [
		{ id: '1', role: 'user', content: 'ilk soru' },
		{ id: '2', role: 'assistant', content: 'ilk cevap' },
		{ id: '3', role: 'user', content: 'ikinci soru' }
	];
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages(history, [], ['Türkçe'], v, 'free_chat');
		assert.deepEqual(
			messages.slice(1, -1).map((m) => [m.role, m.content]),
			[['user', 'ilk soru'], ['assistant', 'ilk cevap']]
		);
		assert.equal(messages[messages.length - 1].content, 'ikinci soru');
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('review mode with nothing to review: the review block is still in the system prompt, between skills and CORE_INVARIANTS', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Merhaba')], [], ['Türkçe'], v, 'review');
		const system = messages[0].content;
		assert.match(system, /## Tekrar oturumu/);
		assert.match(system, /şu anda belirgin bir öncelik yok/);
		// order: coreIntro, then the review block, then CORE_INVARIANTS last (non-overridable)
		const reviewIdx = system.indexOf('## Tekrar oturumu');
		const invariantsIdx = system.indexOf('Kurallar:');
		assert.ok(reviewIdx > 0 && reviewIdx < invariantsIdx);
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('free_chat never computes a review block, even with review-worthy data in the vault: the system prompt has no "Tekrar oturumu" section', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Merhaba')], [], ['Türkçe'], v, 'free_chat');
		assert.ok(!messages[0].content.includes('Tekrar oturumu'));
	});
	delete process.env.CHAT_MEMORY_GATE;
});

/** withVault's cleanup (closeVaultStudyDb + rmSync) must run after the async buildPromptMessages call settles,
 * not right after the synchronous part of it returns — unlike computeReviewBlock (no real internal await),
 * buildPromptMessages does have a real `await Promise.all(...)`, so the DB work is not necessarily done
 * synchronously before this function returns. */
async function withVaultAsync(fn: (v: VaultContext) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-vault-'));
	const v: VaultContext = { id: `t-${Math.random().toString(36).slice(2)}`, name: 't', dir, libraryRoot: dir, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
	try {
		await fn(v);
	} finally {
		closeVaultStudyDb(v.id);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
