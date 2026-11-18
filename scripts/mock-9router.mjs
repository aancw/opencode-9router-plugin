#!/usr/bin/env node
// Minimal mock of a 9router /models endpoint for local development.
// Usage: npm run mock   (listens on http://localhost:20128/v1/models)

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT || 20128);
const BASE_PATH = "/v1";

const MODELS = [
  "gpt-5.2",
  "claude-sonnet-4.5",
  "gemini-2.5-pro",
  "deepseek-v3.2",
];

const payload = {
  object: "list",
  data: MODELS.map((id) => ({
    id,
    object: "model",
    created: 1727000000,
    owned_by: "9router",
  })),
};

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (req.method === "GET" && (path === `${BASE_PATH}/models` || path === "/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === "GET" && (path === `${BASE_PATH}/model` || path === "/model")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: MODELS[0], models: MODELS }));
    return;
  }

  if (req.method === "POST" && path === `${BASE_PATH}/chat/completions`) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
      console.log(`[chat] model=${body.model} reasoning_effort=${body.reasoning_effort ?? "-"} temperature=${body.temperature ?? "-"}`);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const chunk = (delta) =>
        res.write(`data: ${JSON.stringify({
          id: "mock-1",
          object: "chat.completion.chunk",
          created: 1727000000,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
      chunk({ role: "assistant" });
      chunk({ content: "mock reply" });
      res.write(`data: ${JSON.stringify({
        id: "mock-1",
        object: "chat.completion.chunk",
        created: 1727000000,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Not found: ${path}` } }));
});

server.listen(PORT, () => {
  console.log(`mock 9router listening on http://localhost:${PORT}${BASE_PATH}`);
  console.log(`models: ${MODELS.join(", ")}`);
  console.log(`try: OPENCODE_9ROUTER_URL=http://localhost:${PORT}${BASE_PATH} opencode models 9router`);
});
