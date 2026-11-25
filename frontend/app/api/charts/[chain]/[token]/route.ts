import { chartService } from "../../../../../lib/chart-service";
import { ChartError } from "../../../../../lib/coin-chart";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ chain: string; token: string }> }) {
  const headers = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
  try {
    const { chain, token } = await context.params;
    const data = await chartService.get(chain, token, new URL(request.url).searchParams.get("interval") ?? "1m");
    return Response.json(data, { headers });
  } catch (error) {
    const failure = error instanceof ChartError ? error : new ChartError(503, "Der Chart konnte momentan nicht geladen werden.");
    return Response.json({ error: failure.message, retryAfter: failure.retryAfter }, { status: failure.status, headers: { ...headers, "Retry-After": String(failure.retryAfter) } });
  }
}
