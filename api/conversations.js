import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT * FROM public.conversations
      ORDER BY updated_at DESC
      LIMIT 100
    `;

    return res.status(200).json({
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        messages: typeof r.messages === 'string' ? JSON.parse(r.messages) : r.messages || [],
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM public.conversations WHERE id = ${req.body.id}`;
    return res.status(200).json({ ok: true });
  }

  const conv = req.body;

  await sql`
    INSERT INTO public.conversations (id, title, messages, created_at, updated_at)
    VALUES (${conv.id}, ${conv.title}, ${JSON.stringify(conv.messages)}, ${conv.created_at}, ${conv.updated_at})
    ON CONFLICT (id) DO UPDATE SET
      title = ${conv.title},
      messages = ${JSON.stringify(conv.messages)},
      updated_at = ${conv.updated_at}
  `;

  res.status(200).json({ ok: true });
}
