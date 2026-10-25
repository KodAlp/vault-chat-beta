import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORE_INVARIANTS, CORE_INVARIANTS_EN, DEFAULT_ALLOWED_LANGUAGES, NO_RELEVANT_SOURCES_BLOCK, NO_RELEVANT_SOURCES_BLOCK_EN, buildPromptMessages, coreIntro } from './prompt';
import { renderUserSkillsBlock, writeSkill } from './userSkills';
import { closeVaultStudyDb } from './study-db';
import type { VaultContext } from './vaults';
import type { ChatMessage, RetrievedChunk } from '#lib/types.js';

/**
 * A regression test for prompt.ts, which had none despite the memory, review-mode and history features all editing it
 * (memory/review blocks, two new CORE_INVARIANTS bullets, the mode parameter). No database, no Ollama:
 * memoryBlock is forced empty via CHAT_MEMORY_GATE=0 (the memory gate's own kill switch, checked before any DB read — never
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

test('coreIntro: fixed mode, single language, no secondary-language note', () => {
	const out = coreIntro(['Türkçe'], 'fixed');
	assert.match(out, /Her zaman Türkçe dilinde cevap ver\.$/);
	assert.ok(!out.includes('Gerektiğinde'));
});

test('coreIntro: fixed mode, extra languages add the secondary-language note', () => {
	const out = coreIntro(['Türkçe', 'Korece'], 'fixed');
	assert.match(out, /Türkçe dilinde cevap ver\. Gerektiğinde şu dillerden kelime\/örnek de kullanabilirsin: Korece\./);
});

test('coreIntro: an empty list falls back to DEFAULT_ALLOWED_LANGUAGES', () => {
	assert.equal(coreIntro([], 'fixed'), coreIntro(DEFAULT_ALLOWED_LANGUAGES, 'fixed'));
	assert.equal(coreIntro([], 'match'), coreIntro(DEFAULT_ALLOWED_LANGUAGES, 'match'));
});

test('coreIntro: match mode (default) names the last-message rule, not a fixed language rule', () => {
	const out = coreIntro(['Türkçe']);
	assert.match(out, /Kullanıcının son mesajı hangi dilde yazılmışsa o dilde cevap ver/);
	assert.match(out, /Son mesaj dili anlaşılamayacak kadar kısaysa ya da yalnızca kod\/formülden oluşuyorsa Türkçe kullan\./);
	assert.ok(!out.includes('Her zaman Türkçe dilinde cevap ver.'));
});

test('coreIntro: match mode still adds the secondary-language note', () => {
	const out = coreIntro(['Türkçe', 'Korece'], 'match');
	assert.match(out, /Gerektiğinde şu dillerden kelime\/örnek de kullanabilirsin: Korece\./);
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

test('fixed mode: the last message carries the <context> block built from the given chunks, above the question, with no directive appended', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	const chunk: RetrievedChunk = { path: 'wiki/os/scheduling.md', heading_path: 'A > B', display_text: 'İçerik burada.', topic: 'Scheduling', depth: 'undergrad', domains: ['os'], distance: 0.3 };
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Zamanlayıcı nedir?')], [chunk], ['Türkçe'], v, 'free_chat', {
			responseLanguage: 'fixed'
		});
		const last = messages[messages.length - 1];
		assert.equal(last.role, 'user');
		assert.match(last.content, /^<context>\n\[Scheduling \| A > B\] \(wiki\/os\/scheduling\.md, depth: undergrad\)\nİçerik burada\.\n<\/context>\n\nZamanlayıcı nedir\?$/);
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('fixed mode: no chunks, no directive: the question is sent as-is', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Selam')], [], ['Türkçe'], v, 'free_chat', {
			responseLanguage: 'fixed'
		});
		assert.equal(messages[messages.length - 1].content, 'Selam');
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('match mode (default): a directive naming the detected language is appended to the last user message', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages(
			[userMessage('How does a B-tree keep itself balanced when you insert a lot of new keys into it?')],
			[],
			['Türkçe'],
			v,
			'free_chat'
		);
		const last = messages[messages.length - 1];
		assert.match(last.content, /\n\n\(Answer in English\.\)$/);
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('match mode: prior (historical) turns are never retagged — only the final user message gets a directive', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	const history: ChatMessage[] = [
		{ id: '1', role: 'user', content: 'What is a B-tree?' },
		{ id: '2', role: 'assistant', content: 'A B-tree is a balanced search tree used for indexing...' },
		{ id: '3', role: 'user', content: 'peki silme işlemini nasıl yönetiyor?' }
	];
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages(history, [], ['Türkçe'], v, 'free_chat');
		const prior = messages.slice(1, -1);
		for (const m of prior) assert.ok(!m.content.includes('(Answer in'));
		assert.match(messages[messages.length - 1].content, /\(Answer in Turkish\.\)$/);
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
		const messages = await buildPromptMessages(history, [], ['Türkçe'], v, 'free_chat', { responseLanguage: 'fixed' });
		assert.deepEqual(
			messages.slice(1, -1).map((m) => [m.role, m.content]),
			[['user', 'ilk soru'], ['assistant', 'ilk cevap']]
		);
		assert.equal(messages[messages.length - 1].content, 'ikinci soru');
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('numCtx shrinks the history budget to what is left in the window; without numCtx the 12K ceiling applies', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	const big = 'x'.repeat(2000);
	const history: ChatMessage[] = [];
	for (let i = 0; i < 5; i++) {
		history.push({ id: 'u' + i, role: 'user', content: big });
		history.push({ id: 'a' + i, role: 'assistant', content: big });
	}
	history.push({ id: 'last', role: 'user', content: 'son soru' });
	await withVaultAsync(async (v) => {
		const unbounded = await buildPromptMessages(history, [], ['Türkçe'], v, 'free_chat', { responseLanguage: 'fixed' });
		assert.equal(unbounded.length - 2, 6); // 12000 / 2000 prior turns kept
		// A window already (nearly) full with system + question + output reserve: only the newest prior turn survives.
		const tight = await buildPromptMessages(history, [], ['Türkçe'], v, 'free_chat', { responseLanguage: 'fixed', numCtx: 2100 });
		assert.equal(tight.length - 2, 1);
		// A roomy window keeps the ceiling.
		const roomy = await buildPromptMessages(history, [], ['Türkçe'], v, 'free_chat', { responseLanguage: 'fixed', numCtx: 32768 });
		assert.equal(roomy.length - 2, 6);
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

test('the core prompt does not position the app as Obsidian-based', () => {
	for (const mode of ['match', 'fixed'] as const) {
		const text = `${coreIntro(['Türkçe', 'English'], mode)}\n${CORE_INVARIANTS}`;
		assert.ok(!/obsidian/i.test(text), 'core prompt mentions Obsidian');
		assert.ok(!/ikinci beyin/i.test(text), 'core prompt mentions "ikinci beyin"');
	}
});

test('noRelevantSources: the notice ends the system prompt and the question stays bare', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Kotlin coroutine nedir?')], [], ['Türkçe'], v, 'free_chat', {
			responseLanguage: 'fixed',
			noRelevantSources: true
		});
		const last = messages[messages.length - 1];
		assert.equal(last.content, 'Kotlin coroutine nedir?');
		assert.ok(messages[0].content.endsWith(NO_RELEVANT_SOURCES_BLOCK));
		assert.match(NO_RELEVANT_SOURCES_BLOCK, /bulunamadı/);
		assert.match(NO_RELEVANT_SOURCES_BLOCK, /notlardan gelmediğini/);
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test('noRelevantSources never overrides real chunks and is absent by default', async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	const chunk: RetrievedChunk = { path: 'wiki/a.md', heading_path: 'A', display_text: 'x', topic: 'T', depth: 'undergrad', domains: [], distance: 0.3 };
	await withVaultAsync(async (v) => {
		const withChunk = await buildPromptMessages([userMessage('Soru?')], [chunk], ['Türkçe'], v, 'free_chat', { responseLanguage: 'fixed', noRelevantSources: true });
		assert.match(withChunk[withChunk.length - 1].content, /^<context>/);
		assert.ok(!withChunk[0].content.includes(NO_RELEVANT_SOURCES_BLOCK));
		const plain = await buildPromptMessages([userMessage('Soru?')], [], ['Türkçe'], v, 'free_chat', { responseLanguage: 'fixed' });
		assert.equal(plain[plain.length - 1].content, 'Soru?');
		assert.ok(!plain[0].content.includes(NO_RELEVANT_SOURCES_BLOCK));
	});
	delete process.env.CHAT_MEMORY_GATE;
});

// --- promptLanguage ('tr' production default must stay byte-identical; 'en' only for the A/B) ---

const ORIGINAL_MATCH_INTRO = `Sen bu kişisel bilgi kütüphanesinin öğretici asistanısın.
Kullanıcının son mesajı hangi dilde yazılmışsa o dilde cevap ver; sohbetin önceki dili değil, son mesajın dili belirleyicidir. Son mesaj dili anlaşılamayacak kadar kısaysa ya da yalnızca kod/formülden oluşuyorsa Türkçe kullan.`;

test("promptLanguage 'tr' and omitted give the exact production system prompt", async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const omitted = await buildPromptMessages([userMessage('Merhaba')], [], ['Türkçe'], v, 'free_chat');
		const explicit = await buildPromptMessages([userMessage('Merhaba')], [], ['Türkçe'], v, 'free_chat', { promptLanguage: 'tr' });
		const expected = `${ORIGINAL_MATCH_INTRO}\n\n${ORIGINAL_CORE_INVARIANTS}`;
		assert.equal(omitted[0].content, expected);
		assert.deepEqual(explicit, omitted);
		const withNotice = await buildPromptMessages([userMessage('Soru?')], [], ['Türkçe'], v, 'free_chat', {
			promptLanguage: 'tr',
			noRelevantSources: true
		});
		assert.equal(withNotice[0].content, `${expected}\n\n${NO_RELEVANT_SOURCES_BLOCK}`);
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test("promptLanguage 'en' carries no Turkish rule text and uses the English blocks", async () => {
	process.env.CHAT_MEMORY_GATE = '0';
	useEmptySkillsDir();
	await withVaultAsync(async (v) => {
		const messages = await buildPromptMessages([userMessage('Hello')], [], ['Türkçe'], v, 'free_chat', {
			promptLanguage: 'en',
			noRelevantSources: true
		});
		const system = messages[0].content;
		assert.equal(
			system,
			`${coreIntro(['Türkçe'], 'match', 'en')}\n\n${CORE_INVARIANTS_EN}\n\n${NO_RELEVANT_SOURCES_BLOCK_EN}`
		);
		// The language name itself ("Türkçe") comes from vault settings and is the only allowed Turkish.
		const withoutName = system.replaceAll('Türkçe', '');
		assert.ok(!/[çğıöşüÇĞİÖŞÜ]/.test(withoutName), 'no Turkish letters outside the language name');
		for (const word of ['Kurallar', 'Sen bu', 'cevap ver', 'kaynağını', 'uydurma', 'notlardan']) {
			assert.ok(!system.includes(word), word);
		}
		assert.match(CORE_INVARIANTS_EN, /\$\.\.\.\$ \(inline\) or \$\$\.\.\.\$\$ \(block\)/);
		assert.ok(CORE_INVARIANTS_EN.includes('\\( \\)'));
	});
	delete process.env.CHAT_MEMORY_GATE;
});

test("coreIntro 'en': fixed mode and the secondary-language note", () => {
	assert.equal(
		coreIntro(['Türkçe', 'Korece'], 'fixed', 'en'),
		'You are the teaching assistant of this personal knowledge library.\nAlways answer in Türkçe. When needed, you may also use words/examples from these languages: Korece.'
	);
	assert.match(coreIntro(['Türkçe'], 'match', 'en'), /use Türkçe\.$/);
});

test("renderUserSkillsBlock: 'en' renders an English header, default stays Turkish", async () => {
	useEmptySkillsDir();
	writeSkill('demo-rule', '---\ndescription: demo\n---\nBody text.');
	assert.match(await renderUserSkillsBlock('chat'), /^## Kullanıcı kuralı: demo-rule\nBody text\./);
	assert.match(await renderUserSkillsBlock('chat', { language: 'en' }), /^## User rule: demo-rule\nBody text\./);
});
