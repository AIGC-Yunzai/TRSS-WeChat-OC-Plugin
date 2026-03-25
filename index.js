logger.info(logger.yellow("- 正在加载 微信个人号 适配器插件"))

import makeConfig from "../../lib/plugins/config.js"
import fetch from "node-fetch"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import QRCode from "qrcode"

// 默认配置
export const { config, configSave } = await makeConfig("WeixinOC", {
  tips: "",
  // 微信 ilink API 配置
  base_url: "https://ilinkai.weixin.qq.com",
  cdn_base_url: "https://novac2c.cdn.weixin.qq.com/c2c",
  bot_type: "3",  // 机器人类型
  qr_poll_interval: 2000,  // 二维码轮询间隔(ms)
  long_poll_timeout: 35000,  // 长轮询超时(ms)
  api_timeout: 15000,  // API 超时(ms)
  // 账号配置 (扫码登录后会自动保存)
  accounts: [],  // { bot_id, token, account_id, user_id, nickname }
  debug: false,
}, {
  tips: [
    "欢迎使用 TRSS-Yunzai 微信个人号适配器插件!",
    "使用 #微信登录 进行扫码登录",
    "主页: https://github.com/AIGC-Yunzai/TRSS-WeChat-OC-Plugin",
  ],
})

// 工具函数：AES 加密/解密
const AESUtils = {
  getAlgorithm(key) {
    switch (key.length) {
      case 16:
        return "aes-128-ecb"
      case 24:
        return "aes-192-ecb"
      case 32:
        return "aes-256-ecb"
      default:
        throw new Error(`Unsupported AES key length: ${key.length}`)
    }
  },

  // PKCS7 填充 - 与Python cryptography 库兼容
  pkcs7Pad(data, blockSize = 16) {
    const padLen = blockSize - (data.length % blockSize)
    // 当数据长度正好是blockSize倍数时，添加一个完整block的填充
    return Buffer.concat([data, Buffer.alloc(padLen, padLen)])
  },

  // PKCS7 去填充
  pkcs7Unpad(data, blockSize = 16) {
    if (!data || data.length === 0) return data
    const padLen = data[data.length - 1]
    if (padLen <= 0 || padLen > blockSize) return data
    return data.slice(0, -padLen)
  },

  // AES ECB 加密 (手动填充，禁用自动填充)
  encrypt(data, key) {
    const cipher = crypto.createCipheriv(AESUtils.getAlgorithm(key), key, null)
    cipher.setAutoPadding(false)  // 禁用自动填充，因为我们已经手动填充了
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
    return encrypted
  },

  // AES ECB 解密 (手动去填充，禁用自动填充)
  decrypt(data, key) {
    const decipher = crypto.createDecipheriv(AESUtils.getAlgorithm(key), key, null)
    decipher.setAutoPadding(false)  // 禁用自动填充
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
    return AESUtils.pkcs7Unpad(decrypted)  // 手动去填充
  },
}

// 微信 OC 客户端
class WeixinClient {
  constructor(options) {
    this.id = options.id
    this.baseUrl = options.baseUrl || config.base_url
    this.cdnBaseUrl = options.cdnBaseUrl || config.cdn_base_url
    this.apiTimeout = options.apiTimeout || config.api_timeout
    this.token = options.token || null
  }

  // 构建请求头
  _buildHeaders(tokenRequired = false) {
    const headers = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 4294967296))).toString("base64"),
    }
    if (tokenRequired && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`
    }
    return headers
  }

  // HTTP 请求
  async request(method, endpoint, options = {}) {
    let url = `${this.baseUrl}/${endpoint.replace(/^\//, "")}`
    const headers = { ...this._buildHeaders(options.tokenRequired), ...options.headers }

    const fetchOptions = {
      method,
      headers,
      timeout: options.timeout || this.apiTimeout,
    }

    if (options.params) {
      const urlObj = new URL(url)
      for (const [key, value] of Object.entries(options.params)) {
        urlObj.searchParams.set(key, value)
      }
      url = urlObj.toString()
    }

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body)
    }

    const response = await fetch(url, fetchOptions)
    const text = await response.text()

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    return text ? JSON.parse(text) : {}
  }

  // 获取登录二维码
  async getQRCode() {
    return this.request("GET", "ilink/bot/get_bot_qrcode", {
      params: { bot_type: config.bot_type },
      timeout: 15000,
    })
  }

  // 轮询二维码状态
  async pollQRStatus(qrcode) {
    return this.request("GET", "ilink/bot/get_qrcode_status", {
      params: { qrcode },
      timeout: config.long_poll_timeout,
      headers: { "iLink-App-ClientVersion": "1" },
    })
  }

  // 获取消息更新 (长轮询)
  async getUpdates(syncBuf) {
    return this.request("POST", "ilink/bot/getupdates", {
      body: {
        base_info: { channel_version: "yunzai" },
        get_updates_buf: syncBuf || "",
      },
      tokenRequired: true,
      timeout: config.long_poll_timeout,
    })
  }

  // 发送消息
  async sendMessage(toUserId, itemList, contextToken) {
    return this.request("POST", "ilink/bot/sendmessage", {
      body: {
        base_info: { channel_version: "yunzai" },
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: crypto.randomUUID().replace(/-/g, ""),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: itemList,
        },
      },
      tokenRequired: true,
    })
  }

  // 获取上传 URL
  async getUploadUrl(params) {
    return this.request("POST", "ilink/bot/getuploadurl", {
      body: params,
      tokenRequired: true,
    })
  }

  // 上传文件到 CDN
  async uploadToCdn(uploadParam, fileKey, aesKeyHex, fileBuffer) {
    const key = Buffer.from(aesKeyHex, "hex")
    const paddedData = AESUtils.pkcs7Pad(fileBuffer)
    const encrypted = AESUtils.encrypt(paddedData, key)

    if (config.debug) {
      logger.mark(`CDN上传: rawSize=${fileBuffer.length}, paddedSize=${paddedData.length}, encryptedSize=${encrypted.length}`)
      logger.mark(`CDN上传: aesKeyHex=${aesKeyHex.slice(0, 16)}..., keyLength=${key.length}`)
    }

    const url = `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`

    const response = await fetch(url, {
      method: "POST",
      body: encrypted,
      headers: { "Content-Type": "application/octet-stream" },
      timeout: this.apiTimeout,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`CDN upload failed: ${response.status} ${text}`)
    }

    return response.headers.get("x-encrypted-param")
  }

  // 从 CDN 下载文件
  async downloadFromCdn(encryptedQueryParam) {
    const url = `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
    const response = await fetch(url, { timeout: this.apiTimeout })
    if (!response.ok) throw new Error(`CDN download failed: ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
}

