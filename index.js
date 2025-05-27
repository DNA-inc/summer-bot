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

// Store mapping from thread_ts to last inserted section_id
const threadToSectionId = new Map();

(async () => {
  await slackClient.start(process.env.PORT || 3000);
  console.log("⚡️ Slack link summarizer bot is running!");

  // Join #offsite-hackathon-team12 on startup
  try {
    const allChannels = [];

    let cursor;
    do {
      const conversations = await slackClient.client.conversations.list({
        token: process.env.SLACK_BOT_TOKEN,
        types: "public_channel,private_channel",
        cursor,
        limit: 1000,
      });
      allChannels.push(...conversations.channels);
      cursor =
        conversations.response_metadata &&
        conversations.response_metadata.next_cursor;
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
      user: event.user,
    });

    try {
      // Retrieve the message that was reacted to
      const reactedMessageResp = await client.conversations.replies({
        channel: event.item.channel,
        ts: event.item.ts,
        limit: 1,
      });
      if (
        !reactedMessageResp.messages ||
        reactedMessageResp.messages.length === 0
      ) {
        console.log("Could not find the message that was reacted to");
        return;
      }
      const reactedMessage = reactedMessageResp.messages[0];

      // Determine the thread root ts
      const threadRootTs = reactedMessage.thread_ts || reactedMessage.ts;

      // Fetch the first message of the thread (the thread root)
      const threadRepliesResp = await client.conversations.replies({
        channel: event.item.channel,
        ts: threadRootTs,
        limit: 1,
      });
      if (
        !threadRepliesResp.messages ||
        threadRepliesResp.messages.length === 0
      ) {
        console.log("Could not find the thread root message");
        return;
      }
      const threadMessage = threadRepliesResp.messages[0];
      console.log("threadMessage", threadMessage);

      const originalPoster = threadMessage.user;

      // Check if the reacted message was from our bot
      if (reactedMessage.bot_id) {
        console.log("Message is from a bot with ID:", reactedMessage.bot_id);
        if (event.reaction === "+1") {
          console.log("👍 Thumbs up received");
        } else if (event.reaction === "-1") {
          if (event.user !== originalPoster) {
            console.log(
              "Reaction is from a user other than the original poster, ignoring",
              event.user,
              originalPoster
            );
            return;
          }
          console.log("👎 Thumbs down received - Undoing link from canvas");

          // Find the section_id for this thread
          const sectionId = threadToSectionId.get(threadRootTs);
          if (sectionId) {
            await client.apiCall("canvases.edit", {
              canvas_id: "F08UDARNE8H",
              changes: [
                {
                  operation: "delete",
                  section_id: sectionId,
                },
              ],
            });
            threadToSectionId.delete(threadRootTs);
          } else {
            console.log("No section_id found for this thread, cannot undo");
          }
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
            criteria: {},
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

          // Lookup the last section to get its section_id
          const sectionsResp = await client.apiCall(
            "canvases.sections.lookup",
            {
              criteria: {},
              canvas_id: "F08UDARNE8H",
            }
          );

          if (sectionsResp.sections && sectionsResp.sections.length > 0) {
            // Assume the last section is the one we just added
            const lastSection =
              sectionsResp.sections[sectionsResp.sections.length - 1];
            threadToSectionId.set(event.ts, lastSection.section_id);
          }

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
          text: `😕 I couldn't access that link. It might be behind a login, or the site's down. Want to try a different one?`,
        });
      }
    }
  });
})();
