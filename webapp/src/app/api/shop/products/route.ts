import { errorResponse, requireSession } from "@/lib/auth";
import { listPackInfo, listProducts } from "@/lib/shop";

export async function GET(): Promise<Response> {
  try {
    await requireSession();
    const [products, packInfo] = await Promise.all([
      listProducts(),
      listPackInfo(),
    ]);
    return Response.json({
      products: products.map((p) => {
        const payload =
          typeof p.payload === "string" ? JSON.parse(p.payload) : p.payload;
        const pack =
          p.delivery_type === "item_pack" ? String(payload.pack ?? "") : null;
        return {
          slug: p.slug,
          name: p.name,
          description: p.description,
          price: p.price,
          deliveryType: p.delivery_type,
          boostLevel:
            p.delivery_type === "level_boost"
              ? Number(payload.level) || null
              : null,
          pack,
          minLevel: pack ? packInfo[pack]?.minLevel ?? null : null,
          specsByClass: pack ? packInfo[pack]?.specsByClass ?? {} : null,
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
