#!/usr/bin/env node
// Yerel modellerle MCP deneyi (#39): vault-chat MCP sunucusunu stdio'dan
// başlatır, YALNIZ OKUMA araçlarını Ollama'nın araç çağırma API'siyle bir
// yerel modele verir ve cevabı bilinen sorularda ölçer.
//
//   node bench/mcp-yerel-model.mjs --model qwen3:8b [--think] [--repeat 2] [--out sonuc.jsonl]
//
// DATA_DIR (varsayılan: kurulu uygulamanın AppData klasörü) okunur, hiçbir
// şey yazılmaz: create_vault / import_source / edit_note modele verilmez.
// search_library çalışan uygulamanın gömme modelini kullanır (Ollama bge-m3).
//
// Ölçülen: araç çağrısı geçerli mi (sunucu hata döndürdü mü, kasa kimliği
// doğru mu), beklenen araç kullanıldı mı, cevapta beklenen anahtar sözcük ve
// kaynak yolu var mı, kaç tur / kaç saniye sürdü.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : def;
};
const MODEL = opt('model', 'qwen3:8b');
const THINK = args.includes('--think');
const REPEAT = Number(opt('repeat', '1'));
const OUT = opt('out', path.join(here, 'mcp-yerel-model-sonuc.jsonl'));
const ONLY = opt('only', null);
const NUM_CTX = Number(opt('ctx', '8192'));
const MAX_TURNS = 8;
// Araç sonucu bağlama sığsın diye kesilir; kesildiği kaydedilir (LM Studio vb. kesmez).
const TOOL_RESULT_CHARS = Number(opt('tool-chars', '6000'));
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DATA_DIR = process.env.DATA_DIR || path.join(process.env.APPDATA || '', 'app.vaultchat.desktop');
const READ_TOOLS = new Set(['list_vaults', 'list_sources', 'list_domains', 'search_library', 'get_note']);

