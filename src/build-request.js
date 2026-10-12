// Собирает тело запроса к OpenAI-совместимому Chat Completions API
// со structured output (response_format: json_schema, strict).
// Встраивается в Code-ноду n8n - без require и внешних зависимостей.

const MAX_TEXT_CHARS = 12000;

function todayIn(timeZone, now = new Date()) {
  // en-CA даёт формат YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

function truncate(text, limit) {
  return text.length > limit ? text.slice(0, limit) + '\n[...текст обрезан]' : text;
}

function buildLlmRequest(input, { systemPrompt, schema, model, today }) {
  const text = truncate(input.text, MAX_TEXT_CHARS);
  const userContent =
    `Сегодня: ${today}\n` +
    `Источник: ${input.source}\n\n` +
    `Текст заявки:\n<<<\n${text}\n>>>`;

  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_schema', json_schema: schema },
  };
}

module.exports = { buildLlmRequest, todayIn, truncate, MAX_TEXT_CHARS };
