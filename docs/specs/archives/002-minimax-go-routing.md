# Spec 002: MiniMax M3 через подписку GO попадает в pxpipe

## Проблема

Traffic `minimax-m3` не появлялся в дашборде. Диагностика показала:

1. opencode шлёт `minimax-m3` через провайдер **`opencode-go`** (models.dev:
   api `https://opencode.ai/zen/go/v1`, npm `@ai-sdk/anthropic` → формат
   Anthropic Messages, `POST /v1/messages`), а не через `opencode` (zen).
2. У пользователя в opencode.jsonc override baseURL был только у провайдера
   `opencode` — `opencode-go` ходил напрямую в zen/go, минуя pxpipe.
3. В pxpipe совместимые провайдеры (DeepSeek/MiMo/MiniMax) матчились только
   на OpenAI-лейне (`/v1/chat/completions`, `/v1/responses`) — Anthropic-лейн
   (`/v1/messages`) их не учитывал, upstream для minimax через GO указывал на
   `https://opencode.ai/zen` (воркспейс zen, а не подписку GO; для MiniMax это
   401 CreditsError при пустом балансе).

## Решение

- `src/node.ts`: upstream MiniMax для GO-подписчиков → `https://opencode.ai/zen/go`
  (плоская подписка; `/zen` — воркспейс, биллинг отдельно). Спправка обновлена.
- `src/core/proxy.ts`: `findCompatibleProvider` применяется и к messages-лейну;
  count_tokens probe бьёт в upstream совместимого провайдера, а не в дефолтный
  Anthropic.
- Пользовательский конфиг `~/.config/opencode/opencode.jsonc`: добавлен override
  baseURL для провайдера `opencode-go` → http://127.0.0.1:47821/v1.

## Дополнение: baseline-оценка при отсутствии count_tokens

zen/go не реализует `/v1/messages/count_tokens` (404), поэтому probe возвращал
null и дашборд честно исключал строки из экономии («baseline пока нет»). Для
провайдеров без count_tokens (zen/go, api.minimaxi.com) введена оценка:

`baseline = input_tokens + imagedChars / REPORT_CHARS_PER_TOKEN − imagePixels / ANTHROPIC_PIXELS_PER_TOKEN`

(фактически уплаченное + текст, который изображения заменили, − токены самих
изображений; `Math.max(inp)` — никогда не занижает фактическую цену).

- `src/core/proxy.ts`: при `baselineResolved === null` и наличии usage/images
  считается оценка, статус `'estimate'`.
- Статус `'estimate'` добавлен в типы (`tracker.ts`, `transform.ts`) и принимается
  гейтами дашборда и сессий (`dashboard.ts` update/replay, `sessions.ts`).
- Для estimate-строк cache-aware weighted-математика обходится (нет cacheable-пробы;
  `computeBaselineInputEff` вернул бы 0 экономии) — baseline засчитывается as-is.
- Тест: `tests/proxy-usage.test.ts` — 404-проба → `baselineProbeStatus==='estimate'`,
  baseline > input_tokens.

## Проверка

- `npx tsc --noEmit` — чисто.
- Vitest: полный прогон 645 passed / 2 failed (оба предсуществующие: docs-integrity
  на Windows-сепараторе путей, export-git-e2e без git-коммитов в репо).
- E2E руками: `POST /v1/messages` (model minimax-m3, x-api-key GO) через pxpipe →
  200 от zen/go, событие в events.jsonl:
  `compressed:true, baseline_tokens:1397, baseline_probe_status:"estimate", input_tokens:419`.
- Пользователю нужно перезапустить opencode, чтобы подхватился конфиг.