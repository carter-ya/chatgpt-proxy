import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function authenticate(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('token', 'e2e-token');
    localStorage.setItem('user', JSON.stringify({ id: 'user-e2e', email: 'e2e@example.com' }));
  });
}

async function mockModels(page: Page) {
  await page.route('**/api/models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [
      { label: '5.5 极速', model: 'gpt-5-5-instant' },
      { label: '5.6 高', model: 'gpt-5-6-thinking', thinking_effort: 'extended' },
    ] }),
  }));
}

async function mockEmptyConversations(page: Page) {
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"items":[],"total":0}',
  }));
}

test('进入聊天页面时每个初始化接口只请求一次', async ({ page }) => {
  await authenticate(page);
  const requests = { models: 0, conversations: 0, detail: 0 };
  await page.route('**/api/models', async (route) => {
    requests.models += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [{ label: '5.6 高', model: 'gpt-5-6-thinking', thinking_effort: 'extended' }] }),
    });
  });
  await page.route(/\/api\/conversations(?:\?.*)?$/, async (route) => {
    requests.conversations += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'request-once', title: '单次请求', model: 'gpt-5-6-thinking', updated_at: '2026-07-15T00:00:00Z', kind: 'chat' }], total: 1 }),
    });
  });
  await page.route('**/api/conversations/request-once', async (route) => {
    requests.detail += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversation: { id: 'request-once', title: '单次请求', model: 'gpt-5-6-thinking' }, messages: [{ id: 'answer', role: 'assistant', content: '初始化完成' }] }),
    });
  });

  await page.goto('/chat/request-once');
  await expect(page.getByText('初始化完成')).toBeVisible();
  await page.waitForTimeout(200);
  expect(requests).toEqual({ models: 1, conversations: 1, detail: 1 });
});

test('模型选择按账号持久化并在聊天与图片页共享', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);

  await page.goto('/chat');
  const modelSelect = page.getByRole('combobox', { name: '选择模型' });
  await modelSelect.selectOption('gpt-5-6-thinking|extended');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chatgpt-proxy:model-preference:v1:user-e2e')))
    .toBe('gpt-5-6-thinking|extended');

  await page.reload();
  await expect(page.getByRole('combobox', { name: '选择模型' })).toHaveValue('gpt-5-6-thinking|extended');
  await page.goto('/images');
  await expect(page.getByRole('combobox', { name: '选择模型' })).toHaveValue('gpt-5-6-thinking|extended');
});

test('已保存模型失效时回退到接口默认模型的 standard 档', async ({ page }) => {
  await authenticate(page);
  await page.evaluate(() => {
    localStorage.setItem('chatgpt-proxy:model-preference:v1:user-e2e', 'removed-model|max');
  });
  await mockEmptyConversations(page);
  await page.route('**/api/models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ default_model: 'gpt-new', options: [
      { label: '新模型 深入', model: 'gpt-new', thinking_effort: 'extended' },
      { label: '新模型 标准', model: 'gpt-new', thinking_effort: 'standard' },
    ] }),
  }));

  await page.goto('/chat');
  await expect(page.getByRole('combobox', { name: '选择模型' })).toHaveValue('gpt-new|standard');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chatgpt-proxy:model-preference:v1:user-e2e')))
    .toBe('gpt-new|standard');
});

test('模型接口临时失败时不清除已保存偏好', async ({ page }) => {
  await authenticate(page);
  await page.evaluate(() => {
    localStorage.setItem('chatgpt-proxy:model-preference:v1:user-e2e', 'saved-model|standard');
  });
  await mockEmptyConversations(page);
  await page.route('**/api/models', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: '{"error":"temporarily unavailable"}',
  }));

  await page.goto('/chat');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chatgpt-proxy:model-preference:v1:user-e2e')))
    .toBe('saved-model|standard');
});

