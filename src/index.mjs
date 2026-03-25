import createApp from './app.mjs';

async function main() {
  const app = await createApp();

  const shutdown = async (signal) => {
    await app.stop();
    console.log(`Stopped on ${signal}`);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.start();
  console.log(`ANITA bot service listening on port ${app.env.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
