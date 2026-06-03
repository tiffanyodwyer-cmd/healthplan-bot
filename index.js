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

// Regular Notion page IDs
const NOTION_PAGE_IDS = [
  "34ae86878fe681499cc1dc8a63036574",
  "34ae86878fe6805b8a75dd819e812662",
  "27ee86878fe6800fbd40fa044f862fb1",
  "2afe86878fe6805685dcfe9630d46a63",
  "1cbe86878fe6807883f0f0bf5494c460",
];

// Resource database ID (the table with Name, Permalink, Product, etc.)
const RESOURCE_DATABASE_ID = "255e86878fe680e38636de4a7c818077";

// Q&A Knowledge Base database ID
const QA_DATABASE_ID = "373e86878fe6809892d5e315d18d55c5";

// Slack channel ID for #ask-healthplan
const ASK_HEALTHPLAN_CHANNEL_ID = "C0AKN556FME";

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
// FETCH REGULAR NOTION PAGE CONTENT
// ============================================================
async function getNotionPageContent(pageId) {
  try {
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

    let content = "";
    for (const block of data.results) {
      const type = block.type;
      const blockData = block[type];

      if (blockData?.rich_text) {
        const text = blockData.rich_text.map((t) => t.plain_text).join("");
        if (text.trim()) content += text + "\n";
      }

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
// FETCH RESOURCE DATABASE (the table with permalinks)
// ============================================================
async function getResourceDatabase() {
  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${RESOURCE_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 100 }),
      }
    );

    const data = await response.json();
    if (!data.results) return [];

    return data.results.map((row) => {
      const props = row.properties;

      const name =
        props.Name?.title?.map((t) => t.plain_text).join("") || "";
      const description =
        props.Description?.rich_text?.map((t) => t.plain_text).join("") || "";
      const permalink =
        props.Permalink?.url ||
        props.Permalink?.rich_text?.map((t) => t.plain_text).join("") ||
        "";
      const product =
        props.Product?.select?.name ||
        props.Product?.multi_select?.map((s) => s.name).join(", ") ||
        props.Product?.rich_text?.map((t) => t.plain_text).join("") ||
        "";
      const audience =
        props.Audience?.select?.name ||
        props.Audience?.multi_select?.map((s) => s.name).join(", ") ||
        props.Audience?.rich_text?.map((t) => t.plain_text).join("") ||
        "";
      const contentType =
        props["Content Type"]?.select?.name ||
        props["Content Type"]?.rich_text?.map((t) => t.plain_text).join("") ||
        "";

      return { name, description, permalink, product, audience, contentType };
    }).filter((row) => row.name);
  } catch (err) {
    console.error("Error fetching resource database:", err);
    return [];
  }
}

// ============================================================
// ASK CLAUDE WITH NOTION CONTEXT + RESOURCE DATABASE
// ============================================================
async function askClaude(question) {
  try {
    console.log("Fetching Notion pages and resource database...");

    const [pageContents, resources] = await Promise.all([
      Promise.all(NOTION_PAGE_IDS.map((id) => getNotionPageContent(id))),
      getResourceDatabase(),
    ]);

    const notionContext = pageContents.join("\n\n---\n\n");

    const resourceContext =
      resources.length > 0
        ? resources
            .map(
              (r) =>
                `Name: ${r.name}${r.product ? ` | Product: ${r.product}` : ""}${r.audience ? ` | Audience: ${r.audience}` : ""}${r.contentType ? ` | Type: ${r.contentType}` : ""}${r.description ? `\nDescription: ${r.description}` : ""}${r.permalink ? `\nPermalink: ${r.permalink}` : ""}`
            )
            .join("\n\n")
        : "";

    if (!notionContext.trim() && !resourceContext.trim()) {
      return "I'm unable to find this information in the current Health Plan resources. Please ask your question in #ask-healthplan so the team can provide additional support.";
    }

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
        system: `You are a helpful health plan assistant for Vitable. You answer employee questions about their health plan benefits based ONLY on the provided documentation below.

You have access to two types of content:
1. FAQ and health plan documentation (for answering benefit questions)
2. A resource library with permalinks (for when someone asks where to find a specific resource, one-pager, guide, or document)

When someone asks where to find a resource (e.g. "where can I find a one-pager for VPC"), search the resource library and return the matching resource name and its permalink as a clickable link.

When someone asks a health plan question, answer it from the FAQ documentation.

Be friendly, clear, and concise. If the answer is not found in the documentation, respond with exactly: "I'm unable to find this information in the current Health Plan resources. Please ask your question in #ask-healthplan so the team can provide additional support."

Do not make up or assume any information not explicitly stated in the documentation.

--- HEALTH PLAN FAQ DOCUMENTATION ---
${notionContext}

--- RESOURCE LIBRARY (use for permalink lookups) ---
${resourceContext}`,
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
// SAVE Q&A TO NOTION DATABASE
// ============================================================
async function saveQAToNotion(question, answer, threadLink, date) {
  try {
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: QA_DATABASE_ID },
        properties: {
          Question: {
            title: [{ text: { content: question } }],
          },
          Answer: {
            rich_text: [{ text: { content: answer } }],
          },
          Date: {
            date: { start: date },
          },
          "Slack Thread Link": {
            url: threadLink,
          },
        },
      }),
    });
    console.log(`Saved Q&A to Notion: ${question.substring(0, 50)}...`);
  } catch (err) {
    console.error("Error saving Q&A to Notion:", err);
  }
}