test('历史消息清理引用、折叠思考并支持原地重试', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'c1', title: '黄金', model: 'gpt-5-6-thinking', updated_at: 'invalid-date', kind: 'chat' }], total: 1 }),
  }));
  await page.route('**/api/conversations/c1', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'c1', title: '黄金', model: 'gpt-5-6-thinking' },
      messages: [
        { id: 'u1', role: 'user', content: '黄金价格' },
        { id: 'a1', role: 'assistant', content: '当前价格 citeturn0search0', reasoning: '已核实多个来源', sources: [{ id: 's1', title: '示例来源', url: 'https://example.com', domain: 'example.com' }] },
      ],
    }),
  }));
  let retryBody: Record<string, unknown> = {};
  await page.route('**/api/conversations/c1/retry', async (route) => {
    retryBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"content":"重新生成的回答","message_id":"a2"}\n\ndata: [DONE]\n\n' });
  });

  await page.goto('/chat/c1');
  await expect(page.locator('body')).not.toContainText('NaN');
  await expect(page.locator('body')).not.toContainText('turn0search0');
  await page.getByRole('button', { name: /思考了/ }).click();
  await expect(page.getByText('已核实多个来源')).toBeVisible();
  await page.getByRole('button', { name: '1 个来源' }).click();
  await expect(page.getByRole('link', { name: /示例来源/ })).toBeVisible();
  await page.getByTitle('重试').click();
  await expect(page.getByText('重新生成的回答')).toBeVisible();
  expect(retryBody).toMatchObject({ assistant_message_id: 'a1' });
});

test('图片组与无语言代码块使用富组件渲染', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await authenticate(page);
  await mockModels(page);
  const marker = 'image_group{"aspect_ratio":"16:9","query":["water cycle"]}';
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'rich', title: '雨的形成过程', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
  }));
  await page.route('**/api/conversations/rich', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'rich', title: '雨的形成过程', model: 'gpt-5-6-thinking' },
      messages: [{
        id: 'answer', role: 'assistant', content: `${marker}\n\n雨的形成过程：\n\n\`\`\`\n面积：1,000,000 平方米\n水量 = 10,000 立方米\n\`\`\``,
        image_groups: [{ matched_text: marker, aspect_ratio: '16:9', images: [
          { thumbnail_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', content_url: 'https://images.openai.com/full', title: '水循环图' },
        ] }],
      }],
    }),
  }));

  await page.goto('/chat/rich');
  await expect(page.getByAltText('水循环图')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('image_group');
  await expect(page.locator('.code-block')).toContainText('面积：1,000,000 平方米');
  await page.getByRole('button', { name: '复制代码' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('水量 = 10,000 立方米');
  const copyMessage = page.getByRole('button', { name: '复制消息' });
  await expect(copyMessage.locator('svg')).toBeVisible();
  await expect(page.locator('.message-actions')).not.toContainText('▢');
  await copyMessage.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('雨的形成过程');
});

test('助手生成文件链接通过鉴权接口下载且不跳转聊天页面', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'files', title: '演示文稿', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
  }));
  await page.route('**/api/conversations/files', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'files', title: '演示文稿', model: 'gpt-5-6-thinking' },
      messages: [{
        id: 'assistant-file', role: 'assistant',
        content: '[下载演示文稿](sandbox:/mnt/data/水循环演示.pptx)\n\n[失败文件](sandbox:/mnt/data/missing.zip)\n\n[官方网站](https://example.com)',
      }],
    }),
  }));

  let ticketBody: Record<string, string> = {};
  let authorization = '';
  let releaseTicket: (() => void) | undefined;
  await page.route('**/api/download-tickets', async (route) => {
    const body = route.request().postDataJSON() as Record<string, string>;
    if (body.sandbox_path?.endsWith('missing.zip')) {
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"missing"}' });
      return;
    }
    ticketBody = body;
    authorization = route.request().headers().authorization || '';
    await new Promise<void>((resolve) => { releaseTicket = resolve; });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ download_url: 'downloads/ticket-ppt', expires_at: '2026-07-12T00:10:00Z' }),
    });
  });
  await page.route('**/api/downloads/ticket-ppt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E6%B0%B4%E5%BE%AA%E7%8E%AF%E6%BC%94%E7%A4%BA.pptx" },
      body: 'ppt-content',
    });
  });

  await page.goto('/chat/files');
  const initialURL = page.url();
  const downloadLink = page.getByRole('link', { name: '下载演示文稿' });
  await expect(downloadLink).toHaveAttribute('href', 'sandbox:/mnt/data/%E6%B0%B4%E5%BE%AA%E7%8E%AF%E6%BC%94%E7%A4%BA.pptx');
  await downloadLink.click();
  await expect(downloadLink).toContainText('下载中');
  const nativeDownload = page.waitForEvent('download');
  releaseTicket?.();
  await expect((await nativeDownload).suggestedFilename()).toBe('水循环演示.pptx');
  expect(ticketBody).toEqual({
    kind: 'sandbox',
    conversation_id: 'files',
    message_id: 'assistant-file',
    sandbox_path: 'sandbox:/mnt/data/%E6%B0%B4%E5%BE%AA%E7%8E%AF%E6%BC%94%E7%A4%BA.pptx',
  });
  expect(authorization).toBe('Bearer e2e-token');
  await expect.poll(() => page.url()).toBe(initialURL);

  await page.getByRole('link', { name: '失败文件' }).click();
  await expect(page.getByText('（下载失败，点击重试）')).toBeVisible();
  await expect(page.getByRole('link', { name: '官方网站' })).toHaveAttribute('href', 'https://example.com');
});

