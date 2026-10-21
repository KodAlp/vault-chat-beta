/**
 * Imports judge responses produced outside the harness (e.g. by Claude subagents) into the judge cache that
 * bench/run-generation.ts reads, so a later `--judge-cache-only` run can score them with no cloud call.
 *
 *   npx tsx bench/import-judgments.ts --prompts <dumped.jsonl> --responses <responses.jsonl>
 *
 * --prompts: the file from `run-generation.ts --dump-judge-prompts` ({key, id, numChunks, prompt} per line).
 * --responses: one `{key, raw}` per line, raw = the judge's text output. Each is validated with
 * parseJudgeResponse; valid ones are appended to <dataDir>/vaults/default/bench/cache/judge.jsonl as
 * {key, id, result}. Existing cache lines are never rewritten or overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../src/lib/server/env';
import { parseJsonl, planImport, type DumpedPrompt, type RawResponse } from './lib/judge-import';

const argv = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i !== -1 ? argv[i + 1] : undefined;
};

const promptsPath = argValue('--prompts');
const responsesPath = argValue('--responses');
if (!promptsPath || !responsesPath) {
	console.error('kullanım: npx tsx bench/import-judgments.ts --prompts <dumped.jsonl> --responses <responses.jsonl>');
	process.exit(1);
}
for (const p of [promptsPath, responsesPath]) {
	if (!fs.existsSync(p)) {
		console.error(`dosya yok: ${p}`);
		process.exit(1);
	}
}

const cachePath = path.join(dataDir(), 'vaults', 'default', 'bench', 'cache', 'judge.jsonl');
const existing = new Set<string>();
if (fs.existsSync(cachePath)) {
	for (const rec of parseJsonl<{ key?: string }>(fs.readFileSync(cachePath, 'utf-8'))) {
		if (rec.key) existing.add(rec.key);
	}
}

const prompts = parseJsonl<DumpedPrompt>(fs.readFileSync(promptsPath, 'utf-8'));
const responses = parseJsonl<RawResponse>(fs.readFileSync(responsesPath, 'utf-8'));
const plan = planImport(prompts, responses, existing);

if (plan.lines.length > 0) {
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	// Guard against a cache file whose last line lacks a newline (killed writer): appending would glue two records.
	const needsNl = fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0 && !fs.readFileSync(cachePath, 'utf-8').endsWith('\n');
	fs.appendFileSync(cachePath, (needsNl ? '\n' : '') + plan.lines.join('\n') + '\n', 'utf-8');
}

console.log(`[import] ok: ${plan.ok}, geçersiz: ${plan.invalid.length}, eksik: ${plan.missing.length}, zaten önbellekte: ${plan.alreadyCached}`);
for (const e of plan.invalid) console.log(`[import] geçersiz id=${e.id ?? '?'} key=${e.key}: ${e.error}`);
for (const m of plan.missing) console.log(`[import] eksik id=${m.id} key=${m.key}`);
console.log(`[import] önbellek: ${cachePath}`);
