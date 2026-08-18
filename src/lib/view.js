import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import * as fmt from './money.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');
export const eta = new Eta({
  views: dir,
  cache: process.env.NODE_ENV === 'production',
  autoEscape: true,     // <%= %> escapes, <%~ %> is raw
  rmWhitespace: false,
});

/* render(c, 'pages/home', {...}) — brand + user + csrf + recaptcha are always present
   so no template has to remember to pass them. */
export function render(c, template, data = {}) {
  const user = c.get('user');
  const html = eta.render(template, {
    ...fmt,
    ...data,
    user,
    csrf: c.get('csrf'),
    path: c.req.path,
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
    brand: {
      name: process.env.BRAND_NAME || 'Marketedge',
      domain: process.env.BRAND_DOMAIN || 'marketedge.com',
      year: new Date().getFullYear(),
    },
  });
  return c.html(html);
}

export function partial(c, template, data = {}) {
  return c.html(eta.render(template, {
    ...fmt,
    ...data,
    user: c.get('user'),
    csrf: c.get('csrf'),
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
  }));
}