test('新会话流式返回的文件链接使用上游会话和消息 ID 下载', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  const content = '[下载表格](sandbox:/mnt/data/result.xlsx)';
  await page.route('**/api/conversation', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: [
      `data: ${JSON.stringify({ conversation_id: 'stream-created' })}\n\n`,
      `data: ${JSON.stringify({ content, message_id: 'assistant-stream' })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''),
  }));
  await page.route('**/api/conversations/stream-created', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'stream-created', title: '表格', model: 'gpt-5-6-thinking' },
      messages: [{ id: 'assistant-stream', role: 'assistant', content }],
    }),
  }));
  let ticketBody: Record<string, string> = {};
  await page.route('**/api/download-tickets', async (route) => {
    ticketBody = route.request().postDataJSON() as Record<string, string>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ download_url: 'downloads/ticket-xlsx', expires_at: '2026-07-12T00:10:00Z' }),
    });
  });
  await page.route('**/api/downloads/ticket-xlsx', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      headers: { 'Content-Disposition': 'attachment; filename="result.xlsx"' },
      body: 'xlsx-content',
    });
  });

  await page.goto('/chat');
  await page.getByPlaceholder('输入消息...').fill('生成一个表格');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page).toHaveURL(/\/chat\/stream-created$/);
  const nativeDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载表格' }).click();
  await expect((await nativeDownload).suggestedFilename()).toBe('result.xlsx');
  expect(ticketBody).toEqual({
    kind: 'sandbox',
    conversation_id: 'stream-created',
    message_id: 'assistant-stream',
    sandbox_path: 'sandbox:/mnt/data/result.xlsx',
  });
});

test('新会话先显示临时标题再替换为上游标题', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  let conversationSent = false;
  await page.route(/\/api\/conversations(?:\?.*)?$/, async (route) => {
    if (!conversationSent) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'created', title: '雨的形成过程', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
    });
  });
  await page.route('**/api/conversation', async (route) => {
    conversationSent = true;
    await route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: 'data: {"conversation_id":"created"}\n\ndata: {"content":"回答"}\n\ndata: [DONE]\n\n',
    });
  });
  await page.route('**/api/conversations/created', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'created', title: '雨的形成过程', model: 'gpt-5-6-thinking' }, messages: [{ id: 'answer', role: 'assistant', content: '回答' }] }),
  }));

  await page.goto('/chat');
  await page.getByPlaceholder('输入消息...').fill('请解释雨是怎么形成的');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.conversation-item')).toContainText('请解释雨是怎么形成的');
  await expect(page.locator('.conversation-item')).toContainText('雨的形成过程');
});

test('新会话收到 ID 后立即更新地址并可在生成中刷新恢复', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  let releaseResponse: (() => void) | undefined;
  const conversationServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before starting the delayed SSE response.
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    response.write('data: {"conversation_id":"recoverable-chat"}\n\n');
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    response.end('data: {"content":"最终回答"}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => conversationServer.listen(0, '127.0.0.1', resolve));
  const conversationServerURL = `http://127.0.0.1:${(conversationServer.address() as AddressInfo).port}`;
  await page.route('**/api/conversation', async (route) => {
    const requestURL = new URL(route.request().url());
    await route.continue({ url: `${conversationServerURL}${requestURL.pathname}${requestURL.search}` });
  });
  await page.route('**/api/conversations/recoverable-chat', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'recoverable-chat', title: '可恢复会话', model: 'gpt-5-6-thinking' },
      messages: [{ id: 'recovered-message', role: 'assistant', content: '刷新后恢复的内容' }],
    }),
  }));

  try {
    await page.goto('/chat');
    await page.getByPlaceholder('输入消息...').fill('执行长任务');
    await page.getByRole('button', { name: '发送' }).click();

    await expect(page).toHaveURL(/\/chat\/recoverable-chat$/);
    await expect(page.getByText('正在思考…', { exact: true })).toBeVisible();
    await expect(page.getByText('刷新后恢复的内容', { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page).toHaveURL(/\/chat\/recoverable-chat$/);
    await expect(page.getByText('刷新后恢复的内容', { exact: true })).toBeVisible();
  } finally {
    releaseResponse?.();
    await new Promise<void>((resolve, reject) => conversationServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('输入框支持多文件上传、任意格式和图片预览', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  await page.route('**/api/conversations/c-new', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'c-new', title: '文件', model: 'gpt-5-6-thinking' }, messages: [{ id: 'u-new', role: 'user', content: '分析这些文件', attachments: [
      { file_id: 'upload-1', file_name: 'preview.png', mime_type: 'image/png', size_bytes: 4, width: 1, height: 1, download_url: '/api/files/upload-1/download' },
      { file_id: 'upload-2', file_name: 'archive.xyz', mime_type: 'application/x-custom', size_bytes: 2048, width: 0, height: 0, download_url: '/api/files/upload-2/download' },
    ] }, { id: 'a-new', role: 'assistant', content: '收到文件' }] }),
  }));
  await page.route('**/api/files/upload-1/download', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  let uploadIndex = 0;
  await page.route(/\/api\/files(?:\?.*)?$/, async (route) => {
    uploadIndex += 1;
    expect(new URL(route.request().url()).searchParams.get('size_bytes')).toBe('4');
    const image = uploadIndex === 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ file_id: `upload-${uploadIndex}`, file_name: image ? 'preview.png' : 'archive.xyz', mime_type: image ? 'image/png' : 'application/x-custom', size_bytes: 4, width: image ? 1 : 0, height: image ? 1 : 0, download_url: `/api/files/upload-${uploadIndex}/download` }),
    });
  });
  let conversationBody: Record<string, unknown> = {};
  await page.route('**/api/conversation', async (route) => {
    conversationBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"conversation_id":"c-new"}\n\ndata: {"content":"收到文件"}\n\ndata: [DONE]\n\n' });
  });

  await page.goto('/chat');
  const input = page.locator('input[type=file]');
  await expect(input).toHaveAttribute('multiple', '');
  await expect(input).not.toHaveAttribute('accept', /.+/);
  await input.setInputFiles([
    { name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3, 4]) },
    { name: 'archive.xyz', mimeType: 'application/x-custom', buffer: Buffer.from([5, 6, 7, 8]) },
  ]);
  await expect(page.getByAltText('preview.png')).toBeVisible();
  await expect(page.getByText('archive.xyz')).toBeVisible();
  await page.getByPlaceholder('输入消息...').fill('分析这些文件');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('收到文件')).toBeVisible();
  await expect(page.locator('.chat-message.user img[alt="preview.png"]')).toBeVisible();
  await expect(page.locator('.chat-message.user .message-file-card')).toContainText('archive.xyz');
  await expect(page.locator('.chat-message.user .message-file-card')).toContainText('2.0 KB');
  expect(conversationBody.attachments).toHaveLength(2);
});

