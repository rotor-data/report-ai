import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Synthetic chapter with prose long enough to span 2-3 PDF pages
const chapterHTML = `<section class="chapter" data-module-id="m1"><h1 data-unit="t">En månad in.</h1><p data-unit="byline">Fredrik Rozén — VD, Maj 2025</p>` + Array.from({length: 12}, (_, i) =>
  `<h2 data-unit="h${i}">Sektion ${i+1}</h2><p data-unit="p${i}a">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p><p data-unit="p${i}b">Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.</p>`
).join('') + `</section>`;

const units = [
  { unit_id: 't', type: 'heading', level: 1, text: 'En månad in. — VD-brev', order_index: 0 },
  { unit_id: 'byline', type: 'paragraph', text: 'Fredrik Rozén — VD, Maj 2025', order_index: 1 },
];
for (let i = 0; i < 12; i++) {
  units.push({ unit_id: `h${i}`, type: 'heading', level: 2, text: `Sektion ${i+1}`, order_index: 2+i*3 });
  units.push({ unit_id: `p${i}a`, type: 'paragraph', text: `Avsnitt ${i+1}, första stycket. Detta är en lång brödtextparagraf som flödar och fyller spalten — mer än en mening så vi får riktiga radbrytningar och en känsla av hur typografin skalas mot riktig prosa. Ord ord ord ord ord.`, order_index: 3+i*3 });
  units.push({ unit_id: `p${i}b`, type: 'paragraph', text: `Avsnitt ${i+1}, andra stycket. Här fortsätter texten med ytterligare resonemang som är meningsfullt långt.`, order_index: 4+i*3 });
}

const docCSS = `
:root { --mg-top: 25mm; --mg-inner: 25mm; --mg-outer: 20mm; --mg-bottom: 22mm; }
.chapter h1 { font-family: serif; font-size: 28pt; line-height: 1.1; margin: 0 0 6mm; }
.chapter h2 { font-family: sans-serif; font-size: 11pt; text-transform: uppercase; letter-spacing: 0.1em; color: #666; margin: 8mm 0 3mm; }
.chapter p { font-family: serif; font-size: 10.5pt; line-height: 1.6; margin: 0 0 4mm; }
.chapter [data-unit="byline"] { font-family: sans-serif; color: #999; font-size: 9pt; margin-bottom: 12mm; }
`;

const payload = {
  report_id: 'reflow-test',
  title: 'Reflow Smoke Test',
  mode: 'draft',
  page_format: 'a4_portrait',
  pages: [{
    id: randomUUID(), page_number: 1, page_type: 'chapter',
    modules: [{ module_type: 'freeform', order_index: 1, html_content: chapterHTML, html_cache: chapterHTML, content: {}, style: {}, background: null }],
  }],
  brand_tokens: {}, brand_fonts: [], brand_logos: [],
  document_css: docCSS, document_css_overrides: '', style_overrides: {},
  units,
};

const JWT_SECRET = process.env.JWT_SECRET;
const tenant_id = 'd74603ff-a69d-4f14-a412-b99375eee699';
const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const pp = Buffer.from(JSON.stringify({tenant_id, sub:'r', exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${pp}`).digest('base64url');
const token = `${h}.${pp}.${sig}`;

const res = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/pdf', {
  method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
  body:JSON.stringify(payload),
});
console.log('status:', res.status);
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync('/tmp/chapter-test.pdf', buf);
console.log('saved /tmp/chapter-test.pdf', buf.length, 'bytes');

const rast = await fetch('https://smyra-render-178695091452.europe-north1.run.app/render/rasterize', {
  method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
  body:JSON.stringify({pdf_base64:buf.toString('base64'), dpi:90}),
});
const j = await rast.json();
console.log('PDF pages:', (j.pages||[]).length);
for (const p of j.pages||[]) writeFileSync(`/tmp/chapter-${p.page}.png`, Buffer.from(p.png_base64, 'base64'));
