export class Lobby {
  state: DurableObjectState;
  sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState, _env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      this.sockets.add(server);
      server.send(JSON.stringify({ type: 'onlineCount', count: this.sockets.size }));
      this.broadcastCount();
      server.addEventListener('close', () => {
        this.sockets.delete(server);
        this.broadcastCount();
      });
      server.addEventListener('message', () => { /* ping等は無視 */ });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname.endsWith('/count')) {
      return Response.json({ count: this.sockets.size });
    }
    return new Response('not found', { status: 404 });
  }

  broadcastCount() {
    const payload = JSON.stringify({ type: 'onlineCount', count: this.sockets.size });
    for (const ws of this.sockets) ws.send(payload);
  }
}
