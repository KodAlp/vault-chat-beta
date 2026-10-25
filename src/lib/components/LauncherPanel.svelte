<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	/**
	 * Settings/providers' local-launcher control panel for ONE
	 * catalog id (Ollama or any local openai-compat server the user's added
	 * a provider for — see settings/providers/+page.svelte's usage). Wraps
	 * src-tauri/src/launchers.rs's commands; every `id` passed to
	 * `invoke(...)` here is `serverId`, a prop supplied by the parent from a
	 * fixed catalog list (detect_local_servers/list_launchers), never
	 * user-typed text.
	 *
	 * GOTCHA this component works around everywhere it calls save_launcher:
	 * unlike `args` (an `Option<Vec<String>>` param where the Rust side
	 * keeps the existing value when the caller sends `null`/omits it),
	 * `model_path`/`model` are NOT preserve-if-omitted — save_launcher
	 * unconditionally overwrites both to whatever it's given. `saveLauncher`
	 * below is the one place that calls save_launcher, and it always passes
	 * the CURRENTLY LOADED config's model_path/model back through unless the
	 * caller explicitly overrides one — so toggling auto-start or changing
	 * the port can never silently wipe a llama.cpp model_path or a vLLM
	 * model name.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { LauncherConfig, LauncherStatusValue } from '#lib/types.js';

	let {
		serverId,
		displayName,
		defaultPort,
		launchable
	}: {
		serverId: string;
		displayName: string;
		defaultPort: number;
		launchable: boolean;
	} = $props();

	const uid = $props.id();

	let config = $state<LauncherConfig | null>(null);
	let configLoaded = $state(false);
	let status = $state<LauncherStatusValue | 'checking'>('checking');
	let busy = $state(false);
	let error = $state('');
	/** Inline confirmation after a save — this panel is part of the card, not
	 * a dialog, so nothing closes on save and the user otherwise gets no sign
	 * that it worked. */
	let savedNotice = $state<'' | 'saved' | 'savedRestartNote'>('');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;

	let portDraft = $state('');
	let argsDraft = $state('');
	let modelDraft = $state('');

	function applyConfigToDrafts() {
		portDraft = String(config?.port ?? defaultPort);
		argsDraft = (config?.args ?? []).join('\n');
		modelDraft = config?.model ?? '';
	}

	async function loadConfig() {
		try {
			const list = await invoke<LauncherConfig[]>('list_launchers');
			config = list.find((l) => l.id === serverId) ?? null;
		} catch {
			config = null;
		}
		configLoaded = true;
		applyConfigToDrafts();
	}

	async function refreshStatus() {
		try {
			status = await invoke<LauncherStatusValue>('launcher_status', { id: serverId });
		} catch {
			status = 'stopped';
		}
	}

	function errMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	/** The one call site for save_launcher — see the component doc comment's
	 * GOTCHA note. `args: null` means "leave args unchanged" (save_launcher's
	 * own Option semantics); model_path/model always round-trip the
	 * currently loaded config unless explicitly overridden here. */
	async function saveLauncher(overrides: {
		args?: string[] | null;
		port?: number;
		autoStart?: boolean;
		modelPath?: string | null;
		model?: string | null;
	}): Promise<void> {
		if (!config) return;
		busy = true;
		error = '';
		savedNotice = '';
		try {
			await invoke('save_launcher', {
				id: serverId,
				args: overrides.args !== undefined ? overrides.args : null,
				port: overrides.port !== undefined ? overrides.port : config.port,
				autoStart: overrides.autoStart !== undefined ? overrides.autoStart : config.auto_start,
				modelPath: overrides.modelPath !== undefined ? overrides.modelPath : (config.model_path ?? null),
				model: overrides.model !== undefined ? overrides.model : (config.model ?? null)
			});
			await loadConfig();
			// A running server keeps the args/port it was started with.
			savedNotice = status === 'running_ours' || status === 'running_external' ? 'savedRestartNote' : 'saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (savedNotice = ''), 4000);
		} catch (err) {
			error = errMessage(err);
		} finally {
			busy = false;
		}
	}

	async function pickProgram() {
		busy = true;
		error = '';
		try {
			await invoke('pick_launcher_program', { id: serverId });
			await loadConfig();
		} catch (err) {
			error = errMessage(err);
		} finally {
			busy = false;
		}
	}

	async function redetectProgram() {
		busy = true;
		error = '';
		try {
			await invoke('redetect_launcher_program', { id: serverId });
			await loadConfig();
		} catch (err) {
			error = errMessage(err);
		} finally {
			busy = false;
		}
	}

	async function startNow() {
		busy = true;
		error = '';
		try {
			await invoke('start_launcher', { id: serverId });
			await refreshStatus();
		} catch (err) {
			error = errMessage(err);
		} finally {
			busy = false;
		}
	}

	async function stopNow() {
		busy = true;
		error = '';
		try {
			await invoke('stop_launcher', { id: serverId });
			await refreshStatus();
		} catch (err) {
			error = errMessage(err);
		} finally {
			busy = false;
		}
	}

	function toggleAutoStart() {
		if (!config) return;
		void saveLauncher({ autoStart: !config.auto_start });
	}

	function savePort() {
		const n = Number(portDraft);
		if (!Number.isInteger(n) || n < 1 || n > 65535) {
			error = t('LauncherPanel.invalidPort');
			return;
		}
		// Blur fires on every focus change; only an actual edit is a save.
		if (n === config?.port) return;
		void saveLauncher({ port: n });
	}

	function parseArgsDraft(): string[] {
		return argsDraft
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	}

	let argsDirty = $derived(parseArgsDraft().join('\n') !== (config?.args ?? []).join('\n'));

	function saveArgs() {
		void saveLauncher({ args: parseArgsDraft() });
	}

	async function pickModelFile() {
		busy = true;
		error = '';
		try {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const picked = await open({
				multiple: false,
				directory: false,
				filters: [{ name: 'GGUF', extensions: ['gguf'] }]
			});
			if (typeof picked === 'string') {
				await saveLauncher({ modelPath: picked });
			}
		} catch (err) {
			error = errMessage(err);
		} finally {
			busy = false;
		}
	}

	function saveModelName() {
		void saveLauncher({ model: modelDraft.trim() || null });
	}

	onMount(() => {
		void loadConfig();
		void refreshStatus();
	});

	// Poll launcher_status every 5s, but only while this tab/window is
	// actually visible — no point spending an IPC round-trip + loopback HTTP
	// probe every 5s while the user is elsewhere.
	$effect(() => {
		if (typeof document === 'undefined') return;
		let interval: ReturnType<typeof setInterval> | undefined;
		function stopPolling() {
			if (interval !== undefined) clearInterval(interval);
			interval = undefined;
		}
		function startPolling() {
			stopPolling();
			interval = setInterval(() => void refreshStatus(), 5000);
		}
		function onVisibilityChange() {
			if (document.visibilityState === 'visible') {
				void refreshStatus();
				startPolling();
			} else {
				stopPolling();
			}
		}
		if (document.visibilityState === 'visible') startPolling();
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			stopPolling();
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});

	let statusLabel = $derived(
		status === 'running_ours'
			? t('LauncherPanel.statusRunningOurs')
			: status === 'running_external'
				? t('LauncherPanel.statusRunningExternal')
				: status === 'checking'
					? t('Common.yukleniyor')
					: t('LauncherPanel.statusStopped')
	);
	let statusVariant = $derived<'default' | 'outline'>(
		status === 'running_ours' || status === 'running_external' ? 'default' : 'outline'
	);
	let isModelFileKind = $derived(serverId === 'llamacpp' || serverId === 'llamacpp-embed');
	let isVllm = $derived(serverId === 'vllm');
