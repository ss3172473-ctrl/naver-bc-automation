import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { spawn } from "child_process";
import path from "path";

const prisma = new PrismaClient();
let lastCafeRefreshAt = 0;

function spawnScript(scriptFile: string, args: string[] = []) {
  const scriptPath = path.join(process.cwd(), "scripts", scriptFile);
  return spawn("npx", ["ts-node", "--project", "tsconfig.scripts.json", scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
  });
}

async function maybeRefreshCafes() {
  const intervalMs = 1000 * 60 * 60; // 1 hour
  const now = Date.now();
  if (now - lastCafeRefreshAt < intervalMs) return;
  lastCafeRefreshAt = now;

  console.log("[worker] refreshing joined cafes (hourly)");
  const child = spawnScript("refresh-cafes.ts");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

async function tick() {
  await maybeRefreshCafes().catch((error) => {
    console.error("[worker] refresh cafes failed", error);
  });

  const running = await prisma.scrapeJob.count({ where: { status: "RUNNING" } });
  if (running > 0) return;

  const nextJob = await prisma.scrapeJob.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });

  if (!nextJob) return;

  if (nextJob.jobType === "REFRESH_CAFES") {
    const child = spawnScript("refresh-cafes.ts");
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    await prisma.scrapeJob.update({
      where: { id: nextJob.id },
      data: { status: "SUCCESS", completedAt: new Date() },
    }).catch(() => undefined);
    return;
  }

  const child = spawnScript("scrape-job.ts", [nextJob.id]);

  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
}

async function main() {
  console.log("queue worker started");
  while (true) {
    await tick().catch((error) => {
      console.error("worker tick error", error);
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main().finally(async () => {
  await prisma.$disconnect();
});
