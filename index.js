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
  const urlRegex =
    /\b(?:https?:\/\/|www\.)[^\s<>"']+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s<>"']*)?/g;
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

  // Listen for reactions to bot messages
  slackClient.event("reaction_added", async ({ event, client }) => {
    console.log("Reaction received:", {
      reaction: event.reaction,
      channel: event.item.channel,
      ts: event.item.ts,
      user: event.user
    });
    
    try {
      // Get the specific message that was reacted to using conversations.replies
      const result = await client.conversations.replies({
        channel: event.item.channel,
        ts: event.item.ts,
        limit: 1
      });
      
      if (!result.messages || result.messages.length === 0) {
        console.log("Could not find the message that was reacted to");
        return;
      }
      
      const message = result.messages[0];
      
      // Check if the reacted message was from our bot
      if (message.bot_id) {
        console.log("Message is from a bot with ID:", message.bot_id);
        if (event.reaction === "+1") {
          console.log("👍 Thumbs up received - Adding link to canvas");
        } else if (event.reaction === "-1") {
          console.log("👎 Thumbs down received - Doing nothing");
        } else {
          console.log("Other reaction received:", event.reaction);
        }
      } else {
        console.log("Message is not from our bot - ignoring reaction");
      }
    } catch (error) {
      console.error("Error handling reaction:", error);
    }
  });

  // Listen for messages in the joined channel
  slackClient.event("message", async ({ event, client, context }) => {
    // console.log("Message seen in channel:", event);
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
            criteria: {
              section_type: "markdown",
            },
            changes: [
              {
                operation: "insert_at_end",
                document_content: {
                  type: "markdown",
                  markdown:
                    "## Link: [{url}]({url}) \n**Shared by** <@{user}> \n\n {summary}"
                      .replace("{summary}", summary)
                      .replace("{user}", event.user)
                      .replaceAll("{url}", url),
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