// ============================================================
// FETCH SLACK THREAD REPLIES
// ============================================================
async function getThreadReplies(channelId, threadTs) {
  try {
    const response = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}`,
      {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      }
    );
    const data = await response.json();
    return data.messages || [];
  } catch (err) {
    console.error("Error fetching thread replies:", err);
    return [];
  }
}

// ============================================================
// CHECK FOR ✅ REACTION ON A MESSAGE
// ============================================================
async function hasCheckmarkReaction(channelId, messageTs) {
  try {
    const response = await fetch(
      `https://slack.com/api/reactions.get?channel=${channelId}&timestamp=${messageTs}`,
      {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      }
    );
    const data = await response.json();
    const reactions = data.message?.reactions || [];
    return reactions.some((r) => r.name === "white_check_mark");
  } catch (err) {
    console.error("Error fetching reactions:", err);
    return false;
  }
}

// ============================================================
// DAILY TASK: SCAN #ASK-HEALTHPLAN AND SAVE ANSWERED Q&As
// ============================================================
async function runDailyQASync() {
  console.log("Running daily Q&A sync...");

  try {
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

    const response = await fetch(
      `https://slack.com/api/conversations.history?channel=${ASK_HEALTHPLAN_CHANNEL_ID}&oldest=${oneDayAgo}&limit=100`,
      {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      }
    );

    const data = await response.json();
    if (!data.ok || !data.messages) {
      console.error("Error fetching Slack messages:", data.error);
      return;
    }

    // Only look at messages from the Linear Asks bot
    const linearMessages = data.messages.filter(
      (msg) => msg.subtype === "bot_message" && msg.bot_profile?.name === "Linear Asks"
    );

    console.log(`Found ${linearMessages.length} Linear Asks messages to check`);

    for (const msg of linearMessages) {
      // Check if the original message has a ✅ reaction
      const isAnswered = await hasCheckmarkReaction(ASK_HEALTHPLAN_CHANNEL_ID, msg.ts);
      if (!isAnswered) continue;

      // Get the thread replies to find the answer
      const replies = await getThreadReplies(ASK_HEALTHPLAN_CHANNEL_ID, msg.ts);
      if (replies.length < 2) continue;

      // The question comes from the Linear Asks message text or attachment title
      const question = msg.text || msg.attachments?.[0]?.title || "Unknown question";

      // Combine all human replies as the answer
      const answerReplies = replies
        .slice(1)
        .filter((r) => !r.bot_id)
        .map((r) => r.text)
        .join("\n\n");

      if (!answerReplies) continue;

      // Build a link to the Slack thread
      const threadLink = `https://vitable.slack.com/archives/${ASK_HEALTHPLAN_CHANNEL_ID}/p${msg.ts.replace(".", "")}`;

      // Save to Notion
      const date = new Date(parseFloat(msg.ts) * 1000).toISOString().split("T")[0];
      await saveQAToNotion(question, answerReplies, threadLink, date);
    }

    console.log("Daily Q&A sync complete!");
  } catch (err) {
    console.error("Error during daily Q&A sync:", err);
  }
}

// ============================================================
// SCHEDULE DAILY TASK AT 3PM PST (11pm UTC)
// ============================================================
function scheduleDailySync() {
  const now = new Date();

  // 3pm PST = 11pm UTC (UTC-8 standard time)
  const nextRun = new Date();
  nextRun.setUTCHours(23, 0, 0, 0);

  // If 11pm UTC has already passed today, schedule for tomorrow
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  const msUntilNextRun = nextRun - now;
  console.log(`Next Q&A sync scheduled in ${Math.round(msUntilNextRun / 1000 / 60)} minutes`);

  setTimeout(() => {
    runDailyQASync();
    // After first run, repeat every 24 hours
    setInterval(runDailyQASync, 24 * 60 * 60 * 1000);
  }, msUntilNextRun);
}

// ============================================================
// MAIN SLACK ENDPOINT
// ============================================================
app.post("/slack/events", async (req, res) => {
  if (req.body.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  // if (!verifySlackRequest(req)) {
  //   return res.status(401).send("Unauthorized");
  // }

  res.status(200).send();

  const event = req.body.event;
  if (!event) return;

  if (event.type !== "app_mention") return;
  if (event.bot_id) return;

  const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!question) return;

  console.log(`Question received: ${question}`);

  await postToSlack(
    event.channel,
    "Let me check the health plan resources for you... :mag:",
    event.thread_ts || event.ts
  );

  const answer = await askClaude(question);

  await postToSlack(
    event.channel,
    answer,
    event.thread_ts || event.ts
  );
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => {
  res.send("Health Plan Bot is running!");
});

// ============================================================
// START SERVER + DAILY SYNC
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Health Plan Bot server running on port ${PORT}`);
  scheduleDailySync();
});
