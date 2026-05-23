const crypto = require('crypto');

const { GoogleGenerativeAI } = require('@google/generative-ai');

const { kv } = require('@vercel/kv');

const LINE_API = 'https://api.line.me/v2/bot';
const MAX_HISTORY = 200;

const TRIGGER = '整理して';

const EXPIRE_SECONDS = 60 * 60 * 24 * 30;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      return resolve(raw);
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, secret, signature) {
  const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return hash === signature;
}

async function lineGet(path) {
  const res = await fetch(LINE_API + path, {
    headers: { Authorization: 'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN },
  });
  return res.ok ? res.json() : null;
}

async function replyMessage(replyToken, text) {
  const res = await fetch(LINE_API + '/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
  const data = await res.json();
  console.log('[reply] result:', JSON.stringify(data));
  return data;
}

async function saveMessage(groupId, displayName, text) {
  const key = 'msg:' + groupId;
  const entry = JSON.stringify({ displayName, text, ts: Date.now() });
  await kv.rpush(key, entry);
  const len = await kv.llen(key);
  if (len > MAX_HISTORY) await kv.ltrim(key, len - MAX_HISTORY, -1);
  await kv.expire(key, EXPIRE_SECONDS);
  console.log('[kv] saved. key=' + key + ' len=' + Math.min(len, MAX_HISTORY));
}

async function loadMessages(groupId) {
  const key = 'msg:' + groupId;
  const items = await kv.lrange(key, 0, -1);
  if (!items || items.length === 0) return [];
  return items.map(item => (typeof item === 'string' ? JSON.parse(item) : item));
}

async function buildSummary(groupId, inlineText) {
  let historyText;

  if (inlineText) {
    console.log('[buildSummary] inline mode. textLen=' + inlineText.length);
    historyText = inlineText;
  } else {
    const messages = await loadMessages(groupId);
    const history = messages.filter(m => m.text !== TRIGGER);
    console.log('[buildSummary] groupId=' + groupId + ' historyLen=' + history.length);

    if (history.length === 0) {
      return 'まだ整理できる会話履歴がありません。\nグループで会話が蓄積されてからもう一度お試しください！';
    }

    historyText = history.map(m => m.displayName + ': ' + m.text).join('\n');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = [
    '以下はプロジェクトチームのグループLINEの会話履歴です。',
    'プロジェクト管理の観点から分析し、必ず以下の5項目を日本語で出力してください。',
    '該当する情報がない項目は「特になし」と記載してください。',
    '',
    '「会話履歴」',
    historyText,
    '',
    '---',
    '[graph] プロジェクトの進行状況まとめ',
    '（全体の現状と進捗を2～3文で要約）',
    '',
    '[members] メンバー別のタスクと進捗',
    '（各メンバーの担当タスクと進捗を箇条書きで）',
    '',
    '[?] 担当者未定のタスク',
    '（担当が決まっていない課題を箇条書きで）',
    '',
    '[OK] 決定事項',
    '（会話で確定した内容を箇条書きで）',
    '',
    '[!] 未決事項',
    '（まだ検討中・未解決の内容を箇条書きで）',
  ].join('\n');

  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function processEvent(event) {
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;

  const source = event.source || {};
  const groupId = source.groupId || source.roomId;
  if (!groupId) return;

  const userId = source.userId || 'unknown';
  const text = event.message.text.trim();

  let displayName = userId;
  try {
    const profile = await lineGet('/group/' + groupId + '/member/' + userId);
    if (profile && profile.displayName) displayName = profile.displayName;
  } catch (e) {
    console.log('[profile] error: ' + e.message);
  }

  await saveMessage(groupId, displayName, text);

  if (!text.includes(TRIGGER)) return;

  console.log('[trigger] matched. building summary...');

  const triggerIndex = text.indexOf(TRIGGER);
  const afterTrigger = text.slice(triggerIndex + TRIGGER.length).trim();
  const inlineText = afterTrigger.length > 0 ? afterTrigger : null;
  if (inlineText) {
    console.log('[trigger] inline text mode. len=' + inlineText.length);
  }

  let replyText;
  try {
    replyText = await buildSummary(groupId, inlineText);
  } catch (e) {
    console.error('[summary] error: ' + e.message);
    replyText = '整理中にエラーが発生しました。しばらく後にもう一度お試しください。';
  }

  await replyMessage(event.replyToken, replyText);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const rawBody = await readRawBody(req);
  console.log('[webhook] rawBody length:', rawBody.length);

  const signature = req.headers['x-line-signature'];
  if (!signature || !verifySignature(rawBody, process.env.LINE_CHANNEL_SECRET, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log('[webhook] sig OK');

  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  console.log('[webhook] events count:', (body.events || []).length);

  await Promise.all((body.events || []).map(processEvent));

  res.status(200).json({ status: 'ok' });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
