import { loadDoc } from '@/lib/docs/content';
import { DocPage, DocUnavailable } from '@/components/docs/doc-page';

export const metadata = { title: 'AI Assistant' };

export default function AiAssistantDocsPage() {
  const doc = loadDoc('ai-assistant');
  if (!doc) return <DocUnavailable />;
  return (
    <DocPage
      doc={doc}
      basePath="/docs/ai-assistant"
      crumbs={[{ label: 'Docs', href: '/docs' }, { label: 'AI Assistant' }]}
    />
  );
}