import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { dracula } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Components } from 'react-markdown';
import { extractImages } from '../utils/format';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const codeStr = String(children).replace(/\n$/, '');

    if (match) {
      return (
        <SyntaxHighlighter
          style={dracula}
          language={match[1]}
          PreTag="div"
          customStyle={{ margin: 0, borderRadius: 8 }}
        >
          {codeStr}
        </SyntaxHighlighter>
      );
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export default function ChatMessage({ role, content, streaming }: ChatMessageProps) {
  const images = role === 'assistant' ? extractImages(content) : [];

  return (
    <div className={`chat-message ${role}`}>
      <div className="message-avatar">
        {role === 'assistant' ? 'AI' : 'U'}
      </div>

      <div className="message-body">
        {role === 'assistant' ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={components}
            >
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <div>{content}</div>
        )}

        {images.length > 0 &&
          images.map((url, i) => (
            <img
              key={i}
              src={url}
              alt={`生成图片 ${i + 1}`}
              className="message-image"
            />
          ))}

        {streaming && <span className="streaming-cursor" />}
      </div>
    </div>
  );
}