// 适配器实现
export const adapter = new class WeixinOCAdapter {
  id = "WeixinOC"
  name = "微信个人号"
  version = "v1.0.0"

  constructor() {
    // 存储 bot 实例
    this.bots = new Map()
    // 存储登录会话
    this.loginSessions = new Map()
    // 存储上下文 token (用于回复)
    this.contextTokens = new Map()
    // 同步缓冲区
    this.syncBuffers = new Map()
    // 防抖保存定时器
    this._saveTimer = null
    // 待保存的账号数据
    this._pendingSave = new Set()
    // 消息去重缓存
    this._messageCache = new Map()
    this._messageStore = new Map()
    // 防止重复加载
    this._loaded = false
  }

  /**
   * 生成新的 weixin_personal_XXX ID
   */
  _getNextBotId() {
    let num = 1
    while (true) {
      const id = `weixin_personal_${String(num).padStart(3, "0")}`
      // 检查配置中是否已存在
      const inConfig = config.accounts?.some(a => a.bot_id === id)
      // 检查 Bot 对象中是否已存在
      const inBot = !!Bot[id]

      if (!inConfig && !inBot) {
        return id
      }
      num++
    }
  }

  /**
   * 日志内容过滤，移除敏感信息和过长内容
   * @param {any} msg - 原始消息内容
   * @returns {string} - 过滤后的字符串
   */
  makeLog(msg) {
    return this._sanitizeLogString(Bot.String(msg)).slice(0, 500)
  }

  _sanitizeLogString(text) {
    return String(text)
      .replace(/encrypt_query_param=[^&\s"]*/g, "encrypt_query_param=...")
      .replace(/base64:\/\/[A-Za-z0-9+/=]+/g, value => this._summarizeBase64String(value))
  }

  _summarizeBase64String(value) {
    if (typeof value !== "string" || !value.startsWith("base64://")) return value

    const base64 = value.slice("base64://".length)
    const preview = base64.slice(0, 16)
    let bytes = 0

    try {
      bytes = Buffer.from(base64, "base64").length
    } catch {}

    return `base64://${preview}... [bytes=${bytes}]`
  }

  _sanitizeDebugValue(value, seen = new WeakSet()) {
    if (typeof value === "string") return this._sanitizeLogString(value)
    if (!value || typeof value !== "object") return value
    if (seen.has(value)) return "[Circular]"

    seen.add(value)

    if (Array.isArray(value)) {
      return value.map(item => this._sanitizeDebugValue(item, seen))
    }

    const sanitized = {}
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = this._sanitizeDebugValue(item, seen)
    }
    return sanitized
  }

  _debugStringify(value) {
    return JSON.stringify(this._sanitizeDebugValue(value), null, 2)
  }

  _cacheMessage(botId, message) {
    if (!message?.message_id) return

    this._messageStore.set(`${botId}:${message.message_id}`, message)
    if (this._messageStore.size > 1000) {
      const keys = Array.from(this._messageStore.keys())
      for (const key of keys.slice(0, keys.length - 500)) {
        this._messageStore.delete(key)
      }
    }
  }

  _getCachedMessage(botId, messageId) {
    if (!messageId) return null
    return this._messageStore.get(`${botId}:${String(messageId)}`) || null
  }

  _makeQuoteMessageId(botId, messageId) {
    return `quote:${botId}:${messageId}`
  }

  _buildQuotedSource(botId, msg, quote) {
    if (!quote?.message?.length) return null

    const messageId = this._makeQuoteMessageId(botId, msg.message_id || msg.msg_id || this._makeMessageId())
    const fromUserId = msg.from_user_id
    const sender = {
      user_id: `wx_${fromUserId}`,
      nickname: msg.from_user_name || fromUserId,
    }

    return {
      bot: Bot[botId],
      self_id: botId,
      post_type: "message",
      message_type: "private",
      message_id: messageId,
      user_id: sender.user_id,
      sender,
      message: quote.message,
      raw_message: quote.raw_message,
      quote: null,
      quote_message: [],
      quote_raw_message: "",
      original_message: quote.message,
      original_raw_message: quote.raw_message,
      time: messageId,
      seq: messageId,
    }
  }

  /**
   * 防抖保存配置
   * @param {string} userId - 需要保存的账号 user_id
   */
  configSaveDebounced(userId) {
    if (userId) this._pendingSave.add(userId)

    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(async () => {
      if (this._pendingSave.size > 0) {
        await configSave()
        this._pendingSave.clear()
      }
    }, 30000)
  }

  // 生成消息 ID
  _makeMessageId() {
    return `${Date.now()}${Math.floor(Math.random() * 1000)}`
  }

  _normalizeForwardEntries(entries, rawMessage = "") {
    const normalized = []

    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (entry == null) continue

      if (typeof entry === "object" && !Array.isArray(entry) && ("message" in entry || "content" in entry)) {
        const message = entry.message ?? entry.content
        if (message == null) continue
        normalized.push({ ...entry, message })
      } else {
        normalized.push({ message: entry })
      }
    }

    const headerText = typeof rawMessage === "string" ? rawMessage.trim() : ""
    while (headerText && normalized.length) {
      const current = normalized[0]?.message
      if (typeof current !== "string" || current.trim() !== headerText) break
      normalized.shift()
    }

    if (!headerText && normalized.length > 1) {
      const first = normalized[0]?.message
      if (typeof first === "string" && first.trim().startsWith("#")) normalized.shift()
    }

    if (normalized.length % 2 === 0 && normalized.length > 0) {
      const half = normalized.length / 2
      const duplicated = normalized.slice(0, half).every((entry, index) => {
        const left = Bot.String(entry?.message ?? "")
        const right = Bot.String(normalized[index + half]?.message ?? "")
        return left === right
      })
      if (duplicated) return normalized.slice(0, half)
    }

    const seen = new Set()
    return normalized.filter(entry => {
      const message = entry?.message
      if (normalized.length > 1 && typeof message === "string" && message.trim().startsWith("#")) return false

      let key
      try {
        key = JSON.stringify(message)
      } catch {
        key = Bot.String(message)
      }

      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  _decodeMediaAesKey(aesKey) {
    if (!aesKey || typeof aesKey !== "string") return null

    const trimmed = aesKey.trim()
    if (!trimmed) return null

    if (/^[0-9a-fA-F]{32}$/.test(trimmed) || /^[0-9a-fA-F]{48}$/.test(trimmed) || /^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, "hex")
    }

    try {
      const decoded = Buffer.from(trimmed, "base64")
      const decodedText = decoded.toString("utf8").trim()

      if (/^[0-9a-fA-F]{32}$/.test(decodedText) || /^[0-9a-fA-F]{48}$/.test(decodedText) || /^[0-9a-fA-F]{64}$/.test(decodedText)) {
        return Buffer.from(decodedText, "hex")
      }

      if ([16, 24, 32].includes(decoded.length)) return decoded
    } catch {}

    return null
  }

  async _decodeInboundImage(botId, item) {
    const bot = Bot[botId]
    const imageItem = item?.image_item || {}
    const media = imageItem.media || {}
    const encryptedQueryParam = media.encrypt_query_param
    if (!bot?.client || !encryptedQueryParam) return null

    const aesKey = this._decodeMediaAesKey(imageItem.aeskey || media.aes_key)

    try {
      const encryptedBuffer = await bot.client.downloadFromCdn(encryptedQueryParam)
      if (!aesKey) return encryptedBuffer
      return AESUtils.decrypt(encryptedBuffer, aesKey)
    } catch (err) {
      logger.error("下载引用图片失败:", err)
      return null
    }
  }

  _collectQuotedItems(item, quotedItems = []) {
    const refMsg = item?.ref_msg
    const refItem = refMsg?.message_item

    if (refItem && typeof refItem === "object") {
      quotedItems.push(refItem)
      this._collectQuotedItems(refItem, quotedItems)
    }

    return quotedItems
  }

  async _parseQuotedItems(botId, itemList) {
    const quotedItems = []
    const quoteMessage = []
    const quoteRawParts = []
    const textSet = new Set()
    const imageSet = new Set()

    for (const item of itemList || []) {
      this._collectQuotedItems(item, quotedItems)
    }

    if (config.debug) {
      logger.mark("引用解析: 原始 item_list =", this._debugStringify(itemList || []))
      logger.mark("引用解析: 提取到的 ref message_item =", this._debugStringify(quotedItems))
    }

    for (const item of quotedItems) {
      const type = item?.type

      if (type === 1) {
        const text = item.text_item?.text?.trim?.() || ""
        if (text && !textSet.has(text)) {
          textSet.add(text)
          quoteMessage.push({ type: "text", text })
          quoteRawParts.push(text)
        }
        continue
      }

      if (type === 2) {
        const imageKey = item.image_item?.media?.encrypt_query_param
        if (!imageKey || imageSet.has(imageKey)) continue

        imageSet.add(imageKey)
        const imageBuffer = await this._decodeInboundImage(botId, item)
        if (imageBuffer) {
          quoteMessage.push(segment.image(`base64://${imageBuffer.toString("base64")}`))
        } else {
          quoteMessage.push({ type: "text", text: "[引用图片]" })
        }
        quoteRawParts.push("[引用图片]")
      }
    }

    return {
      message: quoteMessage,
      raw_message: quoteRawParts.join(" "),
    }
  }

  // 解析消息内容
  _parseItemList(itemList) {
    const message = []
    const rawMessage = []

    for (const item of itemList || []) {
      const type = item.type

      switch (type) {
        case 1: // 文本
          const text = item.text_item?.text || ""
          if (text) {
            message.push({ type: "text", text })
            rawMessage.push(text)
          }
          break

        case 2: // 图片
          message.push({ type: "image", url: item.image_item?.media?.encrypt_query_param })
          rawMessage.push("[图片]")
          break

        case 3: // 语音
          const voiceText = item.voice_item?.text
          if (voiceText) {
            message.push({ type: "text", text: voiceText })
            rawMessage.push(voiceText)
          } else {
            message.push({ type: "record", url: item.voice_item?.media?.encrypt_query_param })
            rawMessage.push("[语音]")
          }
          break

        case 4: // 文件
          message.push({
            type: "file",
            name: item.file_item?.file_name || "file",
            url: item.file_item?.media?.encrypt_query_param,
          })
          rawMessage.push("[文件]")
          break

        case 5: // 视频
          message.push({ type: "video", url: item.video_item?.media?.encrypt_query_param })
          rawMessage.push("[视频]")
          break

        default:
          rawMessage.push(`[未知类型:${type}]`)
      }
    }

    return { message, raw_message: rawMessage.join(" ") }
  }

  // 构建 Yunzai 消息数据
  async makeMessage(botId, msg) {
    const fromUserId = msg.from_user_id
    const messageId = msg.message_id || msg.msg_id || this._makeMessageId()
    const clientId = msg.client_id || ""

    // 消息去重：使用 msg_id + client_id 组合
    const dedupKey = `${botId}:${messageId}:${clientId}`
    if (this._messageCache.has(dedupKey)) {
      return  // 重复消息，忽略
    }
    // 缓存消息 ID，限制缓存大小
    this._messageCache.set(dedupKey, Date.now())
    if (this._messageCache.size > 1000) {
      // 清理旧缓存（保留最近500条）
      const entries = Array.from(this._messageCache.entries())
      this._messageCache.clear()
      entries.slice(-500).forEach(([k, v]) => this._messageCache.set(k, v))
    }

    const { message, raw_message } = this._parseItemList(msg.item_list)
    const quote = await this._parseQuotedItems(botId, msg.item_list)
    const quotedSource = this._buildQuotedSource(botId, msg, quote)
    const mergedMessage = [...message]
    let mergedRawMessage = raw_message

    if (quotedSource) {
      mergedMessage.unshift({ type: "reply", id: quotedSource.message_id })
      this._cacheMessage(botId, quotedSource)
    }

    if (quote.message.length) {
      mergedMessage.push({ type: "text", text: "\n[引用]" })
      mergedMessage.push(...quote.message)
    }

    if (quote.raw_message) {
      mergedRawMessage = [raw_message, `[引用] ${quote.raw_message}`].filter(Boolean).join("\n")
    }

    // 保存上下文 token (用于回复)
    const contextToken = msg.context_token
    if (contextToken) {
      this.contextTokens.set(`${botId}:${fromUserId}`, contextToken)
    }

    const data = {
      bot: Bot[botId],
      self_id: botId,
      raw: msg,

      post_type: "message",
      message_type: "private",
      user_id: `wx_${fromUserId}`,
      sender: {
        user_id: `wx_${fromUserId}`,
        nickname: msg.from_user_name || fromUserId,
      },
      message_id: messageId,
      message: mergedMessage,
      raw_message: mergedRawMessage,
      quote,
      source: quotedSource ? {
        message_id: quotedSource.message_id,
        seq: quotedSource.seq,
        time: quotedSource.time,
        user_id: quotedSource.user_id,
        message: quotedSource.message,
        raw_message: quotedSource.raw_message,
        sender: quotedSource.sender,
      } : undefined,
      reply_id: quotedSource?.message_id,
      quote_message: quote.message,
      quote_raw_message: quote.raw_message,
      original_message: message,
      original_raw_message: raw_message,
    }

    this._cacheMessage(botId, data)

    if (config.debug) {
      logger.mark("引用解析: quote_raw_message =", data.quote_raw_message || "")
      logger.mark("引用解析: quote_message =", this._debugStringify(data.quote_message || []))
      logger.mark("引用解析: source =", this._debugStringify(data.source || {}))
      logger.mark("引用解析: final message =", this._debugStringify(data.message || []))
      logger.mark("引用解析: final raw_message =", data.raw_message || "")
    }

    Bot[botId].fl.set(data.user_id, data.sender)

    Bot.makeLog("info", `好友消息：[${data.sender.nickname}] ${this.makeLog(mergedRawMessage)}`, botId)
    Bot.em(`${data.post_type}.${data.message_type}`, data)
  }

  // 上传文件到微信 CDN
  async uploadMedia(botId, file, toUserId = "") {
    const bot = Bot[botId]
    if (!bot) throw new Error("Bot not found")

    // 获取文件 buffer
    let fileBuffer
    let fileName = "file"

    if (Buffer.isBuffer(file)) {
      fileBuffer = file
    } else if (typeof file === "string") {
      if (file.startsWith("http")) {
        // 下载网络文件
        const response = await fetch(file)
        fileBuffer = Buffer.from(await response.arrayBuffer())
        fileName = path.basename(new URL(file).pathname) || "file"
      } else if (file.startsWith("base64://")) {
        // 处理 base64 格式的媒体数据
        const base64Data = file.replace(/^base64:\/\//, "")
        fileBuffer = Buffer.from(base64Data, "base64")
        fileName = "base64_file" // 后续代码有魔数检测，会自动判断出正确的格式(jpg/png等)
      } else if (file.startsWith("file://")) {
        // 兼容 file:// 协议的文件路径
        const filePath = file.replace(/^file:\/\//, "")
        fileBuffer = fs.readFileSync(filePath)
        fileName = path.basename(filePath)
      } else {
        // 本地文件
        fileBuffer = fs.readFileSync(file)
        fileName = path.basename(file)
      }
    }

    const fileKey = crypto.randomUUID().replace(/-/g, "")
    const aesKeyHex = crypto.randomUUID().replace(/-/g, "")
    const rawMd5 = crypto.createHash("md5").update(fileBuffer).digest("hex")
    const cipherSize = fileBuffer.length + (16 - (fileBuffer.length % 16) || 16)  // AES 填充后大小

    // 判断媒体类型 - 优先通过文件内容检测
    let mediaType = 3  // 文件
    let itemType = 4

    // 尝试通过文件扩展名判断
    const ext = path.extname(fileName).toLowerCase()
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
      mediaType = 1
      itemType = 2
    } else if ([".mp4", ".avi", ".mov", ".mkv", ".flv"].includes(ext)) {
      mediaType = 2
      itemType = 5
    }

    // 如果无法通过扩展名判断，尝试通过文件内容魔数检测
    if (itemType === 4 && fileBuffer.length > 4) {
      // 检查文件魔数
      const header = fileBuffer.slice(0, 4).toString("hex")
      if (header.startsWith("ffd8ff")) {  // JPEG
        mediaType = 1
        itemType = 2
        fileName = "image.jpg"
      } else if (header.startsWith("89504e47")) {  // PNG
        mediaType = 1
        itemType = 2
        fileName = "image.png"
      } else if (header.startsWith("47494638")) {  // GIF
        mediaType = 1
        itemType = 2
        fileName = "image.gif"
      } else if (header.startsWith("52494646") || header.startsWith("57454250")) {  // WEBP
        mediaType = 1
        itemType = 2
        fileName = "image.webp"
      }
    }

    // 获取上传 URL
    const uploadUrlRes = await bot.client.getUploadUrl({
      filekey: fileKey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: fileBuffer.length,
      rawfilemd5: rawMd5,
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: { channel_version: "yunzai" },
    })

    if (config.debug)
      logger.mark("getUploadUrl 响应:", uploadUrlRes)

    const uploadParam = uploadUrlRes.upload_param
    if (!uploadParam) throw new Error(`Failed to get upload URL: ${JSON.stringify(uploadUrlRes)}`)

    // 上传文件
    const encryptedParam = await bot.client.uploadToCdn(uploadParam, fileKey, aesKeyHex, fileBuffer)

    if (config.debug)
      logger.mark("CDN 上传返回 encryptedParam:", encryptedParam?.slice(0, 50) + "...")

    const aesKeyB64 = Buffer.from(aesKeyHex, "utf8").toString("base64")
    if (config.debug)
      logger.mark(`aes_key base64: ${aesKeyB64.slice(0, 40)}..., length=${aesKeyB64.length}`)

    return {
      media: {
        encrypt_query_param: encryptedParam,
        aes_key: aesKeyB64,
        encrypt_type: 1,
      },
      fileSize: cipherSize,
      rawSize: fileBuffer.length,
    }
  }

  // 构建消息项 - 标准化与 Yunzai segment 兼容
  async makeMsg(data, msg) {
    if (!Array.isArray(msg)) msg = [msg]

    const itemList = []
    const msgs = []
    const forward = []

    for (let i of msg) {
      // 标准化消息格式
      if (typeof i !== "object") i = { type: "text", data: { text: i } }
      else if (!i.data) i = { type: i.type, data: { ...i, type: undefined } }

      switch (i.type) {
        case "text":
          if (i.data.text) {
            msgs.push({ type: "text", text: i.data.text })
            itemList.push({ type: 1, text_item: { text: i.data.text } })
          }
          break

        case "image":
          try {
            const userId = data.user_id?.replace(/^wx_/, "") || ""
            const { media, fileSize } = await this.uploadMedia(data.self_id, i.data.file || i.data.url, userId)
            msgs.push({ type: "image", ...i.data })
            itemList.push({
              type: 2,
              image_item: { media, mid_size: fileSize },
            })
          } catch (err) {
            logger.error("上传图片失败:", err)
            itemList.push({ type: 1, text_item: { text: "[图片上传失败]" } })
          }
          break

        case "video":
          try {
            const userId = data.user_id?.replace(/^wx_/, "") || ""
            const { media, fileSize } = await this.uploadMedia(data.self_id, i.data.file || i.data.url, userId)
            msgs.push({ type: "video", ...i.data })
            itemList.push({
              type: 5,
              video_item: { media, video_size: fileSize },
            })
          } catch (err) {
            logger.error("上传视频失败:", err)
            itemList.push({ type: 1, text_item: { text: "[视频上传失败]" } })
          }
          break

        case "file":
          try {
            const userId = data.user_id?.replace(/^wx_/, "") || ""
            const { media, rawSize } = await this.uploadMedia(data.self_id, i.data.file || i.data.url, userId)
            msgs.push({ type: "file", ...i.data })
            itemList.push({
              type: 4,
              file_item: {
                media,
                file_name: i.data.name || "file",
                len: String(rawSize),
              },
            })
          } catch (err) {
            logger.error("上传文件失败:", err)
            itemList.push({ type: 1, text_item: { text: "[文件上传失败]" } })
          }
          break

        case "record":
          // 微信语音需要 silk 格式，暂不支持
          msgs.push({ type: "text", text: "[语音消息暂不支持]" })
          itemList.push({ type: 1, text_item: { text: "[语音消息暂不支持]" } })
          break

        case "at":
        case "reply":
          // 微信个人号不支持 AT 和回复功能，跳过
          continue

        case "node":
          forward.push(...this._normalizeForwardEntries(i.data, data.raw_message))
          // 转发消息，暂不支持
          forward.push(...i.data)
          continue

        case "raw":
          // 原始数据透传
          msgs.push(i.data)
          break

        default:
          // 未知类型转为文本
          const text = JSON.stringify(i)
          msgs.push({ type: "text", text })
          itemList.push({ type: 1, text_item: { text } })
      }
    }

    return { itemList, msgs, forward }
  }

  // 发送好友消息
  async sendFriendMsg(data, msg) {
    const botId = data.self_id
    const userId = data.user_id.replace(/^wx_/, "")
    const segmentTypes = (Array.isArray(msg) ? msg : [msg]).map(item => {
      if (typeof item !== "object" || item === null) return typeof item
      return item.type || "object"
    })

    const { itemList, msgs, forward } = await this.makeMsg(data, msg)
    const normalizedForward = this._normalizeForwardEntries(forward, data.raw_message)
    Bot.makeLog("info", `发送好友消息：[${data.user_id}] ${this.makeLog(msgs)}`, botId, true)

    const contextToken = this.contextTokens.get(`${botId}:${userId}`)
    if (!contextToken) {
      Bot.makeLog("error", "缺少上下文 token，无法发送消息", botId)
      return { error: "缺少上下文 token" }
    }

    if (!itemList.length && !normalizedForward.length) {
      const reason = "empty_or_unsupported_message"
      Bot.makeLog("info", `跳过空消息发送：[${data.user_id}] ${reason} types=${segmentTypes.join(",")}`, botId, true)
      return { data: { skipped: true, reason, segment_types: segmentTypes } }
    }

    try {
      if (!itemList.length) {
        if (config.debug)
          logger.mark(`发送转发兼容消息: count=${normalizedForward.length}`)
        const forwardResult = await Bot.sendForwardMsg(msg => this.sendFriendMsg(data, msg), normalizedForward)
        return { data: { forwarded: true, results: forwardResult } }
      }

      if (config.debug)
        logger.mark("发送消息 itemList:", this._debugStringify(itemList))
      const result = await Bot[botId].client.sendMessage(userId, itemList, contextToken)
      // 返回的 result = {} ，兼容云崽加个时间戳
      result.time ??= Date.now();
      if (config.debug)
        logger.mark("发送消息结果:", result)
      if (normalizedForward.length) {
        if (config.debug)
          logger.mark(`发送转发兼容消息: count=${normalizedForward.length}`)
        const forwardResult = await Bot.sendForwardMsg(msg => this.sendFriendMsg(data, msg), normalizedForward)
        return { data: { message: result, forward: forwardResult } }
      }
      return result
    } catch (err) {
      Bot.makeLog("error", `发送消息失败: ${err.message}`, botId)
      return { error: err.message }
    }
  }

  // 撤回消息 (微信个人号协议不支持)
  async recallMsg(data, messageId) {
    Bot.makeLog("info", `撤回消息：${messageId} (不支持)`, data.self_id)
    return { error: "微信个人号协议不支持撤回消息" }
  }

  // 获取好友信息
  async getFriendInfo(data) {
    // 微信 ilink 协议没有直接获取用户信息接口
    return {
      user_id: data.user_id,
      nickname: data.sender?.nickname || data.user_id,
    }
  }

  // pickFriend 实现 - 兼容 OneBotv11 签名
  async getMsg(data, message_id) {
    return this._getCachedMessage(data.self_id, message_id)
  }

  async getFriendMsgHistory(data, message_seq, count = 1) {
    const message = this._getCachedMessage(data.self_id, message_seq)
    if (!message) return []
    return Array.from({ length: Math.max(1, count) }, () => message).slice(0, 1)
  }

  pickFriend(data, user_id) {
    const self_id = data.self_id
    if (typeof user_id !== "string") user_id = String(user_id)
    user_id = user_id.replace(/^wx_/, "")

    const full_user_id = `wx_${user_id}`

    const i = {
      ...Bot[self_id]?.fl?.get(full_user_id),
      self_id,
      bot: Bot[self_id],
      user_id: full_user_id,
    }

    return {
      ...i,
      sendMsg: msg => this.sendFriendMsg(i, msg),
      getMsg: message_id => this.getMsg(i, message_id),
      recallMsg: message_id => this.recallMsg(i, message_id),
      getInfo: () => this.getFriendInfo(i),
      getChatHistory: (message_seq, count, reverseOrder = true) => this.getFriendMsgHistory(i, message_seq, count, reverseOrder),
      getAvatarUrl: () => Promise.resolve(""),  // 微信不提供
    }
  }

  // 消息轮询循环
  async startPolling(botId) {
    const bot = Bot[botId]
    if (!bot) return

    while (Bot[botId] && !Bot[botId]._stop) {
      try {
        const syncBuf = this.syncBuffers.get(botId) || ""
        const result = await bot.client.getUpdates(syncBuf)

        if (result.get_updates_buf) {
          this.syncBuffers.set(botId, result.get_updates_buf)
          // 防抖保存配置，避免频繁磁盘写入
          const account = config.accounts.find(a => a.bot_id === botId)
          if (account) {
            account.sync_buf = result.get_updates_buf
            this.configSaveDebounced(account.user_id)
          }
        }

        // 处理消息
        for (const msg of result.msgs || []) {
          if (Bot[botId]?._stop) break
          await this.makeMessage(botId, msg)
        }
      } catch (err) {
        if (err.message?.includes("timeout")) {
          // 长轮询超时是正常的，继续
          continue
        }
        // Token 失效检测
        if (err.message?.includes("401") || err.message?.includes("403") || err.message?.includes("invalid token")) {
          Bot.makeLog("error", `Token 已过期，需要重新登录: ${err.message}`, botId)
          Bot[botId]._needRelogin = true
          Bot[botId]._stop = true
          continue
        }
        Bot.makeLog("error", `消息轮询错误: ${err.message}`, botId)
        await Bot.sleep(5000)
      }
    }
  }

  // 连接微信
  async connect(accountConfig = null) {
    const client = new WeixinClient({
      id: "temp",
      baseUrl: config.base_url,
      cdnBaseUrl: config.cdn_base_url,
      apiTimeout: config.api_timeout,
      token: accountConfig?.token,
    })

    // 如果没有 token，需要扫码登录
    if (!accountConfig?.token) {
      return { needLogin: true, client }
    }

    // 验证 token 是否有效 (通过调用 getUpdates)
    try {
      await client.getUpdates(accountConfig.sync_buf || "")
    } catch (err) {
      if (err.message?.includes("401") || err.message?.includes("403")) {
        return { needLogin: true, client, error: "Token 已过期，需要重新登录" }
      }
    }

    // Token 有效，创建 bot
    return this.createBot(accountConfig, client)
  }

  // 创建 Bot 实例
  async createBot(accountConfig, client) {
    const id = accountConfig.bot_id

    Bot[id] = {
      adapter: this,
      client: client,

      info: {
        user_id: accountConfig.user_id, // 记录真实的微信 ID 供内部逻辑参考
        nickname: accountConfig.nickname || accountConfig.user_id,
      },
      uin: id, // 使用 weixin_personal_XXX 作为系统识别 Uin，防止和用户 uid 撞车
      get nickname() { return this.info.nickname },
      version: {
        id: this.id,
        name: this.name,
        version: this.version,
      },
      stat: { start_time: Date.now() / 1000 },

      pickFriend: (user_id) => this.pickFriend({ self_id: id }, user_id),
      get pickUser() { return this.pickFriend },

      fl: new Map(),
      gl: new Map(),  // 微信个人号没有群组
      gml: new Map(),

      _stop: false,
    }

    // 注册到 Bot.bots，供 prepareEvent 使用
    Bot.bots[id] = Bot[id]
    this.bots.set(id, Bot[id])

    // 启动消息轮询
    this.startPolling(id)

    Bot.makeLog("mark", `${this.name}(${this.id}) 已连接: ${accountConfig.nickname}`, id)
    Bot.em(`connect.${id}`, { self_id: id })

    return { success: true, id }
  }

  // 加载所有账号
  async load() {
    // 防止重复加载
    if (this._loaded) return
    this._loaded = true

    let needSave = false

    for (const account of config.accounts || []) {
      // 兼容旧配置：如果没有 bot_id，为其分配一个并保存
      if (!account.bot_id) {
        account.bot_id = this._getNextBotId()
        needSave = true
      }

      const botId = account.bot_id
      // 跳过已连接的账号
      if (Bot[botId] && !Bot[botId]._stop) {
        Bot.makeLog("info", `微信账号已在连接中: ${account.nickname || account.user_id}`, "WeixinOC")
        continue
      }
      if (account.token) {
        Bot.makeLog("info", `正在连接微信账号: ${account.nickname || account.user_id}`, "WeixinOC")
        await Bot.sleep(2000, this.connect(account))
      }
    }

    if (needSave) {
      await configSave()
    }
  }

  // 销毁 Bot 实例并清理资源
  async destroyBot(botId) {
    if (Bot[botId]) {
      Bot[botId]._stop = true
      await Bot.sleep(1000)  // 等待轮询退出

      // 清理资源
      this.bots.delete(botId)
      this.syncBuffers.delete(botId)
      this.contextTokens.delete(botId)
      delete Bot.bots[botId]
      delete Bot[botId]

      Bot.makeLog("mark", `${this.name} 已断开: ${botId}`, botId)
    }
  }

  // 扫码登录流程
  async startLogin(e) {
    const client = new WeixinClient({
      id: "login",
      baseUrl: config.base_url,
      cdnBaseUrl: config.cdn_base_url,
      apiTimeout: config.api_timeout,
    })

    // 1. 获取二维码
    let qrcodeData
    try {
      qrcodeData = await client.getQRCode()
      if (config.debug)
        logger.mark("二维码响应:", qrcodeData)
    } catch (err) {
      e.reply(`获取二维码失败: ${err.message}`)
      return false
    }

    const qrcode = qrcodeData.qrcode
    const qrcodeUrl = qrcodeData.qrcode_img_content
    if (!qrcode || !qrcodeUrl) {
      e.reply("获取二维码失败: 返回数据缺少二维码内容")
      logger.error("QRCode response:", qrcodeData)
      return false
    }

    // 2. 生成二维码图片 (使用完整URL)
    let qrImage
    try {
      qrImage = await QRCode.toDataURL(qrcodeUrl, { width: 300, margin: 2 })
      qrImage = qrImage.replace(/^data:image\/png;base64,/, "")
    } catch (err) {
      logger.error("生成二维码图片失败:", err)
    }

    // 3. 发送二维码
    if (qrImage) {
      await e.reply(["请使用微信扫码登录:", segment.image(`base64://${qrImage}`)])
    } else {
      await e.reply(`请使用微信扫码登录，或手动访问:\n${qrcodeUrl}`)
    }

    // 4. 轮询扫码状态
    const startTime = Date.now()
    const maxWait = 5 * 60 * 1000  // 5 分钟

    while (Date.now() - startTime < maxWait) {
      await Bot.sleep(config.qr_poll_interval)

      try {
        const status = await client.pollQRStatus(qrcode)

        if (status.status === "confirmed") {
          // 登录成功
          const existing = config.accounts.find(a => a.user_id === status.ilink_user_id)
          let botId

          if (existing) {
            existing.token = status.bot_token
            existing.account_id = status.ilink_bot_id
            existing.nickname = status.nickname || status.ilink_user_id
            if (!existing.bot_id) existing.bot_id = this._getNextBotId()
            botId = existing.bot_id
          } else {
            botId = this._getNextBotId()
            const accountConfig = {
              bot_id: botId,
              token: status.bot_token,
              account_id: status.ilink_bot_id,
              user_id: status.ilink_user_id,
              nickname: status.nickname || status.ilink_user_id,
              sync_buf: "",
            }
            config.accounts.push(accountConfig)
          }

          await configSave()

          const currentAccount = config.accounts.find(a => a.user_id === status.ilink_user_id)

          // 创建 bot
          const result = await this.createBot(currentAccount, new WeixinClient({
            id: currentAccount.bot_id,
            baseUrl: status.baseurl || config.base_url,
            cdnBaseUrl: config.cdn_base_url,
            apiTimeout: config.api_timeout,
            token: currentAccount.token,
          }))

          if (result.success) {
            e.reply(`微信登录成功:\n e.nickname: ${currentAccount.nickname}\n e.user_id: wx_${currentAccount.user_id}\n Bot.uin: ${currentAccount.bot_id}\n\n可用指令:\n #微信列表`)
          }
          return true

        } else if (status.status === "expired") {
          e.reply("二维码已过期，请重新登录")
          return false
        }
        // status === "wait" 继续等待

      } catch (err) {
        if (!err.message?.includes("timeout")) {
          logger.error("轮询二维码状态失败:", err)
        }
      }
    }

    e.reply("登录超时，请重新尝试")
    return false
  }
}

// 注册适配器
Bot.adapter.push(adapter)
// 启动时加载
adapter.load()

if (!global.segment) {
  global.segment = (await import("oicq")).segment;
}
let ret = [];
const files = fs
  .readdirSync('./plugins/TRSS-WeChat-OC-Plugin/apps')
  .filter((file) => file.endsWith('.js'));
files.forEach((file) => {
  ret.push(import(`./apps/${file}`))
})
ret = await Promise.allSettled(ret);
let apps = {};
for (let i in files) {
  let name = files[i].replace('.js', '');
  if (ret[i].status !== 'fulfilled') {
    logger.error(`[微信个人号] 载入插件错误：${logger.red(name)}`);
    logger.error(ret[i].reason);
    continue;
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]];
}
export { apps };

logger.info(logger.green("- 微信个人号适配器插件 加载完成"))
