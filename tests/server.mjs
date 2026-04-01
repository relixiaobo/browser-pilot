// Test fixture server — deterministic HTML pages for browser-pilot tests
import http from 'node:http';

const PORT = parseInt(process.argv[2] || '18273', 10);

const PAGES = {
  '/': `<title>BP Test Page</title>
<a href="/page2" id="link1">Go to Page 2</a>
<button id="btn1" onclick="document.getElementById('output').textContent='clicked'">Click Me</button>
<input type="text" id="input1" aria-label="Name" value="">
<input type="text" id="input2" aria-label="Email" value="old@test.com">
<textarea id="textarea1" aria-label="Notes"></textarea>
<input type="checkbox" id="check1" aria-label="Agree">
<form id="form1" onsubmit="event.preventDefault();document.getElementById('output').textContent='submitted'">
  <input type="text" id="search" aria-label="Search">
  <button type="submit">Submit</button>
</form>
<div id="output"></div>`,

  '/page2': `<title>Page 2</title><h1>Page Two</h1><a href="/">Back</a>`,

  '/dialog': `<title>Dialog Page</title><script>alert('test dialog')</script><p>After alert</p>`,

  '/confirm': `<title>Confirm Page</title>
<button id="cfm" onclick="document.getElementById('r').textContent=confirm('sure?')?'yes':'no'">Confirm</button>
<div id="r"></div>`,

  '/popup': `<title>Popup Page</title><a href="/popup-target" target="_blank" id="poplink">Open Popup</a>`,

  '/popup-target': `<title>Popup Target</title><h1>I am the popup</h1>`,

  '/iframe-host': `<title>Iframe Host</title><h1>Host</h1><iframe src="/iframe-content" width="400" height="200"></iframe>`,

  '/iframe-content': `<title>Iframe Content</title><h1>Inside Frame</h1><button id="ibtn">Inner Button</button>`,

  '/upload': `<title>Upload Page</title>
<input type="file" id="f1" name="file1" aria-label="File 1">
<input type="file" id="f2" name="file2" aria-label="File 2">
<div id="result"></div>
<script>document.getElementById('f1').onchange=e=>document.getElementById('result').textContent='uploaded:'+e.target.files[0].name</script>`,

  '/empty': `<title>Empty Page</title><div>No interactive elements here.</div>`,

  '/many': `<title>Many Elements</title>${Array.from({length:100},(_,i)=>`<button>Btn ${i+1}</button>`).join('\n')}`,
};

const server = http.createServer((req, res) => {
  const path = req.url?.split('?')[0] || '/';

  // Auth-protected route
  if (path === '/auth-check') {
    const auth = req.headers.authorization;
    if (auth === 'Basic ' + Buffer.from('admin:secret123').toString('base64')) {
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end('<title>Auth OK</title><p>Authenticated</p>');
    } else {
      res.writeHead(401, {'WWW-Authenticate':'Basic realm="test"','Content-Type':'text/html'});
      res.end('<title>401</title><p>Unauthorized</p>');
    }
    return;
  }

  // API route for mock testing
  if (path === '/api/data') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end('{"real":true}');
    return;
  }

  const html = PAGES[path];
  if (html) {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Test server on http://127.0.0.1:${PORT}`);
});
