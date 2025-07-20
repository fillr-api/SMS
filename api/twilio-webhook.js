// /api/twilio-webhook.js
import Twilio from 'twilio';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID,
  N8N_WEBHOOK_URL,
  TWILIO_PHONE_NUMBER
} = process.env;

const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Placeholder—implement with your DB or in-memory store
async function getOrCreateThread(userId) {
  // try fetching existing threadId from DB by userId...
  // if found return threadId
  // otherwise:
  const thread = await openai.assistant.threads.create({
    assistant: OPENAI_ASSISTANT_ID,
    user_id: userId
  });
  if (!thread?.id) {
    throw new Error('Failed to create OpenAI thread');
  }
  // save thread.id to DB keyed by userId
  return thread.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { From: userPhone, Body: userMessage } = req.body;

  try {
    // 1. Get or create a thread for this user
    const threadId = await getOrCreateThread(userPhone);

    // 2. Start a new run with the user’s message
    const run = await openai.assistant.runs.create({
      assistant: OPENAI_ASSISTANT_ID,
      thread: threadId,
      user_id: userPhone,
      input: { content: userMessage }
    }).catch(err => {
      console.error('Error starting run:', err);
      return null;
    });

    if (!run || !run.id) {
      console.error('No run.id returned, aborting');
      throw new Error('OpenAI run failed to start');
    }

    // 3. Poll or retrieve the assistant’s first response
    let result = await openai.assistant.runs.retrieve({
      assistant: OPENAI_ASSISTANT_ID,
      thread: threadId,
      run: run.id
    });

    let message = result.choices?.[0]?.message;
    if (!message) {
      throw new Error('No message returned from assistant');
    }

    // 4. If it’s a function call, dispatch to N8N and continue the run
    if (message.function_call) {
      console.log('Function call detected:', message.function_call);

      const fnResponse = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: message.function_call.name,
          arguments: message.function_call.arguments
        })
      }).then(r => r.json());

      // Submit the function result back to the Assistant
      await openai.assistant.runs.update({
        assistant: OPENAI_ASSISTANT_ID,
        thread: threadId,
        run: run.id,
        function_call: {
          name: message.function_call.name,
          content: fnResponse
        }
      });

      // Retrieve the final assistant reply
      result = await openai.assistant.runs.retrieve({
        assistant: OPENAI_ASSISTANT_ID,
        thread: threadId,
        run: run.id
      });
      message = result.choices?.[0]?.message;
      if (!message) {
        throw new Error('No follow-up message after function call');
      }
    }

    const replyText = message.content ?? '​'; // empty-string if no content

    // 5. Send SMS back via Twilio
    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: userPhone,
      body: replyText
    });

    // 6. Acknowledge Twilio webhook
    res.status(200).send('<Response></Response>');
  } catch (err) {
    console.error('Handler error:', err);

    // Send a graceful fallback SMS
    try {
      await twilioClient.messages.create({
        from: TWILIO_PHONE_NUMBER,
        to: userPhone,
        body: 'Sorry, something went wrong on our end. Please try again in a moment.'
      });
    } catch (twilioErr) {
      console.error('Failed sending error SMS:', twilioErr);
    }

    // Always return 200 to Twilio so it stops retrying
    res.status(200).send('<Response></Response>');
  }
}
