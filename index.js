const express = require("express");
const crypto = require("crypto");

const app = express();

// ============================================================
// CONFIGURATION — these are loaded from your environment variables
// ============================================================
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;

// Your Notion page IDs (extracted from your URLs)
const NOTION_PAGE_IDS = [
  "34ae86878fe681499cc1dc8a63036574",
  "34ae86878fe6805b8a75dd819e812662",
  "27ee86878fe6800fbd40fa044f862fb1",
  "2afe86878fe6805685dcfe9630d46a63",
];

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// VERIFY SLACK REQUESTS (security check)
// ============================================================
function verifySlackRequest(req) {
  const slackSignature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];
  const body = JSON.stringify(req.body);

  // Reject requests older than 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;

  const sigBaseString = `v0:${timestamp}:${body}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", SLACK_SIGNING_SECRET)
      .update(sigBaseString)
      .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(slackSignature)
  );
}

// ============================================================
// FETCH NOTION PAGE CONTENT
// ============================================================
async function getNotionPageContent(pageId) {
  try {
    // Get page blocks
    const response = await fetch(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );

    const data = await response.json();
    if (!data.results) return "";

    // Extract text from blocks
    let content = "";
    for (const block of data.results) {
      const type = block.type;
      const blockData = block[type];

      if (blockData?.rich_text) {
        const text = blockData.rich_text.map((t) => t.plain_text).join("");
        if (text.trim()) content += text + "\n";
      }

      // Handle child pages and toggle blocks recursively
      if (block.has_children) {
        const childContent = await getNotionPageContent(block.id);
        content += childContent;
      }
    }

    return content;
  } catch (err) {
    console.error("Error fetching Notion page:", err);
    return "";
  }
}

// ============================================================
// ASK CLAUDE WITH NOTION CONTEXT
// ============================================================
async function askClaude(question) {
  try {
    // Fetch all Notion pages
    console.log("Fetching Notion pages...");
    const pageContents = await Promise.all(
      NOTION_PAGE_IDS.map((id) => getNotionPageContent(id))
    );
    const notionContext = pageContents.join("\n\n---\n\n");

    if (!notionContext.trim()) {
      return "I'm unable to find this information in the current Health Plan resources. Please ask your question in #ask-healthplan so the team can provide additional support.";
    }

    // Call Claude API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: `You are a helpful health plan assistant for Vitable. You answer employee questions about their health plan benefits based ONLY on the provided Notion documentation below.

Be friendly, clear, and concise. If the answer is not found in the documentation, respond with exactly: "I'm unable to find this information in the current Health Plan resources. Please ask your question in #ask-healthplan so the team can provide additional support."

Do not make up or assume any information not explicitly stated in the documentation.

Here is the health plan documentation:
---
${notionContext}
---`,
        messages: [{ role: "user", content: question }],
      }),
    });

    const data = await response.json();
    return (
      data.content?.[0]?.text ||
      "I'm unable to find this information in the current Health Plan resources. Please ask your question in #ask-healthplan so the team can provide additional support."
    );
  } catch (err) {
    console.error("Error calling Claude:", err);
    return "I'm unable to find this information in the current Health Plan resources. Please ask your question in #ask-healthplan so the team can provide additional support.";
  }
}

// ============================================================
// POST MESSAGE TO SLACK
// ============================================================
async function postToSlack(channel, text, threadTs) {
  const body = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

// ============================================================
// MAIN SLACK ENDPOINT
// ============================================================
app.post("/slack/events", async (req, res) => {
  // Handle Slack's URL verification challenge
  if (req.body.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify the request is from Slack
  // (uncomment the lines below once everything is working)
  // if (!verifySlackRequest(req)) {
  //   return res.status(401).send("Unauthorized");
  // }

  // Acknowledge Slack immediately (Slack requires a response within 3 seconds)
  res.status(200).send();

  const event = req.body.event;
  if (!event) return;

  // Only respond to app mentions
  if (event.type !== "app_mention") return;

  // Don't respond to bot messages
  if (event.bot_id) return;

  const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!question) return;

  console.log(`Question received: ${question}`);

  // Post a "thinking" message so the user knows the bot is working
  await postToSlack(
    event.channel,
    "Let me check the health plan resources for you... :mag:",
    event.thread_ts || event.ts
  );

  // Get the answer from Claude
  const answer = await askClaude(question);

  // Post the answer back in the thread
  await postToSlack(
    event.channel,
    answer,
    event.thread_ts || event.ts
  );
});

// ============================================================
// HEALTH CHECK (so Render knows the server is running)
// ============================================================
app.get("/", (req, res) => {
  res.send("Health Plan Bot is running!");
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Health Plan Bot server running on port ${PORT}`);
});
