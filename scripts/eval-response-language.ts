/**
 * Response-language measurement (see .agents docs for the bug this feeds): the chat prompt's
 * coreIntro() hardcodes "Her zaman Türkçe dilinde cevap ver." (prompt.ts), so an English question
 * from the user still gets a Turkish answer. Before touching product code, this script measures
 * prompt variants against a real local model to see which one actually fixes it:
 *
 *   V0 — current behavior: exactly what buildPromptMessages() produces today (allowedLanguages
 *        defaults to ['Türkçe'], same as library-read.ts's DEFAULT_ALLOWED_LANGUAGES).
 *   V1 — prompt-rule only: the one sentence above is replaced with an instruction to answer in
 *        whichever language the user's LAST message is written in — explicitly the last message,
 *        not the conversation's established language — falling back to Turkish only when that
 *        message itself is too short/ambiguous or code/formula-only to read a language off of.
 *        (An earlier version of this sentence also listed greetings as a fallback trigger — a
 *        spec bug caught by the first measurement round: it made "hey there, how's it going"
 *        correctly answer in Turkish per the sentence's own wording while this file's battery
 *        expected English. Fixed here; greeting-en now expects 'eng' with no contradiction.)
 *   V2 — V1 + language detection on the LAST message only: franc-min (trigram-based — no
 *        per-language word list, per the user's explicit rejection of that approach) detects the
 *        last user message's language. Only when detection clears both an absolute length gate
 *        and a top1/top2 score-margin gate (see MIN_LETTERS/MARGIN_THRESHOLD below — both picked
 *        empirically, see this file's calibration notes in the handback report) does the script
 *        append one short directive line to the end of the last user message, e.g.
 *        "\n\n(Answer in German.)" — the English language name is derived generically from
 *        franc's ISO 639-3 code via Intl.DisplayNames(['en'], {type:'language'}), which accepts
 *        3-letter codes directly, so there is no hand-written per-language phrase table. When
 *        detection is not reliable, V2 == V1 for that message (no line appended).
 *   V3 — V1 + a directive on EVERY user turn in the prompt (not just the last one), aimed at
 *        breaking "conversation momentum" — the pattern the first round's follow-up cases showed,
 *        where the model kept answering in the conversation's established language even after the
 *        user switched languages mid-chat. Each user-role message gets its own directive, chosen
 *        from its own text independently:
 *          - franc-min reliable (same gate as V2)      -> "(Answer in <English name>.)"
 *          - not reliable but >=8 letters after strip   -> "(Answer in the same language as this
 *                                                           message.)" (language-independent — no
 *                                                           guess is made, just "match this one")
 *          - <8 letters, or code/formula-only           -> "(Answer in <primary>.)", where
 *                                                           <primary> is derived from the vault's
 *                                                           configured primary language ('Türkçe')
 *                                                           via franc+Intl.DisplayNames, not
 *                                                           hand-written as the literal "Turkish".
 *        Round 2's measurement found this genuinely helps (V3 beat V1/V2 overall) but its middle
 *        "generic" tier is weak — one follow-up case regressed because both the historical English
 *        turn and the new Turkish turn got the same vague "(Answer in the same language as this
 *        message.)" tag, naming nothing concrete for the model to grab onto.
 *   V4 — V1 + a directive on ONLY the last user turn (this is the production-realistic version —
 *        historical turns are never retagged in real usage, since they were already sent to the
 *        model in earlier requests). No vague "generic" tier: every branch names a concrete
 *        language, via decideResponseLanguage() (a standalone pure function, written to be liftable
 *        into product code as-is):
 *          - <8 letters, or code/formula-only            -> primary language (derived from the
 *                                                            vault's configured primary name via
 *                                                            franc+Intl, same as V3's fallback).
 *          - >=8 letters, franc-min reliable on the FULL  -> that language (same gate as V2/V3).
 *            language set (MIN_LETTERS/MARGIN_THRESHOLD)
 *          - >=8 letters, not reliable on the full set    -> re-run franc-min restricted to a
 *                                                            NARROWED candidate set via its `only`
 *                                                            option: {primary, English} union
 *                                                            whichever languages were reliably
 *                                                            detected (same full-set gate) in this
 *                                                            conversation's EARLIER user turns. This
 *                                                            set is derived from the live
 *                                                            conversation, not a hand-written word
 *                                                            list. A small margin
 *                                                            (NARROW_MARGIN_THRESHOLD) is still
 *                                                            required within that narrowed set;
 *                                                            below it, falls through to primary.
 *        Restricting the language universe turns out to fix exactly the cases that broke the
 *        full-language detector: Turkish slang no longer competes against Lingala/Azerbaijani, and
 *        a short English follow-up no longer competes against Portuguese — it only has to beat
 *        Turkish and English.
 *   PROD — the actual product path: builds messages through the real, modified
 *        buildPromptMessages() (src/lib/server/prompt.ts) with LibrarySettings.responseLanguage
 *        'match' (opts.responseLanguage), instead of hand-applying V1's sentence swap + V4's
 *        directive append on top of a V0 call the way V4 does here. Exists to prove the shipped
 *        product code behaves identically to V4's measured 90/90 result, not just this script's
 *        own reimplementation of it.
 *
 * This is a REPORT, not a pass/fail gate — same posture as eval-prompt-injection.ts, which this
 * file's isolation is modeled on line for line: CHAT_MEMORY_GATE=0 (short-circuits before any
 * chats.db read), an empty temp SKILLS_DIR, a throwaway temp vault directory nobody else uses,
 * and a direct POST to Ollama's native /api/chat (stream:false) — not through the app's
 * provider/fallback chain. No app data is touched. Chat temperature is left unset, matching the
 * real chat route's 'chat' task (only generation tasks pin temperature) — so a single call per
 * (case, variant) is noisy; --repeats > 1 runs each (case, variant) pair N times so accuracy
 * numbers come with a real sample size and a Wilson 95% CI, not a single noisy draw.
 *
 *   npx tsx scripts/eval-response-language.ts [--model <name>] [--url <ollama-url>]
 *                                              [--variants V1,V2,V3,V4] [--limit N] [--repeats N]
 */
