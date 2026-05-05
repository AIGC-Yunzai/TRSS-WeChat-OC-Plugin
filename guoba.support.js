import lodash from "lodash";
import path from "path";
import { pluginRoot } from "./model/path.js";
import {
  config,
  configSave,
} from './model/Config.js';

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'WeChat-OC-Plugin',
      title: '微信个人号适配器',
      author: ['@ethan42nd', '@Misaka20002', '@eggacheb'],
      authorLink: ['https://github.com/ethan42nd', 'https://github.com/Misaka20002', 'https://github.com/eggacheb'],
      link: 'https://github.com/AIGC-Yunzai/TRSS-WeChat-OC-Plugin',
      isV3: true,
      isV2: false,
      showInMenu: true,
      description: '基于 TRSS-Yunzai 的微信个人号适配器插件，基于官方 ilink 协议，直接接入微信 ClawBot 官方接口，实现微信与 Yunzai 生态的合规、稳定消息互通。',
      // 显示图标，此为个性化配置
      // 图标可在 https://icon-sets.iconify.design 这里进行搜索
      icon: 'fluent-emoji-flat:artist-palette',
      // 图标颜色，例：#FF0000 或 rgb(255, 0, 0)
      iconColor: '#000000',
      // 如果想要显示成图片，也可以填写图标路径（绝对路径）
      iconPath: path.join(pluginRoot, 'resources/readme/girl.png'),
    },
    configInfo: {
      schemas: [
        {
          component: "Divider",
          label: "用户相关配置",
          componentProps: {
            orientation: "left",
            plain: true,
          },
        },
        {
          field: "accounts",
          label: "用户设置",
          bottomHelpMessage: "用户设置；可用指令： #微信个人号登录 #微信个人号列表",
          component: "GSubForm",
          componentProps: {
            multiple: true,
            schemas: [
              {
                field: "bot_id",
                label: "Bot UIN",
                component: "Input",
                required: true,
                bottomHelpMessage: "机器人唯一标识，例如：weixin_personal_001",
                rules: [
                  { required: true, message: '不能为空' },
                  { pattern: '^(weixin_personal_)(?!000)\\d{3,}$', message: 'Bot UIN 格式不正确' },
                ],
                componentProps: {
                  placeholder: "weixin_personal_xxx",
                },
              },
              {
                field: "nickname",
                label: "昵称",
                component: "Input",
                required: false,
                bottomHelpMessage: "用户的插件自定义昵称",
              },
              {
                field: "isDisable",
                label: "已失效/禁用",
                component: "Switch",
                required: false,
                bottomHelpMessage: "凭证失效或主动禁用时开启",
              },
              {
                component: "Divider",
                label: "↓不推荐修改以下配置↓",
                componentProps: {
                  orientation: "left",
                  plain: true,
                },
              },
              {
                field: "user_id",
                label: "微信 User ID",
                component: "Input",
                required: true,
                bottomHelpMessage: "微信提供的内部 User ID",
              },
              {
                field: "token",
                label: "Token",
                component: "InputPassword",
                required: false,
                bottomHelpMessage: "扫码登录获取的凭证",
              },
              {
                field: "account_id",
                label: "Account ID",
                component: "Input",
                required: false,
                bottomHelpMessage: "iLink 内部 Bot ID",
              },
            ],
          },
        },
        {
          component: "Divider",
          label: "全局配置",
          componentProps: {
            orientation: "left",
            plain: true,
          },
        },
        {
          field: "typing_ttl_time",
          label: "“正在输入”持续时间",
          helpMessage: '单位：毫秒',
          bottomHelpMessage: "e.send_typing() 的“正在输入”状态持续时间(ms)",
          component: "InputNumber",
          componentProps: {
            min: 1000,
            step: 1,
          },
          componentProps: {
            placeholder: 180000,
          },
        },
        {
          field: "debug",
          label: "debug 模式",
          component: "Switch",
          bottomHelpMessage: "控制台输出 debug 信息",
        },
      ],
      getConfigData() {
        return config
      },

      setConfigData(data, { Result }) {
        // 根据 带点的路径 对 config 赋值
        for (let [keyPath, value] of Object.entries(data)) {
          lodash.set(config, keyPath, value)
        }

        // 检查重复的 bot_id 和 user_id
        if (config.accounts && Array.isArray(config.accounts)) {
          const botIds = new Set()
          const userIds = new Set()
          for (const account of config.accounts) {
            if (account.bot_id) {
              if (botIds.has(account.bot_id)) return Result.error(`配置错误: 存在重复的 bot_id (${account.bot_id})`)
              botIds.add(account.bot_id)
            }
            if (account.user_id) {
              if (userIds.has(account.user_id)) return Result.error(`配置错误: 存在重复的 user_id (${account.user_id})`)
              userIds.add(account.user_id)
            }
          }
        }

        try {
          configSave()
          return Result.ok({}, '保存成功~')
        } catch (err) {
          return Result.error('保存失败: ' + err.message)
        }
      },
    },
  }
}
