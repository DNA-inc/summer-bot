require("dotenv").config();
const { App } = require("@slack/bolt");
const { OpenAI } = require("openai");
// Add SLACK_APP_TOKEN to your .env for Socket Mode

const slackClient = new App({
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
  const channelName = "offsite-hackathon-team12";
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

    const channel = allChannels.find((c) => c.name === channelName);
    if (channel) {
      joinedChannelId = channel.id;
      await slackClient.client.conversations.join({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channel.id,
      });
      console.log(`Joined #${channelName}`);
    } else {
      console.error(`Channel #${channelName} not found.`);
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
              content:
                "You are a helpful assistant that summarizes web pages for Slack users.",
            },
            {
              role: "user",
              content: `Summarize the content of this web page for a Slack channel: ${url} — make it short and concise, one paragraph`,
            },
          ],
          max_tokens: 300,
        });

        const summary = completion.choices[0].message.content.trim();
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `Summary of <${url}>:\n${summary}`,
        });
      } catch (err) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: `Sorry, I couldn't summarize <${url}> due to an error.`,
        });
      }
    }
  });
})();
