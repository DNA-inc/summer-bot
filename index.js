import dotenv from "dotenv";
dotenv.config();
import Slack from "@slack/bolt";
import { OpenAI } from "openai";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const SlackClient = Slack.App;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USER_PROMPT = readFileSync(
  join(__dirname, "prompts", "user.txt"),
  "utf8"
);

const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "prompts", "system.txt"),
  "utf8"
);

const CHANNEL_NAME = "offsite-hackathon-team12";

const slackClient = new SlackClient({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper to extract URLs from text
function extractUrls(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

// Store the channel ID after joining
let joinedChannelId;

(async () => {
  await slackClient.start(process.env.PORT || 3000);
  console.log("⚡️ Slack link summarizer bot is running!");

  // Join #offsite-hackathon-team12 on startup
  try {
    let allChannels = [];

    let cursor;
    do {
      const result = await slackClient.client.conversations.list({
        token: process.env.SLACK_BOT_TOKEN,
        types: "public_channel,private_channel",
        cursor,
        limit: 1000,
      });
      allChannels = allChannels.concat(result.channels);
      cursor = result.response_metadata && result.response_metadata.next_cursor;
    } while (cursor);

    const channel = allChannels.find((c) => c.name === CHANNEL_NAME);
    if (channel) {
      joinedChannelId = channel.id;
      await slackClient.client.conversations.join({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channel.id,
      });
      console.log(`Joined #${CHANNEL_NAME}`);
    } else {
      console.error(`Channel #${CHANNEL_NAME} not found.`);
    }
  } catch (error) {
    console.error("Error joining channel:", error);
  }

  console.log("Waiting for messages...");

  // Listen for messages in the joined channel
  slackClient.event("message", async ({ event, client, context }) => {
    console.log("Message seen in channel:", event);
    // Only respond to messages in the joined channel, not from bots
    if (
      !joinedChannelId ||
      event.channel !== joinedChannelId ||
      event.subtype === "bot_message"
    )
      return;
    if (!event.text) return;

    const urls = extractUrls(event.text);
    if (urls.length === 0) return;

    for (const url of urls) {
      try {
        console.log("Summarizing", url);

        const completion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: USER_PROMPT.replace("{url}", url),
            },
          ],
          max_tokens: 300,
        });

        const summary = completion.choices[0].message.content.trim();

        // Post summary in thread
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `${summary}`,
        });

        // Add to Canvas
        try {
          await client.apiCall("canvases.edit", {
            canvas_id: "F08UDARNE8H",
            changes: [
              {
                operation: "insert_at_end",
                document_content: {
                  type: "markdown",
                  markdown: `${url}\n${summary}\n (by @${event.user})`,
                },
              },
            ],
          });

          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: event.ts,
            text: "📌 Saved to the Links canvas!",
          });
        } catch (canvasErr) {
          console.error("Error updating Canvas:", JSON.stringify(canvasErr));
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: event.ts,
            text: "Sorry, I couldn't add the summary to the Canvas due to an error.",
          });
        }
      } catch (err) {
        console.error(err);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `😕 I couldn’t access that link. It might be behind a login, or the site’s down. Want to try a different one?`,
        });
      }
    }
  });
})();
