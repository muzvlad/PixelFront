# Spec 001: регистронезависимое сопоставление моделей

## Проблема

`isAllowed` в `src/core/applicability.ts` сравнивает model id с разрешённым
скопом регистро-зависимо, тогда как два других матчера — `findCompatibleProvider`
(proxy.ts) и `resolveGptProfile` (gpt-model-profiles.ts) — сбрасывают регистр.
Клиент, посылающий официальный MiniMax id `MiniMax-M3` (например, при прямом
подключении к api.minimaxi.com), не пройдёт гейт допуска → `unsupported_model` →
полный passthrough без сжатия.

## Решение

Привести model id к нижнему регистру в `isAllowed` до сравнения с базой
(базы тоже сравнить регистронезависимо, т.к. `PXPIPE_MODELS` может содержать
заглавные id). Поведение для нижнего регистра не меняется.

## Проверка

- `npm test` — существующие тесты public-api / openai-gpt5 не ломаются.
- Новый тест: `MiniMax-M3` → true при дефолтном скопе (minimax-m3 включён).