import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { franc } from 'franc-min';
import { buildPromptMessages } from '../src/lib/server/prompt';
import { closeVaultStudyDb } from '../src/lib/server/study-db';
const ollamaUrl = (): string => process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
import type { VaultContext } from '../src/lib/server/vaults';
import type { ChatMessage, RetrievedChunk } from '../src/lib/types';
import type { ChatMessage as ProviderChatMessage } from '../src/lib/server/providers/types';
import {
	MIN_LETTERS,
	MARGIN_THRESHOLD,
	MIN_LETTERS_GENERIC,
	NARROW_MARGIN_THRESHOLD,
	stripForDetection,
	countLetters,
	iso3ToEnglishName,
	detectReliable,
	decideResponseLanguage,
	responseLanguageDirective,
	resolveLanguageName,
	type LanguageDecision
} from '../src/lib/server/response-language';

const argv = process.argv.slice(2);
const value = (name: string) => {
	const i = argv.indexOf(name);
	return i !== -1 ? argv[i + 1] : undefined;
};

const model = value('--model') ?? 'qwen3:8b';
const url = value('--url') ?? ollamaUrl();
const variantsArg = value('--variants') ?? 'V0,V1,V2,V3';
const variants = variantsArg.split(',').map((s) => s.trim()) as Variant[];
const limit = value('--limit') ? Number(value('--limit')) : Infinity;
const repeats = value('--repeats') ? Math.max(1, Number(value('--repeats'))) : 1;

type Variant = 'V0' | 'V1' | 'V2' | 'V3' | 'V4' | 'PROD';

// The exact sentence coreIntro() emits today when allowedLanguages is ['Türkçe'] (the app's
// default — see prompt.ts's DEFAULT_ALLOWED_LANGUAGES / library-read.ts). This script always
// calls buildPromptMessages with ['Türkçe'], so this literal always matches V0's output — a
// failed replace() throws below rather than silently shipping V0 under the V1/V2/V3 label.
const ORIGINAL_SENTENCE = 'Her zaman Türkçe dilinde cevap ver.';
// Round 2 wording — fixes a spec bug the first round's greeting-en case exposed: the original
// V1 sentence listed "selamlaşma" (greeting) alongside "very short"/"code-only" as a Turkish-
// fallback trigger, so "hey there, how's it going" answering in Turkish was actually CORRECT per
// that sentence's own wording, not a fix failure. Greetings are no longer a fallback trigger here
// — only genuine ambiguity (too short to read a language off of, or code/formula-only) is.
const V1_SENTENCE =
	'Kullanıcının son mesajı hangi dilde yazılmışsa o dilde cevap ver; sohbetin önceki dili değil, son mesajın dili belirleyicidir. Son mesaj dili anlaşılamayacak kadar kısaysa ya da yalnızca kod/formülden oluşuyorsa Türkçe kullan.';

// V2/V3/V4 reliability-gate constants (MIN_LETTERS, MARGIN_THRESHOLD, MIN_LETTERS_GENERIC,
// NARROW_MARGIN_THRESHOLD) and the detection helpers (stripForDetection, countLetters,
// iso3ToEnglishName, detectReliable, decideResponseLanguage) now live in
// src/lib/server/response-language.ts — lifted there verbatim so product code (prompt.ts) and
// this measurement script share one implementation. See that module's doc comment for the
// calibration story (the Lingala/Turkish-slang false positive that set these thresholds).

// The vault's configured primary/fallback language is a human-readable name ('Türkçe'), not an
// ISO code; resolveLanguageName() maps it through Intl.DisplayNames (same function production uses).
const PRIMARY_LANGUAGE = 'Türkçe';
const PRIMARY_ISO3 = resolveLanguageName(PRIMARY_LANGUAGE) ?? 'und';
// iso3ToEnglishName is a hoisted function declaration (defined further down in this file), so
// this call at module-eval time is safe despite appearing above its textual definition.
const PRIMARY_ENGLISH_NAME = iso3ToEnglishName(PRIMARY_ISO3) ?? PRIMARY_LANGUAGE;

