# 琉璃小工具

> 基于 [Refined PrUn](https://github.com/refined-prun/refined-prun) 的全面中文汉化分支并添加了自定义功能

浏览器扩展，用于简化 [Prosperous Universe](https://prosperousuniverse.com/) 游戏界面并添加实用功能。本版本将所有英文界面、按钮、提示、描述及代码注释翻译为中文，方便中文玩家使用。

## 浏览器要求

本扩展仅支持 **Chrome 148 及以上版本**（或同源 Chromium 内核的 Edge 148+）。该最低版本要求是为了使用 Chrome 内置 AI（Gemini Nano）实现本地化 AI 能力——**无需 API Key、无需联网、用户数据不离开本机**。Firefox、Safari 以及更低版本 Chrome 不在本扩展支持范围内。

## 汉化范围

- **功能描述**：全部 120 个功能的名称与说明（基础 84 + 高级 36）
- **XIT 面板**：START、HELP、CMDS、HEALTH、HQUC、CHAT、BURN、TODO、NOTE、CMDL、SORT 等
- **设置面板**：SET、FEAT、FIN(SET)、GAME、BFR、PMMG
- **合同系统**：CONTS/CONTC/CXTS 面板 + 29 个合同条件
- **财务系统**：FIN 面板（10 个财务指标）、FINBS 资产负债表、FINCH 图表（60+ 标签）
- **自动化系统**：ACT 面板（补给/维修/加油/交易/转运等 30+ 个操作日志）
- **通知系统**：18 种通知类型标签
- **共享组件**：确认弹窗、加载提示、材料图标等
- **代码注释**：约 180 条英文注释全部翻译
- **合计修改**：285 个文件，1185 处新增，1383 处删除

## 功能亮点

### 待处理合同条件

![待处理合同条件](https://github.com/user-attachments/assets/21e219dd-5923-4a47-831a-3eb527e99f8d)

### 商品交易所交易记录

![商品交易所交易记录](https://github.com/user-attachments/assets/b0139e1e-153a-4fc7-b88a-f2954add66bf)

### 详细资产负债表

![详细资产负债表](https://github.com/user-attachments/assets/f0452cf4-2a18-4336-a2f7-0b03ba6ef941)

### 总部升级计算器

![总部升级计算器](https://github.com/user-attachments/assets/3a514d76-85b5-4b58-ba5c-2a1a52a8deff)

### CONTD 合作伙伴搜索结果显示在搜索栏上方

![CONTD 合作伙伴搜索](https://github.com/user-attachments/assets/2e9864e4-e13f-4f06-893b-701d9687dbf9)

### SHPT 与 BLCK 目的地标签

![SHPT 与 BLCK 目的地标签](https://github.com/user-attachments/assets/d1c2f806-1b14-4a27-b5a7-1466c9dcaee9)

### 更优的本地市场广告

![更优的本地市场广告](https://github.com/user-attachments/assets/a33aae8a-972b-4ac5-8389-361f71231250)

### 改进的单色图标集

![改进的单色图标集](https://github.com/user-attachments/assets/9fc42ef8-e2c6-43e9-8797-56601389205e)

---

## 游戏内预览

![游戏内截图](https://github.com/user-attachments/assets/ed442f0e-297e-4f62-b539-7057e4a3b30f)

## 构建方式

构建本扩展需要先安装 [pnpm](https://pnpm.io/) v9.x

然后在项目根目录执行：

```bash
pnpm install
pnpm build
```

构建产物位于 `dist` 目录。

## 致谢

本项目基于 [Refined PrUn](https://github.com/refined-prun/refined-prun) 开发，感谢原作者的出色工作。
