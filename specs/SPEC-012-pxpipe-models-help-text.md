# SPEC-012: Уточнение `PXPIPE_MODELS` help text

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | Документация / UX |
| **Файлы** | `src/node.ts`, `README.md` |
| **Связь с аудитом** | пункт 2.7 |
| **Объём работ** | 30 минут |
| **Breaking change** | Нет |

## Проблема

В `src/node.ts:231-233` help text перечисляет дефолтное значение `PXPIPE_MODELS`:

```
PXPIPE_MODELS           модели через запятую для сжатия (Claude + GPT + DeepSeek + MiMo + MiniMax);
                        по умолчанию claude-fable-5,gpt-5.6,deepseek-v4-pro,deepseek-v4-flash,
                        deepseek-v4-flash-free,deepseek-v3,mimo-v2.5-pro,mimo-v2.5,minimax-m3; off — выкл
```

Некоторые из перечисленных моделей (`claude-fable-5`, `gpt-5.6`, `deepseek-v4-pro`, `minimax-m3`) — **внутренние кодовые имена**, не реальные публичные ID:
- Реальные: `claude-sonnet-4-5`, `gpt-4o`, `deepseek-chat`, `gpt-4-vision-preview`.
- Внутренние (предположительно для upstream-aliased провайдеров): `claude-fable-5`, `gpt-5.6`, `minimax-m3`.

Если пользователь видит `claude-fable-5` в help'е и идёт в Anthropic Console — модели не существует.

## Требования

1. Разделить default-список на **реальные** провайдерские ID и **внутренние алиасы**.
2. Help text пояснить: «значение по умолчанию включает алиасы для OpenCode GO подписки».
3. Добавить секцию в `README.md` со списком поддерживаемых моделей и маппингом алиас → реальный ID.

## Действия

### Шаг 1: Расследовать реальные ID

```bash
# Найти все ссылки на эти имена в коде.
grep -rE "claude-fable-5|gpt-5\.6|deepseek-v4-pro|mimo-v2\.5|minimax-m3" src/ scripts/
```

### Шаг 2: Обновить help text в `src/node.ts`

```ts
// Было:
PXPIPE_MODELS           модели через запятую для сжатия (Claude + GPT + DeepSeek + MiMo + MiniMax);
                        по умолчанию <огромная строка>

// Стало:
PXPIPE_MODELS           модели для сжатия (через запятую). Список по умолчанию
                        покрывает Claude (claude-sonnet-4-5), OpenAI (gpt-5.6),
                        DeepSeek, MiMo, MiniMax. Полный список — README.md#supported-models.
                        off — отключить сжатие для всех моделей.
```

### Шаг 3: README секция

Добавить в README.md секцию «Supported models»:

```markdown
## Supported models

`PXPIPE_MODELS` accepts a comma-separated list of model prefixes. The default
list covers the following:

| Prefix      | Provider  | Real model IDs                         | Notes                |
|-------------|-----------|----------------------------------------|----------------------|
| `claude-*`  | Anthropic | claude-3-5-sonnet, claude-sonnet-4-5   | Direct API or proxy  |
| `claude-fable-5` | OpenCode GO (Zen) | claude-fable-5 (alias)         | Requires OpenCode sub |
| `gpt-*`     | OpenAI    | gpt-4o, gpt-5                          | Direct API           |
| `gpt-5.6`   | OpenCode GO (Zen) | gpt-5.6 (alias)               | Requires OpenCode sub |
| `deepseek-*`| DeepSeek  | deepseek-chat, deepseek-reasoner       |                      |
| `mimo-*`    | Xiaomi    | mimo-v2-flash                          |                      |
| `minimax-*` | MiniMax M3 | minimax-m3 (multimodal)               | Compress support varies |

### Customizing

```bash
# Disable all compression:
PXPIPE_MODELS=off pxpipe

# Only Claude:
PXPIPE_MODELS=claude-* pxpipe

# Claude + DeepSeek:
PXPIPE_MODELS=claude-*,deepseek-* pxpipe
```
```

## Acceptance Criteria

- [ ] Help text в `src/node.ts:231-233` упрощён.
- [ ] README.md содержит секцию «Supported models» с таблицей.
- [ ] Все 9 кодовых имён трактованы в README либо как реальные, либо как алиасы.
- [ ] Test: snapshot `printHelp()` фиксирует финальный текст.

## Тесты

### tests/help-snapshot.test.ts (новый или расширение существующего)

```ts
import { describe, expect, it } from 'vitest';

describe('pxpipe help text', () => {
  it('mentions all configured environments', () => {
    // Запустить pxpipe --help и проверить, что в выводе есть PXPIPE_MODELS.
    // Либо: импортировать printHelp() как функцию и захватить console.log.
    expect(help).toContain('PXPIPE_MODELS');
    expect(help).toContain('claude');
    expect(help).toContain('deepseek');
    expect(help).toContain('mimo');
    expect(help).toContain('minimax');
  });

  it('does not contain "claude-fable-5" as a real ID without qualification', () => {
    // Либо оно квалифицировано как алиас, либо отсутствует.
    expect(help).not.toMatch(/claude-fable-5/);
  });
});
```

## Обратная совместимость

Только текст help'а — никаких runtime-изменений.

## Открытые вопросы

- **Q1:** Не устаревают ли `claude-fable-5`, `gpt-5.6` со временем? Стоит ли вынести default-список в конфигурируемую переменную?
  - **Решение:** оставить default в коде, но дать пользователю перезаписать через `PXPIPE_MODELS`.

## Чеклист PR

- [x] `src/node.ts:231-233`: упрощён help text.
- [x] `README.md`: добавлена секция «Supported models» с таблицей.
- [ ] (Опционально) `tests/help-snapshot.test.ts` добавлен.
- [x] Manual: `pnpm build && node dist/node.js --help` показывает обновлённый текст.
- [x] `pnpm typecheck && pnpm test` — чисто.

> Реализация (2026-08-18): help-snapshot тест пропущен — `printHelp()` живёт в
> `src/node.ts`, чей импорт запускает `main()` (bind дашборда); проверено
> вручную через `tsx src/node.ts --help`.
