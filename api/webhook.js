'use strict';

const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const LINE_API = 'https://api.line.me/v2/bot';
const groupHistory = {};
const MAX_HISTORY = 200;

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
  const res = await fetch(`${LINE_API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  return res.ok ? res.json() : null;
}

async function replyMessage(replyToken, text) {
  const res = await fetch(`${LINE_API}/message/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) throw new Error(`LINE reply failed: ${res.status}`);
}

async function getDisplayName(groupId, userId) {
  try {
    const profile = await lineGet(`/group/${groupId}/member/${userId}`);
    return profile && profile.displayName ? profile.displayName : userId;
  } catch (_) {
    return userId;
  }
}

function storeMessage(groupId, displayName, text) {
  if (!groupHistory[groupId]) groupHistory[groupId] = [];
  groupHistory[groupId].push({ displayName, text });
  if (groupHistory[groupId].length > MAX_HISTORY) {
    groupHistory[groupId].splice(0, groupHistory[groupId].length - MAX_HISTORY);
  }
}

async function buildSummary(groupId) {
  const SEIRI = '整理して';
  const history = (groupHistory[groupId] || []).filter(m => m.text !== SEIRI);
  if (history.length === 0) {
    return 'まだ整理できる会話履歴がありません。
グループで会話が蓄積されてからもう一度お試しください！';
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const historyText = history.map(m => `${m.displayName}: ${m.text}`).join('\n');
  const prompt = `以下はプロジェクトチームのグループLINEの会話履歴です。プロジェクト管理の観点から分析し、必ず以下の5項目を日本語で回答してください。該当情報がない項目は「特になし」と記載。\n\n「会話履歴」\n${historyText}\n\n---\n\n📊 プロジェクトの進行状況まとめ\n\n👥 メンバー別のタスクと進捗\n\n❓ 担当者未定のタスク\n\n✅ 決定事項\n\n⚠️ 未決事項`;
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function processEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const groupId = event.source.groupId || event.source.roomId;
  if (!groupId) return;
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const SEIRI = '整理して';
  const displayName = event.source.groupId
    ? await getDisplayName(groupId, userId)
    : userId;
  storeMessage(groupId, displayName, text);
  if (text !== SEIRI) return;
  let replyText;
  try {
    replyText = await buildSummary(groupId);
  } catch (err) {
    console.error('[summarize error]', err);
    replyText = '申し訳ありません、整理中にエラーが発生しました。しばらく後にもう一度お試しください。';
  }
  await replyMessage(event.replyToken, replyText);
}

const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK');
  const rawBody = await readRawBody(req);
  console.log('[webhook] rawBody length:', rawBody.length);
  console.log('[webhook] SECRET defined:', !!process.env.LINE_CHANNEL_SECRET);
  const signature = req.headers['x-line-signature'];
  if (!signature || !verifySignature(rawBody, process.env.LINE_CHANNEL_SECRET, signature)) {
    console.error('[webhook] signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  await Promise.all((body.events || []).map(processEvent));
  res.status(200).json({ status: 'ok' });
};

handler.config = { api: { bodyParser: false } };

module.exports = handler;
