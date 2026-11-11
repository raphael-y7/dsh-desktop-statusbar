# 厂商默认排序依据（Artificial Analysis，只计「公开可用」模型，2026-11-04 核实）

来源：<https://artificialanalysis.ai/leaderboards/models>（2026-11-04 用 curl 抓取页面，解析 Next.js RSC 内嵌 JSON 得到每个模型的精确 `intelligenceIndex`）。
可用性判定：逐个打开 AA 的 `/models/<slug>/providers` 页，以 **provider 数量** 为准——`Total 0 providers` / “No API providers are currently available for …” 视为不可用；`Total ≥1 providers` 且有公开价格视为公开可用。指数版本 **Artificial Analysis Intelligence Index v5.0.1**。

排序规则：每个厂商取 AA 上**公开可用**的最高分模型（同一模型取最高推理档，如 Max / Xhigh）；**不可用的一律排除**（0 provider、preview/internal、deprecated），改用该厂商可用的下一档。

## 最终顺序（从高到低）

| 排名 | 厂商 | AA 可用最强模型 | Intelligence Index | AA provider 数 | 与原排序相比 |
| --- | --- | --- | --- | --- | --- |
| 1 | Anthropic | Claude Opus 5.5 (Max, Default Fallback) | 59.11 | 4（Anthropic/Amazon/Google/Azure） | 不变 |
| 2 | OpenAI | GPT-6 Astra (Max) | 56.85 | 6 | 不变 |
| 3 | Google Gemini | Gemini 4 Argon (High) | 50.41 | 3（AI Studio / Vertex 等） | 不变（仍排除 Carbon） |
| 4 | 月之暗面 Kimi | Kimi K3.1 Pro | 46.45 | 2 | **↑ 从第 5 升到第 4** |
| 5 | Muse (Meta) | Muse Wonder (Max) | 43.57 | 1（Meta） | **↓ 从第 4 降到第 5** |
| 6 | xAI Grok | Grok 4.7 (Xhigh) | 35.49 | 1（AA 记为 SpaceXAI） | 不变 |
| 7 | 阿里云通义千问 | Qwen3.8 Max (0902) | 33.65 | 1（Alibaba Cloud） | 不变 |
| 8 | DeepSeek | DeepSeek V4.1 Flash 1017 (Max) | 32.59 | 23 | 不变 |
| 9 | 智谱 GLM | GLM-5.3 (Max) | 31.65 | 26 | 不变 |
| 10 | 小米 MiMo | MiMo-V2.6-Pro | 29.89 | 4 | 不变 |

机器可读版本：[vendor-intelligence-order.json](vendor-intelligence-order.json)（有序数组，每家带 `excluded` 数组）。

客户端用的厂商标识顺序：

```
["anthropic","openai","google","moonshot","muse","xai","alibaba","deepseek","zhipu","xiaomi"]
```

## 被排除的不可用条目（排除清单）

| 厂商 | 被排除模型 | AA 分数 | 排除原因与证据 |
| --- | --- | --- | --- |
| Muse (Meta) | **Muse Wonder Full (Max)** | 50.08 | AA 明确判定无公开 API：`/models/muse-wonder-full/providers` 写 **“No API providers are currently available for Muse Wonder Full (max).”**、`Total 0 providers`；排行榜该行 Cost / Time / TTFT 全为 `--`，无价格（`priceClass = null`）。与用户反馈一致。 |
| Google Gemini | **Gemini 4 Carbon（High 60.03 / Medium 58.26 / Low 54.22）** | 60.03 | 用户明确说明该模型当前**用不了**，按其口径排除，三个推理档一并排除，Google 改用下一档 Gemini 4 Argon (High) 50.41。**注意**：AA 自己**没有**标 preview/unavailable——其 provider 页写 “Gemini 4 Carbon (high) is available through Google”（1 provider，公开价 $4/$20）。所以这条排除的依据是**用户的实际可访问性**，不是 AA 的可用性字段。 |

其余 8 家（Anthropic、OpenAI、Kimi、xAI、阿里、DeepSeek、智谱、小米）在 AA 上分数最高的条目**本身就有 ≥1 个公开 provider**，无需排除，`excluded` 为空数组。

## Meta (Muse) 专门核查

