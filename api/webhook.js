const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const LINE_API = 'https://api.line.me/v2/bot';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const MAX_HISTORY = 200;
const TRIGGER = '整理して';
const EXPIRE_SECONDS = 60 * 60 * 24 * 30;
const KV_ENV_KEYS = [
        'KV_REST_API_URL',
        'KV_REST_API_TOKEN',
        'KV_REST_API_READ_ONLY_TOKEN',
        'KV_URL',
        'REDIS_URL',
        'UPSTASH_REDIS_REST_URL',
        'UPSTASH_REDIS_REST_TOKEN',
];
const SECRET_ENV_KEYS = [
        'GEMINI_API_KEY',
        'LINE_CHANNEL_ACCESS_TOKEN',
        'LINE_CHANNEL_SECRET',
        'KV_REST_API_TOKEN',
        'KV_REST_API_READ_ONLY_TOKEN',
];

let kvEnvLogged = false;

function trimForLog(value) {
        let text;
        try {
                  text = typeof value === 'string' ? value : JSON.stringify(value);
        } catch (_) {
                  text = String(value);
        }
        return (text || '').slice(0, 500);
}

function getEnvStatus(keys) {
        return keys.reduce((status, key) => {
                  status[key] = process.env[key] ? 'set' : 'missing';
                  return status;
        }, {});
}

function logKvEnvStatus(force) {
        if (!force && kvEnvLogged) return;
        kvEnvLogged = true;
        console.log('[kv] env status:', JSON.stringify(getEnvStatus(KV_ENV_KEYS)));
}

function getErrorMessage(error) {
        if (!error) return 'unknown error';
        return error.message || String(error);
}

function redactSecrets(text) {
        let output = String(text || '');
        SECRET_ENV_KEYS.forEach(key => {
                  const secret = process.env[key];
                  if (secret) output = output.split(secret).join('[redacted]');
        });
        return output;
}

function logError(label, error) {
        if (!error) {
                  console.error(label + ': unknown error');
                  return;
        }

        console.error(label + ':', redactSecrets(error.stack || getErrorMessage(error)));
        if (error.cause) {
                  console.error(label + ' cause:', redactSecrets(error.cause.stack || getErrorMessage(error.cause)));
        }
}

function errorMessageForLine(error) {
        return redactSecrets(getErrorMessage(error)).slice(0, 300);
}

async function readJsonOrText(res) {
        const bodyText = await res.text();
        if (!bodyText) return null;

        try {
                  return JSON.parse(bodyText);
        } catch (_) {
                  return { raw: bodyText };
        }
}

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
        const data = await readJsonOrText(res);
        if (!res.ok) {
                  console.log('[lineGet] status=' + res.status + ' path=' + path + ' body=' + trimForLog(data));
                  return null;
        }
        return data;
}

async function resolveMentions(groupId, text, mention) {
        if (!mention || !Array.isArray(mention.mentionees) || mention.mentionees.length === 0) {
                return text;
        }
        // 後ろから置換することでインデックスがずれないようにする
        const sorted = [...mention.mentionees]
                .filter(m => m.type === 'user' && m.userId)
                .sort((a, b) => b.index - a.index);

        let result = text;
        for (const m of sorted) {
                try {
                        const profile = await lineGet('/group/' + groupId + '/member/' + m.userId);
                        if (!profile || !profile.displayName) continue;
                        const newMention = '@' + profile.displayName;
                        result = result.slice(0, m.index) + newMention + result.slice(m.index + m.length);
                        console.log('[mention] resolved: ' + text.slice(m.index, m.index + m.length) + ' -> ' + newMention);
                } catch (e) {
                        logError('[mention] resolve error', e);
                }
        }
        return result;
}

async function pushMessage(groupId, text) {
        const res = await fetch(LINE_API + '/message/push', {
                  method: 'POST',
                  headers: {
                              'Content-Type': 'application/json',
                              Authorization: 'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN,
                  },
                  body: JSON.stringify({
                              to: groupId,
                              messages: [{ type: 'text', text }],
                  }),
        });
        const data = await readJsonOrText(res);
        console.log('[push] status=' + res.status + ' result:', JSON.stringify(data));
        if (!res.ok) {
                  throw new Error('LINE push failed. status=' + res.status + ' body=' + trimForLog(data));
        }
        return data;
}

