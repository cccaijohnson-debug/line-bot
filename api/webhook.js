import { GoogleGenerativeAI } from "@google/generative-ai";
import { messagingApi } from "@line/bot-sdk";
import crypto from "crypto";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const client = new messagingApi.MessagingApiClient({
          channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const groupHistory = {};

function storeMessage(groupId, name, text) {
          if (!groupHistory[groupId]) groupHistory[groupId] = [];
          groupHistory[groupId].push({ name, text });
          if (groupHistory[groupId].length > 200)
                      groupHistory[groupId].splice(0, groupHistory[groupId].length - 200);
}

async function summarize(groupId, replyToken) {
          const history = groupHistory[groupId] || [];
          if (history.length === 0) {
                      await client.replyMessage({ replyToken, messages: [{ type: "text", text: "\u307e\u3060\u4f1a\u8a71\u5c65\u6b74\u304c\u3042\u308a\u307e\u305b\u3093\u3002" }] });
                      return;
          }
          const historyText = history.map((m) => "[" + m.name + "]: " + m.text).join("\n");
          const prompt = "\u4ee5\u4e0b\u306fLINE\u30b0\u30eb\u30fc\u30d7\u306e\u4f1a\u8a71\u5c65\u6b74\u3067\u3059\u3002\u3053\u306e\u4f1a\u8a71\u3092\u6574\u7406\u3057\u3066\u3001\u4ee5\u4e0b\u306e4\u3064\u306e\u9805\u76ee\u3092\u305d\u308c\u305e\u308c\u65e5\u672c\u8a9e\u3067\u7c21\u6f54\u306b\u307e\u3068\u3081\u3066\u304f\u3060\u3055\u3044\u3002\n\n\u300c\u4f1a\u8a71\u5c65\u6b74\u300d\n" + historyText + "\n\n\u25a0 \u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u9032\u884c\u72b6\u6cc1\u307e\u3068\u3081\n\u25a0 \u30e1\u30f3\u30d0\u30fc\u5225\u306e\u30bf\u30b9\u30af\u3068\u9032\u6357\n\u25a0 \u62c5\u5f53\u8005\u304c\u672a\u5b9a\u306e\u30bf\u30b9\u30af\n\u25a0 \u6c7a\u5b9a\u4e8b\u9805\u30fb\u672a\u6c7a\u4e8b\u9805";
          const result = await model.generateContent(prompt);
          await client.replyMessage({ replyToken, messages: [{ type: "text", text: result.response.text() }] });
}

async function handleEvent(event) {
          if (event.type !== "message" || event.message.type !== "text") return;
          const groupId = event.source.groupId || event.source.roomId || event.source.userId;
          const text = event.message.text.trim();
          let name = "\u30e1\u30f3\u30d0\u30fc";
          try {
                      if (event.source.groupId) {
                                    const p = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
                                    name = p.displayName;
                      }
          } catch (e) {}
          if (text === "\u6574\u7406\u3057\u3066") { await summarize(groupId, event.replyToken); return; }
          storeMessage(groupId, name, text);
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
          if (req.method !== "POST") return res.status(200).send("OK");
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const rawBody = Buffer.concat(chunks);
          const sig = req.headers["x-line-signature"];
          const hash = crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(rawBody).digest("base64");
          if (hash !== sig) return res.status(403).send("Invalid signature");
          const body = JSON.parse(rawBody.toString("utf8"));
          try {
                      await Promise.all(body.events.map(handleEvent));
                      res.status(200).send("OK");
          } catch (err) {
                      console.error(err);
                      res.status(500).send("Error");
          }
}