/** Strips <think>…</think> reasoning traces before language-labeling or echo-checking an answer. */
function stripThink(text: string): string {
	let out = text.replace(/<think>[\s\S]*?<\/think>/g, ' ');
	// A truncated/unclosed <think> (shouldn't happen with stream:false, but be defensive):
	// drop everything from the open tag onward rather than label half a reasoning trace.
	const openIdx = out.indexOf('<think>');
	if (openIdx !== -1) out = out.slice(0, openIdx);
	return out.trim();
}

/** Labels an answer's language for scoring — same strip-first approach as detectReliable, but no
 * margin gate: this is a judge over much longer text, and francAll's own 'und' already covers
 * "too short/ambiguous to tell". */
function labelAnswerLanguage(answer: string): string {
	const stripped = stripForDetection(answer);
	if (countLetters(stripped) < 10) return 'und';
	return franc(stripped);
}

// --- Fixture chunks: realistic English notes, since the user's real vault is mostly English —
// this is the hard, realistic case the bug report actually showed (TR question over EN context
// must still answer in TR). ---
const CHUNK_BTREE: RetrievedChunk = {
	path: 'cs/databases/b-tree-indexing.md',
	heading_path: 'Indexing > B-Trees',
	topic: 'B-Tree Indexing',
	display_text:
		'A B-tree keeps itself balanced by splitting a node the moment an insert would overflow it: the ' +
		'median key moves up into the parent, and the node divides into two half-full siblings. Because ' +
		'every leaf sits at the same depth, a single split can cascade upward but never leaves the tree ' +
		'lopsided — the height only grows when the root itself splits.',
	depth: 'undergrad',
	domains: ['databases'],
	distance: 0.12
};
const CHUNK_TCP: RetrievedChunk = {
	path: 'cs/networking/tcp-congestion-control.md',
	heading_path: 'Congestion Control > Slow Start and Avoidance',
	topic: 'TCP Congestion Control',
	display_text:
		'TCP congestion collapse happens when the network drops packets faster than senders back off, so ' +
		'retransmissions pile onto an already-saturated link. Slow start grows the congestion window ' +
		'exponentially until a loss or ssthresh is hit, then congestion avoidance takes over and grows it ' +
		'only linearly (AIMD) — the window backoff on loss is what actually prevents collapse.',
	depth: 'undergrad',
	domains: ['networking'],
	distance: 0.15
};
const CHUNK_RUST: RetrievedChunk = {
	path: 'cs/languages/rust-ownership.md',
	heading_path: 'Ownership > Borrowing Rules',
	topic: 'Rust Ownership',
	display_text:
		'Rust\'s ownership rules prevent use-after-free at compile time by tracking, for every value, ' +
		'exactly one owner at a time. Moving a value invalidates the old binding, so the compiler rejects ' +
		'any later use of it; borrowing (&T / &mut T) lends access without transferring ownership, under a ' +
		'rule that allows many readers or one writer but never both at once.',
	depth: 'undergrad',
	domains: ['programming-languages'],
	distance: 0.1
};
const CHUNK_LOCKING: RetrievedChunk = {
	path: 'cs/databases/locking-strategies.md',
	heading_path: 'Concurrency Control > Locking',
	topic: 'Database Locking',
	display_text:
		'Pessimistic locking acquires a lock before touching a row, blocking other transactions until it ' +
		'commits — safe under heavy contention but limits throughput. Optimistic locking lets transactions ' +
		'proceed unlocked and checks a version/timestamp at commit time, retrying on conflict; it wins when ' +
		'conflicts are rare, since it never blocks readers or writers up front.',
	depth: 'undergrad',
	domains: ['databases'],
	distance: 0.13
};

function chunk(...chunks: RetrievedChunk[]): RetrievedChunk[] {
	return chunks;
}

function user(content: string, id = 'q'): ChatMessage {
	return { id, role: 'user', content };
}
function assistant(content: string, id = 'a'): ChatMessage {
	return { id, role: 'assistant', content };
}

interface EvalCase {
	id: string;
	category: string;
	history: ChatMessage[];
	chunks: RetrievedChunk[];
	/** ISO 639-3 code, same alphabet franc-min and the judge both speak. */
	expectedLang: string;
}

