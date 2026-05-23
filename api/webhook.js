const { GoogleGenerativeAI } = require("@google/generative-ai");
const { messagingApi } = require("@line/bot-sdk");
const crypto = require("crypto");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// グループの会話履歴を一時保存（メモリ上。Vercelは再起動で消える）
const groupHistory = {};

function storeMessage(groupId, displayName, text) {
    if (!groupHistory[groupId]) groupHistory[groupId] = [];
    const history = groupHistory[groupId];
    history.push({ name: displayName, text, time: new Date().toISOString() });
    // 最大200件まで保持
  if (history.length > 200) history.splice(0, history.length - 200);
}

async function summarizeHistory(groupId, replyToken) {
    const history = groupHistory[groupId] || [];
    if (history.length === 0) {
          await client.replyMessage({
                  replyToken,
                  messages: [{ type: "text", text: "まだ会話履歴がありません。" }],
          });
          return;
    }

  const historyText = history
      .map((m) => `[${m.name}]: ${m.text}`)
      .join("\n");

  const prompt = `以下はLINEグループの会話履歴です。この会話を整理して、以下の4つの項目をそれぞれ日本語で簡潔にまとめてください。

  【会話履歴】
  ${historyText}

  【出力フォーマット】
  ■ プロジェクトの進行状況まとめ
  （現在の進捗や状況を簡潔に）

  ■ メンバー別のタスクと進捗
  （誰が何をやっているか、進捗は？）

  ■ 担当者が未定のタスク
  （まだ担当が決まっていない作業）

  ■ 決定事項・未決事項
  （決まったこと / まだ決まっていないこと）`;

  const result = await model.generateContent(prompt);
    const summary = result.response.text();

  await client.replyMessage({
        replyToken,
        messages: [{ type: "text", text: summary }],
  });
}

async function handleEvent(event) {
    if (event.type !== "message" || event.message.type !== "text") return;

  const groupId =
        event.source.groupId || event.source.roomId || event.source.userId;
    const text = event.message.text.trim();

  // 送信者名を取得（グループではprofileが取れない場合あり）
  let displayName = "メンバー";
    try {
          if (event.source.groupId) {
                  const profile = await client.getGroupMemberProfile(
                            event.source.groupId,
                            event.source.userId
                          );
                  displayName = profile.displayName;
          }
    } catch (e) {
          // プロフィール取得失敗は無視
    }

  // 「整理して」コマンド
  if (text === "整理して") {
        await summarizeHistory(groupId, event.replyToken);
        return;
  }

  // それ以外のメッセージは履歴に保存
  storeMessage(groupId, displayName, text);
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    if (req.method !== "POST") return res.status(200).send("OK");

  const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");

  const signature = req.headers["x-line-signature"];
    const hash = crypto
      .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
      .update(rawBody)
      .digest("base64");

  if (hash !== signature) return res.status(403).send("Invalid signature");

  const body = JSON.parse(rawBody);
    try {
          await Promise.all(body.events.map(handleEvent));
          res.status(200).send("OK");
    } catch (err) {
          console.error(err);
          res.status(500).send("Error");
    }
}
