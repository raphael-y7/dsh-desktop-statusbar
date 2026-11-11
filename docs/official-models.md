# 官方模型目录（2026-11-04 核实；2026-11-10 补录 Anthropic Fable 5.2）

数据来源均为各厂商官网定价页原文，价格单位为**每百万 tokens**，币种见表格。
表格列含义：input = 缓存未命中的输入价；cacheRead = 缓存命中价；cacheWrite = 缓存写入价（Anthropic 取 5m TTL，Kimi 取 5min TTL）；output = 输出价。`—` 表示官网未公布，未做任何推算。

机器可读版本见 [official-models.json](official-models.json)。

**已按「每厂商只保留最新一代」精简（目标 ≤40 条）**：旧代条目已从 JSON/MD 删除，保留条目的价格数值与官网原文一致、未做任何修改；逐厂商保留依据见各厂商小节。

## 汇总

| 厂商 | 保留条目数 | 有价格条目数 | 官方来源 |
| --- | --- | --- | --- |
| DeepSeek | 2 | 2 | https://api-docs.deepseek.com/quick_start/pricing/ |
| Anthropic | 5 | 5 | https://platform.claude.com/docs/en/about-claude/pricing（Fable 5.2: https://www.anthropic.com/pricing） |
| 智谱 GLM | 3 | 3 | https://docs.bigmodel.cn/cn/guide/start/pricing |
| 阿里云通义千问 | 2 | 2 | https://help.aliyun.com/zh/model-studio/model-pricing |
| 月之暗面 Kimi | 3 | 3 | https://platform.moonshot.cn/docs/pricing |
| Google Gemini | 2 | 2 | https://ai.google.dev/gemini-api/docs/pricing |
| xAI Grok | 1 | 1 | https://docs.x.ai/docs/pricing |
| 小米 MiMo | 3 | 3 | https://mimo.mi.com/static/docs/price/pay-as-you-go.md |
| Muse (Meta) | 2 | 2 | https://dev.meta.ai/docs/pricing-rate-limits |
| OpenAI | 4 | 4 | https://platform.openai.com/docs/pricing |

## DeepSeek

来源：https://api-docs.deepseek.com/quick_start/pricing/

保留依据：官网当前在售全部模型只有 flash / v4-pro 两条，全保留。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `deepseek-flash` | USD | 峰 0.3/0.006/—/1.2；谷 0.15/0.003/—/0.6 | 官网只列 cache hit / cache miss / output 三项，无独立缓存写入价；错峰价为峰时价 50%。峰时：UTC 周一至周五 01:00-04:00、06:00-10:00（中国法定节假日除外）。 |
| `deepseek-v4-pro` | USD | 峰 1.32/0.044/—/3.96；谷 0.66/0.022/—/1.98 | 同上；cache miss 输入价即 input。 |

## Anthropic

来源：https://platform.claude.com/docs/en/about-claude/pricing（Fable 5.2 按 https://www.anthropic.com/pricing 于 2026-11-10 单独核实）

保留依据：5.5 代 opus/sonnet/haiku 三条为官网当前主推；fable 5.2 为 2026-11-10 官网最新价（fable 5.1 保留）；更早 5/4.x 与 mythos 等非点名家族按规则删除。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `claude-fable-5.2` | USD | 8 / 0.2 / 10 / 40 | cacheWrite 为官网所列的缓存写入价；非峰谷、单档价（2026-11-10 核实）。 |
| `claude-fable-5.1` | USD | 10 / 0.25 / 12.5 / 50 | cacheWrite 为 5m 写入价；1h 写入 $20。 |
| `claude-opus-5.5` | USD | 4 / 0.2 / 5 / 20 | 1h 写入 $8。 |
| `claude-sonnet-5.5` | USD | 2 / 0.1 / 2.5 / 10 | 1h 写入 $4。 |
| `claude-haiku-5.5` | USD | 0.1 / 0.01 / 0.125 / 0.5（超长：0.5 / 0.05 / 0.625 / 2.5） | 按 prompt 长度分档：≤100k tokens 为左列价，>100k 见 longContext。 |

## 智谱 GLM

> 价格为官网“元/百万 Tokens”；图片/视频/语音/向量模型按次或按字符计价，未收录。

来源：https://docs.bigmodel.cn/cn/guide/start/pricing

保留依据：GLM-5.3 系列（标准 / Flash / FlashX）为官网“最新模型”表全部条目；FlashX-Legal 属小众变体未留，5.2/5.1/5-Turbo/5/4.x/视觉旧代全删。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `GLM-5.3` | CNY | 8 / 2 / 0 / 28 | 缓存存储限时免费。 上下文 1M。 |
| `GLM-5.3-Flash` | CNY | 0.8 / 0.23 / 0 / 2.8 | 缓存存储限时免费。 支持图片/视频/文件/文本输入。 |
| `GLM-5.3-FlashX` | CNY | 2 / 0.57 / 0 / 7 | 缓存存储限时免费。 支持图片/视频/文件/文本输入。 |

