import { errorResponse, HttpError, requireAdmin } from "@/lib/auth";
import { soapCommand } from "@/lib/soap";

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const { command, realmId } = await req.json();
    if (typeof command !== "string" || !command.trim()) {
      throw new HttpError(400, "Command is required.");
    }
    const rId = typeof realmId === "number" ? realmId : undefined;
    const result = await soapCommand(command.trim(), rId);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
