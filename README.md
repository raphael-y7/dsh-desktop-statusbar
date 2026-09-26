<h1 align="center">dsh-desktop-statusbar</h1>

<p align="center">
  <a href="https://github.com/raphael-y7/dsh-desktop-statusbar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/raphael-y7/dsh-desktop-statusbar?style=social"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-desktop-statusbar?color=red"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-green"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.1.7-%234d6bfe"></a>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-%235fa04e"></a>
  <img alt="language" src="https://img.shields.io/github/languages/top/raphael-y7/dsh-desktop-statusbar?color=yellow">
  <a href="https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar"><img alt="dshfind" src="https://img.shields.io/badge/dshfind-listed-%2300a884"></a>
  <a href="https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar"><img alt="1024Store" src="https://img.shields.io/badge/1024Store-listed-orange"></a>
</p>

<p align="center">中文 | <a href="README.en.md">English</a></p>

以一条可配置的状态栏替换 DSH 桌面端对话区底部的统计行：字段、顺序、模型单价与计价单位均可配置，费用按官方峰谷口径实时估算。

> 非商业许可：个人、学习、教学与非营利使用均可自由使用和修改，**禁止商业用途**（[PolyForm Noncommercial 1.0.0](LICENSE)）。

![底栏效果](docs/statusbar.png)

## 功能

- **10 个可选字段**：会话状态、峰谷判断、轮次与步数、综合命中、首字平均、输出速度、运行用时、本轮费用、总计费用、余额
- **点击字段可查看详情**：

  | 字段 | 内容 |
  | --- | --- |
  | 会话状态 | 上下文占用：系统提示词 / 工具定义 / 对话消息 |
  | 综合命中 | 最高 / 最低缓存命中率 |
  | 首字平均 | 最快 / 最慢首字延迟 |
  | 输出速度 | 最快 / 最慢输出速度 |
  | 运行用时 | 模型用时 / 工具调用 |
  | 本轮费用 | 本轮会话的 token 明细 |
  | 总计费用 | 整个会话累计的 token 明细 |
  | 余额 | 充值余额 / 赠金余额 |

- **费用估算**：按官方峰谷口径计价，每条调用按其发生时刻与所用模型分别计算
- **价格库**：自定义单价、峰谷分档、CNY / USD 计价单位
- **其他**：节假日日历一键更新、账户余额每分钟刷新、中英双语

## 安装

在 DSH 桌面端打开 **插件 → 添加插件**，输入包名后安装：

```
dsh-desktop-statusbar
```

网络受限时，可在同一对话框内将安装源切换为「中国大陆镜像源」。亦支持 GitHub 仓库地址：

```
https://github.com/raphael-y7/dsh-desktop-statusbar
```

命令行方式：

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar
```

已发布至 npm，并收录于 [dshfind](https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar) 与 [1024Store](https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar)。

## 使用

打开 **设置 → 状态栏**：

![设置页](docs/settings.png)

- **会话状态**：栏首圆环，进度表示上下文占用，颜色表示运行状态（空闲灰 / 运行绿 / 报错红 / 待审批黄），点击查看各部分的 token 构成
- **统计字段**：勾选控制显示，取消勾选仅隐藏、不改变位置；拖动右侧把手调整顺序；「恢复默认设置」恢复出厂顺序并全选
- **自定义模型价格**：输入模型名并「添加」以新增条目；「修改」展开编辑区，保存后写入；需区分峰谷时段时勾选「峰谷计价」，否则按全天同价计算
- **计价单位**：价格编辑区右上角可选 CNY 或 USD。切换时内置的两款模型改用对应币种的官方参考价（已修改的条目保留），费用段的符号随之变化；余额按接口返回的币种显示
- **节假日**：点「更新节假峰谷」获取并写入下一年的放假安排
- **余额**：每分钟自动刷新

### 计费口径

高峰时段为**北京时间周一至周五 9:00-12:00、14:00-18:00**，空闲价为高峰价的一半；法定节假日与周末全天按空闲价计费（与[官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)一致，2026-09 核对）。

![自定义模型价格](docs/pricing.png)

## 已知限制

- 最快 / 最慢首字与速度来自 host 新增的投影，**升级后需完全退出并重启 DSH** 才开始统计
- 价格库中缺少单价的模型不计费，补充单价后自动补算

## 开发

```powershell
node tools/test.cjs
```

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：允许个人、研究、学习、教学与非营利使用，允许修改与再分发（保留署名），**禁止商业用途**。
