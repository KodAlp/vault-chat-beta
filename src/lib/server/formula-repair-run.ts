import { spawn } from 'node:child_process';
import { AppError } from './app-error';
import { pythonBin, ingestScriptPath } from './convertQueue';
import { convertProcessEnv, releaseConverterWorker } from './convert-worker';
import { resolvePandocBin } from './pandoc-bin';
import { evictForExclusiveJob } from './gpu-evict';
import { sharedJobMutex } from './jobMutex';
import { parseRepairOutput, type RepairResult } from './formula-repair-cli';

/** Model load + one formula: ~15-40 s measured; generous for a cold disk and a busy GPU. */
export const FORMULA_REPAIR_TIMEOUT_MS = 5 * 60_000;
const STDERR_TAIL = 4096;
const STDOUT_MAX = 1024 * 1024;

export interface RepairArgs {
	pdf: string;
	page: number;
	bbox: [number, number, number, number] | null;
	/** Stored crop PNG (optional: the CLI falls back to cropping the PDF). */
	crop: string | null;
	previousB64: string | null;
}

export function buildRepairArgs(a: RepairArgs): string[] {
	const args = ['--pdf', a.pdf, '--page', String(a.page)];
	if (a.bbox) args.push('--bbox', a.bbox.join(','));
	if (a.crop) args.push('--crop', a.crop);
	if (a.previousB64) args.push('--previous-b64', a.previousB64);
	return args;
}

function runCli(args: string[]): Promise<RepairResult> {
	return new Promise<RepairResult>((resolve, reject) => {
		let child;
		try {
			child = spawn(pythonBin(), [ingestScriptPath('formula_repair.py'), ...args], {
				windowsHide: true,
				env: { ...convertProcessEnv(resolvePandocBin()), PYTHONIOENCODING: 'utf-8' }
			});
		} catch (err) {
			reject(new AppError('PYTHON_SPAWN_FAILED', { detail: err instanceof Error ? err.message : String(err) }));
			return;
		}
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		}, FORMULA_REPAIR_TIMEOUT_MS);
		child.stdout.on('data', (c: Buffer) => {
			if (stdout.length < STDOUT_MAX) stdout += c.toString('utf8');
		});
		child.stderr.on('data', (c: Buffer) => {
			stderr = (stderr + c.toString('utf8')).slice(-STDERR_TAIL);
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new AppError('PYTHON_SPAWN_FAILED', { detail: err.message }));
		});
		child.on('close', () => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new AppError('PROCESS_TIMEOUT', { seconds: Math.round(FORMULA_REPAIR_TIMEOUT_MS / 1000) }));
				return;
			}
			try {
				resolve(parseRepairOutput(stdout, stderr));
			} catch (e) {
				reject(e);
			}
		});
	});
}

/**
 * Runs ingest/formula_repair.py on the GPU. The job takes the EXCLUSIVE slot of sharedJobMutex: it waits
 * for running conversions and a chat-model swap, and none starts while it runs (the 1.2B recognizer needs
 * ~2.2 GB of the 6 GB card). Before spawning, the idle convert worker is shut down (its docling models
 * sit in VRAM) and idle Ollama models are unloaded — the same two steps a chat-model swap and a batch
 * import take (ollamaGate.acquireNonResident, enqueueConversion's exclusiveGpu).
 */
export function runFormulaRepair(args: RepairArgs): Promise<RepairResult> {
	return sharedJobMutex.run(async () => {
		await releaseConverterWorker();
		await evictForExclusiveJob();
		return runCli(buildRepairArgs(args));
	});
}
