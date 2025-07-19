// File: /api/twilio-webhook.js

const { OpenAI } = require("openai");
const axios = require("axios");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple in-memory store for thread IDs (swap to DB or Redis in production)
const threadStore = {};

// Config for mapping Twilio numbers to assistant + webhook
const clientConfig = {
  "+18777804236": {
    assistantId: "asst_KMveeu0OOgTqasGMQBTAA37E",
    webhookUrl: "https://fillr.app.n8n.cloud/webhook-test/617ca97c-a7cf-4b5a-bfa9-7d2aad5268a4"
  }
};

module.exports = async function (req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const from = req.body.From;
    const to = req.body.To;
    const message = req.body.Body;

    const config = clientConfig[to];
    if (!config) return res.status(400).send("Unknown Twilio number");

    if (!threadStore[from]) {
      const thread = await openai.beta.threads.create();
      threadStore[from] = {
        threadId: thread.id,
        assistantId: config.assistantId,
        webhookUrl: config.webhookUrl
      };
    }

    const { threadId, assistantId, webhookUrl } = threadStore[from];

    // Send message to OpenAI
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message
    });

    const runStart = await openai.beta.threads.runs.create(threadId, { assistant_id: assistantId });
    const runId = runStart.id;
    let runResult = runStart;

    // Poll until done or needs action
    while (!["completed", "requires_action", "failed"].includes(runResult.status)) {
      await new Promise((r) => setTimeout(r, 1500));
      runResult = await openai.beta.threads.runs.retrieve(threadId, runId);
    }

    // Handle function call
    if (runResult.status === "requires_action" && runResult.required_action) {
      const toolCall = runResult.required_action.submit_tool_outputs.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);

      // Send to N8n webhook
      const response = await axios.post(webhookUrl, {
        function: toolCall.function.name,
        phone: from,
        args
      });

      // Submit back to OpenAI
      await openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
        tool_outputs: [
          {
            tool_call_id: toolCall.id,
            output: JSON.stringify(response.data)
          }
        ]
      });

      // Wait for assistant to reply again
      do {
        await new Promise((r) => setTimeout(r, 1500));
        runResult = await openai.beta.threads.runs.retrieve(threadId, runId);
      } while (runResult.status !== "completed");
    }

    // Final reply from assistant
    const messages = await openai.beta.threads.messages.list(threadId);
    const last = messages.data.find((msg) => msg.role === "assistant");

    if (!last) return res.status(500).send("No assistant reply");

    // Send response via Twilio
    await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        From: to,
        To: from,
        Body: last.content[0].text.value
      }),
      {
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN
        }
      });

    res.status(200).send("OK");

  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).send("Internal Server Error");
  }
};
