export class WeixinStateStore {
  constructor(redisClient, log = console) {
    this.redis = redisClient
    this.log = log
  }

  _key(botId) {
    return `WeixinOC:data:${botId}`
  }

  _contextField(userId) {
    return `context_token:${userId}`
  }

  async getSyncBuf(botId) {
    if (!botId) return ""
    try {
      return await this.redis.hGet(this._key(botId), "sync_buf") || ""
    } catch (error) {
      this.log.error(`[微信个人号] ${botId} Redis 读取 sync_buf 失败: ${error.message}`)
      return ""
    }
  }

  async setSyncBuf(botId, syncBuf) {
    if (!botId || !syncBuf) return false
    try {
      await this.redis.hSet(this._key(botId), "sync_buf", syncBuf)
      return true
    } catch (error) {
      this.log.error(`[微信个人号] ${botId} Redis 写入 sync_buf 失败: ${error.message}`)
      throw error
    }
  }

  async getContextToken(botId, userId) {
    if (!botId || !userId) return ""
    try {
      return await this.redis.hGet(this._key(botId), this._contextField(userId)) || ""
    } catch (error) {
      this.log.error(`[微信个人号] ${botId} Redis 读取 context_token 失败: ${error.message}`)
      return ""
    }
  }

  async setContextToken(botId, userId, contextToken) {
    if (!botId || !userId || !contextToken) return false
    const field = this._contextField(userId)
    try {
      await this.redis.hSet(this._key(botId), field, contextToken)
      return true
    } catch (error) {
      this.log.error(`[微信个人号] ${botId} Redis 写入 context_token 失败: ${error.message}`)
      throw error
    }
  }

  async clearContextToken(botId, userId) {
    if (!botId || !userId) return false
    try {
      await this.redis.hDel(this._key(botId), this._contextField(userId))
      return true
    } catch (error) {
      this.log.error(`[微信个人号] ${botId} Redis 清理 context_token 失败: ${error.message}`)
      return false
    }
  }

  async clearBotState(botId) {
    if (!botId) return false
    try {
      await this.redis.del(this._key(botId))
      return true
    } catch (error) {
      this.log.error(`[微信个人号] ${botId} Redis 清理消息状态失败: ${error.message}`)
      return false
    }
  }
}