</script>

<div class="mt-3 flex flex-col gap-2 rounded-md border p-3 text-xs">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<span class="font-medium">{t('LauncherPanel.title', { name: displayName })}</span>
		<Badge variant={statusVariant}>{statusLabel}</Badge>
	</div>

	{#if configLoaded && !config}
		<p class="text-muted-foreground">{t('LauncherPanel.noProgram')}</p>
		<div class="flex flex-wrap gap-2">
			<Button size="sm" variant="outline" onclick={redetectProgram} disabled={busy}>
				<Icon name="refresh" size="sm" class={busy ? 'animate-spin' : ''} />
				{t('LauncherPanel.redetect')}
			</Button>
			<Button size="sm" variant="outline" onclick={pickProgram} disabled={busy}>{t('LauncherPanel.pickProgram')}</Button>
		</div>
	{:else if config}
		<p class="truncate text-muted-foreground" title={config.program}>{config.program}</p>

		{#if launchable}
			<div class="flex flex-wrap items-center gap-2">
				<Button size="sm" onclick={startNow} disabled={busy || status === 'running_ours' || status === 'running_external'}>
					{t('LauncherPanel.startNow')}
				</Button>
				<Button size="sm" variant="outline" onclick={stopNow} disabled={busy || status !== 'running_ours'}>
					{t('LauncherPanel.stopNow')}
				</Button>
				<Button size="sm" variant="ghost" onclick={pickProgram} disabled={busy}>{t('LauncherPanel.pickProgram')}</Button>
				<Button size="sm" variant="ghost" onclick={redetectProgram} disabled={busy}>{t('LauncherPanel.redetect')}</Button>
			</div>

			<label class="flex cursor-pointer items-center gap-1.5">
				<Switch checked={config.auto_start} onCheckedChange={toggleAutoStart} disabled={busy} />
				{t('LauncherPanel.autoStart')}
			</label>

			<div class="flex items-end gap-2">
				<div class="flex flex-col gap-1">
					<Label for="{uid}-port" class="text-muted-foreground">{t('LauncherPanel.portLabel')}</Label>
					<Input id="{uid}-port" class="h-7 w-24 text-xs" bind:value={portDraft} onblur={savePort} disabled={busy} />
				</div>
			</div>
		{/if}

		{#if launchable && !isVllm}
			<div class="flex flex-col gap-1">
				<Label for="{uid}-args" class="text-muted-foreground">{t('LauncherPanel.argsLabel')}</Label>
				<textarea
					id="{uid}-args"
					class="min-h-16 rounded border border-input bg-transparent p-1.5 font-mono text-xs"
					bind:value={argsDraft}
					disabled={busy}
				></textarea>
				<Button size="sm" variant="outline" class="w-fit" onclick={saveArgs} disabled={busy || !argsDirty}>{t('Common.kaydet')}</Button>
			</div>
		{/if}

		{#if isModelFileKind}
			<div class="flex flex-col gap-1">
				<Label class="text-muted-foreground">{t('LauncherPanel.modelFileLabel')}</Label>
				<p class="truncate text-muted-foreground" title={config.model_path ?? ''}>
					{config.model_path ?? t('LauncherPanel.modelFileNotSet')}
				</p>
				<Button size="sm" variant="outline" class="w-fit" onclick={pickModelFile} disabled={busy}>
					{t('LauncherPanel.pickModelFile')}
				</Button>
			</div>
		{/if}

		{#if isVllm}
			<div class="flex flex-col gap-1">
				<Label for="{uid}-model" class="text-muted-foreground">{t('LauncherPanel.vllmModelLabel')}</Label>
				<div class="flex gap-2">
					<Input id="{uid}-model" class="h-7 flex-1 text-xs" bind:value={modelDraft} disabled={busy} />
					<Button size="sm" variant="outline" onclick={saveModelName} disabled={busy}>{t('Common.kaydet')}</Button>
				</div>
			</div>
		{/if}
	{:else}
		<p class="text-muted-foreground">{t('Common.yukleniyor')}</p>
	{/if}

	{#if error}
		<p class="text-destructive" role="alert">{error}</p>
	{/if}
	<p class="text-muted-foreground" role="status">
		{savedNotice ? t(`LauncherPanel.${savedNotice}`) : ''}
	</p>

	{#if !launchable}
		<p class="text-muted-foreground">{t('LauncherPanel.notLaunchableNote')}</p>
	{/if}
</div>
