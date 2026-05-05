import makeConfig from "../../../lib/plugins/config.js"

export const { config, configSave } = await makeConfig("WeixinOC", {
    tips: "",
    // 微信 ilink API 配置
    base_url: "https://ilinkai.weixin.qq.com",
    cdn_base_url: "https://novac2c.cdn.weixin.qq.com/c2c",
    bot_type: "3",  // 机器人类型
    qr_poll_interval: 2000,  // 二维码轮询间隔(ms)
    long_poll_timeout: 35000,  // 长轮询超时(ms)
    api_timeout: 15000,  // API 超时(ms)
    typing_keepalive_interval: 5000, // e.send_typing() 重复续期“正在输入”间隔(ms)
    typing_ticket_ttl: 60000,        // ticket 有效期(ms)
    typing_ttl_time: 180000,        // e.send_typing() 的“正在输入”状态持续时间(ms)
    // 账号配置 (扫码登录后会自动保存)
    accounts: [],  // { bot_id, token, account_id, user_id, nickname }
    debug: false,
}, {
    tips: [
        "欢迎使用 TRSS-Yunzai 微信个人号适配器插件!",
        "使用 #微信个人号登录 进行扫码登录",
        "主页: https://github.com/AIGC-Yunzai/TRSS-WeChat-OC-Plugin",
    ],
})