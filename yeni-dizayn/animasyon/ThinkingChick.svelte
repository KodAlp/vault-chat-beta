<!--
  ThinkingChick.svelte — yanıt beklenirken gösterilen "defter okuyan kuş".
  Svelte 5 (runes) sürümü; çizim ve zamanlama thinking-chick.js'te.

  <ThinkingChick {phase} config={chickConfig} onexited={() => (showAnswer = true)} />

  phase:  'idle'     kilit elde, defter kapalı
          'thinking' kilit yere iner, defter açılır, sayfalar çevrilir
          'done'     defter kapanır, kilit alınır (config.exitMs, varsayılan 500 ms);
                     bitince onexited çağrılır — yanıtı bundan sonra göster.
  config: önizleme sayfasındaki "Ayarları kopyala" çıktısı (isteğe bağlı).
  label:  ekran okuyucu metni (varsayılan "Yanıt bekleniyor…").
  Arka plan şeffaf; boyut kapsayıcının genişliğine uyar.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { createChick } from './thinking-chick.js';

	type Phase = 'idle' | 'thinking' | 'done';
	let {
		phase = 'idle',
		config = {},
		label = 'Yanıt bekleniyor…',
		onexited
	}: {
		phase?: Phase;
		config?: Record<string, number>;
		label?: string;
		onexited?: () => void;
	} = $props();

	let root: HTMLDivElement;
	let animator: ReturnType<typeof createChick> | undefined = $state();

	onMount(() => {
		animator = createChick(root, { config, onExited: () => onexited?.() });
		animator.setPhase(phase);
		return () => animator?.destroy();
	});

	// Faz değişince makineye ilet (aynı faz tekrar gelirse makine yok sayar).
	$effect(() => {
		animator?.setPhase(phase);
	});

	// Yalnızca config gerçekten değişince yeniden çiz (ilk kurulumda değil).
	let lastConfig = '';
	$effect(() => {
		const key = JSON.stringify(config);
		if (!animator) return;
		if (lastConfig && key !== lastConfig) animator.setConfig(config);
		lastConfig = key;
	});
</script>

<div class="chick" bind:this={root} role="status" aria-live="polite" aria-label={label}></div>

<style>
	.chick {
		width: 100%;
	}
	/* SVG overflow:visible kullanıyor; kapsayıcı taşmayı kesmesin. */
	.chick :global(svg) {
		overflow: visible;
	}
</style>
