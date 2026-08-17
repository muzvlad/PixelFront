# SPEC-013: Schema-валидация `PXPIPE_CONFIG`

| Поле | Значение |
|---|---|
| **Приоритет** | 🟢 Низкий |
| **Категория** | UX / безопасность парсинга |
| **Файлы** | `src/node.ts` |
| **Связь с аудитом** | пункт 5.5 |
| **Объём работ** | 1 час |
| **Breaking change** | Нет |

## Проблема

`applyConfigFileDefaults()` (`src/node.ts:67-86`) делает «сырой» `JSON.parse` без валидации:

```ts
function applyConfigFileDefaults(): void {
  const file = process.env.PXPIPE_CONFIG ?? DEFAULT_CONFIG_FILE;
  if (!fs.existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    console.warn(`[pxpipe] ignored invalid config ${file}: ${(e as Error).message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const cfg = parsed as Record<string, unknown>;

  if (process.env.PXPIPE_MODELS === undefined) {
    const models = normalizeModelsConfig(cfg.models);
    if (models !== undefined) process.env.PXPIPE_MODELS = models;
  }
}
```

### Сценарии, которые сейчас тихо игнорируются:

1. `models: 42` → `normalizeModelsConfig` вернёт `undefined`, env не установится. Пользователь не узнает, что его конфиг проигнорирован.
2. `models: ""` → `normalizeModelsConfig` возвращает `'off'` — это **намеренно** для `off`-семантики. OK.
3. `models: ["claude-*", 42]` → массив фильтруется через `map(String).filter(Boolean)`. Получается `["claude-*"]` беззвучно.
4. Неизвестные ключи (`port`, `verbose`, и т.д.) — игнорируются без предупреждения. Это **forward-compat** поведение, но стоит явно его задокументировать.

## Требования

1. При невалидном типе `models` — `console.warn` с описанием.
2. Unknown ключи — silently ignore (forward compat), но **зафиксировать в логике** (комментарий + тест).
3. Превратить `normalizeModelsConfig` в более явную функцию `validateConfig(obj): ConfigShape | undefined`.

## Дизайн

```ts
/** Known configuration keys; others are silently ignored (forward compat). */
const KNOWN_CONFIG_KEYS = new Set(['models']);

interface ConfigShape {
  /** Список моделей или 'off'. undefined если не задано. */
  models?: string;
}

function validateConfig(obj: unknown): ConfigShape | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return undefined; // Нечего валидировать.
  }
  const o = obj as Record<string, unknown>;
  const out: ConfigShape = {};

  if ('models' in o) {
    const m = o.models;
    if (typeof m === 'string') {
      out.models = m.trim() || 'off';
    } else if (Array.isArray(m)) {
      if (m.every((v) => typeof v === 'string')) {
        const models = (m as string[]).map((s) => s.trim()).filter(Boolean);
        out.models = models.length > 0 ? models.join(',') : 'off';
      } else {
        console.warn(
          `[pxpipe] config.models: array contains non-string values, ignored. ` +
            `Expected string or string[].`,
        );
      }
    } else {
      console.warn(
        `[pxpipe] config.models: expected string or string[], got ${typeof m}, ignored.`,
      );
    }
  }

  return out;
}

