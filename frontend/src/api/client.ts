import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

const apiClient = axios.create({
  baseURL: API_BASE,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      const currentPath = window.location.pathname;
      if (currentPath !== '/login' && currentPath !== '/register') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export interface AuthUser {
  id?: string;
  email: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  kind?: 'chat' | 'image';
  archived?: boolean;
  /** ChatGPT upstream async attention state. 4 means completed and awaiting review. */
  async_status?: number | null;
}

export interface Source {
  id: string;
  title: string;
  url: string;
  domain?: string;
}

export interface Message {
  id: string;
  parent_id?: string;
  role: 'user' | 'assistant';
  content: string;
  images?: FileAsset[];
  attachments?: FileAsset[];
  reasoning?: string;
  sources?: Source[];
  image_groups?: ImageGroup[];
  genui_widgets?: GenUIWidget[];
}

export interface GenUIWidget {
  matched_text: string;
  url: string;
  name?: string;
}

export interface ImageGroup {
  matched_text: string;
  aspect_ratio?: string;
  images: SearchImage[];
}

export interface SearchImage {
  thumbnail_url: string;
  content_url: string;
  source_url?: string;
  title?: string;
  width?: number;
  height?: number;
}

export interface FileAsset {
  file_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  url?: string;
  download_url: string;
  generation_id?: string;
  message_id?: string;
  candidate_group_message_id?: string;
}

export type UploadedFile = FileAsset;

const fileBlobCache = new Map<string, Promise<Blob>>();

interface DownloadTicketResponse {
  download_url: string;
  expires_at: string;
}

function triggerNativeDownload(downloadPath: string) {
  const base = API_BASE.replace(/\/$/, '');
  const relativePath = downloadPath.replace(/^\//, '');
  const href = /^https?:\/\//i.test(downloadPath) ? downloadPath : `${base}/${relativePath}`;
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function createDownloadTicket(payload: Record<string, string>): Promise<void> {
  const response = await apiClient.post<DownloadTicketResponse>('/download-tickets', payload);
  triggerNativeDownload(response.data.download_url);
}

export interface ModelOption {
  label: string;
  title?: string;
  description?: string;
  model: string;
  model_label?: string;
  thinking_effort?: string;
  lane?: string;
}

export interface ModelVersion {
  id: string;
  label: string;
  short_label?: string;
  display_text?: string;
  tooltip?: string;
  badge?: string;
  model: string;
  default_thinking_effort?: string;
  options: ModelOption[];
}

export interface ModelCatalog {
  title?: string;
  default_model: string;
  model_picker_version?: number;
  updated_at?: string;
  versions?: ModelVersion[];
  options: ModelOption[];
}

export interface StreamPayload {
  conversation_id?: string;
  message_id?: string;
  content?: string;
  images?: FileAsset[];
  status?: string;
  reasoning?: string;
  sources?: Source[];
  image_groups?: ImageGroup[];
  genui_widgets?: GenUIWidget[];
  error?: string;
}

export const auth = {
  register: (email: string, password: string) =>
    apiClient.post<LoginResponse>('/auth/register', { email, password }),
  login: (email: string, password: string) =>
    apiClient.post<LoginResponse>('/auth/login', { email, password }),
};

export const chat = {
  sendMessage: (
    message: string,
    model: string,
    conversationId?: string,
    stream = true,
    genId?: string,
    attachments: UploadedFile[] = [],
    thinkingEffort?: string,
    signal?: AbortSignal,
  ) => {
    return fetch(`${API_BASE}/conversation`, {
      method: 'POST',
      headers: getAuthHeaders(),
      signal,
      body: JSON.stringify({
        message,
        model,
        conversation_id: conversationId,
        stream,
        gen_id: genId,
        attachments,
        thinking_effort: thinkingEffort,
      }),
    });
  },

  generateImage: (
    prompt: string,
    model = 'gpt-5-6-thinking',
    signal?: AbortSignal,
    reference?: UploadedFile,
    conversationId?: string,
    attachments: UploadedFile[] = [],
  ) => {
    return fetch(`${API_BASE}/images/generations`, {
      method: 'POST',
      headers: getAuthHeaders(),
      signal,
      body: JSON.stringify({ prompt, model, attachment: reference, attachments, conversation_id: conversationId, original_gen_id: reference?.generation_id, original_file_id: reference?.file_id }),
    });
  },

  selectImage: async (conversationId: string, image: FileAsset) => {
    const response = await fetch(`${API_BASE}/images/select`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        conversation_id: conversationId,
        file_id: image.file_id,
        message_id: image.candidate_group_message_id,
        selected_image_message_id: image.message_id,
      }),
    });
    if (!response.ok) throw new Error(`候选图片反馈失败: HTTP ${response.status} ${await response.text()}`);
  },

  getModels: () => apiClient.get<ModelCatalog>('/models'),

  retryMessage: (
    conversationId: string,
    assistantMessageId: string,
    model: string,
    thinkingEffort: string | undefined,
    signal?: AbortSignal,
  ) => fetch(`${API_BASE}/conversations/${conversationId}/retry`, {
    method: 'POST',
    headers: getAuthHeaders(),
    signal,
    body: JSON.stringify({ assistant_message_id: assistantMessageId, model, thinking_effort: thinkingEffort }),
  }),

  uploadFile: async (file: File, onProgress?: (percentage: number) => void): Promise<UploadedFile> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.post<UploadedFile>('/files', formData, {
      params: { size_bytes: file.size },
      onUploadProgress: onProgress ? (event) => {
        const ratio = typeof event.progress === 'number'
          ? event.progress
          : event.total
            ? event.loaded / event.total
            : 0;
        onProgress(Math.min(100, Math.max(0, Math.round(ratio * 100))));
      } : undefined,
    });
    return res.data;
  },

  getFileBlob: async (file: Pick<FileAsset, 'download_url'>): Promise<Blob> => {
    const token = localStorage.getItem('token');
    const cacheKey = `${token || ''}:${file.download_url}`;
    const cached = fileBlobCache.get(cacheKey);
    if (cached) return cached;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = fetch(file.download_url, { headers }).then((response) => {
      if (!response.ok) throw new Error(`文件下载失败: HTTP ${response.status}`);
      return response.blob();
    }).catch((error) => {
      fileBlobCache.delete(cacheKey);
      throw error;
    });
    fileBlobCache.set(cacheKey, request);
    return request;
  },

  downloadFile: async (file: Pick<FileAsset, 'file_id'>) =>
    createDownloadTicket({ kind: 'file', file_id: file.file_id }),

  downloadSandboxFile: async (conversationId: string, messageId: string, sandboxPath: string) =>
    createDownloadTicket({ kind: 'sandbox', conversation_id: conversationId, message_id: messageId, sandbox_path: sandboxPath }),

  listConversations: (archived = false) =>
    apiClient.get<{
      items: Conversation[];
      total: number;
      limit: number;
      offset: number;
    }>('/conversations', { params: archived ? { archived: true } : undefined }),

  getConversation: (id: string) =>
    apiClient.get<{ conversation: Conversation; messages: Message[] }>(
      `/conversations/${id}`,
    ),

  acknowledgeAsyncStatus: (id: string) =>
    apiClient.post(`/conversations/${id}/async-status`, {}),

  updateConversation: (id: string, data: Record<string, unknown>) =>
    apiClient.patch(`/conversations/${id}`, data),

  archiveConversation: (id: string, archived: boolean) =>
    apiClient.patch(`/conversations/${id}`, { is_archived: archived }),

  deleteConversation: (id: string) => apiClient.delete(`/conversations/${id}`),
};

export default apiClient;
