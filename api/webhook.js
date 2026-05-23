'use strict';

const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const LINE_API = 'https://api.line.me/v2/bot';
const groupHistory = {};
const MAX_HISTORY = 200;

function readRawBody(req) {
            return new Promise((resolve, reject) => {
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
            const SEIRI = '\u6574\u7406\u3057\u3066';
            const history = (groupHistory[groupId] || []).filter(m => m.text !== SEIRI);
            if (history.length === 0) {
                          return '\u307e\u3060\u6574\u7406\u3067\u304d\u308b\u4f1a\u8a71\u5c65\u6b74\u304c\u3042\u308a\u307e\u305b\u3093\u3002\n\u30b0\u30eb\u30fc\u30d7\u3067\u4f1a\u8a71\u304c\u84c4\u7a4d\u3055\u308c\u3066\u304b\u3089\u3082\u3046\u4e00\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\uff01';
            }
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const historyText = history.map(m => `${m.displayName}: ${m.text}`).join('\n');
            const prompt = `\u4ee5\u4e0b\u306f\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u30c1\u30fc\u30e0\u306e\u30b0\u30eb\u30fc\u30d7LINE\u306e\u4f1a\u8a71\u5c65\u6b74\u3067\u3059\u3002\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u7ba1\u7406\u306e\u89b3\u70b9\u304b\u3089\u5206\u6790\u3057\u3001\u5fc5\u305a\u4ee5\u4e0b\u306e5\u9805\u76ee\u3092\u65e5\u672c\u8a9e\u3067\u56de\u7b54\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u8a72\u5f53\u60c5\u5831\u304c\u306a\u3044\u9805\u76ee\u306f\u300c\u7279\u306b\u306a\u3057\u300d\u3068\u8a18\u8f09\u3002\n\n\u300c\u4f1a\u8a71\u5c65\u6b74\u300d\n${historyText}\n\n---\n\n\ud83d\udcca \u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u9032\u884c\u72b6\u6cc1\u307e\u3068\u3081\n\n\ud83d\udc65 \u30e1\u30f3\u30d0\u30fc\u5225\u306e\u30bf\u30b9\u30af\u3068\u9032\u6357\n\n\u2753 \u62c5\u5f53\u8005\u672a\u5b9a\u306e\u30bf\u30b9\u30af\n\n\u2705 \u6c7a\u5b9a\u4e8b\u9805\n\n\u26a0\ufe0f \u672a\u6c7a\u4e8b\u9805`;
            const result = await model.generateContent(prompt);
            return result.response.text();
}

async function processEvent(event) {
            if (event.type !== 'message' || event.message.type !== 'text') return;
            const groupId = event.source.groupId || event.source.roomId;
            if (!groupId) return;
            const userId = event.source.userId;
            const text = event.message.text.trim();
            const SEIRI = '\u6574\u7406\u3057\u3066';
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
                          replyText = '\u7533\u3057\u8a33\u3042\u308a\u307e\u305b\u3093\u3001\u6574\u7406\u4e2d\u306b\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002\u3057\u3070\u3089\u304f\u5f8c\u306b\u3082\u3046\u4e00\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002';
            }
            await replyMessage(event.replyToken, replyText);
}

const handler = async (req, res) => {
            if (req.method !== 'POST') return res.status(200).send('OK');
            const rawBody = await readRawBody(req);
            const signature = req.headers['x-line-signature'];
            if (!signature || !verifySignature(rawBody, process.env.LINE_CHANNEL_SECRET, signature)) {
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