test('文件上传期间可以排队发送，并在全部上传成功后自动发送一次', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  const releases: Array<() => void> = [];
  let uploadIndex = 0;
  const uploadServer = createServer(async (request, response) => {
    const currentUpload = ++uploadIndex;
    for await (const _chunk of request) {
      // Consume the body before pausing so XMLHttpRequest reaches processing state.
    }
    await new Promise<void>((resolve) => releases.push(resolve));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      file_id: `queued-upload-${currentUpload}`,
      file_name: `queued-${currentUpload}.txt`,
      mime_type: 'text/plain',
      size_bytes: 5,
      download_url: `/api/files/queued-upload-${currentUpload}/download`,
    }));
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, '127.0.0.1', resolve));
  const uploadServerURL = `http://127.0.0.1:${(uploadServer.address() as AddressInfo).port}`;
  await page.route(/\/api\/files(?:\?.*)?$/, async (route) => {
    const requestURL = new URL(route.request().url());
    await route.continue({ url: `${uploadServerURL}${requestURL.pathname}${requestURL.search}` });
  });
  let conversationRequests = 0;
  let conversationBody: Record<string, unknown> = {};
  await page.route('**/api/conversation', async (route) => {
    conversationRequests += 1;
    conversationBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"content":"已自动发送"}\n\ndata: [DONE]\n\n' });
  });

  try {
    await page.goto('/chat');
    await page.locator('input[type=file]').setInputFiles([
      { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
      { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') },
    ]);
    const processingUploads = page.locator('.file-preview-item.uploading').filter({ hasText: '正在处理文件…' });
    await expect(processingUploads).toHaveCount(2);
    await expect.poll(() => releases.length).toBe(2);

    const textarea = page.getByPlaceholder('输入消息...');
    const sendButton = page.getByRole('button', { name: '发送' });
    await textarea.fill('等待文件后发送');
    await expect(sendButton).toBeEnabled();
    await expect(page.getByTitle('点击发送，文件上传完成后将自动发送')).toBeVisible();
    await sendButton.click();

    await expect(sendButton).toBeDisabled();
    await expect(page.getByTitle('已排队，文件上传完成后自动发送')).toBeVisible();
    await expect(textarea).toBeDisabled();
    await expect(page.getByRole('combobox', { name: '选择模型' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '上传文件' })).toBeDisabled();
    expect(conversationRequests).toBe(0);

    releases[0]();
    await expect(processingUploads).toHaveCount(1);
    expect(conversationRequests).toBe(0);
    releases[1]();

    await expect(page.getByText('已自动发送')).toBeVisible();
    expect(conversationRequests).toBe(1);
    expect(conversationBody.message).toBe('等待文件后发送');
    expect(conversationBody.attachments).toHaveLength(2);
  } finally {
    releases.forEach((release) => release());
    await new Promise<void>((resolve, reject) => uploadServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('排队发送期间上传失败会取消发送并保留草稿', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  let releaseUpload: (() => void) | undefined;
  const uploadServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the body before returning the delayed failure.
    }
    await new Promise<void>((resolve) => { releaseUpload = resolve; });
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end('{"error":"temporarily unavailable"}');
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, '127.0.0.1', resolve));
  const uploadServerURL = `http://127.0.0.1:${(uploadServer.address() as AddressInfo).port}`;
  await page.route(/\/api\/files(?:\?.*)?$/, async (route) => {
    const requestURL = new URL(route.request().url());
    await route.continue({ url: `${uploadServerURL}${requestURL.pathname}${requestURL.search}` });
  });
  let conversationRequests = 0;
  await page.route('**/api/conversation', async (route) => {
    conversationRequests += 1;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: [DONE]\n\n' });
  });

  try {
    await page.goto('/chat');
    await page.locator('input[type=file]').setInputFiles({
      name: 'will-fail.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('failure'),
    });
    await expect(page.locator('.file-preview-item.uploading')).toContainText('正在处理文件…');
    const textarea = page.getByPlaceholder('输入消息...');
    const sendButton = page.getByRole('button', { name: '发送' });
    await textarea.fill('失败后保留这段文字');
    await sendButton.click();
    await expect(textarea).toBeDisabled();

    releaseUpload?.();
    await expect(page.getByText('上传失败', { exact: true })).toBeVisible();
    await expect(textarea).toBeEnabled();
    await expect(textarea).toHaveValue('失败后保留这段文字');
    await expect(sendButton).toBeEnabled();
    expect(conversationRequests).toBe(0);
  } finally {
    releaseUpload?.();
    await new Promise<void>((resolve, reject) => uploadServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('文件上传失败后可以原地重试', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  let uploadAttempts = 0;
  let releaseRetry: (() => void) | undefined;
  const uploadServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request body so XMLHttpRequest reports upload completion.
    }
    await new Promise<void>((resolve) => { releaseRetry = resolve; });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ file_id: 'retried-upload', file_name: 'retry.txt', mime_type: 'text/plain', size_bytes: 5, download_url: '/api/files/retried-upload/download' }));
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, '127.0.0.1', resolve));
  const uploadServerURL = `http://127.0.0.1:${(uploadServer.address() as AddressInfo).port}`;
  await page.route(/\/api\/files(?:\?.*)?$/, async (route) => {
    uploadAttempts += 1;
    if (uploadAttempts === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily unavailable"}' });
      return;
    }
    const requestURL = new URL(route.request().url());
    await route.continue({ url: `${uploadServerURL}${requestURL.pathname}${requestURL.search}` });
  });

  try {
    await page.goto('/chat');
    await page.locator('input[type=file]').setInputFiles({
      name: 'retry.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('retry'),
    });

    await expect(page.getByText('上传失败', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    const processingUpload = page.locator('.file-preview-item.uploading').filter({ hasText: '正在处理文件…' });
    await expect(processingUpload).toBeVisible();
    await expect(processingUpload).not.toContainText('上传中 100%');
    const spinnerBox = await processingUpload.locator('.spinner').boundingBox();
    expect(spinnerBox).not.toBeNull();
    expect(Math.abs(spinnerBox!.width - spinnerBox!.height)).toBeLessThanOrEqual(1);
    releaseRetry?.();
    await expect(page.getByText('retry.txt')).toBeVisible();
    await expect(page.getByText('上传失败', { exact: true })).toHaveCount(0);
    expect(uploadAttempts).toBe(2);
  } finally {
    releaseRetry?.();
    await new Promise<void>((resolve, reject) => uploadServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('流式连接技术错误显示为可操作的用户提示', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  await page.route('**/api/conversation', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'event: error\ndata: SSE 流读取超时\n\ndata: [DONE]\n\n',
  }));

  await page.goto('/chat');
  await page.getByPlaceholder('输入消息...').fill('执行一个长任务');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText(/响应连接中断，结果可能仍在处理中/)).toBeVisible();
  await expect(page.locator('.chat-message.assistant')).not.toContainText('SSE');
  await expect(page.locator('.chat-message.assistant')).not.toContainText('Timed out');
});

