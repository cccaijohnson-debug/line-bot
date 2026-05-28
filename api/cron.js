const { kv } = require('@vercel/kv');

const LINE_API = 'https://api.line.me/v2/bot';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TRIGGER = '整理して';

function trimForLog(value) {
        let text;
        try {
                text = typeof value === 'string' ? value : JSON.stringify(value);
        } catch (_) {
                text = String(value);
        }
        return (text || '').slice(0, 500);
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
        console.log('[cron:push] status=' + res.status + ' result:', JSON.stringify(data));
        if (!res.ok) {
                throw new Error('LINE push failed. status=' + res.status + ' body=' + trimForLog(data));
        }
        return data;
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
                await kv.set(key, state, { ex: 60 * 60 * 24 * 30 });
                console.log('[kv] state saved. key=' + key);
        } catch (e) {
                console.error('[kv] saveState error:', e.message);
        }
}

async function loadMessages(groupId) {
        const key = 'msg:' + groupId;
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
}

async function callGemini(prompt, retryCount = 0) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

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
        const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
        if (!text) throw new Error('Gemini returned empty text. body=' + trimForLog(data));

        return text;
}

async function buildSummary(groupId) {
        const messages = await loadMessages(groupId);
        const history = messages.filter(m => m && m.text && m.text !== TRIGGER);
        const recent = history.slice(-30);
        console.log('[cron:summary] groupId=' + groupId + ' historyLen=' + history.length + ' sendingLen=' + recent.length);

        if (recent.length === 0) return null;

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

        return await callGemini(prompt);
}

async function handler(req, res) {
        // Vercel cronからの呼び出しを確認（CRON_SECRETが設定されている場合のみ検証）
        const cronSecret = process.env.CRON_SECRET;
        if (cronSecret) {
                const authHeader = req.headers.authorization || '';
                if (authHeader !== 'Bearer ' + cronSecret) {
                        console.log('[cron] unauthorized');
                        return res.status(401).json({ error: 'Unauthorized' });
                }
        }

        console.log('[cron] starting daily summary');

        let groupIds;
        try {
                groupIds = await kv.smembers('groups');
        } catch (e) {
                console.error('[cron] failed to get group list:', e.message);
                return res.status(500).json({ error: 'KV error' });
        }

        console.log('[cron] groups to summarize:', groupIds.length);

        let succeeded = 0;
        let skipped = 0;
        let failed = 0;

        for (const groupId of groupIds) {
                try {
                        const summary = await buildSummary(groupId);
                        if (!summary) {
                                console.log('[cron] skip groupId=' + groupId + ' (no messages)');
                                skipped++;
                                continue;
                        }
                        const message = '📅 本日の自動まとめ\n\n' + summary;
                        await pushMessage(groupId, message);
                        console.log('[cron] done groupId=' + groupId);
                        succeeded++;
                } catch (e) {
                        console.error('[cron] error groupId=' + groupId + ':', e.message);
                        failed++;
                }
        }

        res.status(200).json({ status: 'ok', succeeded, skipped, failed, total: groupIds.length });
}

module.exports = handler;
