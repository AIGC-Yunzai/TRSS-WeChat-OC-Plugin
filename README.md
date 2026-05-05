# TRSS-WeChat-OC-Plugin

<img decoding="async" align=right src="resources/readme/girl.png" width="35%">

这是 TRSS-Yunzai 的微信个人号适配器插件，基于官方 ilink 协议，直接接入[微信 ClawBot 官方接口](https://cloud.tencent.cn/developer/article/2643772)，实现微信与 Yunzai 生态的合规、稳定消息互通。

## 功能

| 功能               | 状态 | 注释                                |
| ------------------ | ---- | ----------------------------------- |
| 扫码登录           | ✅    |                                     |
| 多账号管理         | ✅    |                                     |
| 私聊收发文本       | ✅    |                                     |
| 私聊收发图片       | ✅    |                                     |
| 私聊收发视频       | ✅    |                                     |
| 私聊收发文件       | ✅    |                                     |
| 私聊接收语音       | ⚠️    | Bot 接收后转文字                    |
| 私聊发送语音       | ⚠️    | Bot 以文件发送                      |
| 合并转发消息       | ⚠️    | 降级为多条消息发送                  |
| 接收引用消息多媒体 | ⚠️    | 多媒体为 `base64://` 数组[^1]       |
| 接收消息多媒体     | ⚠️    | `e.img` 为 `base64://` 数组[^1]     |
| Bot“正在输入”状态  | ⚠️    | `e.send_typing` `e.stop_typing`[^2] |

[^1]: 需要插件兼容 Base64 数据 URL: 可参考 [parseSourceImg(), url2Base64()](https://github.com/AIGC-Yunzai/siliconflow-plugin/blob/main/utils/getImg.js)
[^2]: 需要插件兼容 `e.send_typing` `e.stop_typing`: 插件中仅需要在发送消息前插入 `if (e.send_typing) e.send_typing();` ，适配器将自动在你的插件发送消息后移除“正在输入”状态或在3分钟后自动结束状态，可参考或直接用 [misaka20002/chatgpt-plugin v2](https://github.com/misaka20002/chatgpt-plugin/commit/ff96a763618eb5a938e568e0b746346e7ea036de)

## 安装

<img decoding="async" align=right src="https://github.com/user-attachments/assets/917d43f5-be69-4303-9539-eb270b40643d" width="30%">

#### 1. 克隆仓库

```
# 进入云崽根目录后
git clone https://github.com/AIGC-Yunzai/TRSS-WeChat-OC-Plugin.git ./plugins/TRSS-WeChat-OC-Plugin
```

> [!NOTE]
> 如果你的网络环境较差，无法连接到 Github，可以使用 [GitHub Proxy](https://ghproxy.link/) 提供的文件代理加速下载服务：
>
> ```bash
> git clone https://ghfast.top/https://github.com/AIGC-Yunzai/TRSS-WeChat-OC-Plugin.git ./plugins/TRSS-WeChat-OC-Plugin
> ```
> 如果已经下载过本插件需要修改代理加速下载服务地址，在插件根目录使用：
> ```bash
> git remote set-url origin https://ghfast.top/https://github.com/AIGC-Yunzai/TRSS-WeChat-OC-Plugin.git
> ```

#### 2. 安装依赖

```
pnpm install -C plugins/TRSS-WeChat-OC-Plugin
```

## 指令

| 指令                     | 说明               |
| ------------------------ | ------------------ |
| `#微信个人号登录`        | 扫码登录新账号     |
| `#微信个人号列表`        | 查看已登录账号     |
| `#微信个人号删除`        | 删除指定账号       |
| `#微信个人号[禁用/启用]` | 禁用/启用指定账号  |
| `#微信个人号设置昵称`    | 设置插件中你的昵称 |
| `#设置主人`              | 在微信中设置主人   |
| `#设置主人验证码`        | 其他主人查看验证码 |
| `#微信个人号插件更新`    | 更新插件           |

## 支持与贡献

如果你喜欢这个项目，请不妨点个 Star🌟，这是对开发者最大的动力。

有意见或者建议也欢迎提交 [Issues](https://github.com/AIGC-Yunzai/siliconflow-plugin/issues) 和 [Pull requests](https://github.com/AIGC-Yunzai/siliconflow-plugin/pulls)。

## 致谢

- 协议参考：[AstrBot](https://github.com/AstrBotDevs/AstrBot/tree/master/astrbot/core/platform/sources/weixin_oc)
- 架构参考：[Yunzai-KOOK-Plugin](https://github.com/TimeRainStarSky/Yunzai-KOOK-Plugin)

## License

本项目使用 [MIT](/LICENSE) 作为开源许可证。

## 注释