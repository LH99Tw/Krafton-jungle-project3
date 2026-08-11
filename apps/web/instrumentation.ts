export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const { validateProductionWebEnvironment } = await import("./instrumentation-node");
  try {
    validateProductionWebEnvironment();
  } catch (error) {
    console.error(JSON.stringify({
      level: "fatal",
      event: "web.runtime.invalid",
      error: error instanceof Error ? error.message : "invalid production environment",
    }));
    process.exit(1);
  }
}