function applyConfigFileDefaults(): void {
  const file = process.env.PXPIPE_CONFIG ?? DEFAULT_CONFIG_FILE;
  if (!fs.existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    console.warn(`[pxpipe] ignored invalid config ${file}: ${(e as Error).message}`);
    return;
  }
  const cfg = validateConfig(parsed);
  if (!cfg) return;

  if (cfg.models !== undefined && process.env.PXPIPE_MODELS === undefined) {
    process.env.PXPIPE_MODELS = cfg.models;
  }
}
```

## Acceptance Criteria

- [x] `models: 42` → warning + игнор.
- [x] `models: ["claude-*", 42]` → warning + игнор.
- [x] `models: ""` → `off` (как раньше).
- [x] `models: ["claude-*"]` → `claude-*`.
- [x] `models: "claude-*,deepseek-*"` → `claude-*,deepseek-*`.
- [x] Unknown keys → silently ignored (тест: пишет `port: 8080`, поведение не меняется).
- [x] Конфиг с JSON parse error → как раньше (warning).
- [x] Не объект (`42`, `"foo"`) → тихий no-op (как раньше).

## Тесты

### tests/config-validation.test.ts (новый)

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// validateConfig — лучше вынести в отдельный модуль для тестируемости,
// см. SPEC-013-design.

describe('validateConfig', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns undefined for non-object', () => {
    // @ts-expect-error testing invalid input
    expect(validateConfig(42)).toBeUndefined();
    // @ts-expect-error
    expect(validateConfig('foo')).toBeUndefined();
    // @ts-expect-error
    expect(validateConfig(null)).toBeUndefined();
    expect(validateConfig([1, 2])).toBeUndefined();
  });

  it('parses models as string', () => {
    expect(validateConfig({ models: 'claude-*' })?.models).toBe('claude-*');
    expect(validateConfig({ models: '' })?.models).toBe('off');
    expect(validateConfig({ models: '  ' })?.models).toBe('off');
  });

  it('parses models as string array', () => {
    expect(validateConfig({ models: ['claude-*', 'deepseek-*'] })?.models)
      .toBe('claude-*,deepseek-*');
    expect(validateConfig({ models: [] })?.models).toBe('off');
    expect(validateConfig({ models: ['claude-*', ''] })?.models).toBe('claude-*');
  });

  it('warns and ignores on wrong type', () => {
    validateConfig({ models: 42 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('models'));
  });

  it('warns on mixed array', () => {
    validateConfig({ models: ['claude-*', 42] });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('ignores unknown keys silently', () => {
    const result = validateConfig({ models: 'claude-*', port: 8080, fog: 'baz' });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result?.models).toBe('claude-*');
  });

  it('returns empty config when no models key', () => {
    expect(validateConfig({})).toEqual({});
    expect(validateConfig({ port: 8080 })).toEqual({});
  });
});

describe('applyConfigFileDefaults', () => {
  // Эти тесты требуют изоляции env, использовать fresh setup.
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-config-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PXPIPE_CONFIG;
    delete process.env.PXPIPE_MODELS;
  });

  it('sets PXPIPE_MODELS from config file', () => {
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ models: 'claude-*,deepseek-*' }));
    process.env.PXPIPE_CONFIG = cfg;
    delete process.env.PXPIPE_MODELS;
    applyConfigFileDefaults();
    expect(process.env.PXPIPE_MODELS).toBe('claude-*,deepseek-*');
  });

  it('env wins over file', () => {
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ models: 'from-file' }));
    process.env.PXPIPE_CONFIG = cfg;
    process.env.PXPIPE_MODELS = 'from-env';
    applyConfigFileDefaults();
    expect(process.env.PXPIPE_MODELS).toBe('from-env');
  });

  it('silent on missing file', () => {
    process.env.PXPIPE_CONFIG = path.join(tmpDir, 'nonexistent.json');
    delete process.env.PXPIPE_MODELS;
    applyConfigFileDefaults(); // Не должно бросать.
    expect(process.env.PXPIPE_MODELS).toBeUndefined();
  });
});
```

> ⚠️ Для тестирования `applyConfigFileDefaults` нужно либо вынести `validateConfig` в отдельный модуль, либо экспортировать из `node.ts`.

## Обратная совместимость

- Дефолтный путь `~/.config/pxpipe/config.json` без изменений.
- Невалидный JSON — как раньше (warning, ignore).
- Валидный `models: string | string[]` — без изменений.
- Не-валидный `models` теперь **логируется**, раньше тихо.

### Что может измениться в видимом поведении

- Пользователь с опечаткой в конфиге (`models: 42`) теперь увидит warning. Раньше — тихий fallback. Считается улучшением UX.

## Открытые вопросы

- **Q1:** Использовать ли zod/valibot вместо ручной валидации? В данном случае схема из 1 ключа — overkill. Оставить ручной валидатор.
- **Q2:** Должен ли быть JSON-schema файл для пользователей (для IDE autocomplete)? При единственной опции — не нужен.

## Чеклист PR

- [x] `src/node.ts`: `validateConfig` добавлен, `applyConfigFileDefaults` использует его.
- [x] (Опционально) `validateConfig` вынесен в `src/config.ts` для тестируемости.
- [x] `tests/config-validation.test.ts` добавлен.
- [x] `pnpm typecheck && pnpm test` — чисто.
- [x] Manual: создать `~/.config/pxpipe/config.json` с `{"models": 42}` — должен появиться warning.

## Статус

**Done** — реализовано в текущей ветке.

- `src/config.ts`: новый файл, экспортирует `validateConfig(obj): ConfigShape | undefined` + `ConfigShape` interface + `KNOWN_CONFIG_KEYS` set.
- `src/node.ts:67-95`: `applyConfigFileDefaults` теперь импортирует `validateConfig` из `src/config.ts` и использует его; поведение при валидном `models` (string | string[]) и при невалидном JSON сохранено. Невалидный тип `models` теперь пишет `console.warn`.
- `tests/config-validation.test.ts`: 16 тестов — все 8 AC + edge cases (пустой массив, mixed массив, env-wins, silent on missing file). Все 36 test files / 690 tests проходят (duration 6.92s).
- `CHANGELOG.md`: добавлена запись в `Unreleased` секции.

### Открытые вопросы (резолюция)

- **Q1 (zod/valibot):** решено — ручной валидатор остался (1 ключ, overkill от внешней либы не оправдан).
- **Q2 (JSON-schema):** решено — при одной опции `models` не нужен.
