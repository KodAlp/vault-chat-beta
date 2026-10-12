/**
 * Runtime calibration of the small-talk gate for embedding models other than bge-m3.
 *
 * bge-m3's thresholds (smalltalk-gate.ts) were measured by hand against 2016 real negatives.
 * Another model's cosine distribution is shifted (nomic/qwen3 unrelated texts sit much higher),
 * so a fixed number would either never fire or, worse, flag real questions. Instead of
 * hand-measuring each model, the gate measures it: embed the seed phrases (already stored) and
 * PROBE_QUESTIONS (real-looking questions, including the hardest shape — a greeting glued to a
 * one-word topic), take the HIGHEST similarity any probe reaches to any seed (`maxNeg`), and place
 * the thresholds above it with the same kind of margins bge-m3 has (0.054 / 0.094) plus extra
 * slack, because this probe set is far smaller than the 2016-negative validation.
 *
 * Conservative by construction: thresholds are never below the bge-m3 ones, and when the model
 * cannot separate probes from seeds (the personal threshold would exceed MAX_USABLE_PERSONAL) the
 * calibration is refused and the gate stays off, exactly as before. The result only ever makes
 * the gate stricter than "bge-m3 numbers", so a false negative (retrieval runs on "merhaba") is the
 * failure mode, never a silently ungrounded question. Pure: vectors in, thresholds out.
 */

import { DEFAULT_THRESHOLDS, dot, normalize, type GateThresholds } from './smalltalk-gate';

/** Questions that must never look like small talk. Mixed languages and shapes. */
export const PROBE_QUESTIONS: readonly string[] = [
	'türev nedir', 'integral nasıl alınır', 'selam asm nedir', 'merhaba, dijkstra algoritması nasıl çalışır',
	'günaydın, svelte store ne işe yarar', 'hello what is a monad', 'hi there, explain gradient descent',
	'what is the difference between TCP and UDP', 'how does garbage collection work', 'explain the central limit theorem',
	'thanks, but how do I invert a matrix', 'hey, what does the second law of thermodynamics say',
	'bu notta Fourier dönüşümü nasıl tanımlanıyor', 'kuantum dolanıklığı kısaca açıkla', 'lineer bağımsızlık ile rank arasındaki ilişki nedir',
	'ders notlarındaki ikinci örneği çöz', 'teşekkürler, peki özdeğer nasıl bulunur', 'sınav için hangi konulara çalışmalıyım',
	'RAM ile ROM arasındaki fark nedir', 'bayes teoremi örnekle anlat', 'merhaba işlemci önbelleği nedir',
	'selam, hash tablosu çakışmaları nasıl çözülür', 'what are the prerequisites for chapter 3', 'summarize the notes about entropy',
	'cómo se calcula la varianza', 'bonjour, qu\'est-ce qu\'un espace vectoriel', 'wie funktioniert quicksort',
	'what is photosynthesis', 'osmanlı devletinin kuruluş dönemi', 'newton ikinci yasası formülü',
	'how to prove sqrt(2) is irrational', 'what is a mutex', 'ohm kanunu nedir', 'bilgisayar ağlarında yönlendirme nedir',
	'yapay sinir ağlarında geri yayılım', 'p-value ne anlama gelir', 'iyi akşamlar, kovaryans matrisi ne demek',
	'good morning, how is a B-tree balanced', 'okay, now explain eigenvectors', 'tamam, sonraki konu olan limit nedir',
	'test et: bu formül doğru mu', 'deneme sınavı sorularını listele', 'naber, ısı transferi türleri neler',
	'sağ ol, bir de entropi formülünü yazar mısın', 'what is the time complexity of merge sort',
	'konunun ana fikri nedir', 'explain this like I am five', 'tanımı ve özellikleri ver', 'bu kavramı örnekle açıkla',
	'compare stack and queue'
];

/** Fewest probes for which a calibration is trusted. */
export const MIN_PROBES = 20;
/** Above this personal threshold the model cannot tell probes from seeds: calibration refused, gate stays off. */
export const MAX_USABLE_PERSONAL = 0.95;
/** Margins above the worst probe. bge-m3's measured ones are 0.054 / 0.094; these add slack for the smaller probe set. */
export const SEED_MARGIN = 0.07;
export const PERSONAL_MARGIN = 0.10;

/** Identifies the inputs of a calibration so a stored one is dropped when seeds or probes change. */
export function calibrationSignature(seeds: readonly string[], probes: readonly string[] = PROBE_QUESTIONS): string {
	let h = 5381;
	for (const s of [...seeds, '\u0000', ...probes, '\u0000v1']) for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	return `${seeds.length}:${probes.length}:${h.toString(16)}`;
}

/** Highest similarity any probe has to any seed; -1 when vectors are missing or dims disagree. */
export function worstProbeSimilarity(seedVecs: readonly ArrayLike<number>[], probeVecs: readonly ArrayLike<number>[]): number {
	let worst = -1;
	for (const p of probeVecs) {
		const q = normalize(p);
		for (const s of seedVecs) {
			const sim = dot(q, normalize(s));
			if (sim > worst) worst = sim;
		}
	}
	return worst;
}

/**
 * Derives the thresholds, or null when the model cannot be calibrated safely (too few probes,
 * dimension mismatch, or probes too close to seeds for a usable personal threshold).
 */
export function deriveThresholds(seedVecs: readonly ArrayLike<number>[], probeVecs: readonly ArrayLike<number>[]): GateThresholds | null {
	if (seedVecs.length === 0 || probeVecs.length < MIN_PROBES) return null;
	const dims = seedVecs[0].length;
	if ([...seedVecs, ...probeVecs].some((v) => v.length !== dims)) return null;
	const maxNeg = worstProbeSimilarity(seedVecs, probeVecs);
	if (!Number.isFinite(maxNeg) || maxNeg < -0.5) return null;

	const D = DEFAULT_THRESHOLDS;
	const personalSim = Math.max(D.personalSim, maxNeg + PERSONAL_MARGIN);
	if (personalSim > MAX_USABLE_PERSONAL) return null;
	const seedSim = Math.min(personalSim, Math.max(D.seedSim, maxNeg + SEED_MARGIN));
	const negativeSim = Math.min(0.98, Math.max(D.negativeSim, personalSim + 0.03));
	const duplicateSim = Math.min(0.999, Math.max(D.duplicateSim, negativeSim + 0.05));
	return { seedSim, seedMinCorpusDist: null, personalSim, negativeSim, duplicateSim };
}