// Beklenen: anahtar sözcüklerden en az biri (büyük/küçük harf duyarsız), ve
// verildiyse cevapta / araç argümanlarında kaynak yolunun bir parçası.
const TASKS = [
	{
		id: 'gr-einstein',
		q: 'Fizik kasamdaki genel görelilik ders notunda Einstein alan denklemi nasıl yazılıyor? Denklemi ve hangi nottan aldığını yaz.',
		vault: 'fizik', tools: ['search_library', 'get_note'], keys: ['8\\pi G', '8πG', '8 \\pi G', 'R_{\\mu\\nu}', 'G_{\\mu\\nu}'],
		source: 'general-relativity'
	},
	{
		id: 'rus-vezti',
		q: 'Rusça kasamda "везти" ile "вести" fiillerinin farkı nasıl anlatılıyor?',
		vault: 'rusca', tools: ['search_library', 'get_note'], keys: ['araç', 'araba', 'taşıt', 'vehicle', 'transport', 'yürüyerek', 'on foot', 'lead'],
		source: 'adsiz'
	},
	{
		id: 'lazer-inversion',
		q: 'Lazer fiziği notuma göre lazer çalışması için neden nüfus terselmesi (population inversion) gerekir?',
		vault: 'fizik', tools: ['search_library', 'get_note'], keys: ['inversion', 'terselme', 'stimulated', 'uyarılmış', 'absorption', 'soğurma'],
		source: 'laser'
	},
	{
		id: 'stat-partition',
		q: 'Fizik kasamdaki istatistiksel fizik notunda kanonik topluluk için bölüşüm fonksiyonu (partition function) nasıl tanımlanıyor?',
		vault: 'fizik', tools: ['search_library', 'get_note'], keys: ['e^{-\\beta', 'e^{-β', 'e−βE', 'exp(-', '\\beta E', 'βE', 'e^{-E'],
		source: 'statistical'
	},
	{
		id: 'kuantum-liste',
		q: 'Fizik kasamda kuantum alanında hangi notlar var? Başlıklarını listele.',
		vault: 'fizik', tools: ['list_sources', 'search_library'], keys: ['string theory', 'loop quantum gravity'],
		allKeys: true
	},
	{
		id: 'friedmann',
		q: 'Kozmoloji ders notumda Friedmann denklemi nasıl veriliyor?',
		vault: 'fizik', tools: ['search_library', 'get_note'], keys: ['H^2', 'H^{2}', 'H²', '\\dot{a}', 'ȧ', '8\\pi G', '8πG'],
		source: 'cosmology'
	},
	{
		id: 'lqg-ashtekar',
		q: 'Loop quantum gravity notumda Ashtekar değişkenleri nedir, kısaca açıkla.',
		vault: 'fizik', tools: ['search_library', 'get_note'], keys: ['Ashtekar', 'connection', 'bağlantı', 'densitized', 'triad'],
		source: 'loop-quantum'
	},
	{
		id: 'stony-brook',
		q: 'Fizik kasamda "Stony Brook University" başlıklı kaç not var ve hangi alanlarda?',
		vault: 'fizik', tools: ['list_sources', 'search_library'], keys: ['elektromanyetizma', 'istatistiksel', 'kuantum'], count: 3, countWord: 'üç',
		allKeys: true
	},
	{
		id: 'snell',
		q: 'Optik notumda Snell yasası hangi biçimde yazılmış?',
		vault: 'fizik', tools: ['search_library', 'get_note'], keys: ['\\sin', 'sin θ', 'sinθ', 'sin(θ', 'n_1', 'n₁', 'n_i', 'n_t'],
		source: 'optics'
	},
	{
		id: 'almanca-bos',
		q: 'Almanca kasamda Konjunktiv II hakkında ne yazıyor?',
		vault: 'almanca', tools: ['list_vaults', 'search_library', 'list_sources', 'list_domains'],
		// Kasa boş/indekssiz: doğru cevap bunu söylemek, uydurmamak.
		keys: ['indeks', 'boş', 'not yok', 'bulunamadı', 'bulamadım', 'içerik yok', 'hiç not', 'not indexed', 'no notes', 'empty', '0 not', 'mevcut değil', 'bulunmuyor', 'bulunmamaktadır', 'henüz not'],
		noHallucination: true
	}
];

function toOllamaTool(t) {
	return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}

async function chat(messages, tools) {
	const res = await fetch(`${OLLAMA}/api/chat`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: MODEL, messages, tools, stream: false, think: THINK, options: { num_ctx: NUM_CTX, temperature: 0 } })
	});
	if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
	return res.json();
}

function includesAny(text, keys) {
	const t = text.toLowerCase();
	return keys.filter((k) => t.includes(k.toLowerCase()));
}

async function runTask(client, tools, task) {
	const system =
		'Sen kullanıcının yerel bilgi kasasına MCP araçlarıyla erişen bir asistansın. Kasada olmayan bilgiyi uydurma; ' +
		'cevabı araçlardan aldığın içeriğe dayandır ve hangi nottan (yol) aldığını belirt. Türkçe cevap ver.';
	const messages = [{ role: 'system', content: system }, { role: 'user', content: task.q }];
	const calls = [];
	const t0 = Date.now();
	let answer = '';
	let truncated = 0;
	let promptTokens = 0;
	for (let turn = 0; turn < MAX_TURNS; turn++) {
		const r = await chat(messages, tools);
		promptTokens = Math.max(promptTokens, r.prompt_eval_count || 0);
		const msg = r.message || {};
		messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
		if (!msg.tool_calls?.length) {
			answer = msg.content || '';
			break;
		}
		for (const tc of msg.tool_calls) {
			const name = tc.function?.name;
			let a = tc.function?.arguments ?? {};
			if (typeof a === 'string') {
				try {
					a = JSON.parse(a);
				} catch {
					a = { _unparsed: a };
				}
			}
			let text;
			let isError = false;
			if (!READ_TOOLS.has(name)) {
				text = `Bilinmeyen ya da izin verilmeyen araç: ${name}`;
				isError = true;
			} else {
				try {
					const out = await client.callTool({ name, arguments: a });
					isError = Boolean(out.isError);
					text = (out.content || []).map((c) => c.text ?? '').join('\n');
				} catch (err) {
					isError = true;
					text = String(err?.message || err);
				}
			}
			if (text.length > TOOL_RESULT_CHARS) {
				truncated++;
				text = text.slice(0, TOOL_RESULT_CHARS) + '\n…(kesildi)';
			}
			calls.push({ name, args: a, isError, chars: text.length });
			messages.push({ role: 'tool', tool_name: name, content: text });
		}
	}
	const seconds = (Date.now() - t0) / 1000;
	return {
		model: MODEL, think: THINK, task: task.id, ...score(task, answer, calls), turns: calls.length, calls,
		truncated, seconds, promptTokens, noAnswer: answer.length === 0, answer
	};
}

