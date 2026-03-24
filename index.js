logger.info(logger.yellow("- 正在加载 微信个人号 适配器插件"))

import makeConfig from "../../lib/plugins/config.js"
import fetch from "node-fetch"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import QRCode from "qrcode"
import plugin from '../../lib/plugins/plugin.js'

// 更新用
import { createRequire } from 'module'
import _ from 'lodash'
import { Restart } from '../other/restart.js'
const require = createRequire(import.meta.url)
const { exec, execSync } = require('child_process')
let uping = false

// 默认配置
const { config, configSave } = await makeConfig("WeixinOC", {
  tips: "",
  permission: "master",
  // 微信 ilink API 配置
  base_url: "https://ilinkai.weixin.qq.com",
  cdn_base_url: "https://novac2c.cdn.weixin.qq.com/c2c",
  bot_type: "3",  // 机器人类型
  qr_poll_interval: 2000,  // 二维码轮询间隔(ms)
  long_poll_timeout: 35000,  // 长轮询超时(ms)
  api_timeout: 15000,  // API 超时(ms)
  // 账号配置 (扫码登录后会自动保存)
  accounts: [],  // { token, account_id, user_id, nickname }
}, {
  tips: [
    "欢迎使用 TRSS-Yunzai 微信个人号适配器插件!",
    "参考 AstrBot 微信 ilink 协议实现",
    "使用 #微信登录 进行扫码登录",
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

    logger.mark(`CDN上传: rawSize=${fileBuffer.length}, paddedSize=${paddedData.length}, encryptedSize=${encrypted.length}`)
    logger.mark(`CDN上传: aesKeyHex=${aesKeyHex.slice(0, 16)}..., keyLength=${key.length}`)

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
const adapter = new class WeixinOCAdapter {
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
    // 防止重复加载
    this._loaded = false
  }

  /**
   * 日志内容过滤，移除敏感信息和过长内容
   * @param {any} msg - 原始消息内容
   * @returns {string} - 过滤后的字符串
   */
  makeLog(msg) {
    return Bot.String(msg)
      .replace(/encrypt_query_param=[^&\s"]*/g, "encrypt_query_param=...")
      .replace(/base64:\/\/[^\s"]*/g, "base64://...")
      .slice(0, 500)
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
  makeMessage(botId, msg) {
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
      message,
      raw_message,
    }

    Bot[botId].fl.set(data.user_id, data.sender)

    Bot.makeLog("info", `好友消息：[${data.sender.nickname}] ${this.makeLog(raw_message)}`, botId)
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

    logger.mark("getUploadUrl 响应:", uploadUrlRes)

    const uploadParam = uploadUrlRes.upload_param
    if (!uploadParam) throw new Error(`Failed to get upload URL: ${JSON.stringify(uploadUrlRes)}`)

    // 上传文件
    const encryptedParam = await bot.client.uploadToCdn(uploadParam, fileKey, aesKeyHex, fileBuffer)

    logger.mark("CDN 上传返回 encryptedParam:", encryptedParam?.slice(0, 50) + "...")

    const aesKeyB64 = Buffer.from(aesKeyHex, "utf8").toString("base64")
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
        logger.mark(`发送转发兼容消息: count=${normalizedForward.length}`)
        const forwardResult = await Bot.sendForwardMsg(msg => this.sendFriendMsg(data, msg), normalizedForward)
        return { data: { forwarded: true, results: forwardResult } }
      }

      logger.mark("发送消息 itemList:", JSON.stringify(itemList, null, 2))
      const result = await Bot[botId].client.sendMessage(userId, itemList, contextToken)
      logger.mark("发送消息结果:", result)
      if (normalizedForward.length) {
        logger.mark(`发送转发兼容消息: count=${normalizedForward.length}`)
        const forwardResult = await Bot.sendForwardMsg(msg => this.sendFriendMsg(data, msg), normalizedForward)
        return { data: { message: result, forward: forwardResult } }
      }
      return { data: result }
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
      recallMsg: message_id => this.recallMsg(i, message_id),
      getInfo: () => this.getFriendInfo(i),
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
          const account = config.accounts.find(a => a.user_id === bot.info.user_id)
          if (account) {
            account.sync_buf = result.get_updates_buf
            this.configSaveDebounced(account.user_id)
          }
        }

        // 处理消息
        for (const msg of result.msgs || []) {
          if (Bot[botId]?._stop) break
          this.makeMessage(botId, msg)
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
    const id = `wx_${accountConfig.user_id}`

    Bot[id] = {
      adapter: this,
      client: client,

      info: {
        user_id: accountConfig.user_id,
        nickname: accountConfig.nickname || accountConfig.user_id,
      },
      uin: accountConfig.user_id,
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
      gl: new Map(),
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

    for (const account of config.accounts || []) {
      const botId = `wx_${account.user_id}`
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
  }

  // 销毁 Bot 实例并清理资源
  async destroyBot(userId) {
    const botId = `wx_${userId}`
    if (Bot[botId]) {
      Bot[botId]._stop = true
      await Bot.sleep(1000)  // 等待轮询退出

      // 清理资源
      this.bots.delete(botId)
      this.syncBuffers.delete(botId)
      this.contextTokens.delete(botId)
      delete Bot.bots[botId]
      delete Bot[botId]

      Bot.makeLog("mark", `${this.name} 已断开: ${userId}`, botId)
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
          const accountConfig = {
            token: status.bot_token,
            account_id: status.ilink_bot_id,
            user_id: status.ilink_user_id,
            nickname: status.nickname || status.ilink_user_id,
            sync_buf: "",
          }

          // 检查是否已存在
          const existing = config.accounts.find(a => a.user_id === accountConfig.user_id)
          if (existing) {
            existing.token = accountConfig.token
            existing.account_id = accountConfig.account_id
            existing.nickname = accountConfig.nickname
          } else {
            config.accounts.push(accountConfig)
          }

          await configSave()

          // 创建 bot
          const result = await this.createBot(accountConfig, new WeixinClient({
            id: `wx_${accountConfig.user_id}`,
            baseUrl: status.baseurl || config.base_url,
            cdnBaseUrl: config.cdn_base_url,
            apiTimeout: config.api_timeout,
            token: accountConfig.token,
          }))

          if (result.success) {
            e.reply(`微信登录成功: ${accountConfig.nickname} (${accountConfig.user_id})`)
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

// 插件命令
export class WeixinOC extends plugin {
  constructor() {
    super({
      name: "WeixinOCAdapter",
      dsc: "微信个人号适配器",
      event: "message",
      rule: [
        {
          reg: "^#微信(登录|扫码)$",
          fnc: "Login",
          permission: config.permission,
        },
        {
          reg: "^#微信(账号|列表)$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#微信(删除|移除).+$",
          fnc: "Remove",
          permission: config.permission,
        },
        {
          reg: /^#(微信个人号|WeChat(OC)?)((插件)?(强制)?更新| update)(\s*(master|dev|DEV|main|MAIN))?$/i,
          fnc: 'update'
        }
      ],
    })
  }

  // 登录
  async Login() {
    await adapter.startLogin(this.e)
  }

  // 列表
  List() {
    const accounts = config.accounts || []
    if (accounts.length === 0) {
      this.reply("没有已保存的微信账号，请使用 #微信登录 添加", true)
      return
    }

    const list = accounts.map((a, i) => `${i + 1}. ${a.nickname || a.user_id} (${a.user_id})`).join("\n")
    const online = []
    for (const [id, bot] of adapter.bots) {
      if (!bot._stop) online.push(bot.info.nickname || bot.info.user_id)
    }

    this.reply(`已保存 ${accounts.length} 个账号:\n${list}\n\n在线: ${online.join(", ") || "无"}`, true)
  }

  // 删除账号
  async Remove() {
    const input = this.e.msg.replace(/^#微信(删除|移除)/, "").trim()

    // 先立即保存任何待保存的配置
    if (adapter._saveTimer) {
      clearTimeout(adapter._saveTimer)
      await configSave()
      adapter._pendingSave.clear()
    }

    const index = parseInt(input) - 1

    if (!isNaN(index) && index >= 0 && index < config.accounts.length) {
      const removed = config.accounts.splice(index, 1)[0]
      await adapter.destroyBot(removed.user_id)
      await configSave()
      this.reply(`已删除账号: ${removed.nickname || removed.user_id}`, true)
      return
    }

    // 尝试匹配 user_id 或 nickname
    const found = config.accounts.findIndex(a => a.user_id === input || a.nickname === input)
    if (found >= 0) {
      const removed = config.accounts.splice(found, 1)[0]
      await adapter.destroyBot(removed.user_id)
      await configSave()
      this.reply(`已删除账号: ${removed.nickname || removed.user_id}`, true)
      return
    }

    this.reply("未找到指定账号，请使用 #微信列表 查看", true)
  }

  /**
   * rule - 更新微信个人号插件
   * @returns
   */
  async update() {
    if (!this.e.isMaster) return false

    /** 检查是否正在更新中 */
    if (uping) {
      await this.reply('已有命令更新中..请勿重复操作')
      return
    }

    /** 检查git安装 */
    if (!(await this.checkGit())) return

    const isForce = this.e.msg.includes('强制')
    // 检查是否为dev分支更新
    const isDevUpdate = this.e.msg.includes('dev') || this.e.msg.includes('DEV')
    // 检查是否为dev分支更新
    const isMainUpdate = this.e.msg.includes('main') || this.e.msg.includes('MAIN') || this.e.msg.includes('master')

    /** 执行更新 */
    await this.runUpdate(isForce, isDevUpdate, isMainUpdate)

    /** 是否需要重启 */
    if (this.isUp) {
      // await this.reply("更新完毕，请重启云崽后生效")
      setTimeout(() => this.restart(), 2000)
    }
  }

  restart() {
    new Restart(this.e).restart()
  }

  /**
   * 更新
   * @param {boolean} isForce 是否为强制更新
   * @param {boolean} isDevUpdate 是否为更新 dev
   * @param {boolean} isMainUpdate 是否为更新 main
   * @returns
   */
  async runUpdate(isForce, isDevUpdate, isMainUpdate) {
    let command = ''

    if (isForce && isDevUpdate) {
      // dev分支强制更新
      command = "git -C ./plugins/TRSS-WeChat-OC-Plugin/ config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git -C ./plugins/TRSS-WeChat-OC-Plugin/ fetch origin && git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard HEAD && git -C ./plugins/TRSS-WeChat-OC-Plugin/ clean -fd && git -C ./plugins/TRSS-WeChat-OC-Plugin/ checkout dev && git -C ./plugins/TRSS-WeChat-OC-Plugin/ fetch --all && git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard origin/dev"
      this.e.reply('正在执行dev分支强制更新操作，请稍等')
    } else if (isForce && isMainUpdate) {
      // main分支强制更新
      // command = 'git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard HEAD && git -C ./plugins/TRSS-WeChat-OC-Plugin/ clean -fd && git -C ./plugins/TRSS-WeChat-OC-Plugin/ checkout main && git -C ./plugins/TRSS-WeChat-OC-Plugin/ fetch --all && git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard origin/main'
      command = 'git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard HEAD && git -C ./plugins/TRSS-WeChat-OC-Plugin/ clean -fd && git -C ./plugins/TRSS-WeChat-OC-Plugin/ checkout master && git -C ./plugins/TRSS-WeChat-OC-Plugin/ fetch --all && git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard origin/master'
      this.e.reply('正在执行 master 分支强制更新操作，请稍等')
    } else if (isForce) {
      command = `git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard HEAD && git -C ./plugins/TRSS-WeChat-OC-Plugin/ clean -fd && git -C ./plugins/TRSS-WeChat-OC-Plugin/ checkout . && git -C ./plugins/TRSS-WeChat-OC-Plugin/ fetch --all && git -C ./plugins/TRSS-WeChat-OC-Plugin/ reset --hard @{u}`
      this.e.reply('正在执行强制更新操作，请稍等')
    } else {
      command = 'git -C ./plugins/TRSS-WeChat-OC-Plugin/ pull --no-rebase'
      this.e.reply('正在执行更新操作，请稍等')
    }
    /** 获取上次提交的commitId，用于获取日志时判断新增的更新日志 */
    this.oldCommitId = await this.getcommitId('TRSS-WeChat-OC-Plugin')
    uping = true
    let ret = await this.execSync(command)
    uping = false

    if (ret.error) {
      logger.mark(`${this.e.logFnc} 更新失败：TRSS-WeChat-OC-Plugin`)
      this.gitErr(ret.error, ret.stdout)
      return false
    }

    /** 获取插件提交的最新时间 */
    let time = await this.getTime('TRSS-WeChat-OC-Plugin')

    if (/(Already up[ -]to[ -]date|已经是最新的)/.test(ret.stdout)) {
      await this.reply(`TRSS-WeChat-OC-Plugin${isDevUpdate ? '(dev分支)' : ''}${isMainUpdate ? '(main分支)' : ''}已经是最新版本\n最后更新时间：${time}`)
    } else {
      await this.reply(`TRSS-WeChat-OC-Plugin${isDevUpdate ? '(dev分支)' : ''}${isMainUpdate ? '(main分支)' : ''}\n最后更新时间：${time}`)
      this.isUp = true
      /** 获取TRSS-WeChat-OC-Plugin的更新日志 */
      let log = await this.getLog('TRSS-WeChat-OC-Plugin')
      await this.reply(log)
    }

    logger.mark(`${this.e.logFnc} 最后更新时间：${time}`)

    return true
  }

  /**
   * 获取TRSS-WeChat-OC-Plugin的更新日志
   * @param {string} plugin 插件名称
   * @returns
   */
  async getLog(plugin = '') {
    let cm = `cd ./plugins/${plugin}/ && git log  -20 --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%m-%d %H:%M"`

    let logAll
    try {
      logAll = await execSync(cm, { encoding: 'utf-8' })
    } catch (error) {
      logger.error(error.toString())
      this.reply(error.toString())
    }

    if (!logAll) return false

    logAll = logAll.split('\n')

    let log = []
    for (let str of logAll) {
      str = str.split('||')
      if (str[0] == this.oldCommitId) break
      if (str[1].includes('Merge branch')) continue
      log.push(str[1])
    }
    let line = log.length
    log = log.join('\n\n')

    if (log.length <= 0) return ''

    let end = ''
    end =
      '更多详细信息，请前往github查看\nhttps://github.com/AIGC-Yunzai/TRSS-WeChat-OC-Plugin'

    log = await this.makeForwardMsg(`TRSS-WeChat-OC-Plugin更新日志，共${line}条`, log, end)

    return log
  }

  /**
   * 获取上次提交的commitId
   * @param {string} plugin 插件名称
   * @returns
   */
  async getcommitId(plugin = '') {
    let cm = `git -C ./plugins/${plugin}/ rev-parse --short HEAD`

    let commitId = await execSync(cm, { encoding: 'utf-8' })
    commitId = _.trim(commitId)

    return commitId
  }

  /**
   * 获取本次更新插件的最后一次提交时间
   * @param {string} plugin 插件名称
   * @returns
   */
  async getTime(plugin = '') {
    let cm = `cd ./plugins/${plugin}/ && git log -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`

    let time = ''
    try {
      time = await execSync(cm, { encoding: 'utf-8' })
      time = _.trim(time)
    } catch (error) {
      logger.error(error.toString())
      time = '获取时间失败'
    }
    return time
  }

  /**
   * 制作转发消息
   * @param {string} title 标题 - 首条消息
   * @param {string} msg 日志信息
   * @param {string} end 最后一条信息
   * @returns
   */
  async makeForwardMsg(title, msg, end) {
    let nickname = (this.e.bot ?? Bot).nickname
    if (this.e.isGroup) {
      let info = await (this.e.bot ?? Bot).getGroupMemberInfo?.(this.e.group_id, (this.e.bot ?? Bot).uin) || await (this.e.bot ?? Bot).pickMember?.(this.e.group_id, (this.e.bot ?? Bot).uin);
      nickname = info.card || info.nickname
    }
    let userInfo = {
      user_id: (this.e.bot ?? Bot).uin,
      nickname
    }

    let forwardMsg = [
      {
        ...userInfo,
        message: title
      },
      {
        ...userInfo,
        message: msg
      }
    ]

    if (end) {
      forwardMsg.push({
        ...userInfo,
        message: end
      })
    }

    /** 制作转发内容 */
    if (this.e.group?.makeForwardMsg) {
      forwardMsg = await this.e.group.makeForwardMsg(forwardMsg)
    } else if (this.e?.friend?.makeForwardMsg) {
      forwardMsg = await this.e.friend.makeForwardMsg(forwardMsg)
    } else {
      return msg.join('\n')
    }

    let dec = 'TRSS-WeChat-OC-Plugin 更新日志'
    /** 处理描述 */
    if (typeof (forwardMsg.data) === 'object') {
      let detail = forwardMsg.data?.meta?.detail
      if (detail) {
        detail.news = [{ text: dec }]
      }
    } else {
      forwardMsg.data = forwardMsg.data
        .replace(/\n/g, '')
        .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, '___')
        .replace(/___+/, `<title color="#777777" size="26">${dec}</title>`)
    }

    return forwardMsg
  }

  /**
   * 处理更新失败的相关函数
   * @param {string} err
   * @param {string} stdout
   * @returns
   */
  async gitErr(err, stdout) {
    let msg = '更新失败！'
    let errMsg = err.toString()
    stdout = stdout.toString()

    if (errMsg.includes('Timed out')) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, '')
      await this.reply(msg + `\n连接超时：${remote}`)
      return
    }

    if (/Failed to connect|unable to access/g.test(errMsg)) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, '')
      await this.reply(msg + `\n连接失败：${remote}`)
      return
    }

    await this.reply([errMsg, stdout, `\n若存在git冲突，可尝试执行#微信个人号强制更新`])
  }

  /**
   * 异步执行git相关命令
   * @param {string} cmd git命令
   * @returns
   */
  async execSync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr })
      })
    })
  }

  /**
   * 检查git是否安装
   * @returns
   */
  async checkGit() {
    let ret = await execSync('git --version', { encoding: 'utf-8' })
    if (!ret || !ret.includes('git version')) {
      await this.reply('请先安装git')
      return false
    }
    return true
  }
}

// 启动时加载
adapter.load()
logger.info(logger.green("- 微信个人号适配器插件 加载完成"))
