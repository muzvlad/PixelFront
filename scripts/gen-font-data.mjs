// Перегенерация src/dashboard/font-data.ts из assets/fonts/*.woff2.
// Запуск: node scripts/gen-font-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const latin = readFileSync(new URL('../assets/fonts/lora-latin.woff2', import.meta.url)).toString('base64');
const cyr = readFileSync(new URL('../assets/fonts/lora-cyrillic.woff2', import.meta.url)).toString('base64');

const out = `// Сгенерировано из assets/fonts/*.woff2 (Lora, OFL, self-host из TheAgeOfReason).
// Base64 встроен, чтобы дашборд оставался self-contained без font-src в CSP.
// Перегенерировать: node scripts/gen-font-data.mjs
export const LORA_LATIN_WOFF2_B64 = '${latin}';

export const LORA_CYRILLIC_WOFF2_B64 = '${cyr}';
`;

writeFileSync(new URL('../src/dashboard/font-data.ts', import.meta.url), out, 'utf8');
console.log('font-data.ts written');
