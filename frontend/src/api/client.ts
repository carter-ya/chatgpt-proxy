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

export interface LoginResponse {
  token: string;
  user: { email: string };
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  images?: FileAsset[];
  attachments?: FileAsset[];
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
}

export type UploadedFile = FileAsset;

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
    attachment?: UploadedFile,
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
        attachment_file_id: attachment?.file_id,
        attachment,
      }),
    });
  },

  generateImage: (
    prompt: string,
    model = 'gpt-5-6-thinking',
    signal?: AbortSignal,
    attachment?: UploadedFile,
    conversationId?: string,
  ) => {
    return fetch(`${API_BASE}/images/generations`, {
      method: 'POST',
      headers: getAuthHeaders(),
      signal,
      body: JSON.stringify({ prompt, model, attachment, conversation_id: conversationId, original_gen_id: attachment?.generation_id, original_file_id: attachment?.file_id }),
    });
  },

  selectImage: async (conversationId: string, fileId: string) => {
    const response = await fetch(`${API_BASE}/images/select`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ conversation_id: conversationId, file_id: fileId }),
    });
    if (!response.ok) throw new Error(`候选图片反馈失败: HTTP ${response.status}`);
  },

  uploadFile: async (file: File): Promise<UploadedFile> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.post<UploadedFile>('/files', formData);
    return res.data;
  },

  getFileBlob: async (file: Pick<FileAsset, 'download_url'>): Promise<Blob> => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(file.download_url, { headers });
    if (!response.ok) {
      throw new Error(`文件下载失败: HTTP ${response.status}`);
    }
    return response.blob();
  },

  downloadFile: async (file: Pick<FileAsset, 'download_url' | 'file_name'>) => {
    const blob = await chat.getFileBlob(file);
    const objectURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectURL;
    link.download = file.file_name;
    link.click();
    URL.revokeObjectURL(objectURL);
  },

  listConversations: () =>
    apiClient.get<{
      items: Conversation[];
      total: number;
      limit: number;
      offset: number;
    }>('/conversations'),

  getConversation: (id: string) =>
    apiClient.get<{ conversation: Conversation; messages: Message[] }>(
      `/conversations/${id}`,
    ),

  updateConversation: (id: string, data: Record<string, unknown>) =>
    apiClient.patch(`/conversations/${id}`, data),
};

export default apiClient;
