/**
 * Small-talk seed phrases for smalltalk-gate.ts: greetings, "how are you", slang,
 * abusive small talk, thanks, acknowledgements and test messages in several
 * languages. bge-m3 is multilingual, so a few examples per concept cover many
 * more surface forms than the list itself — a stopword list could not, and it
 * would be wrong for every language and slang not on it.
 *
 * Deliberately NOT the whole story: measured on the real vault, these seeds
 * alone catch only the standard greetings the first time they are seen (23 of 95
 * held-out small-talk messages at the shipped threshold); slang and insults are
 * learned from the user (smalltalk-store.ts). Do not lower the gate's
 * thresholds to make the seeds catch more — see the measurements in
 * smalltalk-gate.ts.
 */
export const SMALLTALK_SEEDS: readonly string[] = [
	'merhaba', 'selam', 'günaydın', 'iyi akşamlar', 'nasılsın', 'naber', 'ne haber', 'napıyorsun',
	'hello', 'hi there', 'hey', 'good morning', 'how are you', "what's up", 'howdy',
	'hola, cómo estás', 'bonjour, ça va', 'guten tag, wie geht es dir', 'ciao', 'こんにちは',
	'yo bro', 'wassup dude', 'ne yapıyon lan', 'lan naber', 'kanka nasılsın',
	'salak mısın', 'you are stupid', 'shut up', 'sus be', 'aptal bot',
	'teşekkürler', 'sağ ol', 'thanks a lot', 'thank you', 'tamam', 'anladım', 'okay', 'peki',
	'deneme', 'test 123', 'lol', 'haha'
];