const CASES: EvalCase[] = [
	// --- English knowledge questions over English context (6) ---
	{ id: 'en-know-1', category: 'en-knowledge', history: [user('How does a B-tree keep itself balanced when you insert a lot of new keys into it?')], chunks: chunk(CHUNK_BTREE), expectedLang: 'eng' },
	{ id: 'en-know-2', category: 'en-knowledge', history: [user('What actually causes TCP congestion collapse, and how does window backoff fix it?')], chunks: chunk(CHUNK_TCP), expectedLang: 'eng' },
	{ id: 'en-know-3', category: 'en-knowledge', history: [user('Can you explain how Rust ownership rules prevent use-after-free bugs at compile time?')], chunks: chunk(CHUNK_RUST), expectedLang: 'eng' },
	{ id: 'en-know-4', category: 'en-knowledge', history: [user('Why does adding an index sometimes make a database query slower instead of faster?')], chunks: chunk(CHUNK_BTREE, CHUNK_LOCKING), expectedLang: 'eng' },
	{ id: 'en-know-5', category: 'en-knowledge', history: [user('What is the actual difference between optimistic and pessimistic locking in a database?')], chunks: chunk(CHUNK_LOCKING), expectedLang: 'eng' },
	{ id: 'en-know-6', category: 'en-knowledge', history: [user('How does the slow start phase differ from congestion avoidance in TCP?')], chunks: chunk(CHUNK_TCP), expectedLang: 'eng' },

	// --- Turkish knowledge questions over English context — the realistic hard case (6) ---
	{ id: 'tr-know-1', category: 'tr-knowledge', history: [user('Bir B-ağacına çok fazla yeni anahtar eklendiğinde denge nasıl korunuyor?')], chunks: chunk(CHUNK_BTREE), expectedLang: 'tur' },
	{ id: 'tr-know-2', category: 'tr-knowledge', history: [user('TCP\'de tıkanıklık çöküşüne tam olarak ne sebep oluyor ve pencere geri çekilmesi bunu nasıl düzeltiyor?')], chunks: chunk(CHUNK_TCP), expectedLang: 'tur' },
	{ id: 'tr-know-3', category: 'tr-knowledge', history: [user('Rust\'ın sahiplik kuralları derleme zamanında use-after-free hatalarını nasıl önlüyor?')], chunks: chunk(CHUNK_RUST), expectedLang: 'tur' },
	{ id: 'tr-know-4', category: 'tr-knowledge', history: [user('Bazen bir indeks eklemek bir veritabanı sorgusunu neden yavaşlatır?')], chunks: chunk(CHUNK_BTREE, CHUNK_LOCKING), expectedLang: 'tur' },
	{ id: 'tr-know-5', category: 'tr-knowledge', history: [user('Veritabanında iyimser ve kötümser kilitleme arasındaki fark tam olarak nedir?')], chunks: chunk(CHUNK_LOCKING), expectedLang: 'tur' },
	{ id: 'tr-know-6', category: 'tr-knowledge', history: [user('TCP\'de yavaş başlangıç aşaması tıkanıklık önleme aşamasından nasıl farklı?')], chunks: chunk(CHUNK_TCP), expectedLang: 'tur' },

	// --- German knowledge questions over English context (3) ---
	{ id: 'de-know-1', category: 'de-knowledge', history: [user('Wie bleibt ein B-Baum ausgeglichen, wenn man viele neue Schlüssel einfügt?')], chunks: chunk(CHUNK_BTREE), expectedLang: 'deu' },
	{ id: 'de-know-2', category: 'de-knowledge', history: [user('Was verursacht eigentlich den TCP-Stauzusammenbruch, und wie behebt das Fenster-Backoff das?')], chunks: chunk(CHUNK_TCP), expectedLang: 'deu' },
	{ id: 'de-know-3', category: 'de-knowledge', history: [user('Wie verhindern die Rust-Eigentumsregeln Use-after-free-Fehler zur Kompilierzeit?')], chunks: chunk(CHUNK_RUST), expectedLang: 'deu' },

	// --- Slang / informal (2 + 2) ---
	{ id: 'en-slang-1', category: 'en-slang', history: [user('yo how does a b-tree even work lol')], chunks: chunk(CHUNK_BTREE), expectedLang: 'eng' },
	{ id: 'en-slang-2', category: 'en-slang', history: [user('ngl idk why my query got slower after i added that index lmao')], chunks: chunk(CHUNK_BTREE, CHUNK_LOCKING), expectedLang: 'eng' },
	{ id: 'tr-slang-1', category: 'tr-slang', history: [user('abi b-tree nasıl çalışıyo ya')], chunks: chunk(CHUNK_BTREE), expectedLang: 'tur' },
	{ id: 'tr-slang-2', category: 'tr-slang', history: [user('kanka şu index kısmını bi türlü kafama sokamadım yardım et')], chunks: chunk(CHUNK_BTREE, CHUNK_LOCKING), expectedLang: 'tur' },

	// --- Very short / ambiguous (3) — expected fallback: Turkish ---
	{ id: 'ambiguous-1', category: 'ambiguous', history: [user('why?')], chunks: [], expectedLang: 'tur' },
	{ id: 'ambiguous-2', category: 'ambiguous', history: [user('ok')], chunks: [], expectedLang: 'tur' },
	{ id: 'ambiguous-3', category: 'ambiguous', history: [user('?')], chunks: [], expectedLang: 'tur' },

	// --- Code-only / formula-only (2) — expected fallback: Turkish ---
	{ id: 'code-only-1', category: 'code-or-formula', history: [user('```rust\nlet x = Box::new(5);\nlet y = x;\nprintln!("{}", x);\n```')], chunks: chunk(CHUNK_RUST), expectedLang: 'tur' },
	{ id: 'formula-only-1', category: 'code-or-formula', history: [user('$$O(\\log n)$$')], chunks: chunk(CHUNK_BTREE), expectedLang: 'tur' },

	// --- Mixed TR+EN, matrix language clear (2) ---
	{ id: 'mixed-tr-1', category: 'mixed', history: [user('index eklemek query\'yi neden yavaşlatıyor sometimes?')], chunks: chunk(CHUNK_BTREE, CHUNK_LOCKING), expectedLang: 'tur' },
	{ id: 'mixed-en-1', category: 'mixed', history: [user('so what actually happens when the düğüm (node) splits in a b-tree?')], chunks: chunk(CHUNK_BTREE), expectedLang: 'eng' },

	// --- Follow-up: prior turn Turkish, new message English (2); reverse (1) ---
	{ id: 'followup-tr-then-en-1', category: 'followup', history: [user('B-ağacı nedir?', 'p1'), assistant('B-ağacı, dengeli bir arama ağacı türüdür...', 'p2'), user('ok and how does it handle deletes?', 'q3')], chunks: chunk(CHUNK_BTREE), expectedLang: 'eng' },
	{ id: 'followup-tr-then-en-2', category: 'followup', history: [user('TCP tıkanıklık kontrolü nedir?', 'p1'), assistant('TCP tıkanıklık kontrolü, gönderici hızını ağın taşıma kapasitesine göre ayarlar...', 'p2'), user('interesting, what triggers slow start specifically?', 'q3')], chunks: chunk(CHUNK_TCP), expectedLang: 'eng' },
	{ id: 'followup-en-then-tr-1', category: 'followup', history: [user('What is a B-tree?', 'p1'), assistant('A B-tree is a balanced search tree used for indexing...', 'p2'), user('peki silme işlemini nasıl yönetiyor?', 'q3')], chunks: chunk(CHUNK_BTREE), expectedLang: 'tur' },

	// --- Greeting (1) ---
	{ id: 'greeting-en', category: 'greeting', history: [user('hey there, how\'s it going')], chunks: [], expectedLang: 'eng' }
];