async function pushSummaryError(groupId, error, mode) {
        logError('[summary] error', error);
        try {
                  const lines = ['整理中にエラーが発生しました。'];
                  if (mode === 'direct') {
                            lines.push('貼り付け本文は受け取れていますが、Gemini API呼び出しで失敗しました。');
                  } else {
                            lines.push('会話履歴の読み込み、またはGemini API呼び出しで失敗しました。');
                  }
                  lines.push('原因: ' + errorMessageForLine(error));
                  await pushMessage(groupId, lines.join('\n'));
        } catch (pushError) {
                  logError('[summary] error push failed', pushError);
        }
}

async function saveMessage(groupId, displayName, text) {
        const key = 'msg:' + groupId;
        const entry = JSON.stringify({ displayName, text, ts: Date.now() });
        logKvEnvStatus(false);

        try {
                  console.log('[kv] saving. key=' + key);
                  await kv.rpush(key, entry);
                  const len = await kv.llen(key);
                  if (len > MAX_HISTORY) await kv.ltrim(key, len - MAX_HISTORY, -1);
                  await kv.expire(key, EXPIRE_SECONDS);
                  await kv.sadd('groups', groupId);
                  console.log('[kv] saved. key=' + key + ' len=' + Math.min(len, MAX_HISTORY));
                  return { ok: true, key, len: Math.min(len, MAX_HISTORY) };
        } catch (e) {
                  console.error('[kv] save failed. key=' + key);
                  logError('[kv] save error', e);
                  logKvEnvStatus(true);
                  return { ok: false, key, error: e };
        }
}

async function loadState(groupId) {
        const key = 'state:' + groupId;
        try {
                const state = await kv.get(key);
                return typeof state === 'string' ? state : '';
        } catch (e) {
                console.error('[kv] loadState error:', e.message);
                return '';
        }
}

async function saveState(groupId, state) {
        const key = 'state:' + groupId;
        try {
                await kv.set(key, state, { ex: EXPIRE_SECONDS });
                console.log('[kv] state saved. key=' + key);
        } catch (e) {
                console.error('[kv] saveState error:', e.message);
        }
}

async function loadMessages(groupId) {
        const key = 'msg:' + groupId;
        logKvEnvStatus(false);

        try {
                  const items = await kv.lrange(key, 0, -1);
                  if (!items || items.length === 0) return [];
                  return items.map(item => {
                              if (typeof item !== 'string') return item;
                              try {
                                        return JSON.parse(item);
                              } catch (_) {
                                        return { displayName: 'unknown', text: item, ts: null };
                              }
                  });
        } catch (e) {
                  console.error('[kv] load failed. key=' + key);
                  logError('[kv] load error', e);
                  logKvEnvStatus(true);
                  throw e;
        }
}

function extractDirectText(text) {
        const index = text.indexOf(TRIGGER);
        if (index === -1) return '';
        return text.slice(index + TRIGGER.length).trim();
}

function extractPersonName(directText) {
        if (!directText) return '';
        if (directText.includes('\n') || directText.length > 30) return '';
        return directText;
}

function isGeminiQuotaError(error) {
        const message = getErrorMessage(error);
        return message.includes('status=429') || message.includes('quota') || message.includes('RESOURCE_EXHAUSTED');
}

function splitSentences(text) {
        return text
                  .replace(/^貼り付けテキスト:\s*/u, '')
                  .split(/[。！？\n]+/u)
                  .map(line => line.trim())
                  .filter(Boolean);
}

function uniqueList(items) {
        return Array.from(new Set(items.filter(Boolean)));
}

function pickLines(items, fallback) {
        const list = uniqueList(items).slice(0, 8);
        return list.length ? list.map(item => '- ' + item).join('\n') : '- ' + fallback;
}

