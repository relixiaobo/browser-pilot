const INTERNAL_ROLE_PREFIX = '--browser-pilot-internal=';

async function start(): Promise<void> {
  const roleArgument = process.argv[2];
  if (roleArgument?.startsWith(INTERNAL_ROLE_PREFIX)) {
    process.argv.splice(2, 1);
    const role = roleArgument.slice(INTERNAL_ROLE_PREFIX.length);
    if (role === 'daemon') {
      await import('./daemon.js');
      return;
    }
    if (role === 'janitor') {
      await import('./managed-target-janitor.js');
      return;
    }
    throw new Error('Invalid Browser Pilot internal process role');
  }
  await import('./cli.js');
}

void start().catch(error => {
  process.stderr.write(`Browser Pilot startup error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
