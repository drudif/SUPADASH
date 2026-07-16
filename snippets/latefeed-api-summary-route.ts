// COLE EM: portal-inputs/src/app/api/summary/route.ts
//
// Endpoint read-only pro Dash. Conta inputs pendentes (readAt IS NULL) e
// devolve os 3 mais recentes no shape comum { title, url, createdAt, source }.
// Protegido por SUMMARY_TOKEN (mesmo valor do .env do dash).
import { NextResponse } from "next/server";
import { count, isNull, max, desc } from "drizzle-orm";
import { db } from "@/db";
import { inputs } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = process.env.SUMMARY_TOKEN;
  if (token && req.headers.get("x-summary-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const origin = new URL(req.url).origin;

  const [row] = await db
    .select({ pending: count(), last: max(inputs.createdAt) })
    .from(inputs)
    .where(isNull(inputs.readAt));

  const rows = await db
    .select({ id: inputs.id, title: inputs.title, at: inputs.createdAt })
    .from(inputs)
    .where(isNull(inputs.readAt))
    .orderBy(desc(inputs.createdAt))
    .limit(3);

  // inputs pendentes aparecem no feed inline em "/", então o link cai na home.
  const recent = rows.map((r) => ({
    title: r.title,
    url: `${origin}/`,
    createdAt: r.at,
    source: "latefeed",
  }));

  return NextResponse.json({
    count: row?.pending ?? 0,
    label: "pendentes",
    updatedAt: row?.last ?? null,
    recent,
  });
}
