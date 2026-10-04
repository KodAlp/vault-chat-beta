export interface ChickConfig {
	[key: string]: number | boolean;
}

export type ChickPhase = 'idle' | 'thinking' | 'done';

export interface ChickOptions {
	config?: Partial<ChickConfig>;
	/** Called when the 'done' exit animation has finished. */
	onExited?: () => void;
	onState?: (state: string) => void;
}

export interface Chick {
	setPhase(phase: ChickPhase): void;
	setConfig(partial: Partial<ChickConfig>): void;
	getConfig(): ChickConfig;
	setSpeed(speed: number): void;
	destroy(): void;
}

export const VAULT_CHICK_DEFAULTS: ChickConfig;

export function createChick(root: HTMLElement, opts?: ChickOptions): Chick;