test('生成过程中可以准备下一条消息但不能提前发送', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  await page.route(/\/api\/files(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ file_id: 'next-upload', file_name: 'next.txt', mime_type: 'text/plain', size_bytes: 4, download_url: '/api/files/next-upload/download' }),
  }));
  let releaseResponse: (() => void) | undefined;
  const conversationBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/conversation', async (route) => {
    conversationBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (conversationBodies.length === 1) {
      await new Promise<void>((resolve) => { releaseResponse = resolve; });
    }
    const content = conversationBodies.length === 1 ? '第一条完成' : '第二条完成';
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ content })}\n\ndata: [DONE]\n\n` });
  });

  await page.goto('/chat');
  const textarea = page.getByPlaceholder('输入消息...');
  await textarea.fill('测试思考状态');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('正在思考…', { exact: true })).toHaveCount(1);
  await expect(page.locator('.reasoning-panel')).toHaveCount(1);
  await expect(page.locator('.assistant-working')).toHaveCount(0);
  await expect(textarea).toBeEnabled();
  await expect(page.getByRole('combobox', { name: '选择模型' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '上传文件' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);

  await textarea.fill('下一条草稿');
  await textarea.press('Enter');
  await expect(textarea).toHaveValue('下一条草稿\n');
  expect(conversationBodies).toHaveLength(1);
  await page.getByRole('combobox', { name: '选择模型' }).selectOption('gpt-5-5-instant|');
  await page.locator('input[type=file]').setInputFiles({
    name: 'next.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('next'),
  });
  await expect(page.getByText('next.txt')).toBeVisible();

  releaseResponse?.();
  await expect(page.getByText('第一条完成', { exact: true })).toBeVisible();
  await expect(textarea).toHaveValue('下一条草稿\n');
  await expect(page.getByRole('combobox', { name: '选择模型' })).toHaveValue('gpt-5-5-instant|');
  const sendButton = page.getByRole('button', { name: '发送', exact: true });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  await expect(page.getByText('第二条完成', { exact: true })).toBeVisible();
  expect(conversationBodies).toHaveLength(2);
  expect(conversationBodies[1]).toMatchObject({
    message: '下一条草稿',
    model: 'gpt-5-5-instant',
    attachments: [expect.objectContaining({ file_id: 'next-upload' })],
  });
});

test('停止生成后保留生成期间输入的草稿', async ({ page }) => {
  await authenticate(page);
  await mockModels(page);
  await mockEmptyConversations(page);
  let releaseFirstResponse: (() => void) | undefined;
  let firstRouteFinished = false;
  const conversationBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/conversation', async (route) => {
    conversationBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (conversationBodies.length === 1) {
      await new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
      try {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"content":"已取消的结果"}\n\ndata: [DONE]\n\n' });
      } catch {
        // The browser request is expected to be aborted by the stop button.
      } finally {
        firstRouteFinished = true;
      }
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"content":"草稿已发送"}\n\ndata: [DONE]\n\n' });
  });

  await page.goto('/chat');
  const textarea = page.getByPlaceholder('输入消息...');
  await textarea.fill('开始一个长任务');
  await page.getByRole('button', { name: '发送' }).click();
  await textarea.fill('停止后仍要保留');
  await page.getByRole('button', { name: '停止生成' }).click();

  await expect(textarea).toBeEnabled();
  await expect(textarea).toHaveValue('停止后仍要保留');
  const sendButton = page.getByRole('button', { name: '发送', exact: true });
  await expect(sendButton).toBeEnabled();
  releaseFirstResponse?.();
  await expect.poll(() => firstRouteFinished).toBe(true);
  await sendButton.click();

  await expect(page.getByText('草稿已发送', { exact: true })).toBeVisible();
  await expect(page.getByText('已取消的结果', { exact: true })).toHaveCount(0);
  expect(conversationBodies).toHaveLength(2);
  expect(conversationBodies[1].message).toBe('停止后仍要保留');
});

test('移动端点击图片导航后自动关闭侧栏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await authenticate(page);
  await mockModels(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 'c1', title: '测试会话', model: 'gpt-5-6-thinking', updated_at: '2026-07-12T00:00:00Z', kind: 'chat' }], total: 1 }),
  }));

  await page.goto('/chat');
  await page.getByRole('button', { name: '切换侧边栏' }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/open/);
  await page.getByRole('button', { name: '图片', exact: true }).click();

  await expect(page).toHaveURL(/\/images$/);
  await expect(page.locator('.sidebar')).not.toHaveClass(/open/);
  await expect(page.locator('.sidebar-overlay')).not.toHaveClass(/open/);
});
