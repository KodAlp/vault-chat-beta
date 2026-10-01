<script lang="ts">
	/**
	 * Aşama 2b — first-run wizard for setting up a local LLM server (Ollama /
	 * LM Studio / llama.cpp / Jan), reached from the welcome screen's
	 * "continue" action (see welcome/+page.svelte's proceed()) on the very
	 * first launch of the Tauri desktop build only — localServerSetup.svelte.ts's
	 * server-backed flag (ui-prefs.json, NOT localStorage — the desktop
	 * build's random sidecar port would reset a localStorage-only flag on
	 * every launch) makes this a once-ever wizard, not a once-per-launch one
	 * like /welcome itself.
	 *
	 * Every Tauri command this page calls (detect_local_servers,
	 * redetect_launcher_program, save_launcher, start_launcher,
	 * winget_available, winget_install) is one of the fixed, already
	 * security-reviewed commands in src-tauri/src/launchers.rs and winget.rs
	 * — this page never constructs a launcher/winget id from anything other
	 * than a `server.id`/`server.winget_id` string that itself came straight
	 * back from `detect_local_servers`.
	 *
	 * This route is reachable in a plain browser dev session too (SvelteKit
	 * doesn't gate routes), but isTauri() is false there, so onMount below
	 * just shows the "no local servers detected" + skip state without ever
	 * calling into `@tauri-apps/api/core` — nothing here throws outside Tauri.
	 */
	import { onMount } from 'svelte';
	import { installHint, showWingetNote } from '$lib/install-hints';
	import { serverPlatform } from '$lib/serverPlatform.svelte';
	import { goto } from '$app/navigation';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { t } from '$lib/i18n/index.svelte';
	import { markLocalServerSetupDone } from '$lib/localServerSetup.svelte';
	import { openExternalLink } from '$lib/openExternalLink';
	import { readResponseError } from '$lib/server-error';
	import { settings, persistSettings } from '$lib/settings.svelte';
	import { autoPickModel, emptyChainTasks, chooseEmbeddingCandidate, modelListed } from '$lib/setup-choices';
	import type {
		DetectedServer,
		ProviderStatus,
		PythonSetupEvent,
		PythonSystemStatus,
		WingetDoneEvent,
		WingetProgressEvent
	} from '$lib/types';

	// Only these four are offered as fresh installs when nothing local is
	// detected at all — llamacpp-embed/localai/vllm are advanced/manual
	// paths, managed later from Settings > Sağlayıcılar, not part of the
	// first-run choice.
	const ONBOARDING_IDS = ['ollama', 'lmstudio', 'llamacpp', 'jan'];

	let tauri = isTauri();

	// -- detection ----------------------------------------------------------

	let loading = $state(true);
	let servers = $state<DetectedServer[]>([]);
	let providers = $state<ProviderStatus[]>([]);

	let installedServers = $derived(servers.filter((s) => s.installed !== null || s.running));
	let onboardingOptions = $derived(servers.filter((s) => ONBOARDING_IDS.includes(s.id)));

	async function refreshServers() {
		if (!tauri) return;
		try {
			servers = await invoke<DetectedServer[]>('detect_local_servers');
		} catch {
			servers = [];
		}
	}

	async function refreshProviders() {
		try {
			const res = await fetch('/api/providers');
			if (res.ok) providers = (await res.json()) as ProviderStatus[];
		} catch {
			// Best-effort — a failed refresh just means ensureProviderForServer's
			// "already exists?" check below sees a stale/empty list and may add
			// a provider that turns out to be a near-duplicate; not worth
			// blocking the wizard over.
		}
	}

	onMount(() => {
		void (async () => {
			await Promise.all([refreshServers(), refreshProviders(), refreshWinget(), refreshPythonStatus()]);
			loading = false;
		})();
	});

	// -- "use this server" ---------------------------------------------------

	let busyId = $state<string | null>(null);
	let actionError = $state<Record<string, string>>({});
	let usedServer = $state<DetectedServer | null>(null);

	// llama.cpp/llama.cpp-embed take `-m <gguf>`, vLLM takes a model NAME
	// (see launchers.rs's MODEL_PATH_PLACEHOLDER/MODEL_NAME_PLACEHOLDER) —
	// start_launcher's own build_effective_args() hard-errors
	// ("model_path ayarlanmadı." / "model adı ayarlanmadı.") if that field
	// isn't set yet, and a launcher saved with autoStart:true but no model
	// would then fail the SAME way on every future app launch too. So for
	// these three ids, `useServer` below stops short of starting anything
	// and hands off to this pending-model state instead — the model is
	// collected inline in the same card, and only startPendingServer()
	// actually flips autoStart on and starts it.
	const MODEL_REQUIRED_IDS = ['llamacpp', 'llamacpp-embed', 'vllm'];
	let pendingModelServer = $state<DetectedServer | null>(null);
	let pendingModelPath = $state<string | null>(null);
	let pendingModelName = $state('');
	let pendingModelError = $state('');

	async function ensureProviderForServer(server: DetectedServer): Promise<void> {
		if (server.id === 'ollama') {
			const ollama = providers.find((p) => p.id === 'ollama');
			if (ollama && !ollama.enabled) {
				await fetch('/api/providers/ollama', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ enabled: true })
				});
			}
			await refreshProviders();
			return;
		}

		const baseUrl = `http://127.0.0.1:${server.port}/v1`;
		const existing = providers.find((p) => p.baseUrl === baseUrl);
		if (existing) {
			if (!existing.enabled) {
				await fetch(`/api/providers/${encodeURIComponent(existing.id)}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ enabled: true })
				});
			}
			await refreshProviders();
			return;
		}

		const res = await fetch('/api/providers', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ label: server.display_name, baseUrl, kind: 'openai-compat', local: true })
		});
		if (!res.ok) throw new Error(await readResponseError(res));
		const entry = (await res.json()) as { id: string };
		await fetch(`/api/providers/${encodeURIComponent(entry.id)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: true })
		});
		await refreshProviders();
	}

	function errMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	async function useServer(server: DetectedServer) {
		busyId = server.id;
		actionError = { ...actionError, [server.id]: '' };
		try {
			if (!server.running) {
				if (!server.launchable) {
					throw new Error(t('LocalServerSetupPage.cannotStart'));
				}
				await invoke('redetect_launcher_program', { id: server.id });

				if (MODEL_REQUIRED_IDS.includes(server.id)) {
					// null, not omitted — see the save_launcher call below for why.
					// autoStart stays FALSE here: nothing gets started (or
					// auto-started on a future launch) until startPendingServer()
					// below actually has a model to give it.
					await invoke('save_launcher', {
						id: server.id,
						args: null,
						port: server.port,
						autoStart: false,
						modelPath: null,
						model: null
					});
					pendingModelServer = server;
					pendingModelPath = null;
					pendingModelName = '';
					pendingModelError = '';
					return;
				}

				// null, not omitted: Tauri's IPC round-trips these through JSON,
				// where an omitted key and an explicit `null` are not
				// guaranteed to behave the same for an Option<T> Rust param —
				// null unambiguously deserializes to None. args: null keeps
				// upsert_launcher_program's just-written default_args
				// unchanged (see save_launcher's Option semantics); model_path/
				// model: null is a no-op here since this is the first save for
				// a launcher that redetect_launcher_program just created with
				// both unset.
				await invoke('save_launcher', {
					id: server.id,
					args: null,
					port: server.port,
					autoStart: true,
					modelPath: null,
					model: null
				});
				await invoke('start_launcher', { id: server.id });
			}
			await ensureProviderForServer(server);
			usedServer = server;
		} catch (err) {
			actionError = { ...actionError, [server.id]: errMessage(err) };
		} finally {
			busyId = null;
		}
	}

	/** llama.cpp/llama.cpp-embed's half of the pending-model step — same
	 * `open()` .gguf-filtered file picker LauncherPanel.pickModelFile uses. */
	async function pickPendingModelFile() {
		if (!pendingModelServer) return;
		busyId = pendingModelServer.id;
		pendingModelError = '';
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const picked = await open({
				multiple: false,
				directory: false,
				filters: [{ name: 'GGUF', extensions: ['gguf'] }]
			});
			if (typeof picked === 'string') pendingModelPath = picked;
		} catch (err) {
			pendingModelError = errMessage(err);
		} finally {
			busyId = null;
		}
	}

	/** Only now — with an actual model in hand — does autoStart flip to
	 * true and start_launcher get called, closing the gap useServer() left
	 * open above. */
	async function startPendingServer() {
		const server = pendingModelServer;
		if (!server) return;
		const isVllm = server.id === 'vllm';
		if (isVllm && !pendingModelName.trim()) {
			pendingModelError = t('LocalServerSetupPage.modelNameRequired');
			return;
		}
		if (!isVllm && !pendingModelPath) {
			pendingModelError = t('LocalServerSetupPage.modelFileRequired');
			return;
		}
		busyId = server.id;
		pendingModelError = '';
		try {
			await invoke('save_launcher', {
				id: server.id,
				args: null,
				port: server.port,
				autoStart: true,
				modelPath: isVllm ? null : pendingModelPath,
				model: isVllm ? pendingModelName.trim() : null
			});
			await invoke('start_launcher', { id: server.id });
			await ensureProviderForServer(server);
			usedServer = server;
			pendingModelServer = null;
		} catch (err) {
			pendingModelError = errMessage(err);
		} finally {
			busyId = null;
		}
	}

	/** Jan's path — never started by us (launchable: false); this only wires
	 * the provider entry, on the assumption the user has (or will) turn on
	 * Jan's own "Local API Server" toggle themselves. */
	async function addProviderOnly(server: DetectedServer) {
		busyId = server.id;
		actionError = { ...actionError, [server.id]: '' };
		try {
			await ensureProviderForServer(server);
			usedServer = server;
		} catch (err) {
			actionError = { ...actionError, [server.id]: errMessage(err) };
		} finally {
			busyId = null;
		}
	}

	// -- winget install (shared by server installs + python/pandoc below) ---

	let wingetAvailable = $state(false);
	let wingetBusyId = $state<string | null>(null);
	let wingetLog = $state<string[]>([]);
	let wingetError = $state('');
	/** Which winget id `wingetError` belongs to — the single-flight winget
	 * pipeline shares one error slot across every install button on this
	 * page (server cards + python + pandoc), so this stops a failure from
	 * one card's install from appearing to be about a different card. */
	let wingetErrorId = $state<string | null>(null);
	/** Which winget id the CURRENT wingetLog/success/still-missing state
	 * belongs to — unlike wingetBusyId (null once the install finishes),
	 * this stays set after completion so that card can keep showing what
	 * happened instead of the log/status just vanishing the moment the
	 * install finishes (the bug this whole block exists to fix: previously
	 * nothing here survived past wingetBusyId going back to null). */
	let wingetLogId = $state<string | null>(null);
	/** Set once winget itself reports success (including a no-op "already
	 * installed" run) — shown even when the immediate re-check still can't
	 * see the result yet (see wingetStillMissingId below). */
	let wingetSuccessId = $state<string | null>(null);
	/** Set when a winget install succeeded but this app's own re-check still
	 * reports the thing as missing — the exact bug this fix targets: a
	 * winget install can land pandoc.exe somewhere this already-running
	 * Node process's stale PATH doesn't see until it's restarted. */
	let wingetStillMissingId = $state<string | null>(null);

	async function refreshWinget() {
		if (!tauri) return;
		try {
			wingetAvailable = await invoke<boolean>('winget_available');
		} catch {
			wingetAvailable = false;
		}
	}

	async function runWingetInstall(wingetId: string): Promise<boolean> {
		wingetBusyId = wingetId;
		wingetLog = [];
		wingetError = '';
		wingetErrorId = null;
		wingetLogId = wingetId;
		wingetSuccessId = null;
		wingetStillMissingId = null;
		const { listen } = await import('@tauri-apps/api/event');
		const offProgress = await listen<WingetProgressEvent>('winget-progress', (e) => {
			if (e.payload.id === wingetId) wingetLog = [...wingetLog, e.payload.line];
		});
		const offDone = await listen<WingetDoneEvent>('winget-done', () => {});
		try {
			await invoke('winget_install', { id: wingetId });
			// winget exiting 0 covers both "installed" and "already installed,
			// nothing to upgrade" — both are a success from this wizard's point
			// of view, so the generic success text below reads fine for either.
			wingetSuccessId = wingetId;
			return true;
		} catch (err) {
			wingetError = errMessage(err);
			wingetErrorId = wingetId;
			return false;
		} finally {
			offProgress();
			offDone();
			wingetBusyId = null;
		}
	}

	async function installServerViaWinget(server: DetectedServer) {
		if (!server.winget_id) return;
		const ok = await runWingetInstall(server.winget_id);
		if (ok) {
			await refreshServers();
			const nowVisible = servers.some((s) => s.id === server.id && (s.installed !== null || s.running));
			if (!nowVisible) wingetStillMissingId = server.winget_id;
		}
	}

	// -- Ollama model step ----------------------------------------------------

	type ModelCheck = 'idle' | 'checking' | 'has_model' | 'need_model';
	let modelCheck = $state<ModelCheck>('idle');
	let defaultOllamaModel = $state<string | null>(null);
	let pulling = $state(false);
	let pullLog = $state<string[]>([]);
	let pullError = $state('');

	/** Same base+tag matching rule as LocalServerBanner.modelInstalled. */
	const modelInstalled = modelListed;

	/** What the Ollama step offers to download when nothing usable is installed (and no default model is
	 * configured — the shipped providers.json carries none). */
	const SUGGESTED_OLLAMA_MODEL = 'qwen3:8b';

	async function checkOllamaModel() {
		modelCheck = 'checking';
		try {
			const ollama = providers.find((p) => p.id === 'ollama');
			let wanted = ollama?.defaultModel ?? null;
			if (!wanted) {
				// No configured default: any installed chat model is fine; only an empty list needs a download.
				const listRes = await fetch('/api/providers/ollama/models');
				if (listRes.ok) {
					const listed = (await listRes.json()) as { approved: { id: string }[] };
					if (listed.approved.length > 0) {
						modelCheck = 'has_model';
						return;
					}
				}
				wanted = SUGGESTED_OLLAMA_MODEL;
			}
			defaultOllamaModel = wanted;
			const res = await fetch('/api/models');
			if (!res.ok) {
				modelCheck = 'has_model';
				return;
			}
			const installed = (await res.json()) as { name: string }[];
			modelCheck = modelInstalled(installed.map((m) => m.name), wanted) ? 'has_model' : 'need_model';
		} catch {
			modelCheck = 'has_model';
		}
	}

	async function pullDefaultModel() {
		if (!defaultOllamaModel) return;
		if (await pullModelByName(defaultOllamaModel)) modelCheck = 'has_model';
	}

	/** Streams /api/models' pull progress into pullLog/pullError; true once Ollama reports done. Shared by the
	 * chat-model download above and the embedding-model (bge-m3) download in the embedding step below. */
	async function pullModelByName(model: string): Promise<boolean> {
		pulling = true;
		pullError = '';
		pullLog = [];
		let ok = false;
		try {
			const res = await fetch('/api/models', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model })
			});
			if (!res.ok || !res.body) throw new Error(await readResponseError(res));
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5)) as { type: string; status?: string; error?: string };
					if (event.type === 'progress') pullLog = [...pullLog.slice(-4), event.status ?? ''];
					else if (event.type === 'done') ok = true;
					else if (event.type === 'error') pullError = event.error ?? t('Common.bilinmeyenHata');
				}
			}
		} catch (err) {
			pullError = errMessage(err);
		} finally {
			pulling = false;
		}
		return ok;
	}

	$effect(() => {
		if (usedServer?.id === 'ollama' && modelCheck === 'idle') void checkOllamaModel();
	});

	// -- chat model + embedding choice (Aşama 4c) ----------------------------
	//
	// The shipped providers.json has empty chains, no default model and no embedding (keyword search only),
	// so once a server is running THIS is what makes chat work: pick a chat model, make it the default for
	// the provider, put the provider at the head of every empty chain, point the client's pins at it — and
	// decide how the library is searched.

	/** The providers.json id of the server just set up: 'ollama', or the entry ensureProviderForServer
	 * created/found by baseUrl. */
	let usedProviderId = $derived.by(() => {
		if (!usedServer) return null;
		if (usedServer.id === 'ollama') return 'ollama';
		return providers.find((p) => p.baseUrl === `http://127.0.0.1:${usedServer!.port}/v1`)?.id ?? null;
	});

	let chatModels = $state<string[]>([]);
	let embeddingModels = $state<string[]>([]);
	let modelsLoading = $state(false);
	let chosenChatModel = $state('');
	let chatApplying = $state(false);
	let appliedChatModel = $state<string | null>(null);
	let chatError = $state('');

	let embeddingBusy = $state(false);
	let embeddingError = $state('');
	let embeddingResult = $state<'vectors' | 'keyword' | null>(null);
	let embeddingResultModel = $state('');

	let embeddingCandidate = $derived(chooseEmbeddingCandidate(embeddingModels));

	async function loadServerModels() {
		if (!usedProviderId) return;
		modelsLoading = true;
		chatError = '';
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(usedProviderId)}/models`);
			if (!res.ok) throw new Error(await readResponseError(res));
			const data = (await res.json()) as { approved: { id: string }[]; other: { id: string }[]; embedding?: string[] };
			chatModels = [...data.approved, ...data.other].map((m) => m.id);
			embeddingModels = data.embedding ?? [];
			if (!chosenChatModel || !chatModels.includes(chosenChatModel)) chosenChatModel = autoPickModel(chatModels) ?? chatModels[0] ?? '';
			// Exactly one chat model: nothing to choose, so apply it right away.
			if (appliedChatModel === null && autoPickModel(chatModels) !== null) await applyChatModel();
		} catch (err) {
			chatError = errMessage(err);
		} finally {
			modelsLoading = false;
		}
	}

	/** Re-loads the server's model list whenever the server (or, for Ollama, its model-download state) changes. */
	let modelsLoadedKey = '';
	$effect(() => {
		if (!usedProviderId) return;
		if (usedServer?.id === 'ollama' && modelCheck !== 'has_model') return;
		const key = `${usedProviderId}:${modelCheck}`;
		if (key === modelsLoadedKey) return;
		modelsLoadedKey = key;
		void loadServerModels();
	});

	async function applyChatModel() {
		const providerId = usedProviderId;
		const model = chosenChatModel;
		if (!providerId || !model) return;
		chatApplying = true;
		chatError = '';
		try {
			const patch = await fetch(`/api/providers/${encodeURIComponent(providerId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ defaultModel: model })
			});
			if (!patch.ok) throw new Error(await readResponseError(patch));

			// Put this provider at the head of every chain that is still empty; a chain that already has
			// providers keeps its own routing.
			const chainsRes = await fetch('/api/providers/chains');
			if (!chainsRes.ok) throw new Error(await readResponseError(chainsRes));
			const chains = (await chainsRes.json()) as Record<string, string[]>;
			for (const task of emptyChainTasks(chains)) {
				const r = await fetch('/api/providers/chains', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ taskType: task, providerIds: [providerId] })
				});
				if (!r.ok) throw new Error(await readResponseError(r));
			}

			// The client-side pins (chat header, generation dialogs, grading, title) point at it too.
			settings.defaultModel = settings.fastModel = settings.reasoningModel = model;
			settings.defaultProvider = settings.fastProvider = settings.reasoningProvider = providerId;
			persistSettings();
			appliedChatModel = model;
		} catch (err) {
			chatError = errMessage(err);
		} finally {
			chatApplying = false;
		}
	}

	/** `model` set = use that embedding model for vectors (dims measured with one real embed call, as
	 * EmbeddingSettingsCard's "Test" does, then saved through PUT /api/embedding); `null` = explicit
	 * keyword-search-only (PUT {providerId: null}). */
	async function applyEmbedding(model: string | null) {
		const providerId = usedProviderId;
		if (!providerId) return;
		embeddingBusy = true;
		embeddingError = '';
		try {
			if (model === null) {
				const res = await fetch('/api/embedding', {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ providerId: null })
				});
				if (!res.ok) throw new Error(await readResponseError(res));
				embeddingResult = 'keyword';
				return;
			}
			const test = await fetch('/api/embedding/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ providerId, model })
			});
			if (!test.ok) throw new Error(await readResponseError(test));
			const { dims } = (await test.json()) as { dims: number };
			const res = await fetch('/api/embedding', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ providerId, model, dims })
			});
			if (!res.ok) throw new Error(await readResponseError(res));
			embeddingResult = 'vectors';
			embeddingResultModel = model;
		} catch (err) {
			embeddingError = errMessage(err);
		} finally {
			embeddingBusy = false;
		}
	}

	/** Ollama without an embedding model yet: download bge-m3 (the app's calibrated one), re-list, use it. */
	async function pullAndUseBge() {
		embeddingBusy = true;
		embeddingError = '';
		try {
			if (!(await pullModelByName('bge-m3'))) throw new Error(pullError || t('Common.bilinmeyenHata'));
		} catch (err) {
			embeddingError = errMessage(err);
			embeddingBusy = false;
			return;
		}
		embeddingBusy = false;
		await loadServerModels();
		if (embeddingCandidate) await applyEmbedding(embeddingCandidate);
	}

	// -- system check (python / modules / pandoc) ----------------------------

	let pySystem = $state<PythonSystemStatus | null>(null);
	let pipInstalling = $state(false);
	let pipLog = $state<string[]>([]);
	let pipError = $state(false);

	async function refreshPythonStatus(fresh = false) {
		try {
			const res = await fetch(fresh ? '/api/system/python?fresh=1' : '/api/system/python');
			if (res.ok) pySystem = (await res.json()) as PythonSystemStatus;
		} catch {
			// Best-effort informational panel only.
		}
	}

	async function installPythonViaWinget() {
		const ok = await runWingetInstall('Python.Python.3.12');
		await refreshPythonStatus(true);
		if (ok && !(pySystem?.pythonInstalled ?? false)) wingetStillMissingId = 'Python.Python.3.12';
	}

	async function installPandocViaWinget() {
		const ok = await runWingetInstall('JohnMacFarlane.Pandoc');
		await refreshPythonStatus(true);
		if (ok && !(pySystem?.pandoc ?? false)) wingetStillMissingId = 'JohnMacFarlane.Pandoc';
	}

	async function installPythonModules() {
		pipInstalling = true;
		pipError = false;
		pipLog = [];
		try {
			const res = await fetch('/api/system/python', { method: 'POST' });
			if (!res.ok) throw new Error(await readResponseError(res));
			if (!res.body) throw new Error(t('Common.istekBasarisiz', { status: res.status }));
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let ok = false;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5)) as PythonSetupEvent;
					if (event.type === 'log') pipLog = [...pipLog.slice(-6), event.line];
					else if (event.type === 'error') pipError = true;
					else if (event.type === 'done') ok = event.ok;
				}
			}
			pipError = pipError || !ok;
		} catch {
			pipError = true;
		} finally {
			pipInstalling = false;
			await refreshPythonStatus(true);
		}
	}

	let missingModules = $derived((pySystem?.modules ?? []).filter((m) => !m.installed));

	// -- exit ------------------------------------------------------------

	function finish() {
		markLocalServerSetupDone();
		void goto('/', { replaceState: true });
	}

	function statusLabel(server: DetectedServer): string {
		return server.running ? t('LocalServerSetupPage.statusRunning') : t('LocalServerSetupPage.statusStoppedInstalled');
	}
