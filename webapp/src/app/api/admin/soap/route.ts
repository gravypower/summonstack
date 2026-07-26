import { errorResponse, HttpError, requireAdmin } from "@/lib/auth";
import { soapCommand } from "@/lib/soap";

export async function POST(req: Request): Promise<Response> {
  try {
    await requireAdmin();
    const { command } = await req.json();
    if (typeof command !== "string" || !command.trim()) {
      throw new HttpError(400, "Command is required.");
    }
    const result = await soapCommand(command.trim());
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