interface CaseResult {
	id: string;
	category: string;
	variant: Variant;
	rep: number;
	expectedLang: string;
	detectedLang: string;
	correct: boolean;
	/** Final-user-turn directive for V2/V3 (V3 also logs every turn's directive separately, see
	 * appendedAll) — kept as a single field for reporting parity with V2. */
	appendedDirective: string | null;
	/** V3 only: directive appended to every user turn in the prompt, in order. */
	appendedAll?: (string | null)[];
	/** V3 only: which of the three tiers produced the final turn's directive. */
	v3Tier?: 'lang' | 'generic' | 'primary' | null;
	/** V4 only: which tier decideResponseLanguage resolved to, and its margin at that tier. */
	v4Tier?: 'reliable' | 'narrowed' | 'fallback' | null;
	v4Margin?: number | null;
	echoed: boolean;
	latencyMs: number;
	answerPreview: string;
}

/** Wilson score interval — more honest than a normal-approximation CI at the small-N, possibly-
 * extreme-proportion sizes this battery produces (e.g. 30/30). Returns [lower, upper] in [0,1]. */
function wilsonInterval(successes: number, total: number, z = 1.96): [number, number] {
	if (total === 0) return [0, 0];
	const p = successes / total;
	const denom = 1 + (z * z) / total;
	const center = p + (z * z) / (2 * total);
	const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
	return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

/** Applies V1's sentence swap to a system message's content. Throws if the exact sentence isn't
 * found — a silent no-op here would make V1/V2 byte-identical to V0 without anyone noticing. */
function applyV1(messages: ProviderChatMessage[]): ProviderChatMessage[] {
	const out = messages.map((m) => ({ ...m }));
	const sys = out.find((m) => m.role === 'system');
	if (!sys || !sys.content.includes(ORIGINAL_SENTENCE)) {
		throw new Error('V1: coreIntro sentence not found in system message — did prompt.ts change?');
	}
	sys.content = sys.content.replace(ORIGINAL_SENTENCE, V1_SENTENCE);
	return out;
}

/** Applies V2 on top of V1's messages: detects the RAW last user message (never the assembled
 * context+question blob — the context is always English regardless of the user's language and
 * would otherwise swamp the trigram signal), and appends a directive to the actual last message
 * in the array when detection clears the reliability gate. */
function applyV2(v1Messages: ProviderChatMessage[], rawLastUserText: string): { messages: ProviderChatMessage[]; appended: string | null } {
	const out = v1Messages.map((m) => ({ ...m }));
	const det = detectReliable(rawLastUserText);
	if (!det.reliable || !det.iso3) return { messages: out, appended: null };
	const name = iso3ToEnglishName(det.iso3);
	if (!name) return { messages: out, appended: null };
	const directive = `\n\n(Answer in ${name}.)`;
	const last = out[out.length - 1];
	last.content = `${last.content}${directive}`;
	return { messages: out, appended: directive };
}

type V3Tier = 'lang' | 'generic' | 'primary';

/** V3's per-message directive: three tiers (reliable detection / language-independent mirror /
 * explicit primary-language fallback). Never returns null — V3 tags every user turn with
 * something, unlike V2's all-or-nothing gate on the single last message. */
function directiveForV3(rawText: string): { text: string; tier: V3Tier } {
	const det = detectReliable(rawText);
	if (det.reliable && det.iso3) {
		const name = iso3ToEnglishName(det.iso3);
		if (name) return { text: `(Answer in ${name}.)`, tier: 'lang' };
	}
	const letters = countLetters(stripForDetection(rawText));
	if (letters >= MIN_LETTERS_GENERIC) return { text: '(Answer in the same language as this message.)', tier: 'generic' };
	return { text: `(Answer in ${PRIMARY_ENGLISH_NAME}.)`, tier: 'primary' };
}

/** Applies V3 on top of V1's messages: appends a directive to the end of EVERY user-role message
 * in the prompt (prior turns too, not just the last one) — the "break conversation momentum"
 * mechanism. A prior turn's message.content already equals its source history entry's raw text
 * (trimConversationHistory only drops whole turns from the front, never rewrites a kept one's
 * content — see history-limits.ts), so only the LAST user message needs its raw text sourced
 * separately (from `history`, before prompt.ts's context-block prefix is applied to it). Returns
 * the directive appended to the FINAL user turn (the one immediately preceding the model's turn,
 * and the one most comparable to V2's single appended directive for reporting/echo purposes)
 * alongside the full per-message list for the JSON log. */
function applyV3(
	v1Messages: ProviderChatMessage[],
	history: ChatMessage[]
): { messages: ProviderChatMessage[]; appendedByIndex: (string | null)[]; finalAppended: string | null; finalTier: V3Tier | null } {
	const out = v1Messages.map((m) => ({ ...m }));
	const lastUserRaw = history[history.length - 1].content;
	const finalIdx = out.length - 1;
	const appendedByIndex: (string | null)[] = out.map(() => null);
	let finalTier: V3Tier | null = null;

	out.forEach((m, i) => {
		if (m.role !== 'user') return;
		const rawText = i === finalIdx ? lastUserRaw : m.content;
		const { text, tier } = directiveForV3(rawText);
		m.content = `${m.content}\n\n${text}`;
		appendedByIndex[i] = text;
		if (i === finalIdx) finalTier = tier;
	});

	return { messages: out, appendedByIndex, finalAppended: appendedByIndex[finalIdx], finalTier };
}

// decideResponseLanguage / LanguageDecision now live in src/lib/server/response-language.ts
// (imported above) — this is the exact function lifted into product code (prompt.ts).

/** Applies V4 on top of V1's messages: appends exactly one directive to the END of the last user
 * message only (never historical turns — this is the production-realistic shape). Always appends
 * something (no "V4 == V1" silent case like V2) since decideResponseLanguage always names a
 * concrete language, down to the primary-language fallback tier. */
function applyV4(v1Messages: ProviderChatMessage[], history: ChatMessage[]): { messages: ProviderChatMessage[]; appended: string; decision: LanguageDecision } {
	const out = v1Messages.map((m) => ({ ...m }));
	const lastUserRaw = history[history.length - 1].content;
	const priorUserMessages = history
		.slice(0, -1)
		.filter((m) => m.role === 'user')
		.map((m) => m.content);
	const decision = decideResponseLanguage(lastUserRaw, priorUserMessages, PRIMARY_LANGUAGE);
	const directive = responseLanguageDirective(decision);
	const last = out[out.length - 1];
	last.content = `${last.content}\n\n${directive}`;
	return { messages: out, appended: directive, decision };
}

/** Quick self-test for decideResponseLanguage, printed at the start of a run — the exact examples
 * the coordinator asked to see (see handback report), not part of the scored battery. */
function runSelfTest(): void {
	console.log('\n--- decideResponseLanguage kendi testi ---');
	const cases: { lastMessage: string; priorUserMessages: string[] }[] = [
		{ lastMessage: 'abi b-tree nasıl çalışıyo ya', priorUserMessages: [] },
		{ lastMessage: 'peki silme işlemini nasıl yönetiyor?', priorUserMessages: ['What is a B-tree?'] },
		{ lastMessage: 'yo how does a b-tree even work lol', priorUserMessages: [] },
		{ lastMessage: 'why?', priorUserMessages: [] },
		{ lastMessage: 'ok', priorUserMessages: [] }
	];
	for (const { lastMessage, priorUserMessages } of cases) {
		const d = decideResponseLanguage(lastMessage, priorUserMessages, PRIMARY_LANGUAGE);
		const priorNote = priorUserMessages.length ? ` (önceki tur: ${JSON.stringify(priorUserMessages)})` : '';
		console.log(
			`  ${JSON.stringify(lastMessage)}${priorNote} -> iso3=${d.iso3} englishName=${d.englishName} tier=${d.tier} margin=${d.margin !== undefined ? d.margin.toFixed(3) : '-'}`
		);
	}
	console.log('--- kendi testi bitti ---\n');
}

async function callOllama(messages: ProviderChatMessage[]): Promise<{ answer: string; latencyMs: number }> {
	const start = Date.now();
	const res = await fetch(`${url}/api/chat`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model, messages, stream: false, think: false })
	});
	if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { message?: { content?: string } };
	return { answer: data.message?.content ?? '', latencyMs: Date.now() - start };
}

