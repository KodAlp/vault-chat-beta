<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { Snippet } from 'svelte';
	import type { LucideIcon } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { selectionKey, parseSelectionKey } from '$lib/model-selection';
	import type { ProviderModelOption } from '$lib/types';

	/**
	 * Shared shell for the five generation dialogs (quiz/cards/report/
	 * mindmap/slides) — Faz 9 Adim 4. Before this, each was a near-identical
	 * ~215-260 line file differing only in labels, an optional extra field
	 * (quiz mc/tf/open composition, cards count+due-badge+review CTA), and
	 * which *-generation.svelte.ts store it called. Those five store
	 * modules stay separate on purpose (see frontend-revamp skill) — they
	 * are state logic, not UI, and unifying them was not part of this pass.
	 * This component owns only the generic UI: trigger button, model/
	 * provider + domain/context/prompt fields, and the open/close/generate
	 * dialog chrome. Type-specific extra fields and the final store call
	 * stay with the caller via onGenerate + the extraTop/extraFields
	 * snippets, which close over whatever local state (mc, tf, count...)
	 * that caller needs.
	 *
	 * Model/provider picker ("make provider selection honest" pass): before
	 * this, every caller hardcoded settings.reasoningProvider/reasoningModel
	 * directly into its onGenerate body, so nothing in this dialog — not
	 * even the chat header's own model selector, which only ever affected
	 * /api/chat — could change which provider a given generation actually
	 * used. The five global reasoning*Provider/Model settings are now only
	 * this dialog's OPENING default; the caller reads the user's final
	 * choice back out of onGenerate's args instead of re-reading settings
	 * itself.
	 */
	let {
		chatId,
		vaultId,
		icon,
		label,
		dialogTitle,
		promptLabel,
		promptPlaceholder,
		disabled = false,
		canGenerate = true,
		badge = null,
		open = $bindable(false),
		includedPaths,
		defaultProvider,
		defaultModel,
		onGenerate,
		extraTop,
		extraFields
	}: {
		chatId: string;
		vaultId: string;
		icon: LucideIcon;
		label: string;
		dialogTitle: string;
		promptLabel: string;
		promptPlaceholder: string;
		disabled?: boolean;
		canGenerate?: boolean;
		badge?: number | null;
		open?: boolean;
		/** Chat's own source-tree scope selection (Faz 12) — forwarded as-is
		 * into onGenerate's args so generation uses the same scope the chat
		 * itself is currently answering from. */
		includedPaths?: string[];
		/** Opening default for the picker below — settings.reasoningProvider/
		 * reasoningModel from the caller. Only re-read each time the dialog
		 * transitions closed->open (see the $effect below), not on every
		 * render: the picker holds the user's in-dialog choice steady while
		 * the dialog stays open, rather than snapping back if the global
		 * default happens to change out from under it mid-edit. */
		defaultProvider: string;
		defaultModel: string;
		onGenerate: (args: {
			prompt: string;
			domains?: string[];
			chatId?: string;
			vault: string;
			includedPaths?: string[];
			provider: string;
			model: string;
		}) => void;
		extraTop?: Snippet;
		extraFields?: Snippet;
	} = $props();

	// Capitalized local binding — Svelte only treats a tag as a dynamic
	// component when its name starts uppercase, so the lowercase `icon`
	// prop can't be used as `<icon />` directly.
	let Icon = $derived(icon);

	let domains = $state<string[]>([]);
	let selectedDomain = $state('');
	// Off by default. The chat's last messages are appended to the retrieval query, and a 1500-character chat swamps a
	// 30-character topic: measured on the quiz generator, the pool shared 0.00-0.20 of its top parts with the topic-only
	// pool (even a chat of pure greetings), and no automatic rule separated "chat is the topic" from "chat is noise"
	// (see docs/plan-ogrenme-ajani-ve-performans.md, F1a). Tick it when the prompt has no topic of its own ("bu konudan sınav yap").
	let useChatContext = $state(false);
	let prompt = $state('');

	let modelOptions = $state<ProviderModelOption[]>([]);
	// untrack: reading defaultProvider/defaultModel here is a deliberate
	// one-time seed at mount, not a subscription — the $effect below is
	// what keeps this in sync with the props on every open, on purpose
	// (see its own comment for why re-deriving on every prop change would
	// be wrong).
	let selectionKeyState = $state(untrack(() => selectionKey(defaultProvider, defaultModel)));
	let selectedOption = $derived(
		modelOptions.find((m) => selectionKey(m.providerId, m.id) === selectionKeyState)
	);

	// Re-seed the picker from the CURRENT global default every time the
	// dialog opens, not just once at mount — this component (the trigger
	// button plus the dialog) is mounted for the whole chat screen's
	// lifetime, so a captured initial default would go stale the moment the
	// user changes their reasoning provider/model in Settings before ever
	// opening this dialog. Same "open re-syncs" pattern as StudyPanel's
	// wasOpen effect.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) selectionKeyState = selectionKey(defaultProvider, defaultModel);
		wasOpen = open;
	});

	// İ2 (Aşama 8): same first-use consent gate as ModelPickerRow.svelte —
	// the picker's onValueChange (not bind:value, see below) routes here
	// instead of writing straight to selectionKeyState, so an unconsented
	// cloud pick can still be cancelled back to the current selection
	// instead of already having taken effect.
	let pendingModel = $state<ProviderModelOption | null>(null);
	let consentBusy = $state(false);

	function handleModelSelect(key: string): void {
		const opt = modelOptions.find((m) => selectionKey(m.providerId, m.id) === key);
		if (opt && opt.cloud && !opt.consented) {
			pendingModel = opt;
			return;
		}
		selectionKeyState = key;
	}

	async function confirmPendingModel(): Promise<void> {
		if (!pendingModel) return;
		const opt = pendingModel;
		consentBusy = true;
		try {
			await fetch(`/api/providers/${opt.providerId}/consent`, { method: 'POST' });
			selectionKeyState = selectionKey(opt.providerId, opt.id);
		} finally {
			consentBusy = false;
			pendingModel = null;
		}
	}

	onMount(async () => {
		try {
			const res = await fetch(`/api/domains?vault=${encodeURIComponent(vaultId)}`);
			if (res.ok) domains = (await res.json()) as string[];
		} catch {
			// domain list stays empty — dropdown just shows "Tüm domainler"
		}
		try {
			const res = await fetch('/api/providers/models');
			if (res.ok) modelOptions = (await res.json()) as ProviderModelOption[];
		} catch {
			// Picker just falls back to showing the bare default model id below.
		}
	});

	function openDialog() {
		if (disabled) return;
		open = true;
	}

	function generate() {
		if (!prompt.trim() || !canGenerate || disabled) return;
		open = false;
		const { providerId, modelId } = parseSelectionKey(selectionKeyState);
		onGenerate({
			domains: selectedDomain ? [selectedDomain] : undefined,
			chatId: useChatContext ? chatId : undefined,
			prompt: prompt.trim(),
			vault: vaultId,
			includedPaths,
			provider: providerId,
			model: modelId
		});
	}
