#!/usr/bin/env node

import { startStudioServer } from "./server.js";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";

const args = process.argv.slice(2);
let port = 3001;
let projectRoot = process.env.INKOS_PROJECT_ROOT || "/app/books";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
  }
}

async function ensureDir(dir: string) {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
  }
}

async function startAgentServer() {
  await ensureDir(projectRoot);
  
  const configPath = resolve(projectRoot, "inkos.json");
  const fs = await import("node:fs/promises");
  
  try {
    await fs.access(configPath);
  } catch {
    const defaultConfig = {
      name: "InkOS Agent",
      language: "zh",
      llm: {
        provider: "openai",
        model: "gpt-4",
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY || "",
        temperature: 0.7,
        maxTokens: 4000,
        stream: true
      },
      daemon: {
        enabled: false,
        maxConcurrentBooks: 1,
        chaptersPerCycle: 1,
        schedule: {
          radarCron: "0 */6 * * *",
          writeCron: "0 * * * *"
        },
        retryDelayMs: 60000,
        cooldownAfterChapterMs: 30000,
        maxChaptersPerDay: 24
      },
      notify: []
    };
    
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  console.log(`InkOS Agent API starting on http://localhost:${port}`);
  console.log(`Project root: ${projectRoot}`);
  
  await startStudioServer(projectRoot, port);
}

startAgentServer().catch((e) => {
  console.error("Failed to start agent server:", e);
  process.exit(1);
});
