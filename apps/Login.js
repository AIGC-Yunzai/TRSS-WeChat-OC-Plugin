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
            this.reply("没有已保存的微信账号，请使用 #微信登录 添加", true)
            return
        }

        const list = accounts.map((a, i) => `${i + 1}. ${a.nickname || a.user_id}\n e.user_id: wx_${a.user_id}\n Bot.uin: ${a.bot_id}`)
        const online = []
        for (const [id, bot] of adapter.bots) {
            if (!bot._stop) online.push(`${bot.info.nickname || bot.info.user_id} \n e.user_id: wx_${bot.info.user_id}\n Bot.uin: ${id}`)
        }

        this.e.reply(await common.makeForwardMsg(this.e, ["已保存的账号：", ...list, "已登录的账号：", ...online, "可用指令：\n #微信登录\n #微信删除[序号]\n #微信列表"], this.e.msg));
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

        this.reply("未找到指定账号，请使用 #微信列表 查看", true)
    }

}