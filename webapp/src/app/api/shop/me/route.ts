import { errorResponse, requireSession } from "@/lib/auth";
import { getBalance, listCharacters } from "@/lib/shop";

export async function GET(): Promise<Response> {
  try {
    const session = await requireSession();
    const [balance, characters] = await Promise.all([
      getBalance(session.accountId),
      listCharacters(session.accountId),
    ]);
    return Response.json({
      balance,
      characters: characters.map((c) => ({
        guid: c.guid,
        name: c.name,
        race: c.race,
        class: c.class,
        level: c.level,
        // The shop UI uses this to warn profession-boost buyers to log out.
        online: c.online !== 0,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