</script>

<svelte:head>
	<title>{t('LocalServerSetupPage.title')}</title>
</svelte:head>

{#snippet platformHint(tool: string)}
	{@const hint = installHint(serverPlatform(), tool)}
	{#if hint.kind === 'brew'}
		<p class="mt-1 text-xs text-muted-foreground">
			{t('LocalServerSetupPage.brewHint', { command: hint.command })}
		</p>
	{:else if hint.kind === 'package-manager'}
		<p class="mt-1 text-xs text-muted-foreground">{t('LocalServerSetupPage.packageManagerHint')}</p>
	{/if}
{/snippet}

{#snippet wingetStatus(id: string)}
	{#if wingetBusyId === id}
		{#if wingetLog.length > 0}
			<pre class="mt-2 max-h-24 overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{wingetLog.join('\n')}</pre>
		{/if}
	{:else if wingetLogId === id}
		{#if wingetError && wingetErrorId === id}
			<p class="mt-2 text-sm text-destructive" role="alert">{wingetError}</p>
		{:else if wingetSuccessId === id}
			<p class="mt-2 text-sm text-muted-foreground">
				{wingetStillMissingId === id
					? t('LocalServerSetupPage.installSuccessNotDetected')
					: t('LocalServerSetupPage.installSuccess')}
			</p>
		{/if}
		{#if wingetLog.length > 0}
			<details class="mt-2">
				<summary class="cursor-pointer text-xs text-muted-foreground select-none">
					{t('LocalServerSetupPage.showInstallLog')}
				</summary>
				<pre class="mt-1 max-h-24 overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{wingetLog.join('\n')}</pre>
			</details>
		{/if}
	{/if}
{/snippet}

<div class="mx-auto max-w-2xl px-4 pt-8 pb-16">
	<div class="mb-6 flex items-baseline justify-between gap-4">
		<div>
			<h1 class="font-display text-xl font-medium">{t('LocalServerSetupPage.title')}</h1>
			<p class="mt-1 text-sm text-muted-foreground">{t('LocalServerSetupPage.subtitle')}</p>
			<p class="mt-1 text-xs text-muted-foreground">{t('LocalServerSetupPage.cloudOnlyNote')}</p>
		</div>
		<button type="button" class="shrink-0 text-sm text-muted-foreground underline-offset-2 hover:underline" onclick={finish}>
			{t('LocalServerSetupPage.skip')}
		</button>
	</div>

	{#if loading}
		<p class="text-sm text-muted-foreground">{t('LocalServerSetupPage.detecting')}</p>
	{:else if usedServer}
		<Card.Root class="mb-6">
			<Card.Content>
				<p class="text-sm font-semibold">{t('LocalServerSetupPage.successTitle', { name: usedServer.display_name })}</p>
				<p class="mt-1 text-sm text-muted-foreground">{t('LocalServerSetupPage.successBody')}</p>

				{#if usedServer.id === 'ollama'}
					<div class="mt-4 border-t pt-4">
						<p class="mb-2 text-sm font-medium">{t('LocalServerSetupPage.modelCheckTitle')}</p>
						{#if modelCheck === 'checking' || modelCheck === 'idle'}
							<p class="text-sm text-muted-foreground">{t('Common.yukleniyor')}</p>
						{:else if modelCheck === 'has_model'}
							<p class="text-sm text-muted-foreground">{t('LocalServerSetupPage.modelReady')}</p>
						{:else if modelCheck === 'need_model' && defaultOllamaModel}
							<p class="mb-2 text-sm text-muted-foreground">
								{t('LocalServerSetupPage.modelMissing', { model: defaultOllamaModel })}
							</p>
							<Button size="sm" onclick={pullDefaultModel} disabled={pulling}>
								{pulling
									? t('LocalServerSetupPage.pulling')
									: t('LocalServerSetupPage.pullModel', { model: defaultOllamaModel })}
							</Button>
							{#if pullLog.length > 0}
								<pre class="mt-2 max-h-24 overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{pullLog.join('\n')}</pre>
							{/if}
							{#if pullError}
								<p class="mt-1 text-sm text-destructive" role="alert">{pullError}</p>
							{/if}
						{/if}
					</div>
				{:else}
					<p class="mt-3 text-sm text-muted-foreground">{t('LocalServerSetupPage.otherModelNote')}</p>
				{/if}

				{#if usedProviderId && (usedServer.id !== 'ollama' || modelCheck === 'has_model')}
					<div class="mt-4 border-t pt-4">
						<p class="mb-2 text-sm font-medium">{t('LocalServerSetupPage.chatModelTitle')}</p>
						{#if modelsLoading}
							<p class="text-sm text-muted-foreground">{t('Common.yukleniyor')}</p>
						{:else if appliedChatModel}
							<p class="text-sm text-muted-foreground">{t('LocalServerSetupPage.chatModelApplied', { model: appliedChatModel })}</p>
						{:else if chatModels.length === 0}
							<p class="mb-2 text-sm text-muted-foreground">{t('LocalServerSetupPage.chatModelNone')}</p>
							<Button size="sm" variant="outline" onclick={loadServerModels}>{t('LocalServerSetupPage.refreshModels')}</Button>
						{:else}
							<div class="flex flex-wrap items-center gap-2">
								<select
									class="h-8 max-w-full rounded-md border bg-background px-2 text-sm"
									aria-label={t('LocalServerSetupPage.chatModelTitle')}
									bind:value={chosenChatModel}
									disabled={chatApplying}
								>
									{#each chatModels as id (id)}
										<option value={id}>{id}</option>
									{/each}
								</select>
								<Button size="sm" onclick={applyChatModel} disabled={chatApplying || !chosenChatModel}>
									{t('LocalServerSetupPage.chatModelApply')}
								</Button>
							</div>
						{/if}
						{#if chatError}
							<p class="mt-1 text-sm text-destructive" role="alert">{chatError}</p>
						{/if}
					</div>

					<div class="mt-4 border-t pt-4">
						<p class="mb-1 text-sm font-medium">{t('LocalServerSetupPage.embeddingTitle')}</p>
						<p class="mb-2 text-xs text-muted-foreground">{t('LocalServerSetupPage.embeddingDesc')}</p>
						{#if embeddingResult === 'vectors'}
							<p class="text-sm text-muted-foreground">{t('LocalServerSetupPage.embeddingDoneVectors', { model: embeddingResultModel })}</p>
							<p class="mt-1 text-xs text-muted-foreground">{t('LocalServerSetupPage.embeddingReindexNote')}</p>
						{:else if embeddingResult === 'keyword'}
							<p class="text-sm text-muted-foreground">{t('LocalServerSetupPage.embeddingDoneKeyword')}</p>
						{:else}
							<div class="flex flex-wrap items-center gap-2">
								{#if embeddingCandidate}
									<Button size="sm" onclick={() => applyEmbedding(embeddingCandidate)} disabled={embeddingBusy}>
										{t('LocalServerSetupPage.embeddingUse', { model: embeddingCandidate })}
									</Button>
								{:else if usedServer.id === 'ollama'}
									<Button size="sm" onclick={pullAndUseBge} disabled={embeddingBusy || pulling}>
										{pulling ? t('LocalServerSetupPage.pulling') : t('LocalServerSetupPage.embeddingPullBge')}
									</Button>
								{:else}
									<p class="text-xs text-muted-foreground">{t('LocalServerSetupPage.embeddingNoneFound')}</p>
								{/if}
								<Button size="sm" variant="outline" onclick={() => applyEmbedding(null)} disabled={embeddingBusy}>
									{t('LocalServerSetupPage.embeddingKeywordOnly')}
								</Button>
							</div>
							{#if pullLog.length > 0 && pulling}
								<pre class="mt-2 max-h-24 overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{pullLog.join('\n')}</pre>
							{/if}
						{/if}
						{#if embeddingError}
							<p class="mt-1 text-sm text-destructive" role="alert">{embeddingError}</p>
						{/if}
					</div>
				{/if}

				<div class="mt-4">
					<Button onclick={finish}>{t('LocalServerSetupPage.finish')}</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{:else if installedServers.length > 0}
		<section class="mb-6">
			<h2 class="mb-2 text-sm font-semibold">{t('LocalServerSetupPage.installedSectionTitle')}</h2>
			<div class="flex flex-col gap-3">
				{#each installedServers as server (server.id)}
					<Card.Root>
						<Card.Content>
							<div class="flex flex-wrap items-center gap-1.5">
								<strong class="text-sm">{server.display_name}</strong>
								<Badge variant={server.running ? 'default' : 'outline'}>{statusLabel(server)}</Badge>
							</div>
							{#if server.installed}
								<p class="mt-1 text-xs text-muted-foreground">{server.installed}</p>
							{/if}

							{#if pendingModelServer?.id === server.id}
								<div class="mt-3 flex flex-col gap-2 border-t pt-3">
									<p class="text-xs text-muted-foreground">{t('LocalServerSetupPage.modelRequiredNote')}</p>
									{#if server.id === 'vllm'}
										<Input
											class="h-8 text-xs"
											placeholder={t('LocalServerSetupPage.vllmModelNamePlaceholder')}
											bind:value={pendingModelName}
											disabled={busyId === server.id}
										/>
									{:else}
										<Button size="sm" variant="outline" class="w-fit" onclick={pickPendingModelFile} disabled={busyId === server.id}>
											{t('LocalServerSetupPage.pickModelFile')}
										</Button>
										{#if pendingModelPath}
											<p class="truncate text-xs text-muted-foreground" title={pendingModelPath}>{pendingModelPath}</p>
										{/if}
									{/if}
									<div class="flex gap-2">
										<Button size="sm" onclick={startPendingServer} disabled={busyId === server.id}>
											{busyId === server.id ? t('LocalServerSetupPage.connecting') : t('LocalServerSetupPage.startAfterModel')}
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onclick={() => (pendingModelServer = null)}
											disabled={busyId === server.id}
										>
											{t('Common.iptal')}
										</Button>
									</div>
									{#if pendingModelError}
										<p class="text-sm text-destructive" role="alert">{pendingModelError}</p>
									{/if}
								</div>
							{:else if server.launchable}
								<div class="mt-3">
									<Button size="sm" onclick={() => useServer(server)} disabled={busyId === server.id}>
										{busyId === server.id ? t('LocalServerSetupPage.connecting') : t('LocalServerSetupPage.useThisServer')}
									</Button>
								</div>
							{:else}
								<p class="mt-2 text-xs text-muted-foreground">{t('LocalServerSetupPage.janNote')}</p>
								<div class="mt-2">
									<Button size="sm" variant="outline" onclick={() => addProviderOnly(server)} disabled={busyId === server.id}>
										{busyId === server.id ? t('LocalServerSetupPage.connecting') : t('LocalServerSetupPage.addProviderOnly')}
									</Button>
								</div>
							{/if}

							{#if actionError[server.id]}
								<p class="mt-2 text-sm text-destructive" role="alert">{actionError[server.id]}</p>
							{/if}
						</Card.Content>
					</Card.Root>
				{/each}
			</div>
		</section>
	{:else}
		<section class="mb-6">
			<h2 class="mb-1 text-sm font-semibold">{t('LocalServerSetupPage.noneInstalledTitle')}</h2>
			<p class="mb-3 text-sm text-muted-foreground">{t('LocalServerSetupPage.noneInstalledSubtitle')}</p>
			<p class="mb-4 text-xs text-muted-foreground">{t('LocalServerSetupPage.hardwareNote')}</p>

			<div class="flex flex-col gap-3">
				{#each onboardingOptions as server (server.id)}
					<Card.Root>
						<Card.Content>
							<div class="flex flex-wrap items-center gap-1.5">
								<strong class="text-sm">{server.display_name}</strong>
								{#if server.id === 'ollama'}
									<Badge variant="outline">{t('LocalServerSetupPage.recommendedBadge')}</Badge>
								{/if}
							</div>
							<p class="mt-1 text-sm text-muted-foreground">{t(`LocalServerSetupPage.description_${server.id}`)}</p>

							<div class="mt-3 flex flex-wrap items-center gap-2">
								{#if wingetAvailable && server.winget_id}
									<Button
										size="sm"
										onclick={() => installServerViaWinget(server)}
										disabled={wingetBusyId !== null}
									>
										{wingetBusyId === server.winget_id ? t('LocalServerSetupPage.installing') : t('LocalServerSetupPage.installViaWinget')}
									</Button>
								{:else}
									<Button size="sm" variant="outline" onclick={() => openExternalLink(server.download_url)}>
										{t('LocalServerSetupPage.downloadPage')}
									</Button>
								{/if}
							</div>

							{#if server.winget_id}
								{@render wingetStatus(server.winget_id)}
							{/if}
							{@render platformHint(server.id)}
						</Card.Content>
					</Card.Root>
				{/each}
			</div>
		</section>
	{/if}

	<section class="mt-8 border-t pt-6">
		<h2 class="mb-2 text-sm font-semibold">{t('LocalServerSetupPage.systemCheckTitle')}</h2>

		{#if pySystem}
			<div class="flex flex-col gap-2 text-sm">
				<div class="flex items-center justify-between gap-2">
					<span>
						{pySystem.pythonInstalled
							? t('LocalServerSetupPage.pythonInstalledLabel', { version: pySystem.pythonVersion ?? '' })
							: t('LocalServerSetupPage.pythonNotInstalled')}
					</span>
					{#if !pySystem.pythonInstalled}
						{#if tauri && wingetAvailable}
							<Button size="sm" variant="outline" onclick={installPythonViaWinget} disabled={wingetBusyId !== null}>
								{wingetBusyId === 'Python.Python.3.12' ? t('LocalServerSetupPage.installing') : t('LocalServerSetupPage.installPython')}
							</Button>
						{:else}
							<Button size="sm" variant="outline" onclick={() => openExternalLink('https://www.python.org/downloads/')}>
								{t('LocalServerSetupPage.downloadPage')}
							</Button>
						{/if}
					{/if}
				</div>
				{@render wingetStatus('Python.Python.3.12')}
				{#if !pySystem.pythonInstalled}
					{@render platformHint('python')}
				{/if}

				{#if pySystem.pythonInstalled}
					<div class="mt-2">
						<p class="mb-1 text-xs font-medium text-muted-foreground">{t('LocalServerSetupPage.moduleListTitle')}</p>
						<ul class="flex flex-col gap-0.5 text-xs">
							{#each pySystem.modules as m (m.name)}
								<li class="flex items-center justify-between gap-2">
									<span>{m.name}</span>
									<Badge variant={m.installed ? 'default' : 'outline'}>
										{m.installed ? t('LocalServerSetupPage.moduleInstalled') : t('LocalServerSetupPage.moduleMissing')}
									</Badge>
								</li>
							{/each}
						</ul>
						{#if missingModules.length > 0}
							<div class="mt-2">
								<Button size="sm" variant="outline" onclick={installPythonModules} disabled={pipInstalling}>
									{pipInstalling ? t('LocalServerSetupPage.installing') : t('LocalServerSetupPage.installModules')}
								</Button>
							</div>
							{#if pipLog.length > 0}
								<pre class="mt-2 max-h-24 overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{pipLog.join('\n')}</pre>
							{/if}
							{#if pipError}
								<p class="mt-1 text-sm text-destructive" role="alert">{t('Common.kaydedilemedi')}</p>
							{/if}
						{/if}
					</div>
				{/if}

				<div class="mt-2 flex items-center justify-between gap-2">
					<span>{t('LocalServerSetupPage.pandocLabel')}: {pySystem.pandoc ? t('LocalServerSetupPage.moduleInstalled') : t('LocalServerSetupPage.moduleMissing')}</span>
					{#if !pySystem.pandoc}
						{#if tauri && wingetAvailable}
							<Button size="sm" variant="outline" onclick={installPandocViaWinget} disabled={wingetBusyId !== null}>
								{wingetBusyId === 'JohnMacFarlane.Pandoc' ? t('LocalServerSetupPage.installing') : t('LocalServerSetupPage.installPandoc')}
							</Button>
						{:else}
							<Button size="sm" variant="outline" onclick={() => openExternalLink('https://pandoc.org/installing.html')}>
								{t('LocalServerSetupPage.downloadPage')}
							</Button>
						{/if}
					{/if}
				</div>
				{@render wingetStatus('JohnMacFarlane.Pandoc')}
				{#if !pySystem.pandoc}
					{@render platformHint('pandoc')}
				{/if}

				{#if !wingetAvailable && showWingetNote(serverPlatform())}
					<p class="text-xs text-muted-foreground">{t('LocalServerSetupPage.wingetUnavailableNote')}</p>
				{/if}
			</div>
		{/if}
	</section>
</div>
