const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Client, middleware, messagingApi } = require("@line/bot-sdk");
const crypto = require("crypto");

const lineConfig = {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new messagingApi.MessagingApiClient({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

function verifySignature(body, signature) {
    const hash = crypto
      .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
      .update(body)
      .digest("base64");
    return hash === signature;
}

async function handleEvent(event) {
    if (event.type !== "message" || event.message.type !== "text") {
          return;
    }
    const userMessage = event.message.text;
    const result = await model.generateContent(userMessage);
    const replyText = result.response.text();
    await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: replyText }],
    });
}

module.exports = async (req, res) => {
    if (req.method !== "POST") {
          return res.status(200).send("LINE Bot is running!");
    }
    const signature = req.headers["x-line-signature"];
    const rawBody = JSON.stringify(req.body);
    if (!verifySignature(rawBody, signature)) {
          return res.status(403).send("Invalid signature");
    }
    const events = req.body.events;
    try {
          await Promise.all(events.map(handleEvent));
          res.status(200).send("OK");
    } catch (err) {
          console.error(err);
          res.status(500).send("Error");
    }
};
