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

async function clearStaleRunningJobs() {
  // If a scrape process crashes or hangs, jobs can be left in RUNNING forever.
  // Auto-fail stale RUNNING jobs so the worker can continue processing the queue.
  const staleMs = 1000 * 60 * 5; // 5 minutes
  const cutoff = new Date(Date.now() - staleMs);

  const stale = await prisma.scrapeJob.findMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: cutoff },
      completedAt: null,
    },
    select: { id: true },
    take: 20,
  });

  if (stale.length === 0) return;

  console.error(`[worker] found stale RUNNING jobs=${stale.length}, marking FAILED`);
  for (const job of stale) {
    await prisma.scrapeJob
      .update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          errorMessage: "stale RUNNING job auto-failed by worker (timeout)",
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
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
  await clearStaleRunningJobs().catch((error) => {
    console.error("[worker] clear stale jobs failed", error);
  });

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
