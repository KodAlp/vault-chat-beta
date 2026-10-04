<script lang="ts">
	import { settings, persistSettings } from '$lib/settings.svelte';
	import { i18n, persistLocale, type Locale } from '$lib/i18n/index.svelte';
	import { Switch } from '$lib/components/ui/switch';
	import { t } from '$lib/i18n/index.svelte';

	type ThemeValue = typeof settings.theme;

	let themeOptions = $derived<{ value: ThemeValue; label: string }[]>([
		{ value: 'system', label: t('SettingsPage.themeSystem') },
		{ value: 'light', label: t('SettingsPage.themeLight') },
		{ value: 'dark', label: t('SettingsPage.themeDark') },
		{ value: 'cream', label: t('SettingsPage.themeCream') },
		{ value: 'sand', label: t('SettingsPage.themeSand') },
		{ value: 'forest', label: t('SettingsPage.themeForest') }
	]);

	// Locale names are endonyms (a language's own name for itself) — these
	// stay as-is regardless of UI locale, same as "Français" doesn't become
	// "French" in an English menu.
	const localeOptions: { value: Locale; label: string }[] = [
		{ value: 'tr', label: 'Türkçe' },
		{ value: 'en', label: 'English' }
	];

	function pickTheme(value: ThemeValue) {
		settings.theme = value;
		persistSettings();
	}

	function pickLocale(value: Locale) {
		i18n.locale = value;
		persistLocale();
	}
</script>

<svelte:head>
	<title>{t('SettingsNav.appearance')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<section class="vc-group !p-0">
		<h2 class="vc-group-title">{t('SettingsPage.themeTitle')}</h2>
		<div class="theme-grid" role="radiogroup" aria-label={t('SettingsPage.themeTitle')}>
			{#each themeOptions as opt (opt.value)}
				<label class="theme-card" class:selected={settings.theme === opt.value}>
					<input
						type="radio"
						name="theme"
						value={opt.value}
						checked={settings.theme === opt.value}
						onchange={() => pickTheme(opt.value)}
						class="sr-only"
					/>
					{#if opt.value === 'system'}
						<span class="swatch swatch-split" aria-hidden="true">
							<span class="half" data-theme="light"><i class="side"></i><i class="dot"></i></span>
							<span class="half" data-theme="dark"><i class="side"></i><i class="dot"></i></span>
						</span>
					{:else}
						<span class="swatch" data-theme={opt.value} aria-hidden="true">
							<span class="half"><i class="side"></i><i class="dot"></i></span>
						</span>
					{/if}
					<span class="theme-label">{opt.label}</span>
				</label>
			{/each}
		</div>
	</section>

	<section class="vc-group !p-0">
		<h2 class="vc-group-title">{t('SettingsPage.languageTitle')}</h2>
		<div class="vc-list">
			<div class="vc-list-row">
				<span>{t('SettingsPage.languageTitle')}</span>
				<div class="vc-seg ml-auto" role="tablist" aria-label={t('SettingsPage.languageTitle')}>
					{#each localeOptions as opt (opt.value)}
						<button type="button" role="tab" aria-selected={i18n.locale === opt.value} onclick={() => pickLocale(opt.value)}>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>
		</div>
	</section>

	<section class="vc-group !p-0">
		<h2 class="vc-group-title">{t('SettingsNav.behaviorTitle')}</h2>
		<div class="vc-list">
			<label class="vc-list-row cursor-pointer items-start py-3">
				<span class="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
					{t('SettingsPage.showWelcomeScreen')}
					<span class="text-xs text-muted-foreground">{t('SettingsPage.showWelcomeScreenHint')}</span>
				</span>
				<Switch bind:checked={settings.showWelcomeScreen} onCheckedChange={persistSettings} />
			</label>
			<label class="vc-list-row cursor-pointer items-start py-3">
				<span class="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
					{t('SettingsPage.quizLevelLabels')}
					<span class="text-xs text-muted-foreground">{t('SettingsPage.quizLevelLabelsHint')}</span>
				</span>
				<Switch bind:checked={settings.quizLevelLabels} onCheckedChange={persistSettings} />
			</label>
		</div>
	</section>
</div>

<style>
	.theme-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: var(--space-3);
	}
	.theme-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2);
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		box-shadow: inset 0 0 0 1px var(--separator);
		cursor: pointer;
		transition: background-color var(--duration-fast);
	}
	.theme-card:hover {
		background: var(--fill-hover);
	}
	.theme-card.selected {
		box-shadow: inset 0 0 0 2px var(--accent-text);
	}
	.theme-card:has(input:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
	.theme-label {
		font: 500 13px/18px var(--font-sans);
		color: var(--label);
		padding: 0 var(--space-1);
	}
	.swatch {
		display: flex;
		height: 64px;
		border-radius: var(--radius-md);
		overflow: hidden;
		box-shadow: inset 0 0 0 1px var(--separator-strong);
		background: var(--bg-canvas);
	}
	.swatch .half {
		position: relative;
		flex: 1;
		display: flex;
		background: var(--bg-canvas);
	}
	.swatch .side {
		width: 28%;
		background: var(--bg-sidebar);
		border-right: 1px solid var(--separator);
	}
	.swatch .dot {
		position: absolute;
		right: 10px;
		bottom: 10px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--accent);
	}
	.swatch-split {
		background: none;
	}
</style>
