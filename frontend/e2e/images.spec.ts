import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function image(fileId: string, generationId: string, index: number) {
  return {
    file_id: fileId,
    file_name: `${fileId}.png`,
    mime_type: 'image/png',
    size_bytes: png.length,
    width: 1024,
    height: 1024,
    download_url: `/api/files/${fileId}/download`,
    generation_id: generationId,
    candidate_group_message_id: 'candidate-group',
    message_id: `candidate-message-${index}`,
  };
}

async function authenticate(page: Page) {
  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('token', 'e2e-token');
    localStorage.setItem('user', JSON.stringify({ email: 'e2e@example.com' }));
  });
}

test('图片聊天保留四张候选、正确选择并追加编辑结果', async ({ page }) => {
  await authenticate(page);
  const generationRequests: Array<Record<string, unknown>> = [];
  let selectionBody: Record<string, unknown> = {};
  const initialImages = [0, 1, 2, 3].map((index) => image(`file-${index + 1}`, `gen-${index + 1}`, index + 1));
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0 }) }));
  await page.route('**/api/conversations/conversation-1', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'conversation-1', title: '图片', model: 'gpt-5-6-thinking' }, messages: [{ id: 'assistant-images', role: 'assistant', content: '', images: initialImages }] }),
  }));
  await page.route('**/api/models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [{ label: '5.6 中', model: 'gpt-5-6-thinking', thinking_effort: 'standard' }] }) }));
  await page.route('**/api/files/*/download', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await page.route('**/api/images/select', async (route) => {
    selectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/images/generations', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    generationRequests.push(body);
    const images = generationRequests.length === 1
      ? initialImages
      : [{ ...image('file-edited', 'gen-edited', 5), candidate_group_message_id: undefined, message_id: 'edited-message' }];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: {"conversation_id":"conversation-1"}\n\ndata: ${JSON.stringify({ images })}\n\ndata: [DONE]\n\n`,
    });
  });

  await page.goto('/images');
  const input = page.getByPlaceholder('描述图片，或继续和 ChatGPT 对话...');
  await input.fill('生成四张测试图片');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.locator('.message-image-container')).toHaveCount(4);
  await page.getByRole('button', { name: '选择', exact: true }).nth(1).click();
  await expect(page.getByRole('button', { name: '已选择', exact: true })).toBeVisible();
  expect(selectionBody).toEqual({
    conversation_id: 'conversation-1',
    file_id: 'file-2',
    message_id: 'candidate-group',
    selected_image_message_id: 'candidate-message-2',
  });

  await page.getByRole('button', { name: '以此图编辑', exact: true }).nth(1).click();
  await expect(page.getByLabel('当前编辑原图')).toContainText('输入修改要求后发送');
  await expect(page.getByLabel('当前编辑原图')).toContainText('file-2.png');
  await expect(page.getByRole('button', { name: '已选为编辑原图', exact: true })).toBeVisible();
  const editInput = page.getByPlaceholder('描述你希望如何修改这张图片...');
  await expect(editInput).toBeFocused();
  await editInput.fill('把背景改成森林');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.chat-message.assistant .message-image-container')).toHaveCount(5);
  await expect(page.locator('.chat-message.user .attachment-image-grid .message-image-container')).toHaveCount(1);
  await page.locator('.chat-message.assistant .message-image-container').last().scrollIntoViewIfNeeded();
  await expect(page.getByAltText('file-edited.png')).toBeVisible();
  await expect(page.locator('.message-image-container').first()).toBeAttached();

  expect(generationRequests).toHaveLength(2);
  expect(generationRequests[1]).toMatchObject({
    prompt: '把背景改成森林',
    conversation_id: 'conversation-1',
    original_gen_id: 'gen-2',
    original_file_id: 'file-2',
  });
});

test('图片生成超时后保留新会话地址并可刷新恢复', async ({ page }) => {
  await authenticate(page);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  await page.route('**/api/models', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [{ label: '5.6 中', model: 'gpt-5-6-thinking', thinking_effort: 'standard' }] }),
  }));
  await page.route('**/api/conversations/recoverable-image', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      conversation: { id: 'recoverable-image', title: '仍在生成的图片', model: 'gpt-5-6-thinking' },
      messages: [{ id: 'recovered-image-task', role: 'assistant', content: '刷新后恢复的图片任务' }],
    }),
  }));
  let releaseTimeout: (() => void) | undefined;
  const generationServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before starting the delayed SSE response.
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    response.write('data: {"conversation_id":"recoverable-image"}\n\n');
    await new Promise<void>((resolve) => { releaseTimeout = resolve; });
    response.end('event: error\ndata: 图片生成时间较长，结果可能仍在处理中。请稍后重新打开此对话查看。\n\n');
  });
  await new Promise<void>((resolve) => generationServer.listen(0, '127.0.0.1', resolve));
  const generationServerURL = `http://127.0.0.1:${(generationServer.address() as AddressInfo).port}`;
  await page.route('**/api/images/generations', async (route) => {
    const requestURL = new URL(route.request().url());
    await route.continue({ url: `${generationServerURL}${requestURL.pathname}${requestURL.search}` });
  });

  try {
    await page.goto('/images');
    await page.getByPlaceholder('描述图片，或继续和 ChatGPT 对话...').fill('生成一张复杂图片');
    await page.getByRole('button', { name: '发送' }).click();

    await expect(page).toHaveURL(/\/images\/recoverable-image$/);
    await expect(page.getByText('正在生成图片…', { exact: true })).toBeVisible();
    await expect(page.getByText('刷新后恢复的图片任务', { exact: true })).toHaveCount(0);
    releaseTimeout?.();
    await expect(page.getByText(/图片生成时间较长/).first()).toBeVisible();
    await expect(page).toHaveURL(/\/images\/recoverable-image$/);

    await page.reload();
    await expect(page).toHaveURL(/\/images\/recoverable-image$/);
    await expect(page.getByText('刷新后恢复的图片任务', { exact: true })).toBeVisible();
  } finally {
    releaseTimeout?.();
    await new Promise<void>((resolve, reject) => generationServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('图片页在附件上传完成后自动发送排队的编辑请求', async ({ page }) => {
  await authenticate(page);
  const reference = image('queued-reference', 'queued-reference-gen', 1);
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  await page.route('**/api/conversations/queued-image', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'queued-image', title: '排队图片', model: 'gpt-5-6-thinking' }, messages: [{ id: 'reference-message', role: 'assistant', content: '', images: [reference] }] }),
  }));
  await page.route('**/api/models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [{ label: '5.6 中', model: 'gpt-5-6-thinking', thinking_effort: 'standard' }] }) }));
  await page.route('**/api/files/queued-reference/download', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));

  let releaseUpload: (() => void) | undefined;
  const uploadServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the body so the composer enters its processing phase.
    }
    await new Promise<void>((resolve) => { releaseUpload = resolve; });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ file_id: 'queued-notes', file_name: 'notes.txt', mime_type: 'text/plain', size_bytes: 5, download_url: '/api/files/queued-notes/download' }));
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, '127.0.0.1', resolve));
  const uploadServerURL = `http://127.0.0.1:${(uploadServer.address() as AddressInfo).port}`;
  await page.route(/\/api\/files(?:\?.*)?$/, async (route) => {
    const requestURL = new URL(route.request().url());
    await route.continue({ url: `${uploadServerURL}${requestURL.pathname}${requestURL.search}` });
  });
  const generationRequests: Array<Record<string, unknown>> = [];
  await page.route('**/api/images/generations', async (route) => {
    generationRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"content":"图片请求已发送"}\n\ndata: [DONE]\n\n' });
  });

  try {
    await page.goto('/images/queued-image');
    await page.getByRole('button', { name: '以此图编辑', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('notes'),
    });
    await expect(page.locator('.file-preview-item.uploading')).toContainText('正在处理文件…');

    const textarea = page.getByPlaceholder('描述你希望如何修改这张图片...');
    await textarea.fill('结合附件调整图片');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(textarea).toBeDisabled();
    await expect(page.getByRole('button', { name: '移除编辑原图 queued-reference.png' })).toBeDisabled();
    expect(generationRequests).toHaveLength(0);

    releaseUpload?.();
    await expect(page.getByText('图片请求已发送')).toBeVisible();
    expect(generationRequests).toHaveLength(1);
    expect(generationRequests[0]).toMatchObject({
      prompt: '结合附件调整图片',
      conversation_id: 'queued-image',
      original_gen_id: 'queued-reference-gen',
      original_file_id: 'queued-reference',
    });
    expect(generationRequests[0].attachments).toEqual([expect.objectContaining({ file_id: 'queued-notes' })]);
  } finally {
    releaseUpload?.();
    await new Promise<void>((resolve, reject) => uploadServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('图片加载前后保持稳定尺寸，并可打开和关闭原图预览', async ({ page }) => {
  await authenticate(page);
  const portrait = { ...image('portrait', 'portrait-gen', 1), width: 800, height: 1200 };
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  await page.route('**/api/conversations/layout', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'layout', title: '布局', model: 'gpt-5-6-thinking' }, messages: [{ id: 'portrait-message', role: 'assistant', content: '', images: [portrait] }] }),
  }));
  await page.route('**/api/models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [{ label: '5.6 中', model: 'gpt-5-6-thinking', thinking_effort: 'standard' }] }) }));
  await page.route('**/api/files/portrait/download', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });

  await page.goto('/images/layout');
  const frame = page.locator('.message-image-frame');
  await expect(frame).toBeVisible();
  const before = await frame.boundingBox();
  await expect(page.getByAltText('portrait.png')).toBeVisible();
  const after = await frame.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
  expect(after!.height).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)) * 0.7 + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole('button', { name: '查看原图 portrait.png' }).click();
  await expect(page.getByRole('dialog', { name: '原图预览 portrait.png' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '原图预览 portrait.png' })).toBeHidden();
});