function extractMemberTasks(sentences) {
        const tasks = [];
        sentences.forEach(sentence => {
                  sentence.split(/[、,]/u).forEach(part => {
                            const match = part.trim().match(/^(.{1,20}?(?:さん|氏|くん|ちゃん))は(.+)$/u);
                            if (match) tasks.push(match[1] + ': ' + match[2].trim());
                  });
        });
        return tasks;
}

function buildFallbackSummary(historyText, error) {
        const sentences = splitSentences(historyText);
        const memberTasks = extractMemberTasks(sentences);
        const taskKeywords = /担当|タスク|作成|確認|対応|提出|準備|調整|実施|やる|お願いします|締切|期限|まで|今日|明日|来週/u;
        const decisionKeywords = /決定|確定|承認|合意|決まり|決めた/u;
        const openKeywords = /未定|未確定|未決|検討|要確認|調整中|確認中|\?/u;
        const taskLines = sentences.filter(sentence => taskKeywords.test(sentence));
        const decisions = sentences.filter(sentence => decisionKeywords.test(sentence));
        const openItems = sentences.filter(sentence => openKeywords.test(sentence));
        const unassigned = taskLines.filter(sentence => !/(さん|氏|くん|ちゃん)は/u.test(sentence));

        return [
                  'Gemini APIの利用枠超過のため、簡易整理で返します。',
                  '原因: ' + errorMessageForLine(error),
                  '',
                  '📊 プロジェクトの進行状況まとめ',
                  sentences.length ? '貼り付けられた内容から、タスク・担当・期限に関係しそうな情報を抽出しました。' : '整理できる本文が見つかりませんでした。',
                  '',
                  '👥 メンバー別のタスクと進捗',
                  pickLines(memberTasks, '特になし'),
                  '',
                  '❓ 担当者未定のタスク',
                  pickLines(unassigned, '特になし'),
                  '',
                  '✅ 決定事項',
                  pickLines(decisions, '特になし'),
                  '',
                  '⚠️ 未決事項',
                  pickLines(openItems, '特になし'),
        ].join('\n');
}

async function callGemini(prompt, retryCount = 0) {
        const apiKey = process.env.GEMINI_API_KEY;
        console.log('[gemini] env status:', JSON.stringify({ GEMINI_API_KEY: apiKey ? 'set' : 'missing', GEMINI_MODEL }));
        if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000); // 8秒でタイムアウト

        let res;
        try {
                res = await fetch(GEMINI_API + encodeURIComponent(GEMINI_MODEL) + ':generateContent?key=' + encodeURIComponent(apiKey), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                                      contents: [{ parts: [{ text: prompt }] }],
                                      generationConfig: {
                                                thinkingConfig: { thinkingBudget: 0 },
                                                maxOutputTokens: 1024,
                                      },
                          }),
                          signal: controller.signal,
                });
        } catch (e) {
                clearTimeout(timeout);
                if (e.name === 'AbortError') throw new Error('Gemini API timeout after 8s. status=408');
                throw e;
        }
        clearTimeout(timeout);
        const data = await readJsonOrText(res);
        if (!res.ok) {
                  if (res.status === 503 && retryCount < 1) {
                          console.log('[gemini] 503 unavailable, retrying after 1s...');
                          await new Promise(r => setTimeout(r, 1000));
                          return callGemini(prompt, retryCount + 1);
                  }
                  throw new Error('Gemini API failed. status=' + res.status + ' body=' + trimForLog(data));
        }

        const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        const text = Array.isArray(parts) ? parts.map(part => part.text || '').join('').trim() : '';
        if (!text) {
                  throw new Error('Gemini API returned empty text. body=' + trimForLog(data));
        }

        console.log('[gemini] response received');
        return text;
}

