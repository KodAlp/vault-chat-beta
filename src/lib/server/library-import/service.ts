import { AppError } from '../app-error';
import { libraryRoot } from '../library';
import { normalizePrefix, resolveSourceRoot, runImport, walkSource, type Indexer } from './common';
import { detectAll, getAdapter, type Detected } from './adapters';
import { importScanRegistry, type ImportScanRegistry } from './scan-registry';
import { isAdapterId, type AdapterId, type ImportWarning } from './types';
import type { LibraryImportScan } from '../../library-import-sources';
import type { ImportResultItem, ImportSummary } from '$lib/types';
import type { VaultContext } from '../vaults';

/** What the client gets back from a scan: the plan WITHOUT its internal entries and lookup tables. */
export type ScanSummary = LibraryImportScan;

const SKIPPED_LIST_CAP = 200;

function mergeWarnings(...lists: ImportWarning[][]): ImportWarning[] {
	const byCode = new Map<string, ImportWarning>();
	for (const w of lists.flat()) if (!byCode.has(w.code)) byCode.set(w.code, w);
	return [...byCode.values()];
}

/**
 * detect (+ rank) -> plan, then remember the plan under a scanId. Writes
 * nothing. adapterId is the card the user clicked; without it the best
 * detected adapter is used, falling back to the plain Markdown-folder adapter.
 */
export async function scanSource(
	v: VaultContext,
	rawPath: unknown,
	adapterId: unknown,
	protectedDirs: string[],
	registry: ImportScanRegistry = importScanRegistry
): Promise<ScanSummary> {
	if (adapterId !== undefined && adapterId !== null && adapterId !== '' && !isAdapterId(adapterId)) {
		throw new AppError('IMPORT_ADAPTER_UNKNOWN');
	}
	const root = resolveSourceRoot(rawPath, protectedDirs);
	const tree = walkSource(root);
	const detected: Detected[] = await detectAll(root, tree);
	const chosenId: AdapterId = isAdapterId(adapterId)
		? adapterId
		: (detected.find((d) => d.match)?.adapter ?? 'markdown-folder');
	const adapter = getAdapter(chosenId);
	const chosenDetect = detected.find((d) => d.adapter === chosenId);
	const plan = await adapter.plan(root, tree);
	// A not-matching adapter's warning (Logseq DB graph) is exactly what explains an empty result.
	const warnings = mergeWarnings(
		chosenDetect?.warnings ?? [],
		plan.warnings,
		...detected.filter((d) => !d.match).map((d) => d.warnings)
	);

	if (plan.notes === 0 && warnings.length === 0) throw new AppError('IMPORT_NOTHING_TO_IMPORT');

	const skippedByReason: Record<string, number> = {};
	for (const s of plan.skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;

	return {
		scanId: plan.notes === 0 ? null : registry.add(v.id, root, chosenId, plan),
		adapter: chosenId,
		flavor: plan.flavor ?? chosenDetect?.flavor,
		matched: chosenDetect?.match ?? false,
		detected: detected.map((d) => ({ adapter: d.adapter, match: d.match, confidence: d.confidence, flavor: d.flavor })),
		notes: plan.notes,
		attachments: plan.attachments,
		skipped: plan.skipped.slice(0, SKIPPED_LIST_CAP),
		skippedByReason,
		sampleTargets: plan.sampleTargets,
		warnings
	};
}

/** Imports exactly what the scan recorded. Unknown/expired id -> SCAN_EXPIRED; wrong adapter -> IMPORT_ADAPTER_MISMATCH. */
export async function runScanned(
	v: VaultContext,
	scanId: unknown,
	opts: {
		adapter?: unknown;
		targetPrefix?: unknown;
		indexer?: Indexer;
		onProgress?: (item: ImportResultItem) => void;
		registry?: ImportScanRegistry;
	} = {}
): Promise<ImportSummary> {
	const rec = (opts.registry ?? importScanRegistry).get(scanId, v.id);
	if (!rec) throw new AppError('SCAN_EXPIRED', undefined, 404);
	if (opts.adapter !== undefined && opts.adapter !== null && opts.adapter !== rec.adapter) {
		throw new AppError('IMPORT_ADAPTER_MISMATCH', undefined, 409);
	}
	if (rec.plan.entries.length === 0) throw new AppError('IMPORT_NOTHING_TO_IMPORT');
	return runImport(v, getAdapter(rec.adapter), rec.plan, rec.root, {
		targetPrefix: normalizePrefix(opts.targetPrefix),
		indexer: opts.indexer,
		onProgress: opts.onProgress
	});
}

/** Dirs a source folder may never be (or be inside): the app's data dir, this vault's dir and its library. */
export function protectedDirsFor(v: VaultContext, dataDir?: string): string[] {
	return [...(dataDir ? [dataDir] : []), v.dir, libraryRoot(v)];
}
