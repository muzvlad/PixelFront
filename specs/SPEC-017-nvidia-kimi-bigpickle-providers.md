# SPEC-017: Провайдеры NVIDIA NIM (Kimi, Nemotron) и Big Pickle

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | Routing / compatibility |
| **Файлы** | `src/node.ts`, `src/core/proxy.ts` (тесты), `README.md` |
| **Объём работ** | 1-2 часа |
| **Breaking change** | Нет |

## Проблема

Клиенты (OpenCode с провайдером `nvidia`) шлют модели с org-префиксом:
`moonshotai/kimi-k3`, `nvidia/nemotron-3.5-lightning-30b-a3b`,
`minimaxai/minimax-m3`. Ни один префикс не матчится в `findCompatibleProvider`
→ запрос уходит на дефолтный OpenAI upstream (`api.openai.com`) и падает
(404 / region-block). Журнал pxpipe это подтверждает: `big-pickle -> 403
unsupported_country_region_territory`, nemotron/mimo-free ошибки того же
класса.

Дополнительно — коллизия: `minimaxai/minimax-m3` начинается с `minimax`,
поэтому при добавлении «в лоб» ушёл бы в минимаксовский GO-провайдер.

## Решение

Добавить совместимые провайдеры в `buildCompatibleProviders()` (src/node.ts):

```ts
const NV_UPSTREAM = process.env.NVIDIA_UPSTREAM ?? 'https://integrate.api.nvidia.com';
const nvKey = process.env.NVIDIA_API_KEY;
providers.push({ modelPrefix: 'moonshotai', upstream: NV_UPSTREAM, apiKey: nvKey });
providers.push({ modelPrefix: 'nvidia',     upstream: NV_UPSTREAM, apiKey: nvKey });
// longest-prefix wins: minimaxai/* должен победить 'minimax'
providers.push({ modelPrefix: 'minimaxai',  upstream: NV_UPSTREAM, apiKey: nvKey });
// big-pickle из каталога Zen; ключ подписки форвардится от клиента
providers.push({ modelPrefix: 'big-pickle', upstream: GO_ZEN /* opencode.ai/zen */ });
```

- Путь собирается как `upstreamBase + путь клиента` (`stripOpenAIV1=false`),
  т.е. NVIDIA получит `https://integrate.api.nvidia.com/v1/chat/completions`.
- Auth: если `NVIDIA_API_KEY` не задан — клиентский `Authorization`
  форвардится как есть (существующее поведение compatible-провайдеров).
- Сжатие НЕ включаем: модели не добавляются в `DEFAULT_MODEL_BASES`
  (Nemotron — текстовая, картинки = hard 400; Kimi/Big Pickle — vision не
  подтверждён). Срабатывает существующий fail-closed passthrough
  (`unsupported_model` → `compress:false`).

## Acceptance Criteria

- [ ] `moonshotai/kimi-k3` → NVIDIA upstream.
- [ ] `nvidia/nemotron-3.5-lightning-30b-a3b` → NVIDIA upstream.
- [ ] `minimaxai/minimax-m3` → NVIDIA upstream (НЕ minimax).
- [ ] `minimax-m3` (без org) → по-прежнему minimax/GO.
- [ ] `big-pickle` → Zen gateway, auth форвардится.
- [ ] Неизвестная модель → прежнее поведение (OpenAI upstream).
- [ ] Help text и README обновлены.
- [ ] Тесты проходят, tsc чист.

## Чеклист PR

- [x] `src/node.ts`: 4 новых провайдера + env `NVIDIA_UPSTREAM`/`NVIDIA_API_KEY`.
- [x] `tests/compatible-providers.test.ts`: матчинг префиксов, коллизия minimaxai/minimax.
- [x] `printHelp()`: документация env.
- [x] README: секция Supported models.
- [x] `tsc --noEmit && vitest run` — чисто (43 файла / 717 тестов).

> Реализация (2026-08-26): как и планировано — сжатие для новых моделей не
> включалось (fail-closed passthrough через существующий
> `isPxpipeSupportedGptModel` → `compress:false`). `buildCompatibleProviders`
> остался в node.ts — импорт в тестах невозможен (main() биндит порт), поэтому
> тестируется сам матчер `findCompatibleProvider` из core/proxy.ts.
