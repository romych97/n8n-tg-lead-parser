// Собирает импортируемый в n8n workflow из исходников:
//   src/*.js                        -> код Code-нод
//   prompts/extract-lead.system.md  -> системный промпт
//   schema/lead.schema.json         -> JSON Schema для structured output
// Результат: workflow/lead-intake.workflow.json
//
// Так логика живёт в обычных JS-файлах с тестами, а не только внутри n8n.
// Запуск: npm run build

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

// --env-file-if-exists есть только с Node 22.9+; грузим .env сами, если файл есть.
const envPath = fileURLToPath(new URL('.env', root));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_URL = process.env.LLM_URL || 'https://api.openai.com/v1/chat/completions';
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID || 'PASTE_MANAGER_CHAT_ID';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || 'PASTE_SPREADSHEET_ID';

const { SHEET_COLUMNS } = require('../src/process-response.js');

// Убираем module.exports (он всегда в конце файла и может быть многострочным) -
// в Code-ноде n8n его нет.
const inline = (path) => read(path).replace(/^module\.exports\s*=[\s\S]*$/m, '').trim();

// Детерминированные id, чтобы diff workflow в git был стабильным.
const nodeId = (name) => {
  const h = createHash('sha1').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: nodeId(name),
  name,
  type,
  typeVersion,
  position,
  parameters,
  ...extra,
});

const ifCondition = (name, leftValue, operator, rightValue = '') => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
    conditions: [{ id: nodeId(name + ':cond'), leftValue, rightValue, operator }],
    combinator: 'and',
  },
  options: {},
});

const telegramCreds = { telegramApi: { id: 'telegram-cred', name: 'Telegram Bot' } };

const telegramSend = (name, position, chatId, text, replyTo) =>
  node(name, 'n8n-nodes-base.telegram', 1.2, position, {
    chatId,
    text,
    additionalFields: {
      appendAttribution: false,
      parse_mode: 'HTML',
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    },
  }, { credentials: telegramCreds });

const codeEachItem = (name, position, jsCode) =>
  node(name, 'n8n-nodes-base.code', 2, position, { mode: 'runOnceForEachItem', jsCode });

// --- код Code-нод ---------------------------------------------------------

const normalizeCode = `${inline('src/normalize-input.js')}

// --- n8n ---
const message = $('Telegram Trigger').item.json.message;
// В ветке PDF текст пришёл из ноды "Extract PDF text", в ветке текста его нет.
return { json: normalizeTelegramInput(message, $json.text) };
`;

const buildRequestCode = `// Модель и часовой пояс. Для OpenRouter укажите, например, 'openai/gpt-4o-mini'
// и поменяйте URL в ноде "LLM: extract fields".
const MODEL = ${JSON.stringify(MODEL)};
const TIME_ZONE = 'Asia/Almaty';

const SYSTEM_PROMPT = ${JSON.stringify(read('prompts/extract-lead.system.md').trim())};
const SCHEMA = ${JSON.stringify(JSON.parse(read('schema/lead.schema.json')))};

${inline('src/build-request.js')}

// --- n8n ---
const body = buildLlmRequest($json, {
  systemPrompt: SYSTEM_PROMPT,
  schema: SCHEMA,
  model: MODEL,
  today: todayIn(TIME_ZONE),
});
return { json: { ...$json, body } };
`;

const processCode = `${inline('src/process-response.js')}

// --- n8n ---
const meta = $('Build LLM request').item.json;
return { json: processLlmResponse($json, meta) };
`;

// Нода Google Sheets возвращает записанную строку и теряет chat_id и тексты ответов.
// Контекст восстанавливаем явно в Code-ноде, а не ссылками $('...') в каждой следующей ноде:
// так данные дальше идут через $json, и это проще отлаживать.
const restoreAfterSheetCode = `// Возвращаем результат разбора, чтобы следующие ноды работали через $json.
return { json: $('Process response').item.json };
`;

const apiErrorContextCode = `// На error-выходе HTTP-ноды только описание ошибки - добавляем, кому отвечать.
const ctx = $('Build LLM request').item.json;
return {
  json: {
    chat_id: ctx.chat_id,
    message_id: ctx.message_id,
    error: $json.error ?? null,
    reply_html: 'Сервис распознавания временно недоступен. Попробуйте отправить заявку через пару минут.',
  },
};
`;

// --- ноды ----------------------------------------------------------------

