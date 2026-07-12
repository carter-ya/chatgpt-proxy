import { expect, test, type Page } from '@playwright/test';

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
