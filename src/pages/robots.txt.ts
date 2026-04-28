import type { APIContext } from 'astro';
import { SITE } from '../site';

export function GET(context: APIContext) {
  const site = context.site?.toString().replace(/\/$/, '') || SITE.url;

  return new Response(
    [
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${site}/sitemap-index.xml`,
      `Sitemap: ${site}/rss.xml`,
      '',
      'Disallow: /drafts/',
      'Disallow: /private/',
    ].join('\n'),
    {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    },
  );
}