const nodes = [
  node('Overview', 'n8n-nodes-base.stickyNote', 1, [-420, -280], {
    content:
      '## Telegram → LLM → Google Sheets\n' +
      'Бот принимает заявку текстом или PDF, LLM извлекает поля по JSON Schema ' +
      '(structured output), код валидирует и нормализует данные, строка пишется в таблицу, ' +
      'отправителю приходит ответ, менеджеру - уведомление.\n\n' +
      'Код Code-нод генерируется из `src/` командой `npm run build`.',
    height: 220,
    width: 520,
    color: 4,
  }),

  node('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.1, [-400, 0], {
    updates: ['message'],
    additionalFields: { download: true },
  }, { credentials: telegramCreds, webhookId: nodeId('telegram-webhook') }),

  node('Is PDF?', 'n8n-nodes-base.if', 2, [-180, 0], ifCondition(
    'Is PDF?',
    "={{ $json.message.document?.mime_type ?? '' }}",
    { type: 'string', operation: 'equals' },
    'application/pdf',
  )),

  node('Extract PDF text', 'n8n-nodes-base.extractFromFile', 1, [40, -100], {
    operation: 'pdf',
    binaryPropertyName: 'data',
    options: {},
  }),

  codeEachItem('Normalize input', [260, 0], normalizeCode),

  node('Is lead?', 'n8n-nodes-base.if', 2, [480, 0], ifCondition(
    'Is lead?',
    '={{ $json.kind }}',
    { type: 'string', operation: 'equals' },
    'lead',
  )),

  telegramSend('Reply: help', [700, 180], '={{ $json.chat_id }}', '={{ $json.reply_html }}', '={{ $json.message_id }}'),

  codeEachItem('Build LLM request', [700, -100], buildRequestCode),

  node('LLM: extract fields', 'n8n-nodes-base.httpRequest', 4.2, [920, -100], {
    method: 'POST',
    url: LLM_URL,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { timeout: 60000 },
  }, {
    credentials: { httpHeaderAuth: { id: 'llm-cred', name: 'LLM API key' } },
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
  }),

  codeEachItem('API error context', [1140, 120], apiErrorContextCode),

  telegramSend('Reply: API error', [1360, 120], '={{ $json.chat_id }}', '={{ $json.reply_html }}', '={{ $json.message_id }}'),

  codeEachItem('Process response', [1140, -100], processCode),

  node('Parsed OK?', 'n8n-nodes-base.if', 2, [1360, -100], ifCondition(
    'Parsed OK?',
    '={{ $json.ok }}',
    { type: 'boolean', operation: 'true', singleValue: true },
  )),

  telegramSend('Reply: parse error', [1580, 0], '={{ $json.chat_id }}', '={{ $json.reply_html }}', '={{ $json.message_id }}'),

  node('Append to Google Sheet', 'n8n-nodes-base.googleSheets', 4.5, [1580, -200], {
    operation: 'append',
    documentId: { __rl: true, value: SPREADSHEET_ID, mode: 'id' },
    sheetName: { __rl: true, value: 'gid=0', mode: 'list', cachedResultName: 'Leads' },
    columns: {
      mappingMode: 'defineBelow',
      value: Object.fromEntries(SHEET_COLUMNS.map((c) => [c, `={{ $json.row.${c} }}`])),
      matchingColumns: [],
      schema: SHEET_COLUMNS.map((c) => ({
        id: c,
        displayName: c,
        required: false,
        defaultMatch: false,
        display: true,
        type: 'string',
        canBeUsedToMatch: true,
      })),
    },
    options: {},
  }, { credentials: { googleSheetsOAuth2Api: { id: 'gsheets-cred', name: 'Google Sheets' } } }),

  codeEachItem('Restore context', [1800, -200], restoreAfterSheetCode),

  telegramSend('Reply to sender', [2020, -300], '={{ $json.chat_id }}', '={{ $json.reply_html }}', '={{ $json.message_id }}'),

  node('Notify manager?', 'n8n-nodes-base.if', 2, [2020, -100], ifCondition(
    'Notify manager?',
    "={{ $json.notify_html ?? '' }}",
    { type: 'string', operation: 'notEmpty', singleValue: true },
  )),

  telegramSend('Notify manager', [2240, -100], MANAGER_CHAT_ID, '={{ $json.notify_html }}'),
];

// --- связи ---------------------------------------------------------------

const to = (name) => ({ node: name, type: 'main', index: 0 });
const connections = {
  'Telegram Trigger': { main: [[to('Is PDF?')]] },
  'Is PDF?': { main: [[to('Extract PDF text')], [to('Normalize input')]] },
  'Extract PDF text': { main: [[to('Normalize input')]] },
  'Normalize input': { main: [[to('Is lead?')]] },
  'Is lead?': { main: [[to('Build LLM request')], [to('Reply: help')]] },
  'Build LLM request': { main: [[to('LLM: extract fields')]] },
  'LLM: extract fields': { main: [[to('Process response')], [to('API error context')]] },
  'API error context': { main: [[to('Reply: API error')]] },
  'Process response': { main: [[to('Parsed OK?')]] },
  'Parsed OK?': { main: [[to('Append to Google Sheet')], [to('Reply: parse error')]] },
  'Append to Google Sheet': { main: [[to('Restore context')]] },
  'Restore context': { main: [[to('Reply to sender'), to('Notify manager?')]] },
  'Notify manager?': { main: [[to('Notify manager')], []] },
};

const workflow = {
  name: 'Lead intake: Telegram → LLM → Google Sheets',
  nodes,
  connections,
  pinData: {},
  settings: { executionOrder: 'v1' },
  active: false,
  tags: [],
};

mkdirSync(new URL('workflow/', root), { recursive: true });
writeFileSync(new URL('workflow/lead-intake.workflow.json', root), JSON.stringify(workflow, null, 2) + '\n');
console.log(`workflow/lead-intake.workflow.json: ${nodes.length} nodes, model ${MODEL}`);
