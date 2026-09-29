// ============================================================
// Docs content loader (server only).
//
// The Markdown files in /docs remain the source of truth for API
// behaviour — this only reads and structures them for display.
//   docs/public-api.md      → /docs
//   docs/api-campaigns.md   → /docs/api-campaigns[/{id}]
//   docs/ai-assistant.md    → /docs/ai-assistant
//
// next.config.ts lists these files in `outputFileTracingIncludes` so
// they are present in the Docker/standalone build.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

import {
  extractToc,
  firstTitle,
  parseMarkdown,
  type Block,
  type TocItem,
} from '@/lib/docs/markdown';

export type DocKey = 'reference' | 'api-campaigns' | 'ai-assistant';

export interface DocPageMeta {
  key: DocKey;
  href: string;
  file: string;
  label: string;
}

export const DOC_PAGES: DocPageMeta[] = [
  { key: 'reference', href: '/docs', file: 'public-api.md', label: 'API Reference' },
  { key: 'api-campaigns', href: '/docs/api-campaigns', file: 'api-campaigns.md', label: 'API Campaigns' },
  { key: 'ai-assistant', href: '/docs/ai-assistant', file: 'ai-assistant.md', label: 'AI Assistant' },
];

export interface LoadedDoc {
  key: DocKey;
  href: string;
  label: string;
  title: string;
  blocks: Block[];
  toc: TocItem[];
}

export function loadDoc(key: DocKey, vars: Record<string, string> = {}): LoadedDoc | null {
  const meta = DOC_PAGES.find((p) => p.key === key)!;
  try {
    let md = fs.readFileSync(path.join(process.cwd(), 'docs', meta.file), 'utf8');
    for (const [k, v] of Object.entries(vars)) md = md.split(k).join(v);
    const blocks = parseMarkdown(md);
    return {
      key,
      href: meta.href,
      label: meta.label,
      title: firstTitle(blocks, meta.label),
      blocks,
      toc: extractToc(blocks),
    };
  } catch (err) {
    console.error(`[docs] failed to load ${meta.file}:`, err);
    return null;
  }
}

export interface NavGroup {
  key: DocKey;
  href: string;
  label: string;
  sections: { id: string; text: string }[];
}

/** Sidebar structure: one group per doc, its h2 sections as items. */
export function loadNav(): NavGroup[] {
  return DOC_PAGES.map((meta) => {
    const doc = loadDoc(meta.key);
    return {
      key: meta.key,
      href: meta.href,
      label: meta.label,
      sections: (doc?.toc ?? [])
        .filter((t) => t.level === 2)
        .map((t) => ({ id: t.id, text: t.text })),
    };
  });
}