| 模型 | AA 分数 | AA provider | 结论 |
| --- | --- | --- | --- |
| Muse Wonder Full (Max) | 50.0772 | **0（无公开 API）** | **排除**（这就是用户说的“排最高的那个没开放”） |
| Muse Wonder (Max) | 43.5748 | 1（Meta，$4/$20） | **采用**（Meta 可用最高分），对应目录 `muse-wonder-1.0` |
| Muse Spark 1.3 (Max) | 36.6172 | 1（Meta，$1.25/$4.25） | 不用：AA 标 **deprecated**（“Meta has launched a newer release, Muse Wonder. We suggest considering it instead.”），且分数低于 Wonder |
| Muse Spark Open (Xhigh) | 24.8816 | 有（open weights） | Meta 若连 Wonder 也不可用时的兜底档 |
| Muse Glimmer (High) | 6.3413 | 有 | 太低，不参与 |

即：Meta 去掉不能用的 Wonder Full 后，可用最高分是 **43.57**，低于 Kimi 的 46.45，所以 **Meta 排在 Kimi 之后**（第 5），与用户判断一致。

## Google 专门核查

- Gemini 4 Carbon 三档 60.03 / 58.26 / 54.22 全部排除（依据见上表）；若以后 Carbon 真正可用，Google 会以 60.03 升到**第 1**，Anthropic 退到第 2。
- 排除 Carbon 后 Google 可用最高为 **Gemini 4 Argon (High) 50.41**（3 providers，$4/$20），仍排第 3——Google 用「可用模型」口径在 Meta 之上，因为 Meta 可用最高只有 43.57。

## 其他 8 家的可用性核查明细

| 厂商 | AA 最高条目 | 分数 | provider 数 | 结论 |
| --- | --- | --- | --- | --- |
| Anthropic | Claude Opus 5.5 (Max, Default Fallback) | 59.11 | 4 | 可用，采用 |
| OpenAI | GPT-6 Astra (Max) | 56.85 | 6 | 可用，采用 |
| 月之暗面 Kimi | Kimi K3.1 Pro | 46.45 | 2 | 可用，采用（Kimi 仅此一个 AA 有条目） |
| xAI | Grok 4.7 (Xhigh) | 35.49 | 1 | 可用，采用 |
| 阿里 | Qwen3.8 Max (0902) | 33.65 | 1 | 可用，采用（不在精简目录内，按厂商最强口径） |
| DeepSeek | DeepSeek V4.1 Flash 1017 (Max) | 32.59 | 23 | 可用，采用 |
| 智谱 | GLM-5.3 (Max) | 31.65 | 26 | 可用，采用 |
| 小米 | MiMo-V2.6-Pro | 29.89 | 4 | 可用，采用 |

## 口径说明与风险

- **只算公开可用**：这是本次唯一的口径变化。上一版把 Meta 的 Muse Wonder Full (50.08) 当作可用，所以 Meta 排第 4；修正后 Meta 用 Wonder 的 43.57，掉到第 5，Kimi 升到第 4。其余厂商顺序不变。
- **“No publicly available API” 是图例文本，不是状态标记**：AA 的模型页/图表里到处都有这句（作为图表图例），不能当成模型状态；真正的可用性证据是 provider 页的 provider 数量与“No API providers are currently available”整句。
- 10 家厂商在 AA 上**均有数据**，没有“无数据”厂商；所有分数都是 AA 页面/RSC JSON 里的精确值（`50.0772123627021` 这类），未编造。
- 排序取「**厂商最强模型**」而不是「我们目录里最强的模型」：阿里（Qwen3.8 Max）、DeepSeek（V4.1 Flash）的 AA 最强档不在精简目录内。若改为按目录内模型排序，DeepSeek 会从第 8 掉到最后，顺序会变。
- **单一来源**：以上全部来自 Artificial Analysis 一个站点，时点为 2026-11-04 抓取；榜单更新（Intelligence Index 刚更新到 v5）后需重跑。敏感的排除项只有两个：Google Carbon（依据用户实际可访问性）与 Meta Wonder Full（依据 AA 的 0 provider）。
- 敏感性：若用户确认 Muse Wonder (Max) 同样调不通，Meta 应降到 Muse Spark Open 24.88（open weights 档）→ Meta 会掉到第 10（末位）；若把已废弃的 Muse Spark 1.3 (36.62) 也算上，Meta 才会回到第 6。当前按 AA 的可用性数据取 Wonder 43.57。
