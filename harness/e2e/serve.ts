// Serves the repository root, so the mockup can load seed data from harness/seed/out
const root = new URL('../../', import.meta.url).pathname;
const server = Bun.serve({
  port: Number(process.env.PORT ?? 4510),
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.includes('..')) return new Response('bad path', { status: 400 });
    const file = Bun.file(root + path.slice(1));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});
console.log(`serving ${root} on ${server.url}`);