async function buildSummaryFromText(historyText) {
        const normalizedHistoryText = historyText.trim();

        if (normalizedHistoryText.length === 0) {
                  return 'まだ整理できる会話履歴がありません。\nグループで会話が蓄積されてからもう一度お試しください！';
        }

        const prompt = [
                  '以下はプロジェクトチームのグループLINEの会話履歴です。',
                  'プロジェクト管理の観点から分析し、必ず以下の5項目を日本語で出力してください。',
                  '該当する情報がない項目は「特になし」と記載してください。',
                  '',
                  '【会話履歴】',
                  normalizedHistoryText,
                  '',
                  '---',
                  '📊 プロジェクトの進行状況まとめ',
                  '（全体の現状と進捗を箇条書きで）',
                  '',
                  '👥 メンバー別のタスクと進捗',
                  '（各メンバーの担当タスクと進捗を箇条書きで）',
                  '',
                  '❓ 担当者未定のタスク',
                  '（担当が決まっていない課題を箇条書きで）',
                  '',
                  '✅ 決定事項',
                  '（会話で確定した内容を箇条書きで）',
                  '',
                  '⚠️ 未決事項',
                  '（まだ検討中・未解決の内容を箇条書きで）',
        ].join('\n');

        try {
                  return await callGemini(prompt);
        } catch (e) {
                  if (isGeminiQuotaError(e)) {
                            console.log('[gemini] quota exceeded. using fallback summary');
                            return buildFallbackSummary(normalizedHistoryText, e);
                  }
                  throw e;
        }
}

async function buildPersonSummary(groupId, personName) {
        const messages = await loadMessages(groupId);
        const history = messages.filter(m => m && m.text && m.text !== TRIGGER);
        const recent = history.slice(-20);
        console.log('[buildPersonSummary] groupId=' + groupId + ' person=' + personName + ' sendingLen=' + recent.length);

        if (recent.length === 0) {
                return '「' + personName + '」に関する会話履歴がまだありません。\nグループで会話が蓄積されてからもう一度お試しください！';
        }

        const historyText = recent.map(m => (m.displayName || 'unknown') + ': ' + m.text).join('\n');

        const prompt = [
                '以下はプロジェクトチームのグループLINEの会話履歴です。',
                '「' + personName + '」に関係する情報のみを抽出し、以下の形式で日本語で出力してください。',
                '該当する情報がない項目は「特になし」と記載してください。',
                '',
                '重要ルール：',
                '・タスクとして認識する条件：①「@名前」でメンションして依頼内容がある、または②明示的に「〇〇さんお願い」「〇〇やっておいて」など作業を依頼している場合',
                '・名前は部分一致や略称でも一致と判断する（例：「ko」と「koさん」は同一人物として扱う）',
                '・単に名前が会話に出てくるだけ（依頼・指示なし）はタスクとして扱わない',
                '・同じ事象を複数のカテゴリに重複して記載しない',
                '・完了・解決済みと判断した事象は「⚠️ 進行中・未完了」には含めない',
                '・「✅ 完了済み」に記載したものは「⚠️ 進行中・未完了」に書かない',
                '',
                '【会話履歴】',
                historyText,
                '',
                '---',
                '👤 ' + personName + ' の役割まとめ',
                '',
                '📋 担当タスク・役割',
                '（担当しているタスク・役割を箇条書きで）',
                '',
                '✅ 完了済み',
                '（完了したタスク・決まったことを箇条書きで）',
                '',
                '⚠️ 進行中・未完了',
                '（まだ終わっていないタスク・課題。✅に書いたものは除く）',
                '',
                '❓ 未定・要確認',
                '（担当・期限などが未定のものを箇条書きで）',
        ].join('\n');

        try {
                return await callGemini(prompt);
        } catch (e) {
                if (isGeminiQuotaError(e)) {
                        return 'Gemini APIの利用枠超過のため、「' + personName + '」の役割整理ができませんでした。\n原因: ' + errorMessageForLine(e);
                }
                throw e;
        }
}

