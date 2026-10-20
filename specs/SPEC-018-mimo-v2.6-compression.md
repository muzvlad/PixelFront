# SPEC-018: Сжатие MiMo V2.6 (Pro/Flash/Ultraspeed)

## Проблема

Traffic `mimo-v2.6` не сжимался, дашборд показывал только фактически уплаченные
токены без baseline-сравнения. Диагностика:

1. `DEFAULT_MODEL_BASES` (`src/core/applicability.ts`) содержит `mimo-v2.5` и
   `mimo-v2.5-pro`, но не `mimo-v2.6` — гейт допуска возвращал `unsupported_model`,
   транформация отключалась, baseline-проба не запускалась.
2. Профиль в `gpt-model-profiles.ts` ловил v2.6 generic-правилом `^mimo`
   (tile 85/170) — завышенная оценка image-токенов, гейт прибыльности чаще
   отсекал сжатие.
3. Baseline-оценка в `proxy.ts` (для провайдеров без `count_tokens`, включая
   GO zen/go) считала уплаченные image-токены по `ANTHROPIC_PIXELS_PER_TOKEN=750`,
   тогда как реальная формула MiMo — pixels/1024 (см. доки Xiaomi: dims кратно 32,
   `tokens = (h/16 * w/16) / 4`).

## Решение

- `src/core/gpt-model-profiles.ts`: новый слот `^mimo-v2\.6` — patch-регим,
  `multiplier: 1` (даёт ровно pixels/1024: 1504×1920 → 47×60 = 2820 токенов,
  совпадает с формулой Xiaomi), `patchCap: 8192`. Слот выше generic `^mimo`,
  поэтому v2.5 сохраняет tile 85/170.
- `src/core/openai.ts`: `openAIPixelsPerToken(model)` — цена px/token по
  профилю (patch линейна; tile аппроксимируется 512×512 тайлом).
- `src/core/proxy.ts`: при отсутствии count_tokens baseline-оценка берёт
  px/token из профиля модели для OpenAI-лейна (Anthropic-лейн — прежний 750).
- `src/core/applicability.ts`: `mimo-v2.6` в `DEFAULT_MODEL_BASES`.
- `src/core/index.ts`: экспорт `resolveGptProfile` (нужен тестам).

## Изоляция

MiniMax M3 и MiMo V2.5 не затронуты: у minimax-M3 своё правило `^minimax-m3`,
у v2.5 — generic `^mimo` ниже нового слота. Тест фиксирует оба профиля.

## Проверка

- `tsc --noEmit` — чисто.
- `vitest public-api + proxy-usage` — 42 passed.
- Полный прогон — 718 passed, 1 предсуществующий таймаут (`reflow.test.ts`,
  внешний корпус `~/.pxpipe/4xx-bodies/`; падает и на baseline без правок).

## Ручная проверка E2E (для пользователя)

1. Рестарт pxpipe (`start.bat`).
2. `POST /v1/messages` (model `mimo-v2.6-pro`) через pxpipe.
3. В `~/.pxpipe/events.jsonl`: `compressed:true`, `baseline_probe_status:"estimate"`,
   `baseline_tokens > input_tokens`.
4. Дашборд: чип `mimo-v2.6` активен, колонка «Сохранено» непустая.
