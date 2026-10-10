// Gerçek KaTeX ile LaTeX geçerlilik sınaması (formula_fallback.py çağırır).
// stdin: JSON dizi (LaTeX metinleri). stdout: JSON dizi (true = KaTeX displayMode'da derliyor).
// KaTeX konumu: env VC_KATEX_DIR, yoksa <bu dosyanın klasörü>/../node_modules/katex
// (geliştirmede ingest/ yanında node_modules/, paketli uygulamada dist-server/ingest/ yanında
// dist-server/node_modules/). Bulunamazsa çıkış kodu 2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.VC_KATEX_DIR || path.join(here, '..', 'node_modules', 'katex');
const entry = ['dist/katex.mjs', 'dist/katex.js']
	.map((p) => path.join(dir, p))
	.find((p) => fs.existsSync(p));
if (!entry) {
	process.stderr.write(`katex bulunamadı: ${dir}\n`);
	process.exit(2);
}
const mod = await import(pathToFileURL(entry).href);
const katex = mod.default && mod.default.renderToString ? mod.default : mod;

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const items = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]');
const out = items.map((latex) => {
	try {
		katex.renderToString(String(latex), { displayMode: true, throwOnError: true, strict: 'ignore' });
		return true;
	} catch {
		return false;
	}
});
process.stdout.write(JSON.stringify(out));