/** Cevap + araç çağrılarından puan; --rescore eski kayıtları bununla yeniden puanlar. */
function score(task, answer, calls) {
	const hits = includesAny(answer, task.keys);
	let keyOk = task.allKeys ? hits.length === task.keys.length : hits.length > 0;
	// "3 not" / "üç not": liste numarası ("3. kuantum") sayılmaz.
	if (task.count !== undefined) {
		keyOk = keyOk && new RegExp(`(^|[^\\d.])(${task.count}|${task.countWord})\\s*(adet\\s*)?(not|tane)`, 'i').test(answer);
	}
	const usedTool = calls.some((c) => task.tools.includes(c.name));
	const vaultOk = calls.every((c) => !c.args?.vault || c.args.vault === task.vault);
	const sourceOk = task.source
		? answer.toLowerCase().includes(task.source) || calls.some((c) => JSON.stringify(c.args).includes(task.source))
		: true;
	// Akıl yürütme metni cevaba sızmış mı (qwen3:4b think=false'ta "Okay, let's ...").
	const leakedReasoning = /^(okay|alright|let me|let's|first,)/i.test(answer.trim());
	const errors = calls.filter((c) => c.isError).length;
	return { ok: keyOk && usedTool && sourceOk && answer.length > 0, keyOk, hits, usedTool, vaultOk, sourceOk, errors, leakedReasoning };
}

const RESCORE = opt('rescore', null);
if (RESCORE) {
	const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));
	const rows = fs.readFileSync(RESCORE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const out = rows.map((r) => (r.crash ? r : { ...r, ...score(byId[r.task], r.answer || '', r.calls || []) }));
	fs.writeFileSync(RESCORE.replace(/\.jsonl$/, '.puan.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
	console.error(`yeniden puanlandı: ${out.length} satır`);
	process.exit(0);
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [path.join(repo, 'mcp', 'launch.mjs')],
	env: { ...process.env, DATA_DIR },
	stderr: 'ignore'
});
const client = new Client({ name: 'mcp-yerel-model', version: '0.0.0' });
await client.connect(transport);
const { tools: all } = await client.listTools();
const tools = all.filter((t) => READ_TOOLS.has(t.name)).map(toOllamaTool);
console.error(`model=${MODEL} think=${THINK} araçlar=${tools.map((t) => t.function.name).join(',')}`);
const out = fs.createWriteStream(OUT, { flags: 'a' });
for (let rep = 0; rep < REPEAT; rep++) {
	for (const task of TASKS) {
		if (ONLY && !ONLY.split(',').includes(task.id)) continue;
		let row;
		try {
			row = { rep, ...(await runTask(client, tools, task)) };
		} catch (err) {
			row = { rep, model: MODEL, think: THINK, task: task.id, ok: false, crash: String(err?.message || err) };
		}
		out.write(JSON.stringify(row) + '\n');
		console.error(
			`${task.id.padEnd(16)} ok=${row.ok} key=${row.keyOk} tool=${row.usedTool} vault=${row.vaultOk} src=${row.sourceOk} err=${row.errors} tur=${row.turns} ${row.seconds?.toFixed?.(1)}s${row.crash ? ' CRASH ' + row.crash : ''}`
		);
	}
}
out.end();
await client.close();
