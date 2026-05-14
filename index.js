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

    // Extract Name, Description, Product, Audience, and Permalink from each row
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

    // Fetch regular pages and resource database in parallel
    const [pageContents, resources] = await Promise.all([
      Promise.all(NOTION_PAGE_IDS.map((id) => getNotionPageContent(id))),
      getResourceDatabase(),
    ]);

    const notionContext = pageContents.join("\n\n---\n\n");

    // Format resource database as readable text for Claude
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
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Health Plan Bot server running on port ${PORT}`);
});
