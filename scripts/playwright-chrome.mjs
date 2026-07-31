export function playwrightChromeLaunchOptions(overrides = {}) {
  const executablePath = process.env.BROWSER_PILOT_TEST_CHROME_EXECUTABLE;
  return {
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    headless: true,
    ...overrides,
  };
}
