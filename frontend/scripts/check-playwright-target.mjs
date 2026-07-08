const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5174";

async function main() {
  let response;
  try {
    response = await fetch(baseURL, { redirect: "follow" });
  } catch (error) {
    console.error(`[e2e preflight] Cannot reach ${baseURL}`);
    console.error("[e2e preflight] Start the local frontend/backend launchers first, or set PLAYWRIGHT_BASE_URL.");
    console.error(`[e2e preflight] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`[e2e preflight] ${baseURL} returned HTTP ${response.status}`);
    process.exit(1);
  }

  const body = await response.text();
  if (!body.includes("root") && !body.includes("/src/")) {
    console.error(`[e2e preflight] ${baseURL} does not look like the Vite frontend target.`);
    process.exit(1);
  }
}

await main();
