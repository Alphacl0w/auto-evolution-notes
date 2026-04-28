import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

const postModules = import.meta.glob('/src/content/posts/**/*.md');

export async function getPublishedPosts() {
  if (Object.keys(postModules).length === 0) {
    return [];
  }

  const posts = await getCollection('posts', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export function postUrl(post: Post) {
  return `/articles/${post.slug}/`;
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function archiveLabel(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
  }).format(date);
}

export function termUrl(base: 'categories' | 'tags', term: string) {
  return `/${base}/${encodeURIComponent(term)}/`;
}

export function collectTerms(posts: Post[], selector: (post: Post) => string | string[]) {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const raw = selector(post);
    const terms = Array.isArray(raw) ? raw : [raw];
    for (const term of terms) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, 'zh-CN'));
}
