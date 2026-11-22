import http from 'node:http';
const args = process.argv.slice(2);
const get = name => args[args.indexOf(name) + 1];
const key = process.env.OMLX_API_KEY || process.env.LLAMA_API_KEY;
const model = args.includes('--pin') ? get('--pin') : get('--alias');
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + key) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.url !== '/v1/models') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.end(JSON.stringify({ data: [{ id: model }] }));
});
server.listen(Number(get('--port')), get('--host'));
