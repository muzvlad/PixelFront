/**
 * Координатор для доступа к активному tracker'у из других модулей.
 *
 * Тонкий singleton: `node.ts:main()` вызывает `setActiveTracker()` при старте,
 * `sessions.ts:prune()` вызывает `getActiveTracker()` чтобы обернуть
 * destructive rewrite в `suspend`/`resume` без потери событий.
 *
 * Избегаем циклических импортов: `sessions.ts` не импортирует `node.ts`;
 * `node.ts` не импортирует `sessions.ts` (это уже было).
 */
import type { Tracker } from './core/tracker.js';

let activeTracker: Tracker | undefined;

/** Set the process-wide active tracker. Called by node.ts on startup/shutdown.
 *  Accepts `null` as well so callers can pass `setActiveTracker(null)` without
 *  losing the call's intent (the TS-strict difference between `null` and
 *  `undefined` shouldn't matter to node.ts:shutdown()). */
export function setActiveTracker(t: Tracker | null | undefined): void {
  activeTracker = t ?? undefined;
}

/** Get the process-wide active tracker, if any. */
export function getActiveTracker(): Tracker | undefined {
  return activeTracker;
}
