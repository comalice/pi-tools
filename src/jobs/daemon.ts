import { startController } from "./controller.ts";

const controller = await startController();

const shutdown = async () => {
  await controller.stop();
  process.exit(0);
};

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
