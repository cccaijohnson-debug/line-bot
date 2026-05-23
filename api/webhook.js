const { GoogleGenerativeAI } = require("@google/generative-ai");
const { messagingApi } = require("@line/bot-sdk");
const crypto = require("crypto");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const groupHistory = {};

function storeMessage(groupId, displayName, text) {
      if (!groupHistory[groupId]) groupHistory[groupId] = [];
      const history = groupHistory[groupId];
      history.push({ name: displayName, text });
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
      const historyText = history.map((m) => "[" + m.name + "]: " + m.text).join("\n");
      const prompt = "以下はLINEグループの会話履歴です。この会話を整理して、以下の4つの項目をそれぞれ日本語で簡潔にまとめてください。\n\n【会話履歴】\n" + historyText + "\n\n【出力フォーマット】\n■ プロジェクトの進行状況まとめ\n（現在の進捗や状況を簡潔に）\n\n■ メンバー別のタスクと進捗\n（誰が何をやっているか、進捗は？）\n\n■ 担当者が未定のタスク\n（まだ担当が決まっていない作業）\n\n■ 決定事項・未決事項\n（決まったこと / まだ決まっていないこと）";
      const result = await model.generateContent(prompt);
      const summary = result.response.text();
      await client.replyMessage({
              replyToken,
              messages: [{ type: "text", text: summary }],
      });
}

async function handleEvent(event) {
      if (event.type !== "message" || event.message.type !== "text") return;
      const groupId = event.source.groupId || event.source.roomId || event.source.userId;
      const text = event.message.text.trim();
      let displayName = "メンバー";
      try {
              if (event.source.groupId) {
                        const profile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
                        displayName = profile.displayName;
              }
      } catch (e) {}
      if (text === "整理して") {
              await summarizeHistory(groupId, event.replyToken);
              return;
      }
      storeMessage(groupId, displayName, text);
}

module.exports = async function handler(req, res) {
      if (req.method !== "POST") return res.status(200).send("OK");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const signature = req.headers["x-line-signature"];
      const hash = crypto
        .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
        .update(rawBody)
        .digest("base64");
      if (hash !== signature) {
              console.error("Signature mismatch. hash:", hash, "signature:", signature);
              return res.status(403).send("Invalid signature");
      }
      const body = JSON.parse(rawBody);
      try {
              await Promise.all(body.events.map(handleEvent));
              res.status(200).send("OK");
      } catch (err) {
              console.error(err);
              res.status(500).send("Error");
      }
};

module.exports.config = { api: { bodyParser: false } };
