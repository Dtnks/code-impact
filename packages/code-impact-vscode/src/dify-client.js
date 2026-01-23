'use strict';

const { fetch, FormData, File } = require('undici');

// 个人使用：直接内置默认的云端地址与 API Key，可被外部覆盖
const DEFAULT_BASE_URL = 'https://api.dify.ai/v1';
// 新的 Agent 应用密钥
const DEFAULT_API_KEY = 'app-R0xzSSGP2LRWiBl6Ne2AI5D2';

/**
 * Dify API 客户端
 * 简化自 notify-bot，实现 Workflow 调用等能力
 */
class DifyClient {
    /**
     * @param {Object} config
     * @param {string} config.baseUrl - Dify API 基础 URL
     * @param {string} config.apiKey - Dify API Key
     */
    constructor(config = {}) {
        this.baseUrl = config.baseUrl || process.env.DIFY_BASE_URL || DEFAULT_BASE_URL;
        this.apiKey = config.apiKey || process.env.DIFY_API_KEY || DEFAULT_API_KEY;
        if (!this.apiKey) {
            throw new Error('DIFY_API_KEY 未设置');
        }
    }

    /**
     * 运行 Agent 应用（替代原 Workflow）
     * @param {Object} options
     * @param {Object} options.inputs - 传入的上下文（建议均为字符串）
     * @param {string} [options.query] - 用户 query，默认空字符串
     * @param {string} [options.user] - 用户标识
     * @param {boolean} [options.stream] - 是否流式
     * @param {string} [options.conversationId] - 会话 ID，用于保留上下文
     */
    async runAgent(options = {}) {
        const {
            inputs = {},
            query = '',
            user = 'code-impact-vscode',
            stream = true,
            conversationId,
        } = options;
        const url = `${this.baseUrl}/chat-messages`;
        const headers = { Authorization: `Bearer ${this.apiKey}` };

        const payload = {
            inputs,
            query,
            response_mode: stream ? 'streaming' : 'blocking',
            user,
        };
        if (conversationId) payload.conversation_id = conversationId;

        const response = await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Dify Agent 调用失败: ${response.status} ${response.statusText}\n${errorText}`);
        }
        if (stream) return response.body;
        return await response.json();
    }

    /**
     * 上传文件，返回 file_id
     * @param {Object} options
     * @param {Buffer|string} options.content
     * @param {string} options.fileName
     * @param {string} [options.mime]
     */
    async uploadFile(options = {}) {
        const { content, fileName, mime = 'application/octet-stream' } = options;
        if (!content || !fileName) {
            throw new Error('uploadFile 需要 content 和 fileName');
        }
        const url = `${this.baseUrl}/files/upload`;
        const fd = new FormData();
        const file = new File([content], fileName, { type: mime });
        fd.append('file', file);

        const resp = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}` },
            body: fd,
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`上传文件失败: ${resp.status} ${resp.statusText}\n${text}`);
        }
        const json = await resp.json();
        // Dify 返回 { data: { id, name, size, mime_type, ... } }
        const fileId = json?.id;
        if (!fileId) {
            throw new Error('上传文件成功但未返回 file_id');
        }
        return fileId;
    }
}

module.exports = { DifyClient };

