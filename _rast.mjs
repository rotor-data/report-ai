import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const pdf = readFileSync('/tmp/verify.pdf');
const tenant_id = 'd74603ff-a69d-4f14-a412-b99375eee699';
const JWT_SECRET = process.env.JWT_SECRET;
const h = Buffer.from(JSON.stringify({alg:'HS256', typ:'JWT'})).toString('base64url');
const p = Buffer.from(JSON.stringify({tenant_id, sub: 'r', exp: Math.floor(Date.now()/1000) + 300})).toString('base64url');
const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
const token = `${h}.${p}.${sig}`;
const res = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/rasterize', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`},
  body: JSON.stringify({pdf_base64: pdf.toString('base64'), dpi: 100}),
});
const json = await res.json();
for (const pg of json.pages || []) writeFileSync(`/tmp/verify-${pg.page}.png`, Buffer.from(pg.png_base64, 'base64'));
console.error('saved', (json.pages || []).length, 'pages');