function fmtPct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function printTable(results: CaseResult[], cases: EvalCase[]) {
	for (const variant of variants) {
		const rows = results.filter((r) => r.variant === variant);
		if (rows.length === 0) continue;
		const correctCount = rows.filter((r) => r.correct).length;
		const overall = correctCount / rows.length;
		const [lo, hi] = wilsonInterval(correctCount, rows.length);
		const meanLatency = rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length;
		console.log(
			`\n=== ${variant} — genel doğruluk: ${fmtPct(overall)} (${correctCount}/${rows.length})  ` +
				`[%95 GA (Wilson): ${fmtPct(lo)}–${fmtPct(hi)}]  ortalama gecikme: ${(meanLatency / 1000).toFixed(1)}s ===`
		);

		const categories = [...new Set(rows.map((r) => r.category))];
		for (const cat of categories) {
			const catRows = rows.filter((r) => r.category === cat);
			const acc = catRows.filter((r) => r.correct).length / catRows.length;
			console.log(`  ${cat.padEnd(16)} ${fmtPct(acc).padStart(7)}  (${catRows.filter((r) => r.correct).length}/${catRows.length})`);
		}

		if (variant === 'V2' || variant === 'V3' || variant === 'V4' || variant === 'PROD') {
			const withDirective = rows.filter((r) => r.appendedDirective !== null);
			const echoRate = withDirective.length ? withDirective.filter((r) => r.echoed).length / withDirective.length : 0;
			console.log(`  yönerge eklenen örnek: ${withDirective.length}/${rows.length}  |  eko oranı: ${fmtPct(echoRate)} (${withDirective.filter((r) => r.echoed).length}/${withDirective.length || 0})`);
		}
		if (variant === 'V3') {
			for (const tier of ['lang', 'generic', 'primary'] as const) {
				const tierRows = rows.filter((r) => r.v3Tier === tier);
				if (tierRows.length === 0) continue;
				const acc = tierRows.filter((r) => r.correct).length / tierRows.length;
				console.log(`    son-tur katman=${tier.padEnd(8)} ${tierRows.length} örnek, doğruluk ${fmtPct(acc)}`);
			}
		}
		if (variant === 'V4' || variant === 'PROD') {
			for (const tier of ['reliable', 'narrowed', 'fallback'] as const) {
				const tierRows = rows.filter((r) => r.v4Tier === tier);
				if (tierRows.length === 0) continue;
				const acc = tierRows.filter((r) => r.correct).length / tierRows.length;
				console.log(`    karar katmanı=${tier.padEnd(10)} ${tierRows.length} örnek, doğruluk ${fmtPct(acc)}`);
			}
		}
	}

	// Per-case accuracy table — one row per case, one column per run variant, "doğru/tekrar".
	console.log('\n--- vaka bazında doğruluk (doğru/tekrar) ---');
	const header = `${'id'.padEnd(24)}${'kategori'.padEnd(16)}${'beklenen'.padEnd(10)}${variants.map((v) => v.padEnd(8)).join('')}`;
	console.log(header);
	for (const c of cases) {
		const cols = variants
			.map((variant) => {
				const rows = results.filter((r) => r.id === c.id && r.variant === variant);
				if (rows.length === 0) return '-'.padEnd(8);
				return `${rows.filter((r) => r.correct).length}/${rows.length}`.padEnd(8);
			})
			.join('');
		console.log(`${c.id.padEnd(24)}${c.category.padEnd(16)}${c.expectedLang.padEnd(10)}${cols}`);
	}

	console.log('\n--- başarısız örnekler (ilk 20) ---');
	const failures = results.filter((r) => !r.correct).slice(0, 20);
	for (const f of failures) {
		console.log(`[${f.variant} #${f.rep}] ${f.id} (${f.category}): beklenen=${f.expectedLang} algılanan=${f.detectedLang}`);
		console.log(`  cevap: ${f.answerPreview.slice(0, 160).replace(/\n/g, ' ')}`);
	}
}

