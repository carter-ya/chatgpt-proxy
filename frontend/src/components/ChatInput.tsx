import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { chat, type FileAsset, type ModelOption, type UploadedFile } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { modelOptionKey, modelPreferenceKey, resolvePreferredModel } from '../utils/modelPreference';

interface ChatInputProps {
  onSend: (text: string, model: string, thinkingEffort: string | undefined, attachments: UploadedFile[]) => void;
  sending: boolean;
  onCancel: () => void;
  placeholder?: string;
  referenceImage?: FileAsset;
  onRemoveReference?: () => void;
}

interface AttachmentPreview {
  asset: UploadedFile;
  previewURL?: string;
}

interface FailedUpload {
  id: string;
  file: File;
  error: string;
}

interface ActiveUpload {
  id: string;
  fileName: string;
  progress: number;
}

const fallbackModels: ModelOption[] = [
  { label: '5.6 深入', model: 'gpt-5-6-thinking', thinking_effort: 'max', lane: 'thinking' },
];

export default function ChatInput({ onSend, sending, onCancel, placeholder = '输入消息...', referenceImage, onRemoveReference }: ChatInputProps) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [models, setModels] = useState<ModelOption[]>(fallbackModels);
  const [selectedModel, setSelectedModel] = useState(modelOptionKey(fallbackModels[0]));
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
  const [activeUploads, setActiveUploads] = useState<ActiveUpload[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [referencePreviewURL, setReferencePreviewURL] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<AttachmentPreview[]>([]);
  const failedUploadIDRef = useRef(0);
  const preferenceKey = useMemo(() => modelPreferenceKey(user), [user?.id, user?.email]);

  useEffect(() => {
    let cancelled = false;
    void chat.getModels().then(({ data }) => {
      if (cancelled || !data.options?.length) return;
      setModels(data.options);
      const saved = preferenceKey ? localStorage.getItem(preferenceKey) : null;
      const preferred = resolvePreferredModel(data.options, data.default_model, saved);
      if (!preferred) return;
      const preferredKey = modelOptionKey(preferred);
      setSelectedModel(preferredKey);
      if (preferenceKey && saved !== preferredKey) {
        localStorage.setItem(preferenceKey, preferredKey);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [preferenceKey]);

  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    attachmentsRef.current.forEach((item) => item.previewURL && URL.revokeObjectURL(item.previewURL));
  }, []);

  useEffect(() => {
    if (!referenceImage) {
      setReferencePreviewURL('');
      return;
    }
    let objectURL = '';
    let cancelled = false;
    void chat.getFileBlob(referenceImage).then((blob) => {
      if (cancelled) return;
      objectURL = URL.createObjectURL(blob);
      setReferencePreviewURL(objectURL);
    }).catch(() => setReferencePreviewURL(''));
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      composerRef.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => {
      cancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [referenceImage?.file_id, referenceImage?.download_url]);

  const selectedOption = useMemo(
    () => models.find((option) => modelOptionKey(option) === selectedModel) || models[0],
    [models, selectedModel],
  );
  const uploading = activeUploads.length;

  const selectModel = useCallback((value: string) => {
    setSelectedModel(value);
    if (preferenceKey) localStorage.setItem(preferenceKey, value);
  }, [preferenceKey]);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, []);

  const uploadFile = useCallback(async (file: File, existingUploadID?: string) => {
    const id = existingUploadID || `upload-${++failedUploadIDRef.current}`;
    setFailedUploads((current) => current.filter((item) => item.id !== id));
    setActiveUploads((current) => [...current.filter((item) => item.id !== id), { id, fileName: file.name, progress: 0 }]);
    try {
      const asset = await chat.uploadFile(file, (progress) => {
        setActiveUploads((current) => current.map((item) => item.id === id ? { ...item, progress } : item));
      });
      const previewURL = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      setAttachments((current) => [...current, { asset, previewURL }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      setFailedUploads((current) => [
        ...current.filter((item) => item.id !== id),
        { id, file, error: message },
      ]);
    } finally {
      setActiveUploads((current) => current.filter((item) => item.id !== id));
    }
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploadError('');
    const rejected: string[] = [];
    const valid = files.filter((file) => {
      if (file.size <= 50 * 1024 * 1024) return true;
      rejected.push(`${file.name} 超过 50MB`);
      return false;
    });
    if (rejected.length) setUploadError(rejected.join('；'));
    await Promise.all(valid.map((file) => uploadFile(file)));
  }, [uploadFile]);

  const retryUpload = useCallback(async (failedUpload: FailedUpload) => {
    await uploadFile(failedUpload.file, failedUpload.id);
  }, [uploadFile]);

  const removeAttachment = useCallback((fileID: string) => {
    setAttachments((current) => current.filter((item) => {
      if (item.asset.file_id !== fileID) return true;
      if (item.previewURL) URL.revokeObjectURL(item.previewURL);
      return false;
    }));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sending || uploading > 0 || !selectedOption) return;
    onSend(trimmed, selectedOption.model, selectedOption.thinking_effort, attachments.map((item) => item.asset));
    attachments.forEach((item) => item.previewURL && URL.revokeObjectURL(item.previewURL));
    setText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [attachments, onSend, selectedOption, sending, text, uploading]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }, [addFiles]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length) void addFiles(files);
  }, [addFiles]);

  return (
    <div
      ref={composerRef}
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-overlay">松开以上传文件</div>}
      {referenceImage && (
        <div className="edit-reference-preview" aria-label="当前编辑原图">
          {referencePreviewURL ? <img src={referencePreviewURL} alt={referenceImage.file_name} /> : <span className="edit-reference-placeholder"><span className="spinner" /></span>}
          <span className="edit-reference-copy"><strong>编辑原图</strong><small>输入修改要求后发送</small><span>{referenceImage.file_name}</span></span>
          <button type="button" onClick={onRemoveReference} aria-label={`移除编辑原图 ${referenceImage.file_name}`}>×</button>
        </div>
      )}
      {(attachments.length > 0 || failedUploads.length > 0 || activeUploads.length > 0) && (
        <div className="file-preview">
          {attachments.map(({ asset, previewURL }) => (
            <div className="file-preview-item" key={asset.file_id}>
              {previewURL ? <img src={previewURL} alt={asset.file_name} /> : <span className="file-icon">📄</span>}
              <span className="file-name">{asset.file_name}</span>
              <button type="button" className="remove-file" onClick={() => removeAttachment(asset.file_id)} aria-label={`移除 ${asset.file_name}`}>×</button>
            </div>
          ))}
          {failedUploads.map((failedUpload) => (
            <div className="file-preview-item upload-failed" key={failedUpload.id}>
              <span className="upload-failed-icon" aria-hidden="true">!</span>
              <span className="upload-failed-details">
                <span className="file-name">{failedUpload.file.name}</span>
                <span className="upload-failed-message" title={failedUpload.error}>上传失败</span>
              </span>
              <button type="button" className="retry-upload" onClick={() => void retryUpload(failedUpload)} disabled={sending}>重试</button>
              <button type="button" className="remove-file" onClick={() => setFailedUploads((current) => current.filter((item) => item.id !== failedUpload.id))} aria-label={`移除上传失败文件 ${failedUpload.file.name}`}>×</button>
            </div>
          ))}
          {activeUploads.map((upload) => (
            <div className="file-preview-item uploading" key={upload.id}>
              <span className="spinner" />
              <span className="active-upload-details">
                <span className="file-name">{upload.fileName}</span>
                <span>上传中 {upload.progress}%</span>
                <span className="upload-progress-track" aria-label={`${upload.fileName} 上传进度 ${upload.progress}%`}>
                  <span style={{ width: `${upload.progress}%` }} />
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {uploadError && <div className="upload-error">{uploadError}</div>}
      <div className="chat-input-container">
        <div className="composer-toolbar">
          <select value={selectedModel} onChange={(event) => selectModel(event.target.value)} disabled={sending} aria-label="选择模型">
            {models.map((option) => <option key={modelOptionKey(option)} value={modelOptionKey(option)}>{option.label}</option>)}
          </select>
        </div>
        <div className="chat-input-wrapper">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => { setText(event.target.value); adjustHeight(); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={referenceImage ? '描述你希望如何修改这张图片...' : placeholder}
            disabled={sending}
            rows={1}
          />
          <button type="button" className="upload-btn" onClick={() => fileInputRef.current?.click()} disabled={sending} aria-label="上传文件">📎</button>
          {sending ? (
            <button type="button" className="send-btn" onClick={onCancel} aria-label="停止生成">■</button>
          ) : (
            <button type="button" className="send-btn" onClick={handleSend} disabled={!text.trim() || uploading > 0} aria-label="发送">➤</button>
          )}
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
        </div>
      </div>
    </div>
  );
}
