import { embedTexts, embeddingKey } from './embeddings';
import { getEmbeddingConfig } from './providers/config-store';
import { QUERY_PREFIX } from './embed-config';
import { getChatsDb } from './chats-db';
import { logAppEvent } from './app-log';
import * as store from './smalltalk-store';
import { decideSmallTalk, isGateCalibratedFor, smallTalkGateEnabled, type GateDecision } from './smalltalk-gate';
import type { RetrieveResult } from '$lib/types';

/**
 * SvelteKit-side glue for the small-talk gate: the gate itself (smalltalk-gate.ts) and the
 * phrase store (smalltalk-store.ts) are pure so they can be unit-tested; this file is the part
 * that needs the embedding model and the shared chats.db, like retrieve.ts, and is exercised
 * through the app rather than `tsx --test`.
 *
 * Everything here fails soft. The gate is a heuristic layered over a working chat: a failure to
 * seed, embed or write must degrade to "no gate" (sources attached, as before), never to an
 * error in the user's answer. It is also the only place that logs, and it logs ids and numbers,
 * never the message text (app-log.ts's content rule).
 */

// Same call as retrieve()'s query embedding: CPU-only (on the Ollama path) so the embedding model
// never evicts the chat model — see embeddings.ts's EmbedTextsOptions.purpose.
const embedFn: store.EmbedFn = (texts) => embedTexts(texts.map((t) => `${QUERY_PREFIX}${t}`), { purpose: 'query' });

let readyFor: string | null = null;
let notCalibratedLogged: string | null = null;

/**
 * Whether the gate may run: an embedding model is configured AND it is the family the thresholds
 * were measured with (bge-m3, 1024 dims — see smalltalk-gate.ts). Anything else = off: checking,
 * learning and teaching are all no-ops. Logs once per model, not per message.
 */
export function smallTalkGateActive(): boolean {
	const cfg = getEmbeddingConfig();
	if (cfg === null) return false;
	if (isGateCalibratedFor(cfg.model, cfg.dims)) return true;
	const id = `${cfg.providerId}/${cfg.model}/${cfg.dims}`;
	if (notCalibratedLogged !== id) {
		notCalibratedLogged = id;
		logAppEvent({ kind: 'smalltalk', message: `küçük konuşma kapısı kapalı: gömme modeli (${cfg.model}, ${cfg.dims} boyut) eşikleri ölçülen bge-m3 ailesi değil` });
	}
	return false;
}

function logError(action: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	logAppEvent({ kind: 'smalltalk', message: `küçük konuşma kapısı: ${action} başarısız: ${message}`, smallTalkAction: 'error' });
}

/**
 * The gate, as retrieve() calls it. Returns null (= no gate this turn) when it is switched off,
 * not seeded yet, or anything fails. The first turn after an install (or an embedding-model
 * change) seeds in the background instead of making that turn wait ~3 s; the gate is active from
 * the next one.
 */
export function checkSmallTalk(vector: number[], bestDistance: number | undefined): GateDecision | null {
	if (!smallTalkGateEnabled(process.env.CHAT_SMALLTALK_GATE)) return null;
	// FTS-only mode or an embedding model the thresholds were not measured with: no decision.
	if (!smallTalkGateActive()) return null;
	try {
		const db = getChatsDb();
		const key = embeddingKey();
		if (readyFor !== key) {
			if (!store.isReady(db, key)) {
				void store
					.ensureReady(db, embedFn, key)
					.then(() => {
						readyFor = key;
					})
					.catch((err) => logError('tohumlama', err));
				return null;
			}
			readyFor = key;
		}
		return decideSmallTalk(vector, bestDistance, store.loadPhrases(db, key));
	} catch (err) {
		logError('karar', err);
		return null;
	}
}

/** Embeds a single short message and remembers it as small talk. */
export async function learnFromMessage(text: string, source: 'auto' | 'user'): Promise<store.LearnResult | null> {
	const clean = text.trim();
	if (!clean || clean.length > store.MAX_PHRASE_CHARS) return null;
	// Nothing to embed with in FTS-only mode, or the gate is off for this model: a silent no-op, not an error.
	if (!smallTalkGateActive()) return null;
	const [vec] = await embedFn([clean]);
	return store.learn(getChatsDb(), embeddingKey(), clean, vec, source);
}

/**
 * What the chat route does after the gate flagged a message, without making the answer wait:
 *  - a plain flag counts a hit on the phrase, and one made by a SEED also teaches the message
 *    (the only automatic learning: a personal match is already known, and a message the
 *    seeds did not flag is never guessed at);
 *  - an override ("Yine de kaynak ara") records the message as a confirmed question and
 *    switches off the learned phrase that misfired — never a seed, which one message must not disable.
 */
export function afterSmallTalkGate(gate: NonNullable<RetrieveResult['gate']>, text: string): void {
	if (!smallTalkGateActive()) return;
	try {
		const db = getChatsDb();
		if (gate.phraseId !== undefined) store.recordHit(db, gate.phraseId);
		if (gate.overridden) {
			const blockId = gate.phraseSource && gate.phraseSource !== 'seed' ? gate.phraseId : undefined;
			void embedFn([text.trim()])
				.then(([vec]) => {
					store.confirmQuestion(db, embeddingKey(), text, vec, blockId);
					logAppEvent({ kind: 'smalltalk', message: 'soru olarak onaylandı', smallTalkAction: 'confirmed_question', gatePhraseId: blockId });
				})
				.catch((err) => logError('soru onayı', err));
		} else if (gate.via === 'seed') {
			void learnFromMessage(text, 'auto')
				.then((r) => {
					if (r?.created) logAppEvent({ kind: 'smalltalk', message: 'sohbet cümlesi öğrenildi', smallTalkAction: 'learned', gatePhraseId: r.id });
				})
				.catch((err) => logError('öğrenme', err));
		}
	} catch (err) {
		logError('sonrası', err);
	}
}

/** "Kaynaklar alakasız": the user says this message is small talk. Returns whether it was stored. */
export async function teachSmallTalk(text: string): Promise<boolean> {
	const r = await learnFromMessage(text, 'user');
	if (r) logAppEvent({ kind: 'smalltalk', message: 'kullanıcı öğretti', smallTalkAction: 'taught', gatePhraseId: r.id });
	return r !== null;
}

export function listSmallTalk() {
	return store.listPhrases(getChatsDb());
}

export function deleteSmallTalk(id: number): boolean {
	return store.deletePhrase(getChatsDb(), id);
}

export function clearSmallTalk(): number {
	return store.clearLearned(getChatsDb());
}
