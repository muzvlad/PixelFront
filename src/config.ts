/**
 * Configuration file validation (`PXPIPE_CONFIG`).
 *
 * The config file is JSON loaded at startup; before SPEC-013 it was a raw
 * `JSON.parse` followed by a tolerant `normalizeModelsConfig` helper that
 * silently dropped wrong types. A user typo (`models: 42`) meant the env
 * override never kicked in and there was no signal in the logs.
 *
 * `validateConfig` is the single source of truth: it parses the JSON object,
 * normalises `models`, and logs a warning on any wrong-typed key. Unknown
 * keys are silently ignored on purpose — forward-compat for new options
 * shipped in later releases (see SPEC-013, Q1).
 *
 * Split out from `src/node.ts` so unit tests can exercise the validator
 * without booting the proxy / dashboard.
 */

/** Keys recognised by the validator. Anything else is silently ignored. */
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set(['models']);

/** Parsed configuration shape — every field is optional. */
export interface ConfigShape {
  /** Comma-separated model list, or `'off'` to disable the override.
   *  `undefined` when the key is absent or invalid (after a warning). */
  models?: string;
}

/**
 * Validate a parsed JSON value. Returns `undefined` for non-objects; otherwise
 * a normalised `ConfigShape`. Invalid `models` types are warned about once
 * per call (the caller is expected to log via stderr already).
 */
export function validateConfig(obj: unknown): ConfigShape | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return undefined;
  }
  const o = obj as Record<string, unknown>;
  const out: ConfigShape = {};

  if ('models' in o) {
    out.models = normaliseModelsField(o.models);
  }

  return out;
}

/**
 * Normalise the `models` field — accepts `string` or `string[]`, returns
 * comma-separated list, or `'off'` for an empty list. Any other type or a
 * mixed array logs a warning and returns `undefined`.
 */
export function normaliseModelsField(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || 'off';
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) {
      const models = (value as string[]).map((s) => s.trim()).filter(Boolean);
      return models.length > 0 ? models.join(',') : 'off';
    }
    console.warn(
      '[pxpipe] config.models: array contains non-string values, ignored. ' +
        'Expected string or string[].',
    );
    return undefined;
  }
  console.warn(
    `[pxpipe] config.models: expected string or string[], got ${typeof value}, ignored.`,
  );
  return undefined;
}
