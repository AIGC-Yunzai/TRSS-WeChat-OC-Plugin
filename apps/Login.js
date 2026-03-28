import plugin from '../../../lib/plugins/plugin.js'
import common from '../../../lib/common/common.js';

export class WeixinOC extends plugin {
    constructor() {
        super({
            name: "WeixinOCAdapter",
            dsc: "微信个人号适配器",
            event: "message",
            rule: [
                {
                    reg: "^#微信(个人号)?(登录|扫码)$",
                    fnc: "Login",
                    permission: 'master'
                },
                {
                    reg: "^#微信(个人号)?(账号|列表)$",
                    fnc: "List",
                    permission: 'master'
                },
                {
                    reg: "^#微信(个人号)?(删除|移除).+$",
                    fnc: "Remove",
                    permission: 'master'
                },
                {
                    reg: "^#微信(个人号)?(设置|修改)昵称.*$",
                    fnc: "SetNickname"
                },
            ],
        })
    }

    // 登录
    async Login() {
        const { adapter, config, configSave, } = await import('../index.js')
        await adapter.startLogin(this.e)
    }

    // 列表
    async List() {
        const { adapter, config, configSave, } = await import('../index.js')
        const accounts = config.accounts || []
        if (accounts.length === 0) {
            this.reply("没有已保存的微信账号，请使用 #微信个人号登录", true)
            return
        }

        const list = accounts.map((a, i) => `${i + 1}. ${a.nickname || a.user_id}\n e.user_id: wx_${a.user_id}\n Bot.uin: ${a.bot_id}`)
        const online = []
        for (const [id, bot] of adapter.bots) {
            if (!bot._stop) online.push(`${bot.info.nickname || bot.info.user_id} \n e.user_id: wx_${bot.info.user_id}\n Bot.uin: ${id}`)
        }

        this.e.reply(await common.makeForwardMsg(this.e, ["已保存的账号：", ...list, "已登录的账号：", ...online, "可用指令：\n #微信个人号登录\n #微信个人号删除[序号]\n #微信个人号列表\n #微信个人号设置昵称[序号]"], this.e.msg));
    }

    // 删除账号
    async Remove() {
        const { adapter, config, configSave, } = await import('../index.js')
        const input = this.e.msg.replace(/^#微信(个人号)?(删除|移除)/, "").trim()

        // 先立即保存任何待保存的配置
        await configSave()
        adapter._pendingSave.clear()

        const index = parseInt(input) - 1

        if (!isNaN(index) && index >= 0 && index < config.accounts.length) {
            const removed = config.accounts.splice(index, 1)[0]
            await adapter.destroyBot(removed.bot_id)
            await configSave()
            this.reply(`已删除账号: ${removed.nickname || removed.user_id}`, true)
            return
        }

        // 尝试匹配 user_id, bot_id 或 nickname
        const found = config.accounts.findIndex(a => a.user_id === input || a.nickname === input || a.bot_id === input)
        if (found >= 0) {
            const removed = config.accounts.splice(found, 1)[0]
            await adapter.destroyBot(removed.bot_id)
            await configSave()
            this.reply(`已删除账号: ${removed.nickname || removed.user_id}`, true)
            return
        }

        this.reply("未找到指定账号，请使用 #微信个人号列表", true)
    }

    // 设置/修改昵称
    async SetNickname() {
        const { adapter, config, configSave } = await import('../index.js')

        // 判断指令是否来源于微信个人号 (根据 adapter.id 判断)
        const isWechat = this.e.bot?.version?.id === "WeixinOC"
        if (!isWechat && !this.e.isMaster) {
            this.reply("暂无权限，仅主人或在微信内可使用此指令", true)
            return false
        }

        const input = this.e.msg.replace(/^#微信(个人号)?(设置|修改)昵称/, "").trim()
        const accounts = config.accounts || []
        let targetAccount = null
        let newNickname = ""

        if (isWechat) {
            // 微信内：仅可以修改当前Bot的昵称，不需要序号解析
            targetAccount = accounts.find(a => a.bot_id === this.e.self_id)
            if (!targetAccount) {
                this.reply("未找到当前账号的配置信息", true)
                return
            }
            // 微信内输入的全部内容直接作为新昵称
            newNickname = input
        } else {
            // 非微信内(如QQ等)：必须指定序号或标识
            if (!input) {
                this.reply("请指定要修改的账号序号或标识，例如：\n#微信个人号设置昵称 1\n#微信个人号设置昵称 1 新名字", true)
                return
            }

            // 按第一个空格分割输入内容，获取目标ID和直接附带的新昵称
            let targetId = input
            const spaceIndex = input.indexOf(" ")

            if (spaceIndex > -1) {
                targetId = input.substring(0, spaceIndex).trim()
                newNickname = input.substring(spaceIndex + 1).trim()
            }

            // 查找指定的账号
            const index = parseInt(targetId) - 1
            if (!isNaN(index) && index >= 0 && index < accounts.length) {
                targetAccount = accounts[index]
            } else {
                targetAccount = accounts.find(a => a.user_id === targetId || a.nickname === targetId || a.bot_id === targetId)
            }

            if (!targetAccount) {
                this.reply("未找到指定账号，请使用 #微信个人号列表 查看", true)
                return
            }
        }

        // 如果用户在指令中没有提供新昵称，则启动 awaitContext 等待用户二次输入
        if (!newNickname) {
            await this.e.reply(`请输入账号 [${targetAccount.user_id}] 的新昵称，请在120秒内发送：`, true, { recallMsg: 119 })
            try {
                if (typeof this.awaitContext === 'function') {
                    const e_new = await this.awaitContext()
                    if (!e_new || !e_new.msg) return // 超时或出错直接退出

                    // 去除可能重复输入的指令前缀并获取新昵称
                    newNickname = e_new.msg.replace(/^#微信(个人号)?(设置|修改)昵称/, "").trim()
                } else {
                    this.reply("当前环境不支持上下文等待，请一次性发送完整指令。", true)
                    return
                }
            } catch (err) {
                return // awaitContext 异常捕获退出
            }

            if (!newNickname) {
                this.reply("昵称不能为空，已取消设置。", true)
                return
            }
        }
        if (newNickname.length > 50) {
            this.reply(`❌昵称长度不能超过 50 个字符！你当前输入了 ${newNickname.length} 个字符，请缩短后重试。`, true)
            return
        }

        // 保存前先清理并同步配置(防冲突处理)
        await configSave()
        if (adapter._pendingSave) {
            adapter._pendingSave.clear()
        }

        const oldName = targetAccount.nickname || '无'
        targetAccount.nickname = newNickname
        await configSave()

        // 如果该账号当前处于在线状态，同步更新内存中机器人的 info 数据，让修改直接生效
        const botId = targetAccount.bot_id
        const bot = adapter.bots.get(botId)
        if (bot && bot.info) {
            bot.info.nickname = newNickname
        }

        // 确保全局 Bot 变量中也实时修改成功
        if (global.Bot && global.Bot[botId] && global.Bot[botId].info) {
            global.Bot[botId].info.nickname = newNickname
        }

        this.reply(`✅修改成功！\n账号：${targetAccount.user_id}\n旧昵称：${oldName}\n新昵称：${newNickname}`, true)
    }
}