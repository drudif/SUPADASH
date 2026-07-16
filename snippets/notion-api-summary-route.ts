// COLE EM: notion-clone/src/app/api/summary/route.ts
//
// Endpoint read-only pro Dash. Conta o total de páginas e devolve as 3 mais
// recentes no shape comum { title, url, createdAt, source }.
// Protegido por SUMMARY_TOKEN (mesmo valor do .env do dash).
import { NextResponse } from "next/server";
import { count, max, desc } from "drizzle-orm";
import { db } from "@/db";
import { pages } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = process.env.SUMMARY_TOKEN;
  if (token && req.headers.get("x-summary-token") !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const origin = new URL(req.url).origin;

  const [row] = await db
    .select({ total: count(), last: max(pages.updatedAt) })
    .from(pages);

  const rows = await db
    .select({ id: pages.id, title: pages.title, at: pages.updatedAt })
    .from(pages)
    .orderBy(desc(pages.updatedAt))
    .limit(3);

  const recent = rows.map((r) => ({
    title: r.title,
    url: `${origin}/page/${r.id}`,
    // updatedAt é timestamp_ms (Date) -> serializa como ISO.
    createdAt: r.at ? new Date(r.at).toISOString() : null,
    source: "notion",
  }));

  return NextResponse.json({
    count: row?.total ?? 0,
    label: "páginas",
    updatedAt: row?.last ? new Date(row.last).toISOString() : null,
    recent,
  });
}
