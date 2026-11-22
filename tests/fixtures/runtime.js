import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const get = name => args[args.indexOf(name) + 1];
const key = process.env.OMLX_API_KEY || process.env.LLAMA_API_KEY;
const omlx = args[0] === 'serve';
let model;
let statusRequests = 0;
if (omlx) {
  if (args.includes('--pin')) throw Error('unrecognized arguments: --pin');
  const settings = JSON.parse(await fs.readFile(path.join(get('--base-path'), 'model_settings.json')));
  model = Object.keys(settings.models).find(id => settings.models[id].is_pinned);
} else model = get('--alias');
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + key) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (omlx && req.url === '/v1/models/status') {
    statusRequests++;
    res.end(JSON.stringify({ models: [{ id: model, pinned: true, loaded: statusRequests > 1 }] }));
  } else if (req.url === '/fixture/status-requests') {
    res.end(JSON.stringify(statusRequests));
  } else if (req.url === '/v1/models') {
    res.end(JSON.stringify({ data: [{ id: model }] }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(Number(get('--port')), get('--host'));
