# Spec 003: Cache-aware оценка baseline на estimate-строках (GO zen/go, api.minimaxi.com)

## Проблема

Провайдеры без `/v1/messages/count_tokens` (opencode GO zen/go, api.minimaxi.com)
получают `baseline_probe_status='estimate'`: baseline — pxpipe-оценка полного
текстового запроса (`src/core/proxy.ts:706-731`).

Эта оценка кэше-неосведомлена (cache-blind): она равна полной цене текста по
ставке 1.0 на токен. Действительный запрос при этом платит 0.1x за кэшированный
префикс. Исходная формула кредитовала оценку «как есть»:

```ts
// dashboard.ts (update и replay), sessions.ts
const estimateBaseline = ... === 'estimate';
baselineInputEff = estimateBaseline ? (baseline as number) : computeBaselineInputEff(...);
```

Скидка провайдера за кэш попадала в кредит pxpipe — ровно то, что
`docs/CACHING_AND_SAVINGS.md` запрещает («The cache discount is provider
behavior, not pxpipe savings»).

### Факт по логу `~/.pxpipe/events.jsonl` (15.10–22.10, 4271 estimate-строк, /v1/messages)

| Величина | Значение |
|---|---|
| Фактически уплачено (вход, eff) | 57.1M токенов |
| Baseline как сейчас (cache-blind) | 1392.8M токенов |
| Saved как сейчас | 1335.7M токенов — «96% сэкономлено» при факте 57.1M |
| Saved по честной модели | 134.8M токенов (baseline 191.9M) |

Завышение — x9.9. Строками `baseline_probe_status='ok'` этот лог не покрыт
(проба недоступна у провайдера) — то есть баг бьёт по 100% трафика minimax-m3.

## Решение

Оценивать baseline тем же кэш-состоянием, которое показал реальный запрос.
Единственный наблюдаемый сигнал — usage провайдера: `input_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`.

```text
realized_rate = actual_eff / (input + cc + cr)
actual_eff    = input + cc*1.25 + cr*0.10

baseline_eff(estimate) = baseline_estimate * realized_rate
saved                   = baseline_eff - actual_eff
```

Смысл: текстовый контрфакт состоял бы из того же контента, поэтому кэшировался бы
так же — кэш-хит префикса и цена записи повторяют наблюдённые. Формула равносильна
пропорциональному масштабированию бакета, который провайдер выставил:
`input` → 1.0x, `cc` → 1.25x, `cr` → 0.1x, доли — от общего билла.

Инварианты:
- `cr = 0, cc = 0` → rate = 1.0 → baseline без изменений (холодный ход, полная ставка).
- `cr > 0` → rate ≈ 0.1 → baseline падает до кэш-цены, как и должен.
- `cc > 0` → rate > 1.0 (запись кэша), baseline дорожает — как и текстовый путь.
- `billed = 0` (нет usage) → кредит 0, а не весь baseline.

Путь `probe_status='ok'` (реальный count_tokens) не трогаем — он уже cache-aware
через `computeBaselineInputEff`.

## Точки правки

- `src/core/baseline.ts`: + `computeRealizedInputRate`, + `computeEstimatedBaselineInputEff`.
- `src/dashboard.ts`: ветка `estimate` в `update()` и в `replay()`.
- `src/sessions.ts`: ветка `estimate` в сборке сессии (`tokensSavedEst`).
- `tests/savings-honesty.test.ts`: инварианты «cache-blind baseline не завышает».
- `docs/CACHING_AND_SAVINGS.md`: раздел про estimate-строки.

## Проверка

- `node node_modules\typescript\bin\tsc --noEmit` — чисто.
- `node node_modules\vitest\vitest.mjs run` — 43 файла / 735 тестов passed
  (в `tests/savings-honesty.test.ts` +6 инвариантов на estimate-путь).
- Пересчёт всего лога старой и новой формулой (4276 estimate-строк, /v1/messages):

  | | факт входа | baseline | saved | saved/факт |
  |---|---|---|---|---|
  | было | 57.2M | 1395.0M (raw) | 1337.8M | x23.4 |
  | стало | 57.2M | 192.2M | 135.0M | x2.4 |

  Завышение снято в 9.9x. GPT-лейн (mimo) не затронут — он уже cache-aware
  (`computeOpenAIBaselineInputEff`): saved 31.9M при факте 39.7M.
  Общий итог по логу: saved 1401.1M → 166.9M (x14.5 → x1.72 к факту).
- Прокси пересобран (`node scripts/build.mjs`) и перезапущен, дашборд на
  http://127.0.0.1:47821 отдаёт новые числа: текущая сессия — baseline 96 895,
  actual 33 201, saved 63 694 (65.7%), топ-сессии 28.8M / 28.3M / 17.3M токенов
  (были бы в ~10x больше).

## Известные ограничения

- `sessions.ts` (сводка по сессиям в `/api/sessions.json`) считает экономию только
  для `/v1/messages`; строки GPT-лейна там дают 0. В глобальных тотах дашборда
  GPT-лейн учтён. Расхождение старое, в этот спек не входило.
- Оценка baseline на estimate-строках берёт провайдерскую картинку (`px/750`),
  а minimax выставляет изображения примерно на 25% дороже — база занижена,
  экономия слегка завышена (в пользу честности не работает, но и не раздувает).

