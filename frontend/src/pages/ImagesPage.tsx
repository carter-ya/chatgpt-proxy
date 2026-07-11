import { useCallback, useState } from 'react';
import { chat, type FileAsset } from '../api/client';
import ChatMessage from '../components/ChatMessage';

function parseImageEvent(data: string, images: Map<string, FileAsset>): string {
  if (!data || data === '[DONE]') return '';
  try {
    const parsed = JSON.parse(data);
    for (const image of parsed.images || []) {
      if (image.file_id) images.set(image.file_id, image);
    }
    return parsed.conversation_id || '';
  } catch {
    return '';
  }
}

export default function ImagesPage() {
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<FileAsset[]>([]);
  const [reference, setReference] = useState<FileAsset | undefined>();
  const [selectedImage, setSelectedImage] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const generate = useCallback(async () => {
    const value = prompt.trim();
    if (!value || generating) return;
    setGenerating(true);
    setError('');
    setImages([]);
    setSelectedImage('');
    const controller = new AbortController();
    try {
      const response = await chat.generateImage(value, undefined, controller.signal, reference, conversationId);
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('图片生成没有返回流');
      const decoder = new TextDecoder();
      let buffer = '';
      const generated = new Map<string, FileAsset>();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const id = parseImageEvent(line.slice(6).trim(), generated);
            if (id) setConversationId(id);
          }
        }
        setImages(Array.from(generated.values()));
      }
      const remaining = buffer.trim();
      if (remaining.startsWith('data: ')) parseImageEvent(remaining.slice(6).trim(), generated);
      setImages(Array.from(generated.values()));
      if (generated.size === 0) throw new Error('生成完成，但没有返回图片资源');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setGenerating(false);
    }
  }, [conversationId, generating, prompt, reference]);

  return (
    <main className="main-content images-page">
      <div className="images-workspace">
        <h1>图片</h1>
        <div className="image-reference-row">
          {reference && (
            <span className="image-reference-chip">
              正在编辑：{reference.file_name}
              <button type="button" aria-label="移除引用图片" onClick={() => setReference(undefined)} disabled={generating}>×</button>
            </span>
          )}
        </div>
        <div className="image-prompt-row">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="描述你想生成的图片..."
            disabled={generating}
            rows={3}
          />
          <button type="button" onClick={() => void generate()} disabled={generating || !prompt.trim()}>
            {generating ? '生成中...' : '生成图片'}
          </button>
        </div>
        {generating && <div className="image-status">正在生成高质量图片...</div>}
        {error && <div className="image-error">{error}</div>}
        {images.length > 1 && <div className="image-choice-hint">请选择你更满意的图片</div>}
        <div className="generated-image-grid">
          {images.map((image, index) => (
            <div
              className={`generated-image-option ${selectedImage === image.file_id ? 'selected' : ''}`}
              key={image.file_id}
              onClick={() => !generating && setReference(image)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setReference(image);
              }}
            >
              <ChatMessage role="assistant" content="" images={[image]} />
              {images.length > 1 && (
                <button type="button" onClick={(event) => {
                  event.stopPropagation();
                  setSelectedImage(image.file_id);
                  void chat.selectImage(conversationId, image.file_id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
                }}>
                  {selectedImage === image.file_id ? '已选择' : `选择第 ${index + 1} 张`}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
