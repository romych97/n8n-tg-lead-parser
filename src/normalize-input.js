// Приводит входящее сообщение Telegram к единому виду для дальнейшей обработки.
// Файл встраивается в Code-ноду n8n скриптом scripts/build-workflow.mjs,
// поэтому здесь нельзя использовать require и внешние зависимости.

const MIN_TEXT_LENGTH = 15;

const HELP_HTML =
  'Пришлите заявку текстом или PDF-файлом - я разберу её и занесу в таблицу.\n\n' +
  'Например: <i>Здравствуйте, нужен корпоративный сайт до 1 декабря, бюджет 300 тыс. ' +
  'Анна, ООО Ромашка, +7 701 123 45 67</i>';

function telegramUserLabel(from) {
  if (!from) return null;
  if (from.username) return '@' + from.username;
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return fullName || String(from.id);
}

function normalizeTelegramInput(message, extractedText) {
  const document = message.document || null;
  const base = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    tg_user: telegramUserLabel(message.from),
    source: document ? 'pdf' : 'text',
    file_name: document ? document.file_name || null : null,
  };

  if (typeof message.text === 'string' && message.text.trim().startsWith('/')) {
    return { ...base, kind: 'command', text: '', reply_html: HELP_HTML };
  }

  if (document && document.mime_type !== 'application/pdf') {
    return {
      ...base,
      kind: 'unsupported',
      text: '',
      reply_html: 'Этот формат файла пока не поддерживается. ' + HELP_HTML,
    };
  }

  const text = String(extractedText ?? message.text ?? message.caption ?? '').trim();

  if (text.length < MIN_TEXT_LENGTH) {
    const reply = document
      ? 'Не удалось извлечь текст из PDF - возможно, это скан. Пришлите текстовый PDF или текст сообщением.'
      : HELP_HTML;
    return { ...base, kind: 'empty', text, reply_html: reply };
  }

  return { ...base, kind: 'lead', text, reply_html: null };
}

module.exports = { normalizeTelegramInput, telegramUserLabel, HELP_HTML, MIN_TEXT_LENGTH };