</script>

<button
	type="button"
	class="flex flex-col items-center gap-0.5 rounded-sm border-none bg-transparent p-0 text-muted-foreground hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
	onclick={openDialog}
	{disabled}
	title={dialogTitle}
>
	<span class="relative inline-flex">
		<Icon size={19} aria-hidden="true" />
		{#if badge}
			<span
				class="absolute -top-1.5 -right-2.5 rounded-full bg-primary px-1 text-[0.6875rem] leading-none font-bold text-primary-foreground"
			>
				{badge > 99 ? '99+' : badge}
			</span>
		{/if}
	</span>
	<span class="text-[0.6875rem]">{label}</span>
</button>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{dialogTitle}</Dialog.Title>
		</Dialog.Header>

		{#if extraTop}
			{@render extraTop()}
		{/if}

		<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
			{t('GenerationDialog.modelLabel')}
			<Select.Root type="single" value={selectionKeyState} onValueChange={handleModelSelect}>
				<Select.Trigger class="w-full">
					{selectedOption
						? `${selectedOption.providerLabel} · ${selectedOption.id}`
						: parseSelectionKey(selectionKeyState).modelId || t('ModelPickerRow.autoModel')}
				</Select.Trigger>
				<Select.Content>
					{#if !selectedOption}
						<Select.Item
							value={selectionKeyState}
							label={parseSelectionKey(selectionKeyState).modelId || t('ModelPickerRow.autoModel')}
						>
							{parseSelectionKey(selectionKeyState).modelId || t('ModelPickerRow.autoModel')}
						</Select.Item>
					{/if}
					{#each modelOptions as m (m.providerId + '/' + m.id)}
						<Select.Item value={selectionKey(m.providerId, m.id)} label={`${m.providerLabel} · ${m.id}`}>
							{m.providerLabel} · {m.id}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</label>

		<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
			{t('GenerationDialog.domainLabel')}
			<Select.Root type="single" bind:value={selectedDomain}>
				<Select.Trigger class="w-full">
					{selectedDomain || t('GenerationDialog.allDomains')}
				</Select.Trigger>
				<Select.Content>
					{#each domains as d (d)}
						<Select.Item value={d} label={d}>{d}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</label>

		<label class="flex cursor-pointer items-center gap-2 text-sm">
			<Checkbox bind:checked={useChatContext} />
			{t('GenerationDialog.useChatContext')}
		</label>

		<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
			{promptLabel}
			<Textarea bind:value={prompt} placeholder={promptPlaceholder} class="min-h-16" />
		</label>

		{#if extraFields}
			{@render extraFields()}
		{/if}

		{#if disabled}
			<p class="text-xs text-muted-foreground">{t('GenerationDialog.alreadyGenerating')}</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>{t('Common.iptal')}</Button>
			<Button onclick={generate} disabled={!prompt.trim() || !canGenerate || disabled}>{t('GenerationDialog.generate')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={pendingModel !== null} onOpenChange={(o) => !o && (pendingModel = null)}>
	<AlertDialog.Content>
		{#if pendingModel}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('GenerationDialog.consentTitle')}</AlertDialog.Title>
				<AlertDialog.Description>
					{t('GenerationDialog.consentDescription', { provider: pendingModel.providerLabel })}
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.iptal')}</AlertDialog.Cancel>
				<AlertDialog.Action
					disabled={consentBusy}
					onclick={(e) => {
						e.preventDefault();
						confirmPendingModel();
					}}
				>
					{t('GenerationDialog.consentConfirm')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
