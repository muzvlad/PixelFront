# SPEC-009: Конфигурируемые skip-директории в `pxpipe export`

| Поле | Значение |
|---|---|
| **Приоритет** | 🟡 Средний |
| **Категория** | UX / configurability |
| **Файлы** | `src/node.ts` |
| **Связь с аудитом** | пункт 5.2 |
| **Объём работ** | 30 минут |
| **Breaking change** | Нет |

## Проблема

`WALK_SKIP_DIRS` (`src/node.ts:751-754`) — хардкод:

```ts
const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '__pycache__', '.cache', '.next', '.nuxt', '.turbo',
]);
```

Mono-repos часто имеют специфичные директории:
- Python: `.venv`, `venv`, `.tox`, `site-packages`
- Rust: `target`
- Go: `vendor`
- Terraform: `.terraform`
- Java/Kotlin: `.gradle`, `build`, `target`
- Vue: ещё `.nuxt` уже включён.

Пользователь не может дополнить список без правки исходников.

## Требования

1. Добавить переменную окружения `PXPIPE_SKIP_DIRS` — comma-separated список дополнительных директорий.
2. Финальный `WALK_SKIP_DIRS` = defaults + env.
3. Whitespace trimming + filter empty.
4. Документация в `printExportHelp()` и README.

## Дизайн

```ts
/**
 * Default directories never descended into when walking files.
 * Extend with PXPIPE_SKIP_DIRS (comma-separated) for mono-repos with
 * Python venvs (`.venv`), Rust targets, etc.
 */
const DEFAULT_WALK_SKIP_DIRS = [
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '__pycache__', '.cache', '.next', '.nuxt', '.turbo',
] as const;

function buildWalkSkipDirs(): Set<string> {
  const extra = (process.env.PXPIPE_SKIP_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_WALK_SKIP_DIRS, ...extra]);
}

const WALK_SKIP_DIRS = buildWalkSkipDirs();
```

### Обновление `printExportHelp`

```ts
Options:
  --include <glob>   include only files matching glob (repeatable)
  --exclude <glob>   exclude files matching glob (repeatable)
  ...
Environment variables:
  PXPIPE_SKIP_DIRS   comma-separated additional dirs to skip during walk
                     (default: node_modules, .git, ..., .turbo).
                     Add e.g. ".venv,target,vendor" for Python/Rust/Go projects.
```

## Acceptance Criteria

- [ ] `PXPIPE_SKIP_DIRS=".venv,target"` → эти директории пропускаются при `pxpipe export`.
- [ ] Без env — поведение идентично текущему.
- [ ] Документация обновлена в `printExportHelp` и README.
- [ ] Snapshot-тест: один и тот же `pxpipe export .` с дефолтным env даёт идентичный набор файлов.

## Тесты

### tests/skip-dirs.test.ts (новый)

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const CLI = path.resolve(__dirname, '../bin/cli.js');

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-skip-'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'foo.js'), '// junk');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), '// actual code');
  fs.mkdirSync(path.join(dir, '.venv'));
  fs.writeFileSync(path.join(dir, '.venv', 'lib.py'), '# junk');
  return dir;
}

describe('pxpipe export skip dirs', () => {
  let dir: string;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('skips node_modules by default', () => {
    const out = execSync(`node ${CLI} export ${dir}`, { encoding: 'utf8' });
    expect(out).toContain('main.ts');
    expect(out).not.toContain('foo.js'); // node_modules content не попало
  });

  it('skips .venv when PXPIPE_SKIP_DIRS=.venv', () => {
    const out = execSync(
      `node ${CLI} export ${dir}`,
      { env: { ...process.env, PXPIPE_SKIP_DIRS: '.venv' }, encoding: 'utf8' },
    );
    expect(out).toContain('main.ts');
    expect(out).not.toContain('lib.py');
  });

  it('does not skip .venv without PXPIPE_SKIP_DIRS', () => {
    const out = execSync(`node ${CLI} export ${dir}`, { encoding: 'utf8' });
    expect(out).toContain('main.ts');
    expect(out).toContain('lib.py'); // попало в результат
  });
});
```

> ⚠️ E2E-тест требует собранного CLI (`pnpm build`). Если в CI билд не происходит — пропустить, заменить на unit-тест для `buildWalkSkipDirs()` (см. ниже).

### Альтернативный unit-тест (без билда)

```ts
import { buildWalkSkipDirs } from '../src/node.js'; // или вынести в helper.ts

describe('buildWalkSkipDirs', () => {
  it('returns default set when env unset', () => {
    delete process.env.PXPIPE_SKIP_DIRS;
    expect(buildWalkSkipDirs()).toContain('node_modules');
    expect(buildWalkSkipDirs()).toContain('.git');
  });

  it('extends with custom env', () => {
    process.env.PXPIPE_SKIP_DIRS = '.venv, target , vendor';
    const set = buildWalkSkipDirs();
    expect(set).toContain('node_modules');
    expect(set).toContain('.venv');
    expect(set).toContain('target');
    expect(set).toContain('vendor');
    delete process.env.PXPIPE_SKIP_DIRS;
  });

  it('handles empty/missing env gracefully', () => {
    process.env.PXPIPE_SKIP_DIRS = '';
    const set = buildWalkSkipDirs();
    expect(set.size).toBe(DEFAULT_WALK_SKIP_DIRS.length);
  });
});
```

## Обратная совместимость

- Без env — поведение **идентично**.
- С env — расширенное поведение (плюс к default).

## Открытые вопросы

- **Q1:** Должна ли быть **только** `PXPIPE_SKIP_DIRS` env, или CLI-флаг (`--skip-dirs`)? Env проще, но требует шелла. CLI-флаг удобнее для одноразовых вызовов.
  - **Решение:** начать с env; при необходимости добавить CLI-флаг отдельной спекой.
- **Q2:** Что с поддиректориями, чьи имена совпадают с `*.pyc` (например, `__pycache__` для Python уже в default; но `*.egg-info` для setuptools — нет)?
  - **Решение:** оставить на будущее; пользователь может добавить `PXPIPE_SKIP_DIRS=.tox,*.egg-info`.

## Чеклист PR

- [x] `src/config.ts`: добавлены `DEFAULT_WALK_SKIP_DIRS` + `buildWalkSkipDirs()` (чистая функция, тестируемая без boot'а прокси).
- [x] `src/node.ts`: `WALK_SKIP_DIRS = buildWalkSkipDirs()`; `printExportHelp` обновлён (секция Environment variables).
- [x] `README.md`: секция «Export CLI» с примером для mono-repos (`.venv,target,vendor,.terraform,.gradle`).
- [x] `tests/skip-dirs.test.ts`: 3 unit-теста (defaults, расширение+trim, пустой env).
- [x] `pnpm typecheck && pnpm test` — чисто.

## Отклонение от дизайна

Unit-тесты вместо E2E CLI-теста — не требуют билда (`buildWalkSkipDirs` в `config.ts`). E2E через `execSync` зависел бы от собранного `bin/cli.js`; спека явно разрешала unit-альтернативу.
