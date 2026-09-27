/**
 * Human-eval sheet generator — reads a generation.json (bench/run-generation.ts)
 * and writes a self-contained, offline HTML page listing N sampled items
 * (question, turns, generated answer, retrieved sources with text collapsed,
 * reference answer collapsed) with 1-5 radio inputs for Correctness /
 * Relevance / Clarity / Citation Quality, plus a "Download ratings JSON"
 * button (client-side Blob download — no server, no network call from the
 * page itself).
 *
 *   npx tsx bench/human-eval.ts --from <generation.json> --n 30 --seed 1 --out <html>
 *
 * Works even when generation.json has no judge scores (--no-judge runs) —
 * the judge column is simply omitted from each card.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
}

const fromPath = argValue('--from');
const n = Number(argValue('--n') ?? '30');
const seed = Number(argValue('--seed') ?? '1');
const outPath = argValue('--out');

if (!fromPath || !outPath) {
	console.error('kullanım: npx tsx bench/human-eval.ts --from <generation.json> --n 30 --seed 1 --out <html>');
	process.exit(1);
}
if (!fs.existsSync(fromPath)) {
	console.error(`dosya yok: ${fromPath}`);
	process.exit(1);
}

interface GenerationItem {
	id: string;
	type: string;
	lang: string;
	answerable: boolean;
	question: string;
	answerPreview: string;
	judgeFailed: boolean;
	judge?: { correctness: number; relevance: number; reason: string };
}

interface AnswerRecord {
	id: string;
	question: string;
	turns?: { role: 'user' | 'assistant'; content: string }[];
	reference_answer: string;
	sut: { answer: string; chunks: { path: string; heading_path: string; topic: string; text: string }[] };
}

const generation = JSON.parse(fs.readFileSync(fromPath, 'utf-8')) as { items: GenerationItem[] };

const answersPath = path.join(path.dirname(fromPath), 'answers.jsonl');
const answersById = new Map<string, AnswerRecord>();
if (fs.existsSync(answersPath)) {
	for (const line of fs.readFileSync(answersPath, 'utf-8').split('\n')) {
		if (!line.trim()) continue;
		const rec = JSON.parse(line) as AnswerRecord;
		answersById.set(rec.id, rec);
	}
}

function mulberry32(s: number) {
	let a = s >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rand = mulberry32(seed);
const shuffled = [...generation.items].sort(() => rand() - 0.5);
const picked = shuffled.slice(0, Math.min(n, shuffled.length));

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const cards = picked
	.map((item, idx) => {
		const answer = answersById.get(item.id);
		const turnsHtml = answer?.turns?.length
			? `<div class="turns">${answer.turns.map((t) => `<div class="turn ${esc(t.role)}"><b>${esc(t.role)}:</b> ${esc(t.content)}</div>`).join('')}</div>`
			: '';
		const sourcesHtml = answer?.sut.chunks.length
			? answer.sut.chunks
					.map(
						(c, i) =>
							`<details><summary>C${i + 1}: ${esc(c.topic)} | ${esc(c.heading_path)} (${esc(c.path)})</summary><pre>${esc(c.text)}</pre></details>`
					)
					.join('')
			: '<p class="muted">(kaynak yok)</p>';
		const judgeHtml = item.judge
			? `<p class="judge">Yargıç: correctness=${item.judge.correctness}, relevance=${item.judge.relevance} — <i>${esc(item.judge.reason)}</i></p>`
			: '<p class="muted">(yargıç skoru yok)</p>';
		const criteria = ['correctness', 'relevance', 'clarity', 'citation_quality'];
		const radios = criteria
			.map(
				(c) =>
					`<div class="criterion"><span>${c}</span>${[1, 2, 3, 4, 5]
						.map((v) => `<label><input type="radio" name="${item.id}__${c}" value="${v}"> ${v}</label>`)
						.join('')}</div>`
			)
			.join('');
		return `<div class="card" data-id="${esc(item.id)}">
			<h3>#${idx + 1} — ${esc(item.id)} <span class="tag">${esc(item.type)}</span> <span class="tag">${esc(item.lang)}</span> ${item.answerable ? '' : '<span class="tag warn">unanswerable</span>'}</h3>
			<p class="question"><b>Soru:</b> ${esc(item.question)}</p>
			${turnsHtml}
			<details open><summary><b>Üretilen cevap</b></summary><pre>${esc(answer?.sut.answer ?? item.answerPreview)}</pre></details>
			<details><summary>Referans cevap</summary><pre>${esc(answer?.reference_answer ?? '')}</pre></details>
			<details><summary>Kaynaklar (${answer?.sut.chunks.length ?? 0})</summary>${sourcesHtml}</details>
			${judgeHtml}
			<div class="criteria">${radios}</div>
		</div>`;
	})
	.join('\n');

const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>İnsan değerlendirmesi — ${esc(path.basename(fromPath))}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background:#fafafa; color:#1a1a1a; }
.card { background:#fff; border:1px solid #ddd; border-radius:8px; padding:1rem; margin-bottom:1.5rem; }
.tag { display:inline-block; background:#eee; border-radius:4px; padding:0 6px; font-size:0.8em; margin-left:4px; }
.tag.warn { background:#fde2e2; }
pre { white-space: pre-wrap; word-break: break-word; background:#f5f5f5; padding:0.5rem; border-radius:4px; }
.muted { color:#888; }
.judge { font-size:0.9em; color:#444; }
.turns { margin: 0.5rem 0; }
.turn { padding:2px 0; }
.criteria { display:flex; flex-wrap:wrap; gap:1rem; margin-top:0.75rem; border-top:1px solid #eee; padding-top:0.75rem; }
.criterion span { display:block; font-weight:600; margin-bottom:2px; }
.criterion label { margin-right:6px; font-size:0.9em; }
#downloadBtn { position:sticky; top:1rem; float:right; padding:0.5rem 1rem; font-size:1em; cursor:pointer; }
h1 { margin-bottom:0; }
.meta { color:#666; font-size:0.9em; }
</style>
</head>
<body>
<h1>İnsan değerlendirmesi</h1>
<p class="meta">Kaynak: ${esc(fromPath)} — ${picked.length} öğe, seed=${seed}</p>
<button id="downloadBtn">Download ratings JSON</button>
<div id="cards">${cards}</div>
<script>
document.getElementById('downloadBtn').addEventListener('click', function () {
	try {
		var ratings = {};
		var radios = document.querySelectorAll('#cards input[type=radio]:checked');
		for (var i = 0; i < radios.length; i++) {
			var r = radios[i];
			var parts = r.name.split('__');
			var id = parts[0];
			var criterion = parts[1];
			if (!ratings[id]) ratings[id] = {};
			ratings[id][criterion] = Number(r.value);
		}
		var blob = new Blob([JSON.stringify({ ratings: ratings, generatedFrom: ${JSON.stringify(path.basename(fromPath))}, seed: ${seed} }, null, 2)], { type: 'application/json' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = 'human-ratings.json';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	} catch (e) {
		alert('İndirme başarısız: ' + e);
	}
});
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf-8');
console.log(`Yazıldı: ${outPath} (${picked.length} öğe)`);
