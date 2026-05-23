const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const LINE_API = 'https://api.line.me/v2/bot';
const groupHistory = {};
const MAX_HISTORY = 200;
// 整理して trigger keyword
const TRIGGER = '整理して';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
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
    headers: { 'Authorization': 'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN }
  });
  return res.json();
}

async function replyMessage(replyToken, text) {
  console.log('[reply] token=' + replyToken + ' text=' + text.substring(0, 50));
  const res = await fetch(LINE_API + '/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN
    },
    body: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }]
    })
  });
  const data = await res.json();
  console.log('[reply] result:', JSON.stringify(data));
  return data;
}

function storeMessage(groupId, displayName, text) {
  if (!groupHistory[groupId]) groupHistory[groupId] = [];
  groupHistory[groupId].push({ displayName: displayName, text: text });
  if (groupHistory[groupId].length > MAX_HISTORY) {
    groupHistory[groupId].splice(0, groupHistory[groupId].length - MAX_HISTORY);
  }
}

async function buildSummary(groupId) {
  const history = (groupHistory[groupId] || []).filter(m => m.text !== TRIGGER);
  console.log('[buildSummary] groupId=' + groupId + ' historyLen=' + history.length);
  if (history.length === 0) {
    return 'まだ整理できる会話履歴がありません。\nグループで会話が蓄積されてからもう一度お試しください！';
  }
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const historyText = history.map(m => m.displayName + ': ' + m.text).join('\n');
  const parts = [];
  parts.push('以下はプロジェクトチームのグループLINEの会話履歴です。プロジェクト管理の観点から分析し、必ず以下の5項目を日本語で出力してください：');
  parts.push('');
  parts.push('[1] プロジェクトの進行状況まとめ');
  parts.push('[2] メンバー別のタスクと進捗');
  parts.push('[3] 担当者が未定のタスク');
  parts.push('[4] 決定事・未決事項');
  parts.push('[5] 次のアクションアイテム');
  parts.push('');
  parts.push('会話履歴:');
  parts.push(historyText);
  const prompt = parts.join('\n');
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function processEvent(event) {
  console.log('[processEvent] type=' + event.type);
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
    console.log('[processEvent] skip non-text event');
    return;
  }
  const text = event.message.text;
  const source = event.source || {};
  const groupId = source.groupId || source.roomId || source.userId || 'unknown';
  const userId = source.userId || 'unknown';
  console.log('[processEvent] text=' + text + ' groupId=' + groupId + ' userId=' + userId);
  console.log('[processEvent] trigger check: text=' + JSON.stringify(text) + ' TRIGGER=' + JSON.stringify(TRIGGER) + ' match=' + (text === TRIGGER || text.includes(TRIGGER)));
  // Get display name
  let displayName = userId;
  try {
    if (source.groupId) {
      const profile = await lineGet('/group/' + source.groupId + '/member/' + userId);
      displayName = profile.displayName || userId;
    } else {
      const profile = await lineGet('/profile/' + userId);
      displayName = profile.displayName || userId;
    }
  } catch(e) { console.log('[processEvent] profile error: ' + e.message); }
  // Store message
  storeMessage(groupId, displayName, text);
  console.log('[processEvent] stored. history len=' + (groupHistory[groupId] || []).length);
  // Check trigger
  if (text === TRIGGER || text.trim() === TRIGGER || text.includes(TRIGGER)) {
    console.log('[processEvent] TRIGGER MATCHED! Building summary...');
    try {
      const summary = await buildSummary(groupId);
      console.log('[processEvent] summary ready, replying...');
      await replyMessage(event.replyToken, summary);
    } catch(e) {
      console.error('[processEvent] error: ' + e.message);
      await replyMessage(event.replyToken, 'エラーが発生しました: ' + e.message);
    }
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');
  const rawBody = await readRawBody(req);
  console.log('[webhook] rawBody length:', rawBody.length);
  console.log('[webhook] SECRET defined:', !!process.env.LINE_CHANNEL_SECRET);
  const signature = req.headers['x-line-signature'];
  console.log('[webhook] signature:', signature ? signature.substring(0,20) + '...' : 'MISSING');
  if (!signature || !verifySignature(rawBody, process.env.LINE_CHANNEL_SECRET, signature)) {
    console.error('[webhook] sig FAIL - sig=' + signature + ' expected=' + crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET || '').update(rawBody).digest('base64').substring(0,20));
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