## 阿里云通义千问

来源：https://help.aliyun.com/zh/model-studio/model-pricing

保留依据：按用户确认只保留 qwen3.8-flash 与 qwen3.8-27b 两条。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `qwen3.8-flash` | CNY | 0.8 / — / — / 2.7 | 华北2（北京）；单次请求输入 0<Token≤1M；非思考与思考模式同价。上下文缓存“享有折扣”但未公布具体单价；Batch 调用的输入输出均按 50% 计费。 |
| `qwen3.8-27b` | CNY | 3 / — / — / 12 | 华北2（北京）；单次请求输入 0<Token≤1M。新加坡/国际地域：输入 3.646、输出 21.875（元/百万 tokens）。上下文缓存折扣未公布单价。 |

## 月之暗面 Kimi

来源：https://platform.moonshot.cn/docs/pricing

保留依据：K3.1 Pro 为最新一代（含 highspeed 档）；K3 仍可正常调用，按用户补充加回（官网顺序在 K3.1 之后）；K2 系列为上一代，已删。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `kimi-k3.1-pro` | CNY | 13 / 1.3 / 13 / 68 | cacheWrite 为 5min TTL 价；1h TTL 写入 ¥26.00。Batch API 为标准价 60%。 |
| `kimi-k3.1-pro-highspeed` | CNY | 26 / 1.3 / 26 / 136 | 5min TTL 写入 ¥26.00；1h TTL ¥52.00。 |
| `kimi-k3` | CNY | 20 / 2 / 20 / 100 | 5min TTL 写入 ¥20.00；1h TTL ¥40.00。Batch 60%。 |

## Google Gemini

> 仅收录文本/对话类 token 计价模型；图像生成、TTS、Transcribe、Embedding、Robotics 等按张/按秒/按字符计价，未收录。缓存写入不计费（Google 只收缓存存储费），故 cacheWrite 为 null。

来源：https://ai.google.dev/gemini-api/docs/pricing

保留依据：Gemini 4 Argon 为最新旗舰，Gemini 3.8 Flash 为最新一代 Flash 档；3.6/3.5/3.1/2.5 及 live/omni 等旧代或非主推档已删。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `gemini-4-argon` | USD | 2 / 0.1 / — / 10 | 仅付费层（无免费额度）；2026-12-01 起调至 input 4.00 / cache 0.20 / output 20.00。仅支持隐式缓存。 |
| `gemini-3.8-flash` | USD | 0.75 / 0.075 / — / 3.75 | 促销价至 2026-12-31；2027-01-01 起 input 1.50 / cache 0.15 / output 7.50。缓存存储另计 $0.50/1M tokens/小时。 |

## xAI Grok

> 仅收录 Text API 文本模型；Imagine/Voice/Tools 按张、按秒、按次计价，未收录。

来源：https://docs.x.ai/docs/pricing

保留依据：Grok 4.7 为官网最新旗舰；4.6/4.5/4.3/4.20 与 grok-build 已删。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `grok-4.7` | USD | 2 / 0.5 / — / 6（超长：4 / 1 / — / 12） | 短上下文价（<200k tokens）；≥200k tokens 的整单按 longContext 计费。缓存写入不收费；Batch 8 折；Priority 2x；US 区域端点 1.1x。 上下文 500k。 |

## 小米 MiMo

> mimo-v2.5-pro / mimo-v2.5 已于 2026-10-21 下线，未收录；Batch API 为实时价 50%。

来源：https://mimo.mi.com/static/docs/price/pay-as-you-go.md

保留依据：MiMo-V2.6 为最新一代，保留 pro / flash 两条常用档，并按用户点名补回 pro-ultraspeed（官网 API 名确认为 mimo-v2.6-pro-ultraspeed，非 mimo-v2.6-ultraspeed）。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `mimo-v2.6-pro` | CNY | 3 / 0.025 / 0 / 6 | 国内人民币价；缓存写入限时免费。海外美元价：$0.435 / $0.0036 / $0.87。 |
| `mimo-v2.6-flash` | CNY | 1 / 0.02 / 0 / 2 | 国内人民币价；海外美元价：$0.14 / $0.0028 / $0.28。 |
| `mimo-v2.6-pro-ultraspeed` | CNY | 30 / 0.25 / 0 / 60 | 国内人民币价；不支持 Batch API。海外美元价：$4.35 / $0.036 / $8.7。 |

## Muse (Meta)

> 查证结论：Muse 是 Meta 的模型系列（Meta Model API / dev.meta.ai），非独立厂商。Muse Image 按张 $0.01、Muse Voice Transcribe 按音频 $0.18/小时，未收录。

来源：https://dev.meta.ai/docs/pricing-rate-limits

保留依据：Muse Wonder 1.0 为旗舰（官网 models 页确认 Wonder 仅有 1.0，无 1.1/2.0），Muse Spark 1.3 为最新 Spark；1.2/1.1 与 contributor 变体已删。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `muse-wonder-1.0` | USD | 4 / 0.2 / — / 20 | Standard 模式；Muse Wonder 无 Contributor 模式。 |
| `muse-spark-1.3` | USD | 1.25 / 0.15 / — / 4.25 | Standard 模式。 |

