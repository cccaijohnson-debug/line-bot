const { GoogleGenerativeAI } = require("@google/generative-ai");
const { messagingApi } = require("@line/bot-sdk");
const crypto = require("crypto");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const result = await model.generateContent(event.message.text);
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: result.response.text() }],
  });
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
