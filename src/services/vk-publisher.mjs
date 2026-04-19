import { withRetry, withTimeout, isRetryableHttpError } from './resilience.mjs';

const VK_API_VERSION = '5.199';
const VK_API_BASE_URL = 'https://api.vk.com/method';

export class VkPublishError extends Error {
  constructor(message, {
    code = 'vk_publish_error',
    providerCode = '',
    rawResponse = null,
    userMessage = 'Не получилось опубликовать материал в VK. Попробуй ещё раз.',
  } = {}) {
    super(message);
    this.name = 'VkPublishError';
    this.code = code;
    this.providerCode = providerCode || code;
    this.rawResponse = rawResponse;
    this.userMessage = userMessage;
  }
}

function toPositiveGroupId(value) {
  const normalized = String(value ?? '').trim().replace(/^-+/u, '');
  return normalized;
}

function buildAttachmentId(photo = {}) {
  return `photo${photo.owner_id}_${photo.id}`;
}

export default class VkPublisher {
  constructor({
    accessToken = '',
    groupId = '',
    enabled = false,
    apiVersion = VK_API_VERSION,
  } = {}) {
    this.accessToken = String(accessToken ?? '').trim();
    this.groupId = toPositiveGroupId(groupId);
    this.enabled = Boolean(enabled);
    this.apiVersion = apiVersion;
  }

  isConfigured() {
    return Boolean(this.enabled && this.accessToken && this.groupId);
  }

  async callMethod(method, params = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries({
      ...params,
      access_token: this.accessToken,
      v: this.apiVersion,
    })) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      body.set(key, String(value));
    }

    const response = await withRetry(
      () => withTimeout(
        (signal) => fetch(`${VK_API_BASE_URL}/${method}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body,
          signal,
        }),
        30_000,
        `VK ${method} timed out`,
      ),
      { retries: 2, delayMs: 400, shouldRetry: isRetryableHttpError },
    );

    if (!response.ok) {
      throw new VkPublishError(`VK ${method} failed with HTTP ${response.status}`, {
        code: 'vk_http_error',
        rawResponse: { method, status: response.status },
      });
    }

    const json = await response.json();
    if (json?.error) {
      throw new VkPublishError(
        json.error.error_msg || `VK ${method} failed`,
        {
          code: `vk_api_${json.error.error_code ?? 'error'}`,
          providerCode: String(json.error.error_code ?? ''),
          rawResponse: json,
        },
      );
    }

    return json?.response;
  }

  async uploadWallPhoto(image, index = 0) {
    const uploadServer = await this.callMethod('photos.getWallUploadServer', {
      group_id: this.groupId,
    });

    const form = new FormData();
    const fileName = String(image?.fileName ?? `vk-publish-${index + 1}.jpg`);
    const mimeType = String(image?.mimeType ?? 'image/jpeg');
    form.set('photo', new Blob([image.buffer], { type: mimeType }), fileName);

    const uploadResponse = await withRetry(
      () => withTimeout(
        (signal) => fetch(uploadServer.upload_url, {
          method: 'POST',
          body: form,
          signal,
        }),
        30_000,
        'VK upload timed out',
      ),
      { retries: 2, delayMs: 400, shouldRetry: isRetryableHttpError },
    );

    if (!uploadResponse.ok) {
      throw new VkPublishError(`VK upload failed with HTTP ${uploadResponse.status}`, {
        code: 'vk_upload_http_error',
        rawResponse: { status: uploadResponse.status },
      });
    }

    const uploadPayload = await uploadResponse.json();
    if (!uploadPayload?.photo || !uploadPayload?.server || !uploadPayload?.hash) {
      throw new VkPublishError('VK upload response is incomplete', {
        code: 'vk_upload_invalid_response',
        rawResponse: uploadPayload,
      });
    }

    const savedPhotos = await this.callMethod('photos.saveWallPhoto', {
      group_id: this.groupId,
      photo: uploadPayload.photo,
      server: uploadPayload.server,
      hash: uploadPayload.hash,
    });

    const savedPhoto = Array.isArray(savedPhotos) ? savedPhotos[0] : null;
    if (!savedPhoto?.owner_id || !savedPhoto?.id) {
      throw new VkPublishError('VK saveWallPhoto returned no saved photo', {
        code: 'vk_save_invalid_response',
        rawResponse: savedPhotos,
      });
    }

    return {
      uploadServer,
      uploadPayload,
      savedPhoto,
      attachmentId: buildAttachmentId(savedPhoto),
    };
  }

  async publishPost({ caption = '', images = [] } = {}) {
    if (!this.isConfigured()) {
      throw new VkPublishError('VK publishing is not configured', {
        code: 'vk_not_configured',
        userMessage: 'VK публикация пока не настроена.',
      });
    }
    if (!Array.isArray(images) || images.length === 0) {
      throw new VkPublishError('No images provided for VK publish', {
        code: 'vk_no_images',
      });
    }

    const uploaded = [];
    for (const [index, image] of images.entries()) {
      uploaded.push(await this.uploadWallPhoto(image, index));
    }

    const attachments = uploaded.map((entry) => entry.attachmentId);
    const post = await this.callMethod('wall.post', {
      owner_id: `-${this.groupId}`,
      from_group: 1,
      message: caption,
      attachments: attachments.join(','),
    });

    if (!post?.post_id) {
      throw new VkPublishError('VK wall.post returned no post_id', {
        code: 'vk_post_invalid_response',
        rawResponse: post,
      });
    }

    return {
      channel: 'vk',
      ownerId: `-${this.groupId}`,
      postId: String(post.post_id),
      attachmentIds: attachments,
      rawResponse: {
        uploaded: uploaded.map((entry) => ({
          savedPhoto: entry.savedPhoto,
        })),
        post,
      },
    };
  }
}
