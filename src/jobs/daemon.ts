import { startController } from "./controller.ts";

const controller = await startController();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await controller.stop();
  process.exit(0);
};

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
