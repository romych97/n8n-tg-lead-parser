// Разбирает ответ LLM, валидирует и нормализует поля, готовит строку для
// Google Sheets и тексты уведомлений.
// Встраивается в Code-ноду n8n - без require и внешних зависимостей.

const TIME_ZONE = 'Asia/Almaty';
const REVIEW_CONFIDENCE_THRESHOLD = 0.6;

// Порядок колонок в Google Таблице. Первая строка листа должна совпадать с этим списком.
const SHEET_COLUMNS = [
  'received_at',
  'status',
  'source',
  'tg_user',
  'client_name',
  'company',
  'phone',
  'email',
  'request_type',
  'product_or_service',
  'quantity',
  'budget',
  'currency',
  'deadline',
  'priority',
  'summary',
  'missing_fields',
  'confidence',
  'raw_text',
];

const REQUIRED_KEYS = [
  'is_lead', 'client_name', 'company', 'phone', 'email', 'request_type',
  'product_or_service', 'quantity', 'budget', 'currency', 'deadline',
  'priority', 'summary', 'missing_fields', 'confidence',
];

const REQUEST_TYPES = ['purchase', 'consultation', 'support', 'partnership', 'other'];
const PRIORITIES = ['low', 'medium', 'high'];

const REQUEST_TYPE_LABELS = {
  purchase: 'покупка',
  consultation: 'консультация',
  support: 'поддержка',
  partnership: 'сотрудничество',
  other: 'другое',
};
const PRIORITY_LABELS = { low: 'низкий', medium: 'средний', high: 'высокий' };

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return '+7' + digits.slice(1);
  if (digits.length === 10 && (digits[0] === '7' || digits[0] === '9')) return '+7' + digits;
  if (digits.length >= 10 && digits.length <= 15 && String(raw).trim().startsWith('+')) return '+' + digits;
  return null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const email = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

function formatDateTime(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function parseLlmContent(apiResponse) {
  const message = apiResponse?.choices?.[0]?.message;
  if (!message) return { error: 'В ответе API нет choices[0].message' };
  if (message.refusal) return { error: 'Модель отказалась отвечать: ' + message.refusal };
  if (typeof message.content !== 'string') return { error: 'Пустой content в ответе модели' };

  let data;
  try {
    data = JSON.parse(message.content);
  } catch (e) {
    return { error: 'Ответ модели не является валидным JSON' };
  }

  const missingKeys = REQUIRED_KEYS.filter((key) => !(key in data));
  if (missingKeys.length) return { error: 'В ответе модели нет полей: ' + missingKeys.join(', ') };
  return { data };
}

function decideStatus({ is_lead, phone, email, confidence, rawPhone, rawEmail }) {
  if (!is_lead) return 'spam';
  const hasContact = Boolean(phone || email);
  const contactLooksBroken = (rawPhone && !phone) || (rawEmail && !email);
  if (!hasContact || contactLooksBroken || confidence < REVIEW_CONFIDENCE_THRESHOLD) return 'needs_review';
  return 'new';
}

function buildReplyHtml(row) {
  if (row.status === 'spam') {
    return 'Похоже, это не заявка клиента. Сохранил в таблицу со статусом «спам».';
  }
  const lines = [
    row.status === 'new' ? '✅ Заявка принята и занесена в таблицу' : '⚠️ Заявка занесена, но требует проверки менеджером',
    '',
    `<b>Клиент:</b> ${escapeHtml(row.client_name || '—')}${row.company ? ', ' + escapeHtml(row.company) : ''}`,
    `<b>Контакты:</b> ${escapeHtml([row.phone, row.email].filter(Boolean).join(', ') || '—')}`,
    `<b>Тип:</b> ${REQUEST_TYPE_LABELS[row.request_type]}`,
    `<b>Суть:</b> ${escapeHtml(row.summary)}`,
  ];
  if (row.budget !== '') lines.push(`<b>Бюджет:</b> ${row.budget} ${row.currency || ''}`.trim());
  if (row.deadline) lines.push(`<b>Срок:</b> ${row.deadline}`);
  lines.push(`<b>Приоритет:</b> ${PRIORITY_LABELS[row.priority]}`);
  if (row.missing_fields) lines.push(`<b>Не хватает:</b> ${escapeHtml(row.missing_fields)}`);
  return lines.join('\n');
}

function buildNotifyHtml(row) {
  if (row.status === 'spam') return null;
  const icon = row.priority === 'high' ? '🔥' : '📥';
  return (
    `${icon} <b>Новая заявка</b> (${REQUEST_TYPE_LABELS[row.request_type]}, приоритет: ${PRIORITY_LABELS[row.priority]})\n` +
    `${escapeHtml(row.summary)}\n` +
    `Клиент: ${escapeHtml(row.client_name || '—')}, ${escapeHtml([row.phone, row.email].filter(Boolean).join(', ') || 'контактов нет')}\n` +
    `Статус: ${row.status === 'new' ? 'новая' : 'на проверку'} · от ${escapeHtml(row.tg_user || '—')}`
  );
}

function processLlmResponse(apiResponse, meta, now = new Date()) {
  const parsed = parseLlmContent(apiResponse);
  if (parsed.error) {
    return {
      ok: false,
      error: parsed.error,
      chat_id: meta.chat_id,
      message_id: meta.message_id,
      reply_html: 'Не получилось автоматически разобрать заявку. Попробуйте прислать её ещё раз или передайте менеджеру вручную.',
    };
  }

  const d = parsed.data;
  const phone = normalizePhone(d.phone);
  const email = normalizeEmail(d.email);
  const confidence = Math.min(1, Math.max(0, Number(d.confidence) || 0));
  const requestType = REQUEST_TYPES.includes(d.request_type) ? d.request_type : 'other';
  const priority = PRIORITIES.includes(d.priority) ? d.priority : 'medium';

  const row = {
    received_at: formatDateTime(now, TIME_ZONE),
    status: decideStatus({ is_lead: d.is_lead, phone, email, confidence, rawPhone: d.phone, rawEmail: d.email }),
    source: meta.source === 'pdf' && meta.file_name ? `pdf: ${meta.file_name}` : meta.source,
    tg_user: meta.tg_user || '',
    client_name: d.client_name || '',
    company: d.company || '',
    phone: phone || '',
    email: email || '',
    request_type: requestType,
    product_or_service: d.product_or_service || '',
    quantity: d.quantity || '',
    budget: typeof d.budget === 'number' ? d.budget : '',
    currency: d.currency || '',
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(d.deadline || '') ? d.deadline : '',
    priority,
    summary: d.summary || '',
    missing_fields: Array.isArray(d.missing_fields) ? d.missing_fields.join(', ') : '',
    confidence: Math.round(confidence * 100) / 100,
    raw_text: String(meta.text || '').slice(0, 500),
  };

  return {
    ok: true,
    chat_id: meta.chat_id,
    message_id: meta.message_id,
    row,
    reply_html: buildReplyHtml(row),
    notify_html: buildNotifyHtml(row),
  };
}

module.exports = {
  processLlmResponse,
  parseLlmContent,
  normalizePhone,
  normalizeEmail,
  decideStatus,
  formatDateTime,
  SHEET_COLUMNS,
  TIME_ZONE,
};
