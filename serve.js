const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const file = path.join('g:', 'DreamPatrol', 'Files', 'dimilinks-image-demo.html');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Server started at http://127.0.0.1:' + PORT);
});
