export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.WALLET_INTEL_AUTOSTART === "1") {
    const { intelligenceService } = await import("./lib/wallet-intelligence-service");
    intelligenceService().start();
  }
}