## OpenAI

> o 系列仅 o3 / o3-pro 仍在价格页；gpt-5.6-sol 另在 Cyber 表中出现（同价）。图像/音频/转写/嵌入模型与微调价格未收录。

来源：https://platform.openai.com/docs/pricing

保留依据：官网“最新”折叠组 4 条：GPT-6 Astra 旗舰 + GPT-6.1 的 sol/terra + gpt-6-luna 轻量档；gpt-6-sol 被 6.1-sol 取代，5.x/4.x/o 系列及 cyber/rosalind/realtime 等专用档已删。

| 模型（API 名） | 币种 | input / cacheRead / cacheWrite / output | 备注 |
| --- | --- | --- | --- |
| `gpt-6-astra` | USD | 10 / 1 / 12.5 / 50 | Standard 档、短上下文档价格；Batch/Flex 为 5 折，Fast 为 2x，Ultrafast 为 6x；30m 缓存写入价，12h 写入为 30m 的 2 倍。 |
| `gpt-6.1-sol` | USD | 2 / 0.1 / 2.5 / 10 | Standard 档、短上下文档价格；Batch/Flex 为 5 折，Fast 为 2x，Ultrafast 为 6x；30m 缓存写入价，12h 写入为 30m 的 2 倍。 |
| `gpt-6.1-terra` | USD | 1 / 0.05 / 1.25 / 5 | Standard 档、短上下文档价格；Batch/Flex 为 5 折，Fast 为 2x，Ultrafast 为 6x；30m 缓存写入价，12h 写入为 30m 的 2 倍。 |
| `gpt-6-luna` | USD | 0.1 / 0.01 / 0.125 / 0.5 | Standard 档、短上下文档价格；Batch/Flex 为 5 折，Fast 为 2x，Ultrafast 为 6x；30m 缓存写入价，12h 写入为 30m 的 2 倍。 |

## 名称查证结论

| 名称 | 结论 |
| --- | --- |
| `muse` | Muse 是 Meta 的模型系列（Meta Model API，dev.meta.ai）：muse-wonder-1.0、muse-spark-1.3 / 1.2 / 1.1 及 contributor 变体。已收录到 vendors 中的 muse。 |
| `fable` | fable 是 Anthropic 的模型系列：Claude Fable 5.2 / 5.1 与 Claude Fable 5 均在 Anthropic 官方定价表中，已收录。 |
| `haike` | 官方页面未出现名为 haike 的模型。最可能是 Anthropic Claude Haiku 的谐音/拼写变体：用户同批点名的 fable 已确认为 Anthropic 模型，且 haike 与 Haiku 音近；Claude Haiku 系列已在目录中（claude-haiku-5.5 / claude-haiku-4.5 / claude-haiku-3.5）。此为推测，未新增 haike 条目、未编价格，需用户确认。 |
| `huike` | 用户已澄清是 haike，huike 作废，不再单独追查。 |

## 未核实清单

| 名称 | 结论 | 核实日期 |
| --- | --- | --- |
| `haike` | 在 12 家已收录厂商官方定价页 + Anthropic 模型总览 + 腾讯混元/百度千帆/讯飞开放平台/商汤 SenseNova/华为云/火山引擎页面全文检索，均无 haike 或「海科/海客」；公开检索（DuckDuckGo/Bing）也无可核实的官方模型。未收录、未编价；疑为 Claude Haiku 谐音，见「名称查证结论」。 | 2026-11-04 |

## 已排除 / 未收录

- 火山引擎 / 豆包：按用户要求移除，不收录。
- 按第四轮要求：各厂商只保留最新一代，旧代模型已从目录删除（原 150 条 → 精简后条数见汇总表），价格未改动。
- 阿里云 Qwen3.7 Flash：用户确认已下架，不收录；qwen3.8-2.4t-a95b 不在保留清单内，不收录。
- 各厂商按张、按秒、按字符、按分钟计价的图像/视频/语音/嵌入模型：不属于 token 定价目录，未收录。

## 核实方式

2026-11-04 用 curl 抓取下列官方页面并逐条抄录（页面为模拟环境中的权威数据）：

- https://api-docs.deepseek.com/quick_start/pricing/
- https://platform.claude.com/docs/en/about-claude/pricing
- https://www.anthropic.com/pricing（2026-11-10 补录 Fable 5.2）
- https://docs.bigmodel.cn/cn/guide/start/pricing
- https://help.aliyun.com/zh/model-studio/model-pricing
- https://platform.moonshot.cn/docs/pricing
- https://ai.google.dev/gemini-api/docs/pricing
- https://docs.x.ai/docs/pricing
- https://mimo.mi.com/static/docs/price/pay-as-you-go.md
- https://dev.meta.ai/docs/pricing-rate-limits
- https://platform.openai.com/docs/pricing
