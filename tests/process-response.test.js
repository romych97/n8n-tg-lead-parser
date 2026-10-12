const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processLlmResponse,
  normalizePhone,
  normalizeEmail,
  SHEET_COLUMNS,
} = require('../src/process-response.js');

const meta = {
  chat_id: 111,
  message_id: 42,
  tg_user: '@anna',
  source: 'text',
  file_name: null,
  text: 'Нужен сайт до 1 декабря, бюджет 300к. Анна, +7 701 123 45 67',
};

const apiResponse = (content, extra = {}) => ({
  choices: [{ message: { role: 'assistant', content: JSON.stringify(content), ...extra } }],
});

const lead = (overrides = {}) => ({
  is_lead: true,
  client_name: 'Анна',
  company: 'ООО Ромашка',
  phone: '+7 701 123 45 67',
  email: null,
  request_type: 'purchase',
  product_or_service: 'корпоративный сайт',
  quantity: null,
  budget: 300000,
  currency: 'RUB',
  deadline: '2026-12-01',
  priority: 'medium',
  summary: 'Нужен корпоративный сайт до 1 декабря.',
  missing_fields: ['email'],
  confidence: 0.92,
  ...overrides,
});

const NOW = new Date('2026-10-06T05:30:00Z'); // 10:30 в Алматы

test('корректная заявка: статус new, все колонки на месте', () => {
  const result = processLlmResponse(apiResponse(lead()), meta, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.row.status, 'new');
  assert.equal(result.row.phone, '+77011234567');
  assert.equal(result.row.received_at, '2026-10-06 10:30');
  assert.equal(result.row.missing_fields, 'email');
  assert.deepEqual(Object.keys(result.row), SHEET_COLUMNS);
  assert.match(result.reply_html, /Заявка принята/);
  assert.match(result.notify_html, /Новая заявка/);
});

test('нет контактов - needs_review', () => {
  const result = processLlmResponse(apiResponse(lead({ phone: null, email: null })), meta, NOW);
  assert.equal(result.row.status, 'needs_review');
  assert.match(result.reply_html, /требует проверки/);
});

test('низкая уверенность - needs_review', () => {
  const result = processLlmResponse(apiResponse(lead({ confidence: 0.4 })), meta, NOW);
  assert.equal(result.row.status, 'needs_review');
});

test('телефон есть в тексте, но невалидный - needs_review, а не new', () => {
  const result = processLlmResponse(apiResponse(lead({ phone: '12-34' })), meta, NOW);
  assert.equal(result.row.phone, '');
  assert.equal(result.row.status, 'needs_review');
});

test('спам: статус spam, менеджера не уведомляем', () => {
  const result = processLlmResponse(apiResponse(lead({ is_lead: false })), meta, NOW);
  assert.equal(result.row.status, 'spam');
  assert.equal(result.notify_html, null);
});

test('отказ модели обрабатывается как ошибка', () => {
  const result = processLlmResponse(apiResponse({}, { content: null, refusal: 'cannot help' }), meta, NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /отказалась/);
});

test('невалидный JSON обрабатывается как ошибка', () => {
  const response = { choices: [{ message: { content: '{not json' } }] };
  const result = processLlmResponse(response, meta, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.chat_id, 111);
});

test('нет обязательных полей - ошибка', () => {
  const result = processLlmResponse(apiResponse({ is_lead: true }), meta, NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /нет полей/);
});

test('неизвестные enum и плохая дата заменяются безопасными значениями', () => {
  const result = processLlmResponse(
    apiResponse(lead({ request_type: 'buy', priority: 'urgent', deadline: 'завтра' })),
    meta,
    NOW,
  );
  assert.equal(result.row.request_type, 'other');
  assert.equal(result.row.priority, 'medium');
  assert.equal(result.row.deadline, '');
});

test('HTML в данных клиента экранируется', () => {
  const result = processLlmResponse(apiResponse(lead({ summary: '<b>взлом</b> & ко' })), meta, NOW);
  assert.match(result.reply_html, /&lt;b&gt;взлом&lt;\/b&gt; &amp; ко/);
});

test('нормализация телефонов', () => {
  assert.equal(normalizePhone('8 (701) 123-45-67'), '+77011234567');
  assert.equal(normalizePhone('+7 701 123 45 67'), '+77011234567');
  assert.equal(normalizePhone('9161234567'), '+79161234567');
  assert.equal(normalizePhone('+49 30 1234 5678'), '+493012345678');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone(null), null);
});

test('нормализация email', () => {
  assert.equal(normalizeEmail(' Anna@Example.COM '), 'anna@example.com');
  assert.equal(normalizeEmail('anna@example'), null);
  assert.equal(normalizeEmail(null), null);
});
