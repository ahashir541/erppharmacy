// Writes the header, footer and blog cards into every page's HTML, so search engines and slow phones get
// them at once (script.js only adds behaviour on top). Uses the same templates and SITE settings as
// script.js. Run after changing script.js or a page:  node prerender.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'script.js'), 'utf8');
const cut = src.indexOf("\nconst headerSlot = document.getElementById('header-slot')");
if (cut < 0) throw new Error('script.js: the header-slot line was not found');
// eslint-disable-next-line no-new-func
const { header, footer, POSTS, SITE } = new Function(`${src.slice(0, cut)}\nreturn { header, footer, POSTS, SITE };`)();

/** What script.js's hideEmpty() would do, done once here: empty settings are hidden in the HTML. */
const settle = (html) => html
  .replace(/<li data-needs="(\w+)">/g, (m, k) => (SITE[k] ? m : `<li data-needs="${k}" hidden>`))
  .replace(/<p data-needs-social([^>]*)>\s*<\/p>/g, '<p data-needs-social$1 hidden></p>');

const cards = (limit) => POSTS.slice(0, limit).map((p) => `
    <a class="post" href="${p.href}"><div class="pcard"><img class="pbg" src="${p.img}" alt="${p.title}" width="640" height="400" loading="lazy" decoding="async"><span class="ptag">${p.cats[0]}</span>
      <div class="ptitle" aria-hidden="true"><span class="pe">${p.eyebrow}</span> <b class="l1">${p.l1}</b> <b class="l2">${p.l2}</b> <span class="pbox">${p.box}</span></div></div>
      <div class="body"><div class="cats">${p.cats.map((c) => `<span>${c}</span>`).join('')}</div><h3>${p.title}</h3><p>${p.excerpt}</p><span class="more">Learn more →</span></div></a>`).join('');

const block = (name, html) => `<!--nuskha:${name}-->${html}\n<!--/nuskha:${name}-->`;
const put = (page, name, html, slot) => {
  const marked = new RegExp(`<!--nuskha:${name}-->[\\s\\S]*?<!--/nuskha:${name}-->`);
  if (marked.test(page)) return page.replace(marked, block(name, html));
  if (!page.includes(slot)) return page;
  return page.replace(slot, block(name, html));
};

const pages = [...fs.readdirSync(here).filter((f) => f.endsWith('.html')), ...fs.readdirSync(path.join(here, 'blog')).filter((f) => f.endsWith('.html')).map((f) => `blog/${f}`)];
for (const rel of pages) {
  const file = path.join(here, rel);
  let html = fs.readFileSync(file, 'utf8');
  html = put(html, 'header', settle(header()), '<div id="header-slot"></div>');
  html = put(html, 'footer', settle(footer()), '<div id="footer-slot"></div>');
  const posts = /<div class="posts" id="posts"(?: data-limit="(\d+)")?>/.exec(html);
  if (posts) {
    const filled = block('posts', cards(Number(posts[1]) || POSTS.length));
    const marked = /<!--nuskha:posts-->[\s\S]*?<!--\/nuskha:posts-->/;
    if (marked.test(html)) html = html.replace(marked, filled);
    else html = html.replace(`${posts[0]}</div>`, `${posts[0]}${filled}</div>`);
  }
  fs.writeFileSync(file, html);
  console.log('prerendered', rel);
}