async function buildSummary(groupId) {
        const messages = await loadMessages(groupId);
        const history = messages.filter(m => m && m.text && m.text !== TRIGGER);
        const recent = history.slice(-30);
        console.log('[buildSummary] groupId=' + groupId + ' historyLen=' + history.length + ' sendingLen=' + recent.length);

        if (recent.length === 0) {
                return 'まだ整理できる会話履歴がありません。\nグループで会話が蓄積されてからもう一度お試しください！';
        }

        const historyText = recent.map(m => (m.displayName || 'unknown') + ': ' + m.text).join('\n');

        const prompt = [
                'あなたはプロジェクト管理アシスタントです。',
                '以下のグループLINEの会話から「言いっぱなし・忘れがちな確認事項」だけを短く抽出してください。',
                '',
                '抽出対象：',
                '・「〜します」「〜確認します」「〜送ります」「〜やっておきます」など約束・宣言したが完了報告がないもの',
                '・誰かへの質問・依頼に対して、回答・対応がまだのもの',
                '・「〜どうする？」「〜検討しよう」など未決のまま流れているもの',
                '',
                '出力ルール：',
                '・各項目は1行で簡潔に（長文にしない）',
                '・完了済みのものは一切出力しない（✅セクションは作らない）',
                '・該当なしの項目は「特になし」と書く',
                '・担当者名がわかる場合は名前を添える',
                '',
                '【会話履歴】',
                historyText,
                '',
                '---',
                '🔔 要フォローアップ',
                '（言ったけど完了報告がないこと・忘れてそうなこと）',
                '',
                '❓ 未決・要検討',
                '（誰が・いつやるか決まっていないこと）',
        ].join('\n');

        try {
                return await callGemini(prompt);
        } catch (e) {
                if (isGeminiQuotaError(e)) {
                        console.log('[gemini] quota exceeded. using fallback summary');
                        return buildFallbackSummary(historyText, e);
                }
                throw e;
        }
}

async function processEvent(event) {
        try {
                  console.log('[event] type=' + event.type + ' source=' + JSON.stringify(event.source));

                  if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
                            console.log('[event] skip: not a text message');
                            return;
                  }

                  const source = event.source || {};
                  const groupId = source.groupId || source.roomId;
                  const text = event.message.text.trim();
                  const isTrigger = text === TRIGGER || text.startsWith(TRIGGER);
                  const directText = isTrigger ? extractDirectText(text) : '';
                  console.log('[event] groupId=' + groupId + ' text=' + event.message.text);

                  if (!groupId) {
                            console.log('[event] skip: no groupId');
                            return;
                  }

                  if (directText) {
                            const personName = extractPersonName(directText);
                            if (personName) {
                                      console.log('[trigger] person filter mode. name=' + personName);
                                      try {
                                                const summary = await buildPersonSummary(groupId, personName);
                                                await pushMessage(groupId, summary);
                                      } catch (e) {
                                                await pushSummaryError(groupId, e, 'person');
                                      }
                            } else {
                                      console.log('[trigger] direct text mode. chars=' + directText.length);
                                      try {
                                                const summary = await buildSummaryFromText('貼り付けテキスト:\n' + directText);
                                                await pushMessage(groupId, summary);
                                      } catch (e) {
                                                await pushSummaryError(groupId, e, 'direct');
                                      }
                            }
                            return;
                  }

                  const userId = source.userId || 'unknown';
                  let displayName = userId;
                  if (source.userId) {
                            try {
                                      console.log('[profile] fetching. groupId=' + groupId + ' userId=' + userId);
                                      const profile = await lineGet('/group/' + groupId + '/member/' + userId);
                                      if (profile && profile.displayName) displayName = profile.displayName;
                                      console.log('[profile] displayName=' + displayName);
                            } catch (e) {
                                      logError('[profile] error', e);
                            }
                  } else {
                            console.log('[profile] skip: no userId');
                  }

                  const textToSave = event.message.mention
                            ? await resolveMentions(groupId, text, event.message.mention)
                            : text;
                  const saveResult = await saveMessage(groupId, displayName, textToSave);
                  if (!saveResult.ok) {
                            console.error('[kv] continuing without saved history for this event');
                  }

                  if (!isTrigger) return;

                  console.log('[trigger] matched. building summary...');

                  try {
                            const summary = await buildSummary(groupId);
                            await pushMessage(groupId, summary);
                  } catch (e) {
                            await pushSummaryError(groupId, e, 'history');
                  }
        } catch (e) {
                  logError('[event] error', e);
        }
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
        console.log('[webhook] body:', JSON.stringify(body).slice(0, 500));

        try {
                  await Promise.all((body.events || []).map(processEvent));
        } catch (e) {
                  logError('[handler] error', e);
        }

        res.status(200).json({ status: 'ok' });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
