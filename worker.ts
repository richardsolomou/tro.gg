// Edge entry for the client. Redirects www.tro.gg → tro.gg so the game only
// ever loads from the apex origin (the server's CLIENT_ORIGIN is a single
// value; a second origin would fail the WebSocket handshake). Every other
// request is served from the static build.
export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.tro.gg") {
      url.hostname = "tro.gg";
      return Response.redirect(url.toString(), 301);
    }
    // The client polls /version.json to spot a freshly-deployed frontend; serve it
    // uncached so the poll reflects the live deploy the moment it lands, not a copy
    // the edge or browser held onto.
    if (url.pathname === "/version.json") {
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }
    return env.ASSETS.fetch(request);
  },
};