test('历史图片进入可视区后才下载', async ({ page }) => {
  await authenticate(page);
  const lazyImages = Array.from({ length: 10 }, (_, index) => image(`lazy-${index + 1}`, `lazy-gen-${index + 1}`, index + 1));
  const downloaded = new Set<string>();
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[],"total":0}' }));
  await page.route('**/api/conversations/lazy', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ conversation: { id: 'lazy', title: '懒加载', model: 'gpt-5-6-thinking' }, messages: [{ id: 'lazy-images', role: 'assistant', content: '', images: lazyImages }] }),
  }));
  await page.route('**/api/models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ default_model: 'gpt-5-6-thinking', options: [{ label: '5.6 中', model: 'gpt-5-6-thinking', thinking_effort: 'standard' }] }) }));
  await page.route('**/api/files/*/download', async (route) => {
    const match = route.request().url().match(/\/api\/files\/([^/]+)\/download/);
    if (match) downloaded.add(match[1]);
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });

  await page.goto('/images/lazy');
  await expect(page.locator('.message-image-container')).toHaveCount(10);
  await expect.poll(() => downloaded.has('lazy-10')).toBe(true);
  expect(downloaded.size).toBeLessThan(10);
  await page.locator('.message-image-container').nth(4).scrollIntoViewIfNeeded();
  await expect.poll(() => downloaded.has('lazy-5')).toBe(true);
});
