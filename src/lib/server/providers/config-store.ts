import fs from 'node:fs';
import { providersPath } from '../env';

export interface ProviderConfigEntry {
	id: string;
	label: string;
	baseUrl: string;
	kind: 'ollama' | 'openai-compat';
	reasoningDialect: 'think-tags' | 'reasoning_content' | 'none';
	enabled: boolean;
	timeouts: { connectMs: number; firstTokenMs: number; idleMs: number };
}

export interface ProvidersFile {
	providers: ProviderConfigEntry[];
	chains: Record<string, string[]>;
}

function readFile(): ProvidersFile {
	return JSON.parse(fs.readFileSync(providersPath(), 'utf-8')) as ProvidersFile;
}

function writeFile(data: ProvidersFile): void {
	fs.writeFileSync(providersPath(), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Settings-UI writers for data/providers.json — separate from registry.ts's
 * read-only, mtime-cached loader. Writing here naturally invalidates that
 * cache (the mtime changes), so no extra invalidation call is needed. */
export function readProvidersFile(): ProvidersFile {
	return readFile();
}

export function updateProviderEnabled(id: string, enabled: boolean): ProviderConfigEntry {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new Error(`Bilinmeyen provider: ${id}`);
	entry.enabled = enabled;
	writeFile(data);
	return entry;
}

export function updateChain(taskType: string, providerIds: string[]): void {
	const data = readFile();
	data.chains[taskType] = providerIds;
	writeFile(data);
}
