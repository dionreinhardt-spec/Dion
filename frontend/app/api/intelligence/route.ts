import { intelligenceService } from "../../../lib/wallet-intelligence-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const service = intelligenceService();
  service.start();
  return Response.json(service.snapshot(), { headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
}
