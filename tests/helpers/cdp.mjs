import { WebSocketServer } from 'ws';

export async function startCdpFixture(options = {}) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    autoPong: options.autoPong ?? true,
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('connection', socket => {
    options.onConnection?.(socket, server);
    socket.on('message', bytes => {
      const context = {
          message: JSON.parse(bytes.toString()),
          socket,
          server,
      };
      if (options.onMessage) {
        options.onMessage(context);
      } else if (context.message.id !== undefined) {
        socket.send(JSON.stringify({ id: context.message.id, result: {} }));
      }
    });
  });
  const port = server.address().port;
  return {
    server,
    port,
    wsUrl: `ws://127.0.0.1:${port}${options.path ?? '/devtools/browser/test'}`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
