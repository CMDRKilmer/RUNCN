# 隐私权政策 / Privacy Policy

**琉璃小工具（Refined PrUn 中文版）**

最后更新日期：2026年7月8日

## 概述

琉璃小工具是一款用于增强 Prosperous Universe (PrUn) 游戏界面的浏览器扩展。我们重视用户隐私，本政策说明本扩展如何处理用户数据。

## 数据收集

本扩展 **不会** 收集、传输或分享任何用户个人信息。

## 本地存储

本扩展使用浏览器的 `chrome.storage` API 在本地保存用户的扩展设置和偏好配置。这些数据仅存储在用户本地浏览器中，不会传输至任何外部服务器。

## 主机权限

本扩展仅访问 Prosperous Universe 游戏页面（`apex.prosperousuniverse.com`），用于注入界面优化功能。不会访问或读取任何其他网站的数据。

## 第三方翻译服务（用户可选）

当用户主动启用聊天翻译功能并在 XIT SET 翻译设置中配置第三方翻译服务（如 Microsoft Translator、Google Translate、DeepL、Anthropic Claude、Google Gemini、OpenAI、DeepSeek、MiniMax、智谱 GLM、通义千问、Moonshot、百度千帆、腾讯混元、零一万物、阶跃星辰、Hugging Face 或自定义 HTTP 翻译接口）时：

- 翻译功能仅在用户点击消息或输入框旁的"翻译"按钮时显式触发，扩展不会自动翻译或自动发送任何内容；
- 待翻译的聊天文本会通过 HTTPS 直连用户配置的翻译服务商 API；
- 用户在该设置页填写的 API 密钥保存在本地浏览器存储中，扩展不会上传、转发或中转密钥至除用户所选服务商之外的任何第三方；
- 注意：扩展主代码运行在页面上下文中，与其他同源页面脚本共享运行环境。请勿在不可信的设备或被注入恶意脚本的页面使用本翻译功能。

## 其他第三方服务

除上述用户主动配置的翻译服务外，本扩展不使用任何分析、广告或追踪服务。

## 政策变更

如本隐私政策发生变更，将在本页面更新。

## 联系方式

如有任何隐私相关问题，请通过 GitHub Issues 联系：  
https://github.com/Aivking/RUNCN/issues