async function main() {
	process.env.CHAT_MEMORY_GATE = '0';
	process.env.SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-lang-skills-'));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-lang-vault-'));
	const v: VaultContext = {
		id: 'eval-language',
		name: 'eval',
		dir,
		libraryRoot: dir,
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};

	const results: CaseResult[] = [];

	try {
		console.log(`model: ${model}  url: ${url}  variants: ${variants.join(',')}  limit: ${limit === Infinity ? 'yok' : limit}  repeats: ${repeats}`);
		console.log(`V1 cümlesi: ${V1_SENTENCE}`);
		console.log(`V2/V3 eşikleri: MIN_LETTERS=${MIN_LETTERS}, MARGIN_THRESHOLD=${MARGIN_THRESHOLD}, MIN_LETTERS_GENERIC=${MIN_LETTERS_GENERIC}`);
		console.log(`V3 primary fallback: PRIMARY_ISO3=${PRIMARY_ISO3}, PRIMARY_ENGLISH_NAME=${PRIMARY_ENGLISH_NAME}`);
		console.log(`V4 NARROW_MARGIN_THRESHOLD=${NARROW_MARGIN_THRESHOLD}`);
		runSelfTest();

		const cases = CASES.slice(0, limit);
		let doneCount = 0;
		const total = cases.length * variants.length * repeats;

		for (const c of cases) {
			const v0Messages = await buildPromptMessages(c.history, c.chunks, ['Türkçe'], v, 'free_chat');

			for (const variant of variants) {
				for (let rep = 1; rep <= repeats; rep++) {
					let messages = v0Messages;
					let appended: string | null = null;
					let appendedAll: (string | null)[] | undefined;
					let v3Tier: V3Tier | null = null;
					let v4Tier: LanguageDecision['tier'] | null = null;
					let v4Margin: number | null = null;

					if (variant === 'V1' || variant === 'V2' || variant === 'V3' || variant === 'V4') {
						messages = applyV1(v0Messages);
					}
					if (variant === 'V2') {
						const rawLastUser = c.history[c.history.length - 1].content;
						const applied = applyV2(messages, rawLastUser);
						messages = applied.messages;
						appended = applied.appended;
					}
					if (variant === 'V3') {
						const applied = applyV3(messages, c.history);
						messages = applied.messages;
						appended = applied.finalAppended;
						appendedAll = applied.appendedByIndex;
						v3Tier = applied.finalTier;
					}
					if (variant === 'V4') {
						const applied = applyV4(messages, c.history);
						messages = applied.messages;
						appended = applied.appended;
						v4Tier = applied.decision.tier;
						v4Margin = applied.decision.margin ?? null;
					}
					if (variant === 'PROD') {
						// The real product path: buildPromptMessages() with responseLanguage:'match',
						// not this script's own hand-applied V1-sentence-swap + V4-directive-append.
						// Should be equivalent to V4 — same decideResponseLanguage() call underneath.
						messages = await buildPromptMessages(c.history, c.chunks, ['Türkçe'], v, 'free_chat', {
							responseLanguage: 'match'
						});
						const priorUserMessages = c.history
							.slice(0, -1)
							.filter((m) => m.role === 'user')
							.map((m) => m.content);
						const decision = decideResponseLanguage(c.history[c.history.length - 1].content, priorUserMessages, PRIMARY_LANGUAGE);
						appended = responseLanguageDirective(decision);
						v4Tier = decision.tier;
						v4Margin = decision.margin ?? null;
					}

					const { answer, latencyMs } = await callOllama(messages);
					const clean = stripThink(answer);
					const detectedLang = labelAnswerLanguage(clean);
					const correct = detectedLang === c.expectedLang;
					const echoed =
						(variant === 'V2' || variant === 'V3' || variant === 'V4' || variant === 'PROD') &&
						appended !== null &&
						/answer in/i.test(clean);

					doneCount++;
					console.log(`[${doneCount}/${total}] ${variant}#${rep} ${c.id.padEnd(24)} beklenen=${c.expectedLang} algılanan=${detectedLang} ${correct ? 'OK' : 'X'} (${(latencyMs / 1000).toFixed(1)}s)`);

					// Ad hoc diagnostic requested for en-know-3, which stayed Turkish in every
					// variant of the first measurement round (V0/V1-old/V2) — dump the full
					// answer every time it recurs here so there's enough fresh evidence (across
					// V1-new/V2/V3 x repeats) to form an educated guess, not just one data point.
					if (c.id === 'en-know-3') {
						console.log(`  [en-know-3 tanı] tam cevap (${variant}#${rep}): ${JSON.stringify(clean)}`);
					}

					results.push({
						id: c.id,
						category: c.category,
						variant,
						rep,
						expectedLang: c.expectedLang,
						detectedLang,
						correct,
						appendedDirective: appended,
						appendedAll,
						v3Tier,
						v4Tier,
						v4Margin,
						echoed,
						latencyMs,
						answerPreview: clean.slice(0, 300)
					});
				}
			}
		}

		printTable(results, cases);

		const outDir = path.join(os.tmpdir(), 'lang-eval');
		fs.mkdirSync(outDir, { recursive: true });
		const outFile = path.join(outDir, `results-${Date.now()}.json`);
		fs.writeFileSync(
			outFile,
			JSON.stringify(
				{
					model,
					url,
					variants,
					repeats,
					v1Sentence: V1_SENTENCE,
					minLetters: MIN_LETTERS,
					marginThreshold: MARGIN_THRESHOLD,
					minLettersGeneric: MIN_LETTERS_GENERIC,
					narrowMarginThreshold: NARROW_MARGIN_THRESHOLD,
					primaryIso3: PRIMARY_ISO3,
					primaryEnglishName: PRIMARY_ENGLISH_NAME,
					results
				},
				null,
				2
			)
		);
		console.log(`\nTam sonuçlar yazıldı: ${outFile}`);
	} finally {
		closeVaultStudyDb(v.id);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack ?? err.message : err);
	process.exitCode = 1;
});
