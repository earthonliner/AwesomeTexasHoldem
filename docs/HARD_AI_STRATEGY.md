# 困难难度 AI 策略详解（含当前参数）

> 本文档描述困难难度 AI 的完整决策模型：范围、胜率、弃牌率、动作 EV、尺度、混合与真人剥削是**如何在同一套口径下彼此衔接**的。以下数值是当前实现的基准、公式和上下限，用于模拟有范围意识、会混合策略且会针对熟客调整的线下现金局强玩家，**并非声称已经求得 GTO 均衡**。最终动作还会受随机混合、具体组合、位置、有效筹码、行动线和玩家画像共同影响；文中 `range=0.25` 表示按对应规则排序后保留约 25% 的两张底牌组合，不代表每一类牌都以 25% 概率行动。
>
> 代码入口：`src/ai/decision.ts`（决策）、`src/ai/preflopRanges.ts`（翻前范围函数）、`src/engine/preflopStrength.ts`（起手牌排序）、`src/engine/monteCarlo.ts`（范围采样与胜率）、`src/ai/profile.ts`（真人画像）、`src/ai/image.ts`（自我形象）、`scripts/ai-eval/`（配对评估与脚本对手）。文末「审计采纳情况」记录了外部策略审计的逐条处理结果与第二、三轮复盘，「当前实测行为指标」给出配对评估结果。

## 目录

1. [设计主线](#0-设计主线)
2. [固定性格](#1-固定性格同桌可观察换桌才重置)
3. [翻前手牌排序与场景识别](#2-翻前手牌排序与场景识别)
4. [未开池：RFI、浅码与小盲 limp](#3-未开池rfi浅码与小盲-limp)
5. [Limped pot：隔离与 overlimp](#4-limped-pot隔离与-overlimp)
6. [面对一次 open](#5-面对一次-open防守3-bet-与-squeeze)
7. [面对 3-bet](#6-面对-3-bet有效筹码驱动的-call--4-bet--jam)
8. [面对 4-bet+](#7-面对-4-bet继续与-5-bet)
9. [大额下注与全下](#8-大额下注全下与隔离)
10. [对手翻后范围](#9-对手翻后范围按角色采样)
11. [听牌、阻断牌与湿润度](#10-真实听牌阻断牌与牌面湿润度)
12. [动态诈唬频率](#11-动态诈唬频率候选质量优先)
13. [动作 EV：下注对照过牌、加注对照跟注](#12-动作-ev下注对照过牌加注对照跟注)
14. [下注尺度](#13-牌面spr-与下注尺度)
15. [一次性抽样的行动线计划](#14-一次性抽样的行动线计划)
16. [真人画像剥削](#15-置信度加权的真人画像剥削)
17. [自我形象、思考时间与规则保护](#16-自我形象思考时间与规则保护)
18. [审计采纳情况](#17-审计采纳情况)
19. [当前实测行为指标](#18-当前实测行为指标)

---

## 0. 设计主线

```text
组合计数正确 → 场景范围正确 → 对手按角色（下注者/跟注者/过牌者/未行动者/已全下者）建模
→ 被跟注后的条件范围 → 候选动作 EV 可比较 → 明显劣势动作被截断
→ 近等价动作中保留性格与混合 → 有足够样本时才针对真人偏差剥削
```

困难相对中等真正增加的是精度和一致性，而不是诈唬率：

| 参数 | 中等 | 困难 | 原因 |
| --- | ---: | ---: | --- |
| 翻后范围蒙特卡洛 | 480 次/决策 | **720 次**，临界时追加 720 次 | 固定样本无法支撑 1–2 个百分点的边界判断（850 次的标准误约 1.7%） |
| 河牌单挑 | 采样 | **精确枚举**（≤990 个组合） | 没有未来公共牌时不需要采样噪声 |
| 翻前大额跟注/全下模拟 | 500 次 | **850 次** | 大底池方差高 |
| 浅码 4-bet 的 jam/call 对比 | 360 次 | **520 次** | 同上 |
| 最终诈唬频率硬上限 | 0.36 | **0.46** | 困难允许更多合格候选，但仍须通过阻断牌、行动线和 EV 门槛 |
| 跟注 sigmoid 温度 | 0.048 | **0.038** | 更贴近数学边界 |
| 明显负 EV 跟注 | 随机 | **截断为 0** | 河牌 `edge < -0.03`、其他街 `< -0.08` 直接弃牌 |
| 持久化玩家画像 | 不读取 | **读取并按样本置信度加权** | 针对真人长期倾向，而不是偷看底牌 |

---

## 1. 固定性格：同桌可观察、换桌才重置

每个困难 AI 创建时有 **38%** 概率生成 LAG、**62%** 概率生成 TAG；字段在“均值 ± spread”内均匀采样并截断到 `[0,1]`。

| 字段 | TAG 范围 | LAG 范围 | 在策略中的主要作用 |
| --- | ---: | ---: | --- |
| `vpip` | 0.205–0.275 | 0.295–0.365 | 翻前整体松紧：`style = clamp(vpip / 0.27, 0.72, 1.4)` |
| `pfr` | 0.725–0.835 | 0.765–0.875 | **倾向参数**（兼容字段），不是 PFR 手数比例；困难主路径以显式位置范围开池 |
| `aggression` | 0.56–0.70 | 0.65–0.79 | 价值加注、隔离、下注尺度、c-bet/probe/float 频率 |
| `bluff` | 0.135–0.205 | 0.185–0.255 | 动态诈唬公式的起点，不是最终诈唬率 |
| `callDown` | 0.43–0.57 | 0.49–0.63 | 跟注边际：`edge += (callDown - 0.5) × 0.055` |
| `positionAwareness` | 0.87–0.97 | 0.87–0.97 | 动态诈唬的位置项与非河牌胜率实现修正 |
| `stackReactivity` | 0.79–0.93 | 0.79–0.93 | 深浅筹码 4-bet/5-bet、听牌隐含赔率 |
| `potReactivity` | 0.77–0.91 | 0.77–0.91 | 底池相对筹码大小对诈唬频率的影响 |

同一手牌的翻前排序还加入 `U(-0.0125,+0.0125)` 小扰动，避免边界组合每次执行完全相同的动作。性格的定位是**在接近等价的动作中形成偏好**（c-bet 基准、隔离概率、尺度微调），而不是改变数学门槛。

---

## 2. 翻前手牌排序与场景识别

### 2.1 两套排序，各司其职

审计指出原加法公式会得出 **AKs (106.25) > AA (106)**、AQs > JJ，这会污染所有 “top X%” 阈值。现在：

| 排序 | 来源 | 用途 |
| --- | --- | --- |
| **可玩性排序** `preflopScore` | 显式 169 类起手牌表 `PLAYABILITY_ORDER`（前 20：AA KK QQ JJ AKs AKo TT AQs AJs KQs 99 AQo ATs KJs QJs 88 KTs AJo JTs 77） | RFI、防守、隔离、3-bet 候选、翻后带入的翻前范围 |
| **全下排序** `preflopAllInScore` | 对子 `52 + rank×2.9`；非对子 `30 + 高牌×1.9 + 低牌×1.0 + (A 高 +3) + 连张 1/0.5 + 同花 2.5` | shove / re-shove 范围、open-jam、浅码 4-bet jam 的 EV 对比 |

两者都以真实 **1,326 个组合权重**（对子 6、同花 4、非同花 12）换算成百分位 `pct∈(0,1]`。例如 22 与 76s 的可玩性百分位相近（0.79 / 0.78），但全下百分位分别为 0.53 与 0.30——小对子适合摊牌全下，同花连张不适合。

### 2.2 价值 4-bet / 5-bet 使用显式手牌类别

单一百分位无法同时表达 “JJ 比 AKs 更可玩” 与 “AK 在任何深度都是 jam 候选”，因此 4-bet/5-bet 价值改为显式类别概率（见 §6、§7）。

### 2.3 场景识别

| 完整翻前加注次数 | 场景 |
| ---: | --- |
| 0，且无人 limp | `unopened` |
| 0，已有 limp | `limped` |
| 1 | `singleRaised` |
| 2 | `threeBet` |
| ≥3 | `fourBetPlus` |

首个不足额 all-in 仍会建立一个 raised pot；之后不足额加注不会虚增成 3-bet/4-bet 层级。缺少完整行动历史时按当前下注级别推断：`≤1.5BB / ≤4.5BB / ≤12BB / >12BB` 分别视为 unopened / single-raised / 3-bet / 4-bet+。

有效深度统一定义为 `effectiveDepthBB = (min(本方后手, 对局有效后手) + 本手已投入) / BB`。**对局有效后手**取还能与本方继续下注的那名对手：

```text
contest(对手) = 对手后手 + max(0, 对手本街已投入 - 本方本街已投入)   // 它还能对本方投入的筹码
对局有效后手  = min(本方后手, contest(相关攻击者))                  // 攻击者仍能行动
              = min(本方后手, 在局对手中最大的 contest)              // 攻击者已全下或已弃牌
```

已全下的攻击者后面没有筹码，之后的下注只发生在仍有筹码的玩家之间。此前一律按相关攻击者计算：20BB 的全下被两名 100BB 玩家跟注后，两名深码玩家之间的有效后手被算成约 0，SPR、commit 判断与几何尺度都按“已经全下”处理。

---

## 3. 未开池：RFI、浅码与小盲 limp

```text
openRange = clamp(位置基准 × style + stealBonus, 0.08, 0.82)
            × shortStackOpenMultiplier(effectiveDepthBB)
shortStackOpenMultiplier(d) = clamp(0.72 + d / 90, 0.72, 1)     // 25BB 起逐渐收紧
```

| 位置 | 2 人桌 | 3 人桌 | 4–7 人桌 | 8–9 人桌 |
| --- | ---: | ---: | ---: | ---: |
| Early | — | — | 0.19 | **0.145** |
| Middle | — | — | 0.22 | **0.19** |
| HJ | — | — | **0.255** | **0.255** |
| CO | — | — | **0.33** | **0.33** |
| BTN | **0.78** | **0.58** | **0.48** | **0.48** |
| SB | —（BTN 兼任） | **0.42** | **0.42** | **0.42** |

深度从未开池节点起就参与决策：

| 有效深度 | 行为 |
| --- | --- |
| `≤ 12BB` | **open-jam**：按全下排序，`allInPct ≥ 1 - min(0.85, openRange × openJamWidth)` 时全下，否则弃牌（不再 raise/fold）；`openJamWidth = clamp(2.1 - 0.25 × 后方人数, 1, 1.9)`——只剩盲注在后时 jam 范围约为开池范围的 1.6–1.9 倍，前位约等于开池范围（10BB BTN 会 jam A5o/Q9o/22，UTG 只 jam AJo+ 一类） |
| `< 22BB` | 高牌 ≤8 的同花连张（gap≤2）首入直接弃牌：没有隐含赔率 |
| 其他 | 常规 raise-or-fold |

- 除 SB 外采用 **raise-or-fold**；BB 无人加注时直接 check。
- 非单挑 SB 的 limp 分支现在**带保护**：非 premium（AA/KK/QQ/AKs/AKo 之外）以 `P = 0.28 × (1 - aggression × 0.35)`（约 20%–23%）limp；premium 也以 **18%** 进入同一 limp 分支，因此 limp 范围不再是 BB 可以无条件攻击的封顶范围。
- RFI 尺度：基准倍数 `2.55 + U(0,0.4)`，取整到 0.5BB 后通常为 **2.5BB 或 3BB**，受合法最小加注与底池上限约束。

---

## 4. Limped pot：隔离与 overlimp

| 参数 | 当前公式/数值 |
| --- | --- |
| 隔离范围 | `clamp(位置基准 × style + 0.10 - max(0, limper数 - 1) × 0.02, 0.16, 0.58)` |
| 执行隔离的混合概率 | `0.72 + aggression × 0.22` |
| 隔离基础倍数 | `3.05 + U(0,0.4)` |
| 每个 limper 尺度加成 | `+0.70×` |
| SB/BB OOP 尺度加成 | `+0.45×` |
| 可 overlimp 的结构 | 任意对子、同花 A、gap≤2 的同花连张 |
| overlimp 范围 | `strength ≥ 1 - clamp(位置基准 × style + 0.18, 0, 0.65)` |

limper 越多，死钱越多但被多人跟注、实现率下降的概率也越高，因此**隔离尺度随人数增大、隔离范围反而略微收紧**（每多一名 limper 收紧 2 个百分点），而不是同比扩大。`位置基准 × style` 只应用一次 style，不存在双重放大。

---

## 5. 面对一次 open：防守、3-bet 与 squeeze

| 位置 | 防守基准 |
| --- | ---: |
| BB | **0.42** |
| SB | **0.23** |
| 其他 IP | **0.24** |
| 其他 OOP | **0.17** |

开池者的范围宽度按它的**桌面座位**取 §3 的 RFI 基准 `openerRange = openingRange(开池者座位, 桌人数)`（6 人桌：UTG 0.19、MP 0.22、HJ 0.255、CO 0.33、BTN 0.48、SB 0.42）。此前用的是翻后实时行动顺序：中间玩家全部弃牌后，UTG 开池面对 BB 同样“最后行动”，会被误当成按钮偷盲而过度防守。只有缺少座位信息时才回退到位置因子（≥0.72→0.40，≤0.42→0.19，其余 0.26）。

```text
callerRange(座位, IP, openerRange)
  = 位置基准 × clamp(sqrt(openerRange / 0.26), 0.80, 1.25)

defendRange
  = callerRange
  × exp(-0.20 × max(0, openBB - 2.5))
  × style
  × 真人范围修正          // 被画像真人开池：× sqrt(rangeMult)
  + min(0.08, caller数 × 0.035)
最终 clamp [0.055, 0.56]
```

例：BB 面对 UTG open 防守 `0.42 × 0.855 ≈ 0.36`，面对 CO `≈ 0.47`，面对 BTN/SB（封顶 ×1.25）`≈ 0.53`，再乘尺寸衰减与 style。

- 尺寸项为指数衰减，4.5BB→5BB 只会平滑收紧，不存在范围断崖。
- Value 3-bet：`value3Range = clamp(0.055 × (openerRange / 0.26)^0.7, 0.04, 0.095)`——面对 UTG 约 top **4.4%**（QQ+/AK 一带），CO 约 **6.5%**，BTN 约 **8.5%**，SB 约 **7.7%**。
- Light 3-bet 候选：A2s–A5s、高张≥8 且 gap≤1 的同花连张、以及“同花、高张≥J、低张≥9”的结构（J9s/QTs/KJs/AQs 等）；还须位于 top `min(defendRange, 0.20)`，混合概率 `bluff × (IP ? 0.55 : 0.38) × foldPressure`。
- 3-bet 目标倍数：IP **2.9–3.3×**，OOP **3.65–4.05×**；每个已跟注者再 `+0.65×` 形成 squeeze，仍受 pot-cap 限制。
- IP/OOP 优先使用与攻击者的真实行动顺序；上下文缺失时，翻前以 `positionFactor≥0.65` 视为 IP，翻后以 `≥0.60` 视为 IP。

---

## 6. 面对 3-bet：有效筹码驱动的 call / 4-bet / jam

```text
sizePenalty      = clamp(1.15 - max(0, 3betBB - 8) × 0.035, 0.65, 1.10)
shallowPressure  = clamp((70 - effectiveDepthBB) / 40, 0, 1)
deepRealisation  = clamp((effectiveDepthBB - 120) / 180, 0, 1)
depthFactor      = 1 - shallowPressure × 0.24 × stackReactivity
                     + deepRealisation × 0.20 × stackReactivity

continueRange = clamp(
  (IP ? 0.13 : 0.105) × sizePenalty × style × depthFactor
  + (对子/同花A/同花连张 ? deepRealisation × 0.025 × stackReactivity : 0),
  0.055, 0.22)
```

**Bluff 4-bet**：仅 A2s–A5s，概率 `bluff × (0.30 + shallowPressure×0.38 - deepRealisation×0.14) × foldPressure`。

**Value 4-bet 概率**（`valueFourBetProbability`，`sp = shallowPressure`，`dr = deepRealisation`）：

| 手牌 | 概率 |
| --- | --- |
| AA / KK | 1 |
| QQ | `0.92 - 0.25·dr` |
| AKs | `0.90 - 0.30·dr` |
| AKo | `0.78 + 0.22·sp - 0.35·dr` |
| JJ | `0.40 + 0.55·sp - 0.40·dr` |
| AQs | `0.22 + 0.50·sp - 0.22·dr` |
| TT | `0.70·sp - 0.10` |
| AQo | `0.45·sp - 0.10` |
| 其他 | 0（只可能作为 call 或 bluff 4-bet） |

**浅码分支（`effectiveDepthBB ≤ 50` 且面对 `≥ 7.5BB`）不再直接 jam**，而是比较 fold / call / jam 的 EV：

```text
threeBetRange   = clamp((IP ? 0.075 : 0.095) × rangeMult, 0.04, 0.16)     // 全下排序
continueShare   = clamp(jamContinueFraction(jamRisk, pot) / foldPressure, 0.2, 0.8)
jamContinueFraction = clamp(0.28 + 0.22 × pot / jamRisk, 0.25, 0.65)

EV(jam)  = (1 - continueShare) × pot
         + continueShare × [eq(vs threeBetRange × continueShare) × (pot + jamRisk + callerContribution) - jamRisk]
EV(call) = eq(vs threeBetRange) × (pot + toCall) × (IP ? 0.90 : 0.80) - toCall

jam  当 EV(jam) > max(0, EV(call)) + 0.01 × pot
call 当 EV(call) > 0 且（value 类别或位于 continueRange 内）
否则 fold
```

被跟注后的胜率来自 **3-bet 范围中真正会继续的那一片**，而不是整个 3-bet 范围。常规深度的 4-bet 基准 `2.15–2.55×`，受 0.8 pot-cap 和最小加注约束。

---

## 7. 面对 4-bet+：继续与 5-bet

```text
shallowStackOff = clamp((75 - effectiveDepthBB) / 45, 0, 1)
deepFourBetPlay = clamp((effectiveDepthBB - 160) / 180, 0, 1)
continueRange   = clamp(0.038 × rangeMult × (1 + 0.50·shallowStackOff·stackReactivity
                                                + 0.22·deepFourBetPlay·stackReactivity), 0.035, 0.10)
```

**5-bet 概率**（`fiveBetProbability`，`so = shallowStackOff`，`dp = deepFourBetPlay`）：

| 手牌 | 概率 |
| --- | --- |
| AA / KK | `0.95 - 0.15·dp` |
| QQ | `0.70 + 0.30·so - 0.40·dp` |
| AKs | `0.68 + 0.32·so - 0.35·dp` |
| AKo | `0.45 + 0.45·so - 0.30·dp` |
| JJ | `0.60·so - 0.05` |
| TT / AQs | `0.35·so - 0.10` |
| 其他 | 0（continueRange 内以 call 为主） |

目标基准 `2.05–2.45×`，允许在合法/有效筹码边界全下。

---

## 8. 大额下注、全下与隔离

`effective = max(1, min(本方后手, 对局有效后手))`，`currentLevel = 本街已投入 + toCall`。满足 `toCall ≥ effective × 0.52`、`currentLevel ≥ maxRaiseTo` 或**当前加注者已全下**时进入全下模型。最后一个条件不能省：对局有效后手按后方深码玩家计算（§2.3）之后，UTG 的 18BB 全下相对 BTN 的 100BB 只是一个“小额 open”，BTN 会以约 60% 的频率用 KQs 3-bet——而全下者根本不会弃牌。

```text
jamRange = shoveRangeFraction(currentLevelBB)          // 分段线性插值，无断崖
  控制点：6BB→0.34, 10BB→0.24, 18BB→0.14, 30BB→0.09, 55BB→0.05, 90BB→0.04
≤15BB 且 CO/BTN/SB 的首次 jam ×1.45（只剩盲注在后的短码 jam 范围远宽于前位）
4-bet+ pot ×0.72；被画像真人 ×rangeMult；最终 clamp [0.025, 0.30]
```

例：BB 持 A9o 面对 BTN 10BB open-jam（`villR=0.30`，赔率 0.44，胜率 ≈0.53）跟注；K8o/Q7o 弃牌；同样的 A9o 面对 25BB jam（`villR=0.11`）弃牌。

- 对手组合按**全下排序**抽样，困难运行 **850 次**。
- 模拟对手数 = 台面上**已投入到当前下注级别或已全下**的对手数（`committedOpponents`），而不是 “最后一次加注后的 caller 数 + 1”；尚未行动的玩家不算对手，而是转化为安全边际。
- 底池赔率 `odds = call / winnable`：`call = min(toCall, 本方后手)`，`winnable` 为本方有资格赢得的各层底池之和（含本方的跟注）。本方全下也不够跟注时，超出部分不属于本方：BB 剩 5BB，面对 3BB open、两家跟注后的 100BB 全下，赔率是 `5 / 21.5 = 23%`，而不是 `99 / 209.5 = 47%`——此前 KQs、88、A5s、K9o（对全下范围约 29%–35%）都会弃牌。
- 多名全下者形成多层边池时，仍按“对全部已投入对手的胜率 × 可赢底池”计算；本方在人数更少的边池里胜率更高，因此这一近似偏保守。
- 安全边际 `margin = 0.012 + min(2, 后方未行动人数) × 0.012 + (跟注后仍有 >20% 底池的后手且行动未关闭 ? 0.01 : 0)`。
- 继续门槛：`equity + (攻击者为被画像真人 ? valueLean×0.30 : 0) ≥ odds + margin`。
- 后方仍有玩家时的隔离：面对 ≥40BB 的 jam 仅 `AA/KK`，较短 jam 可用 `AA/KK/QQ/AKs/AKo`。
- 引擎禁止制造无人可匹配的“假加注”。

“跟注后仍有筹码和未来行动”的局面（`chipsBehind > 0.2 × potAfterCall`）只通过 margin 处理；这是审计 5.6 指出的近似，尚未拆成独立的三类节点。

---

## 9. 对手翻后范围：按角色采样

范围采样器 `estimateEquityVsRange` 把每名对手分成五种角色，从**同一份按当前牌面排序、并经翻前范围过滤**的组合列表中抽样：

| 角色 | 何时 | 抽样池 |
| --- | --- | --- |
| **下注者** | 本街最后攻击者 | 极化：`1 - bluffShare` 来自 top `rangeFraction`（value pool），`bluffShare` 来自 value pool 之外按诈唬候选质量排序的 bluff pool |
| **跟注者** | 面对下注时已跟注的对手 | **85%** 来自 value pool 下方约 35% 组合的 capped 区间，**15%** 慢打份额仍来自 value pool |
| **过牌者** | 无人下注且已在本街 check（上一街 check-through 时，后方未行动者亦按过牌者处理） | **80%** 来自去掉 top `checkedCapTier` 之后的弱区，**20%** 陷阱份额来自 top 区 |
| **未行动者** | 面对下注时尚未行动的后方玩家 | 完整翻前过滤后的范围 |
| **已全下者** | 本街之前已全下、本街没有行动 | 完整翻前过滤后的范围；翻后才全下的只取其中最强的 **50%**（`idleShare`） |

已全下者之后没有任何行动能再收窄它的范围，因此既不是跟注者也不是过牌者。本街以下注或跟注的方式全下的对手仍按下注者/跟注者采样，只是被标记为全下座位。有全下座位时，采样器除总胜率外还分别给出 `equityVsLive`（只对仍能行动的对手，即它们争夺的边池）与 `equityVsAllIn`（只对全下者，即其他人都弃牌后主池的价值），平局按各自池内的人数平分；这三项是 §12.6 分层 EV 的输入。

过牌封顶层级 `checkedCapTier`：

```text
AI 自己是上一街攻击者（对手 check 给加注者）：0.08        // 几乎不含信息
否则：clamp(0.34 - 0.05 × (对手数 - 1)
           + (上一街攻击者本街 check 给我 ? 0.06 : 0)
           + (上一街全桌 check-through ? 0.06 : 0), 0.16, 0.42)
```

这解决了此前 “四张同花河牌、全桌两次过牌，顶对却只有 1% 胜率” 的失真：过牌者不再被当成 “top 54% 的下注范围”，但也不被视为绝对没有强牌。

**当前街范围比例**（下注者 / 未行动者用）：

```text
基础：面对下注 0.38；无人下注 0.62
下注尺度：- min(0.18, min(2, betToPot) × 0.12)
同街 ≥2 次激进动作：×0.72；3-bet pot ×0.82；4-bet+ pot ×0.65；limped pot ×1.18
turn -0.04；river -0.08；基础 clamp [0.12,0.85]
check-raise ×0.62；相关攻击者为被画像真人 ×rangeMult
面对真人本街首个下注：× betWidth[该下注的尺寸类]（§15）；最终 clamp [0.07,0.88]
```

尺寸类由共享函数 `betSizeClass` 定义：`betToPot < 0.42` 为 small，`< 0.85` 为 medium，否则 big。统计与读取使用同一口径。

**翻前范围连续带入**：

| 翻前底池 | 保留组合比例 |
| --- | ---: |
| 4-bet+ | **0.055** |
| 3-bet | **0.12** |
| Single-raised，范围对手是翻前加注者 | `openerRange`：按加注者**桌面座位**（§5，6 人桌 UTG 0.19 … BTN 0.48） |
| Single-raised，范围对手是跟注者 | `callerRange(其座位, BTN/CO 视为 IP, openerRange)`：BB 最宽（约 0.36–0.53），SB 与 OOP 冷跟最窄 |
| Limped / 未加注 | **0.72** |
| 无法分类但已加注 | **0.30** |

**范围对手**依次取：仍在局中的相关攻击者 → 仍在局中的翻前加注者 → BB → SB → 第一个在局对手；先在仍能行动的对手中找，都已全下时才在全下者中找（全下者的范围只在摊牌时起作用）。此前统一按“相关攻击者的实时位置”取 0.19/0.26/0.34，BB 跟注者会被当成开池范围，翻前加注者在翻后行动靠前时又被当成前位范围。范围对手为被画像真人时乘 `rangeMult`，最终 clamp `[0.035, 0.86]`。

**下注范围的诈唬份额**：

```text
base = 0.30 + boardWetness × 0.10；betToPot ≥ 0.8 +0.05；river +0.02
同街 ≥2 次激进动作 ×0.70；多人 ÷ sqrt(liveOpponents)；clamp [0.08,0.50]
check-raise ×0.62；被画像真人按大小注读数缩放
真人首个下注为 big 且 betWidth.big > 1：× sqrt(betWidth.big)
最终 clamp [0.03, betWidth > 1.3 ? 0.60 : 0.50]
```

频繁超池的玩家不可能每次都有坚果：范围变宽的那部分主要是诈唬，所以大注的诈唬份额随宽度一起上升，上限也放宽到 0.60。

**采样实现细节**：

- value pool 至少保留 `max(6, 对手数×3)` 个组合——这只是让有放回采样能工作，不再以 “至少 12 个” 隐性放宽极紧范围。
- 组合冲突时沿同一排序回退到相邻组合（下注者向上、过牌者向下），不再回退到随机两张牌。
- **河牌单挑精确枚举**：所有加权池按权重逐组合评估，结果与随机源和迭代次数无关。
- **自适应采样**：flop/turn 或多人河牌先跑 720 次；若估计值落在最近边界（面对下注时为底池赔率，否则为价值阈值）的 `1.6 × SE` 之内，再跑 720 次取均值。
- 被跟注后的胜率（`calledEquity`）：各角色都只保留 **继续份额** `continueShare = 1 - FE^(1/n)`——下注者 value pool 乘以该份额，过牌者/未行动者取各自池的最强部分，陷阱份额则始终继续。多人时继续人数 `round(n × (1 - FE^(1/n)))`（至少 1 人）。`n` 只数**能弃牌**的对手：全下者既不弃牌也不收窄，原样留在被跟注分支里，全下的下注者保留完整的价值/诈唬结构。
- 同一公共牌的组合排序放入 **12 个 board 的 LRU 缓存**；缓存键只含公共牌（翻前另含排序模式），底牌阻断与范围过滤在使用时应用。

---

## 10. 真实听牌、阻断牌与牌面湿润度

AI 明确区分顶对/中对/底对/口袋超对、同花听牌、坚果同花听牌、卡顺、两头顺和组合听牌。只有让玩家底牌真正改善牌力的顺子牌才算 outs；“公共牌自己成顺”不会被误认为 8 个干净 outs。

`boardWetness ∈ [0,1]`：

| 牌面特征 | 加分 |
| --- | ---: |
| 三张及以上同花 | +0.45 |
| 两张同花 | +0.20 |
| 相邻 rank / gap 2 / gap 3 | 每处 +0.18 / +0.12 / +0.06 |
| 对子牌面 | +0.15 |
| 连通部分上限 | 0.40 |

`blockerScore`：三张及以上同花牌面持该花色 A/K `+0.55/+0.30`；对子牌面持该 rank `+0.25`；任意 A `+0.08`；总分截断到 1。

`showdownValue`：超对/顶对/中对/其他一对 `0.58/0.50/0.38/0.30`；A-high `0.16`，其他高牌 `0.06`；更强成牌按牌型类别归一化。

```text
bluffQuality
  = blockerScore × (river ? 0.75 : 0.25)
  + 同花听牌 (坚果 0.45；其他 0.32)
  + 顺子听牌 (两头 0.35；卡顺 0.20)
  + 组合听牌 0.18
  + overcard数 × 0.06
  - showdownValue × (river ? 0.55 : 0.25)
clamp [0,1]
```

近似 outs：同花 9、两头顺 8、卡顺 4、高牌状态每张 overcard 3，总上限 **15**。审计 7.2 建议把湿润度拆成 drawDensity / rangeAdvantage / nutAdvantage / runoutImpact 四项，目前尚未拆分（见 §17）。

---

## 11. 动态诈唬频率：候选质量优先

```text
dynamicBluff
  = bluff
  + positionAwareness × (positionFactor - 0.5) × 0.40
  + boardWetness × 0.25
  - (liveOpponents - 1) × 0.12
  + (0.5 - min(1, pot / stack)) × 0.15 × potReactivity
  - (recentImage - 0.3) × 0.35
river ×0.85；clamp [0, 0.8]

candidateMultiplier = clamp(0.18 + bluffQuality×1.15 - showdownValue×0.28, 0.05, 1.05)
bluffFrequency      = dynamicBluff × exploit.bluffMult × candidateMultiplier
多人 ×0.72；困难上限 0.46
```

`bluffFrequency` 现在只是 §14 中 **通用诈唬计划的抽样概率**，并且只在没有更高优先级计划（价值、c-bet、float、probe、barrel）时使用；最终还要乘 EV 门（§12）。

---

## 12. 动作 EV：下注对照过牌、加注对照跟注

### 12.1 价值基准

```text
valueThreshold = min(0.82, 0.55 + (对手数 - 1) × 0.07) - clamp(recentImage - 0.3, 0, 0.4) × 0.10
nutRange       = equity ≥ 0.88 且（两对+ 或 顶对/超对）
strongValue    = equity ≥ valueThreshold 且（flop/turn 至少一对；river 可仅凭 equity）
protectionValue= flop/turn、顶对/超对、equity ≥ max(0.40, valueThreshold - 0.16)
```

### 12.2 主动下注：与过牌比较

```text
checkRealisation = (river ? 1 : IP ? 0.95 : 0.85) × max(0.7, 1 - (对手数 - 1) × 0.06)
EV(check)        = equity × pot × checkRealisation

FE               = 弃牌率模型（见下）
eqCalled         = 对手按继续份额收窄后的胜率（§9 calledEquity）
EV(bet)          = FE × pot + (1 - FE) × [eqCalled × (pot + heroRisk + callerContribution) - heroRisk]
ΔEV              = EV(bet) - EV(check)                       // 以底池为单位记录在 reason 的 dEV=
```

有对手已全下时，底池分成主池与边池，下注、过牌、跟注都按层计算（§12.6）。

审计 3.2 的河牌例子（65% 总胜率、对手一半弃牌一半以 30% 胜率跟注）在此模型下：`EV(check)=65`，`EV(bet 75)=50`，因此不下注——尽管下注 EV 为正。

### 12.3 无差别门（indifference gate）

```text
gate(ΔEV) = clamp((ΔEV / pot + 0.07) / 0.05, 0, 1)
P(执行计划) = 计划本身的混合概率 × gate(ΔEV)
```

- `ΔEV ≤ -0.07 pot`：动作被移除（概率 0）。
- `ΔEV ≥ -0.02 pot`：完全由性格/混合概率决定。
- 之间线性过渡，容忍 EV 模型自身的偏差。
- 坚果价值（`nutRange`）不设门：不会因为对手弃牌率高而放弃下注。

### 12.4 面对下注：加注与跟注比较

```text
call       = min(toCall, 本方后手)
winnable   = 本方有资格赢得的各层底池之和（含本方的跟注）   // 无人全下且本方够跟时 = potBefore + toCall
directOdds = call / winnable
听牌隐含赔率：depth = clamp((SPR - 2) / 6, 0, 1)
  impliedDiscount = depth × (IP ? 0.12 : 0.07) × (干净听牌 ? 1 : 0.62)
  needed = directOdds × (1 - impliedDiscount × (0.55 + stackReactivity×0.45))

callEquity = 摊牌时能拿到的份额：无全下者时即 equity，有全下者时见 §12.6
mathEdge = callEquity - needed
edge     = mathEdge + (callDown - 0.5) × 0.055 + 非河牌位置修正 + 真人 valueLean
非河牌位置修正 = positionAwareness × (positionFactor - 0.5) × 0.055

deadZone = river ? 0.03 : 0.08
P(continue) = mathEdge < -deadZone ? 0 : sigmoid(edge / 0.038)
directOdds ≤ 0.15 且 callEquity > 0.17 时 P(continue) ≥ 0.86
```

本方全下也不够跟注时，对手多出的下注会退回，不属于本方：剩 20 筹码、面对 60 底池里的 100 下注，价格是 `20 / 100 = 20%`（可赢的底池含本方跟注共 100），而不是 `100 / 260 = 38%`。此前按后者计算，短码跟注的门槛几乎翻倍。

审计 3.4 的反例（河牌 `edge = -0.08` 仍以 10.9% 跟注）被 deadZone 截断为 0；随机化只保留在 `±0.03`（河牌）/`±0.08`（有牌待发）的无差别带内。

继续之后：

| 动作 | 条件 | 与谁比较 |
| --- | --- | --- |
| Value raise | `equity ≥ valueThreshold + 0.08`、至少一对、混合 `0.48 + aggression×0.32`（check-raise 位置的坚果再 +0.10） | `ΔEV = EV(raise) - EV(call)`，`EV(call) = callEquity × winnable - call`；坚果免门 |
| Semi-bluff raise | 真实听牌且 `bluffQuality ≥ 0.35`（check-raise 位置 ≥ 0.28），混合 `max(bluffFrequency × 0.72, checkRaiseBluff)` | `EV(raise) - max(EV(call), 0)` |
| Bluff raise（弃牌区） | river `bluffQuality ≥ 0.35` / 其他街 `≥ 0.45`，`toCall ≤ 0.7 pot`，混合 `bluffFrequency × 0.35` | `EV(raise) - max(EV(call), 0)` |
| Light raise（剥削） | 下注者是被画像真人、本街唯一一次激进动作、单挑、`lightRaise > 0`（§15）；跟注区与弃牌区中未走上面任何加注线的手牌 | 混合 `lightRaise`，`EV(raise) - max(EV(call), 0)` |
| Trap-call | `trapMore`、`equity ≥ valueThreshold + 0.08`、未 commit，**42%** 只跟不加 | — |

```text
checkRaiseSpot  = AI 本街已 check，且面对的是本街唯一一次下注
checkRaiseBluff = checkRaiseSpot
                  ? clamp(0.16 + bluffQuality × 0.40, 0, 0.45) × raisePressure
                    × (turn ? 0.7 : 1) × (多人 ? 0.5 : 1)
                  : 0
raisePressure   = 下注者是被画像真人 ? raiseFold : foldPressure
```

两头顺（`bluffQuality ≈ 0.33`）和非坚果同花听牌（`≈ 0.31`）过去低于 0.35 的门槛，check 之后从不 check-raise；check-raise 位置门槛降到 0.28，这些听牌就成了 check-raise 的诈唬部分，与 check-raise 的价值部分（暗三、两对）相配。顶对好踢脚不额外加成，check-raise 频率约 46%。

加注的 `heroRisk` 与 `callerContribution` 区分“本方为加注先补齐的金额”和“对手面对加注需要补齐的金额”。

### 12.5 弃牌率模型

```text
基础：主动下注/刺探 0.39；面对下注的加注 0.30
IP +0.05；每多一名能弃牌的对手 -0.10（已全下者不计）
尺寸：河牌主动下注 + clamp(size - 0.5, -0.25, 0.25) × 0.60
      其他         + clamp(size - 0.5, -0.25, 0.65) × 0.13
阻断牌 + blockerScore × 0.08
check-raise（AI 已 check、加注本街唯一一次下注）+0.06   // 攻击的是宽的 c-bet/stab 范围
面对 check-raise -0.16；同街 ≥2 次激进动作 -0.10
× (加注被画像真人的下注 ? raiseFold : 河牌主动下注 ? riverFold : foldPressure)；clamp [0.08, 0.72]
checked-through probe 与 turn check-through 后的河牌诈唬额外 + 0.04 + positionFactor × 0.03，之后 clamp [0.08, 0.78]
```

多人时 `FE` 解释为 “所有人都弃牌” 的概率，被跟注分支按 `f = FE^(1/n)` 的联合响应收窄各对手范围（§9）。

**河牌尺寸斜率**：河牌下注面对的是已成型的牌，回应对尺寸远比前两街敏感。AI 群体面对河牌开池下注，1/3 pot 约弃牌 29%，3/4 pot 约 60%，超池并不更多（预期超池极化的范围更愿意抓诈唬）。通用斜率 0.13 让 1/3 pot 与 3/4 pot 的弃牌率只差 5 个百分点，极化诈唬因此永远过不了 EV 门。河牌斜率 0.60 下（未计位置与阻断牌）：1/4 pot `0.24`，1/3 pot `0.29`，1/2 pot `0.39`，`≥ 3/4 pot` 封顶 `0.54`。

### 12.6 已有对手全下：主池与边池分层

引擎一直按层结算，但决策此前只用“总胜率 × 总底池”：全下者被当成能弃牌、能被价值下注榨取的普通对手，诈唬时也假设它会弃牌。现在底池按本方有资格赢的层拆开：

```text
winnable = 本方有资格赢得的各层底池之和（含本方的跟注）
mainPot  = 其中全下对手也有资格赢的部分；sidePot = winnable - mainPot
eqAll    = 对全部在局对手的胜率          // 主池的摊牌
eqLive   = 只对仍能行动的对手的胜率      // 边池的摊牌
eqAllIn  = 只对全下对手的胜率            // 其他人都弃牌后主池的价值

callEquity = (eqAll × mainPot + eqLive × sidePot) / winnable
EV(check)  = (eqAll × mainPot + eqLive × sidePot) × checkRealisation
EV(call)   = callEquity × winnable - call
EV(bet/raise) = FE × (sidePot + eqAllIn × mainPot - call)
              + (1 - FE) × [calledAll × mainPot
                            + calledLive × (sidePot + heroRisk - call + callerContribution)
                            - heroRisk]
```

- `FE` 只来自能弃牌的对手（§12.5）。所有能弃牌的人都弃牌时，本方拿下边池，主池仍要按 `eqAllIn` 与全下者摊牌。
- `calledAll` / `calledLive` 是被跟注分支（§9 `calledEquity`）中对全部对手、只对继续的非全下对手的胜率。
- 下注的对象是仍能行动的对手：`eq = eqLive`，§12.1 价值阈值中的对手数改为**能弃牌的对手数**——全下者不会再为价值下注付钱。
- 能弃牌的对手为 0（只剩全下者）时不再下注或加注，只按 `winnable` 的赔率跟注或弃牌。
- 攻击者已全下时不再 `check-to-raiser`（它不能再下注）；位置改按仍能行动的对手判断，只有在它们全部之后行动才算 IP；范围对手也优先取仍能行动的对手（§9）。
- 自适应二次采样面对下注时以 `callEquity` 与 `directOdds` 比较，三项胜率一起取均值。

效果（20BB 翻前全下被本方与 150BB 玩家跟注，本方剩 80BB、先行动，翻牌 K♦8♠3♣；每格 200 次决策）：

| 手牌 / 场景 | 此前 | 当前 |
| --- | ---: | ---: |
| KJ 顶对，被 check 到 | check 给已全下的加注者 78%、下注 23% | **下注 100%**：加注者不能再行动，价值只能从深码玩家身上拿 |
| A3 面对深码玩家半池下注 | 跟注 19% | **跟注 46%**：跟注同时保住对全下者宽范围的主池份额 |
| 空气（76s、QJ） | 0%（同样 check 给加注者） | 0%–2%：主池里的全下者弃不了牌，诈唬只能针对边池 |

翻前的对应处理见 §8：当前加注者全下时总是进入全下模型，赔率同样按 `winnable` 计算。

仍是近似的地方：跟注了全下的玩家，翻后仍按普通平跟范围（§9）估计，比实际偏宽，中等牌（例如上例的 87 中对）因此会更多地薄价值下注；多个全下者的层级只区分“有全下者的部分”与“其余部分”，没有逐层计算胜率。

---

## 13. 牌面、SPR 与下注尺度

极化价值与诈唬共用同一套尺寸模型，薄价值走非极化小尺寸桶：

| 街道/场景 | 底池比例 |
| --- | --- |
| Flop：对子面或 `wetness<0.22` | **0.30 pot** |
| Flop：湿润面 | `0.48 + wetness×0.28` |
| 3-bet/4-bet flop | 上述结果 `-0.08` |
| Turn 非极化 | `0.52 + wetness×0.28` |
| Turn 极化 | 再 `+0.10` |
| River 薄价值 | **0.34 pot** |
| River 极化 | `0.72 + blockerScore×0.18` |
| 多人池 | `+0.08` |
| 性格修正 | `+(aggression - 0.6)×0.08` |

- **几何尺度**只在 `polar` 范围、`SPR ≤ 3` 且单挑时作为候选：`g = ((1 + 2×effectiveStack/pot)^(1/剩余街数) - 1) / 2`，取 `max(原尺度, min(1, g))`。薄价值、保护下注、多人池不再使用。
- Turn/River 极化范围若至少成同花或 `blockerScore ≥ 0.45`，有 **18%** 混合到 `1.05–1.25 pot` overbet。
- 最终加入 `±0.04 pot` 抖动并截断到 `[0.25, 1.25]`。

面对下注的加注倍数：

| 类型 | IP 基准 | OOP 基准 |
| --- | ---: | ---: |
| 价值加注 | 2.7–3.1× | 3.2–3.6× |
| 半诈唬加注 | 2.75–3.15× | 3.25–3.65× |
| 阻断牌诈唬加注 | 2.8–3.2× | 3.3–3.7× |

通用尺度器取 `xBetTarget = currentLevel × (xBetBase + U(0,0.4) + squeezeBonus)` 与 `potCap = currentLevel + potAfterCall × max(fraction,0.5) × U(0.9,1.1)` 的较小值。只有 `effectiveRemaining ≤ potAfterCall×1.1` 才视为低 SPR commit spot；允许全下时，若目标已达到最大投入的 **90%**，直接推完。主动价值下注只有在 commit 且 `equity≥0.72` 时开启全下补齐；面对下注的价值加注门槛为 `equity≥0.70`。

审计 7.4 建议按尺寸配比价值与诈唬（1/3 pot 约 20% 诈唬、pot 约 33%）。河牌已按这一比例配给诈唬（§14 计划 3）；翻牌与转牌的尺寸仍只按牌面与范围类型选择，没有按尺寸配比。

---

## 14. 一次性抽样的行动线计划

无人下注时，AI **只选一个计划、只抽一次样**。计划按优先级排列，第一个适用的计划拥有本次决策；抽样失败即 check，不会落入下一个分支再抽一次。旧实现中普通诈唬、c-bet、probe 依次独立抽样，最终下注率为 `1 - Π(1 - p_i)`（例如 30% 与 40% 叠加成 58%），各个“上限”因此形同虚设。

| 优先级 | 计划 | 适用条件 | 抽样概率（EV 门之前） | 尺寸 |
| ---: | --- | --- | --- | --- |
| 1 | `polar-value` / `thin-value` / `protection-value` | `strongValue` 或 `protectionValue` | 价值 1、保护 `protectionChance`；再乘 `(1 - trapChance) × leadShare` | 坚果用极化桶，其余薄价值桶 |
| 2 | `range-cbet` | flop、AI 是翻前最后攻击者、未面对 check-raise，且 `hasDraw` 或 `bluffQuality ≥ 0.08` 或 `showdownValue ≤ 0.30` | `clamp(cbetBase × cbetQuality × foldPressure, 0.04, 0.62)` | 薄价值桶 |
| 3 | `river-thin-bluff` / `river-polar-bluff` | river；高牌，或 `blockerScore ≥ 0.25` 的底对 / 低于公共牌的对子 | `clamp((thinNeed + polarNeed) × valuePerAir × clamp(riverFold, 0.4, 1.3) × 0.7^(对手数-1), 0, 0.85)` | 以 `polarShare` 抽取极化桶，否则薄价值桶 |
| 4 | `checked-to-float` | 上一街对手是攻击者、本街已 check 给 AI、AI 上街不是攻击者、对手 ≤2 | `clamp((0.34 + IP 0.20 + aggression×0.12) × foldPressure × (0.45 + bluffQuality), 0, 0.72)` | 极化桶 |
| 5 | `delayed-probe` / `delayed-protection` | turn/river 且上一街全桌 check-through；turn 候选：听牌、高牌、底/中对、`bluffQuality ≥ 0.10`；river 候选仅高牌，已由计划 3 接管，因此实际只在 turn 出现 | `clamp(probeBase × probeQuality × foldPressure, 0.06, 0.64)` | 薄价值桶 |
| 6 | `planned-barrel` | AI 上一街以 bluff 身份进攻且未面对 check-raise；river 只剩计划 3 之外的手牌（例如中对） | `clamp(((river ? 0.34 : 0.52) + J+ runout 0.08 + bluffQuality×0.18) × bluffMult, 0, 0.72)` | 极化桶 |
| 7 | `candidate-semi-bluff` / `blocker-bluff` | `bluffFrequency > 0` | `bluffFrequency × leadShare`（§11） | 极化桶 |

```text
protectionChance = clamp(0.36 + aggression×0.34 + wetness×0.10 - (对手数-1)×0.07 + (IP ? 0.05 : 0), 0.25, 0.78)
trapChance       = trapMore ? 0.20 : 0

checkToRaiser = 上一街攻击者是对手、它本街还没有 check 给 AI、AI 不是上一街攻击者
leadShare     = checkToRaiser
                ? clamp(((flop 0.20 | turn 0.30 | river 0.45) + wetness × 0.12)
                        × (该攻击者是被画像真人 ? leadMult : 1), 0, 0.85)
                : 1

cbetBase    = 0.40 + aggression×0.24 + (IP ? 0.10 : 0) + (3-bet/4-bet pot ? 0.08 : 0)
              - (对手数-1)×0.10 - wetness×0.08
cbetQuality = clamp(0.55 + bluffQuality×0.50 + (有 overcard ? 0.06 : 0), 0.55, 1)

probeBase    = 0.28 + aggression×0.24 + positionFactor×0.20 - (对手数-1)×0.07 - (river ? 0.03 : 0)
probeQuality = 一对 ? 0.75 : clamp(0.66 + bluffQuality×0.42 - showdownValue×0.18, 0.55, 1)
```

**Check 给加注者**：在上一街攻击者之前行动时，此前的实现几乎把所有强牌都领先下注（donk），过牌范围因此只剩弱牌，面对任何下注都只能弃牌；AI 群体的 donk 率达 22%，面对 c-bet 的弃牌率 49%，flop check-raise 只有 0.6%。现在默认 check 给加注者：它会以约 60% 的频率继续下注，强牌和好听牌留给 check-raise 或 check-call（§12.4），领先下注只占少数，湿润面和后面的街道略多（河牌对方不再有牌要保护，领先价值下注更多）。旧的“OOP 两对+ 慢打 12%”被这条规则吸收。对手是真人时，领先份额按它的“跟进率”读数 `leadMult` 缩放：很少 c-bet/续打的加注者会白送免费牌，就更多领先下注；每街都开火的加注者正是 check-raise 的对象；下注范围比群体宽的加注者（例如用超池打空气），即使跟进得少，也照样 check 给它（§15）。check 时的标签为 `check-to-raiser`。

**河牌诈唬按尺寸配给（计划 3）**：河牌下注 `s` 个底池时，抓诈唬的牌要在对手范围里有 `s/(1+2s)` 的诈唬才无差别（1/3 pot 20%、3/4 pot 30%、pot 33%），换算成每个该尺寸的价值下注配 `s/(1+s)` 个诈唬。诈唬来自没有摊牌价值的空气，而一条行动线上有多少空气取决于这条线：转牌攻击者的河牌范围里每手空气对应好几个价值下注，空气几乎都该下注；转牌无人下注之后就少得多。`valuePerAir`（每手到达河牌的空气对应的价值下注数）与 `thinShare`（其中薄价值尺寸的份额）取自困难 vs 困难群体实测（6 人桌、100BB、6,000 手）：

```text
line       = aggressor（AI 是转牌攻击者）| checkedTo（转牌攻击者 check 给 AI）
           | lead（AI 在转牌攻击者之前行动）| afterCheck（转牌无人下注）
thinNeed   = thinShare × t/(1+t)             // t = 薄价值尺寸（约 0.34 pot）
polarNeed  = (1 - thinShare) × b/(1+b)       // b = 极化尺寸（约 0.72–0.90 pot）
chance     = clamp((thinNeed + polarNeed) × valuePerAir × clamp(riverFold, 0.4, 1.3)
                   × 0.7^(对手数-1), 0, 0.85)
polarShare = clamp(polarNeed / (thinNeed + polarNeed) + (blockerScore - 0.2) × 0.5, 0.15, 0.85)
afterCheck 的弃牌率另加 0.04 + positionFactor × 0.03（转牌无人表现强度）
```

| 行动线 | `valuePerAir` | `thinShare` | 单挑抽样概率（EV 门前，`t=0.34`、`b=0.75`） | 选极化尺寸的比例（`blockerScore=0.2`） |
| --- | ---: | ---: | ---: | ---: |
| `aggressor` | 8.4 | 0.71 | 0.85（公式值 2.56，取上限） | 41% |
| `checkedTo` | 6.1 | 0.76 | 0.85（公式值 1.80） | 35% |
| `lead` | 2.2 | 0.80 | 0.64 | 30% |
| `afterCheck` | 1.5 | 0.74 | 0.45 | 37% |

之后仍要过 §12.3 的 EV 门；河牌弃牌率随尺寸变化（§12.5），大尺寸的诈唬需要更多弃牌才能过门，阻断牌好的牌因此多用大尺寸。未抽中或未过门时 check，标签为 `river-give-up`（在转牌攻击者之前行动时为 `check-to-raiser`）。

困难 vs 困难实测（4 个种子各 1500 手，引入计划前 → 后）：AI 作为转牌攻击者单挑到河牌时，空气下注率 3.4% → **39.1%**；转牌攻击者 check 给 AI 时 3.8% → **47.1%**；在转牌攻击者之前行动时 0% → 14.3%；转牌无人下注之后 23.8% → 19.1%（此前由不分尺寸、不分行动线的 `delayed-probe` 负责）。转牌攻击者的河牌下注中，带诈唬标签的比例为小注 0.3% → 4.5%、中等注 4.6% → 20.6%、大注 0% → 6.3%，仍低于无差别比例（20% / 29% / 34%）：困难 AI 到河牌的空气远少于价值牌，EV 门也会截掉弃牌不够的诈唬。群体面对河牌开池下注的弃牌率不变（0.418 → 0.418）。脚本对手的配对评估几乎走不到这个计划（对 `nit` 的 1,800 手里只下注 2 次）。

**多人河牌**：每多一名对手，抽样概率乘 **0.7**。多一名对手，价值范围更窄、要平衡的诈唬更少，诈唬也要多一人弃牌；后者已由 EV 门计价（每多一名能弃牌的对手弃牌率 −0.10，§12.5），频率因此不再减半。计划 3 接管了此前由 `delayed-probe` 负责的河牌空气，最初按 `0.5^(对手数-1)` 递减时，翻牌、转牌都已过牌的多人底池在河牌下注得更少：以同一批牌与随机数对照（16 个种子、756 个多人翻牌），河牌过牌率 54.0% → 58.6%，三街全过牌率 6.2% → 6.7%。改为 0.7 后两者回到 54.0% / 6.2%，与第二轮相同；单挑不受影响。

这些概率都是**最终频率**（单次抽样），因此比旧的分支概率设得更高；随后再乘 §12.3 的 EV 门。所有计划在 commit 局面下只有具备真实权益时才允许补齐全下（价值 `equity ≥ 0.72`）。对子加听牌等半诈唬保留 `isBluff` 标记以接通后续 barrel；若 barrel 变成负 EV，AI 进入 `barrel-giveup` 而不是为了“讲故事”继续烧钱。

---

## 15. 置信度加权的真人画像剥削

单机保存一份真人画像；局域网按真人座位分别维护。多人池只把当前/上一街相关真人攻击者的画像用于本次决策；没有明确攻击者时，只有 heads-up 才使用唯一真人作为 fallback。真人本手弃牌之后，单机模式不再把画像传给 AI（局域网已按在局真人解析）：此前 AI 之间剩下的底池也会按真人的弃牌率、诈唬读数去打，把针对真人的剥削用在了其他 AI 身上。

**贝叶斯统计**（`(命中数 + prior×priorWeight) / (机会数 + priorWeight)`）：

| 指标 | 先验 | 先验权重 |
| --- | ---: | ---: |
| VPIP | 0.30 | 8 手牌 |
| PFR | 0.18 | 8 手牌 |
| Fold to steal | 0.50 | 5 次机会 |
| Aggression | 0.50 | 10 个动作 |
| 河牌**摊牌弱牌下注率**（`bluffCaught`） | 0.30 | 5 次摊牌下注 |
| Went to showdown | 0.30 | 8 手牌 |
| Fold to c-bet | 0.50 | 5 次机会 |
| 开池下注频率（按尺寸类，汇总各街） | small **0.13** / medium **0.25** / big **0.02** | 10 次机会 |
| 开池下注频率（分街，small / medium / big） | flop **0.14 / 0.17 / 0.02**；turn **0.02 / 0.45 / 0.02**；river **0.34 / 0.10 / 0.05** | 10 次机会 |
| 跟进率（c-bet 与续打，汇总） | **0.60** | 8 次机会 |
| 跟进率（分街） | flop **0.49**；turn **0.70**；river **0.63** | 8 次机会 |
| 下注被加注后的弃牌率 | **0.40** | 6 次 |
| 面对河牌开池下注的弃牌率 `foldToRiverBet` | **0.42** | 8 次 |

- Steal 只统计 unopened pot 中 CO/BTN/SB 对盲位的首个 open。
- C-bet 只统计翻前最后攻击者在 flop 的下注及真人回应。
- **开池机会**：翻后某街真人第一次行动时无需跟注（第一个行动或被 check 到）。这次行动若是下注，按 `betSizeClass`（§9）记入 small / medium / big；面对下注的加注不算开池下注。
- **跟进机会**：开池机会中真人是上一街最后攻击者的那部分（翻前加注者的 flop、flop 下注者的 turn……），下注即记一次跟进。
- 开池机会、各尺寸的开池下注与跟进机会除了汇总之外，还**按街**（flop / turn / river）各记一份。
- **被加注**：真人本街下注或加注之后，另一名玩家在同街加注，且真人需要回应（`toCall > 0`）；回应为弃牌时记一次弃牌。每街最多一次。
- **面对河牌开池下注**：河牌的第一个下注来自别人，真人需要回应（不含真人自己下注后被加注）；回应为弃牌时记一次弃牌。
- 开池频率、跟进率、被加注弃牌率与河牌弃牌率都不需要摊牌，没有“只有被跟注的牌才会亮出”的偏差。开池频率、跟进率与河牌弃牌率的先验取 AI 群体的实测水平（困难 vs 困难，6 人桌、100BB）；被加注弃牌率的先验 0.40 取自 §12.5 加注弃牌率的基准（AI 群体实测约 0.35），因此读数乘数约等于真人实际弃牌率与模型假设弃牌率之比。群体几乎不用的尺寸（flop 超池、turn 小注）先验取下限 0.02，单次观察不会把读数推到上限。
- 河牌“弱牌下注”只在摊牌后确认：高牌或只能玩公共牌才记为 weak。它衡量的是 **被看到的河牌下注中弱牌的比例**，不是总体诈唬率（成功的诈唬不会亮牌），因此读取时只按 **0.7** 的信任度混合。
- **大小注共用一个分类函数** `isBigRiverBet`：`betToPot > 0.55` 为大注，统计与读取口径一致（此前统计用 0.55、读取用 0.70，0.6 pot 会被错桶）。

**置信度**：

```text
总权重 = clamp(hands / 36, 0, 1)
偷盲权重 = 总权重 × clamp(stealFaced / 8, 0, 1)
c-bet 权重 = 总权重 × clamp(cbetFaced / 10, 0, 1)
行动权重 = 总权重 × clamp((aggressive + passive) / 35, 0, 1)
下注权重 = 总权重 × clamp(开池机会 / 30, 0, 1)
跟进权重 = 总权重 × clamp(跟进机会 / 15, 0, 1)
加注权重 = 总权重 × clamp(被加注次数 / 12, 0, 1)
河牌权重 = 总权重 × clamp(面对河牌开池下注次数 / 12, 0, 1)
分街跟进混入比例 = clamp(该街跟进机会 / 10, 0, 1)      // 分街跟进读数逐步替代汇总读数
blend(raw, w) = 1 + (raw - 1) × w
```

**具体剥削**：

| 真人倾向 | 困难 AI 调整 |
| --- | --- |
| `foldToSteal > 0.60` 且 AI 位置因子 > 0.55 | `stealBonus = (foldToSteal - 0.60) × 0.60 × 偷盲权重` |
| `foldToSteal > 0.55` | 诈唬乘数向 **1.30×** 混合 |
| `wentToShowdown > 0.45` | 诈唬乘数向 **0.60×** 混合 |
| `aggression > 0.60` | `excess = clamp((aggression - 0.60) / 0.25, 0, 1)`；诈唬乘数向 `1 - 0.2·excess` 混合；`valueLean += 0.05 × 行动权重 × excess × shownWeakEvidence`；`trapMore` 需 行动权重 > 0.30 且 `excess ≥ 0.3` |
| Fold to c-bet | `bluffMult ×= blend(1 + (foldToCbet - 0.5) × 0.9, c-bet 权重)` |
| 综合弃牌压力 | `blend(1 + (foldToCbet - 0.5)×0.7 + (foldToSteal - 0.5)×0.4, max(c-bet 权重, 偷盲权重))` |
| 真人翻前松紧 | `observedRange = clamp((VPIP/0.28)×0.45 + (PFR/0.18)×0.55, 0.65, 1.65)`，按总权重向 1 混合 |
| 开池下注宽度（每个尺寸类） | 见下方公式：汇总读数向群体水平收缩，当前街的读数向这名玩家自己的汇总读数收缩，`betWidth = blend(当前街的读数, 下注权重)`。面对真人本街首个下注时，范围比例乘该尺寸的 `betWidth`（全下且小于它最常用的尺寸时改乘 `usedWidth`，见下方）；big 尺寸还提高诈唬份额（§9） |
| 跟进率 | `read(norm) = clamp(norm / ((跟进下注 + norm × 8) / (跟进机会 + 8)), 0.6, 2.2)`；`lead = 汇总 read(0.60) + (该街 read(该街先验) - 汇总) × 分街跟进混入比例`；`usedWidth` = 按各尺寸开池下注次数加权的 `betWidth`（该街有开池机会时用该街次数，否则用汇总次数；尚无下注时为 1）；`leadMult = blend(lead / max(1, usedWidth), 跟进权重)`，缩放 check 给真人加注者时的领先份额（§14） |
| 河牌弃牌 | `read = clamp(foldToRiverBet / 0.42, 0.4, 1.7)`；`riverFold = foldPressure + (read - foldPressure) × 河牌权重`（样本不足时由综合弃牌压力代替）。乘在 AI 河牌主动下注的弃牌率上（§12.5），并缩放河牌诈唬计划的频率（§14） |
| 被加注后弃牌 | `rate = (弃牌 + 0.40 × 6) / (被加注 + 6)`，`read = clamp(rate / 0.40, 0.45, 1.7)`；`raiseFold = foldPressure + (read - foldPressure) × 加注权重`（样本不足时由综合弃牌压力代替），用于加注真人下注时的弃牌率（§12.5）与 check-raise 诈唬频率（§12.4）；`lightRaise = clamp((read - 1.1) × 0.7, 0, 0.35) × 加注权重` |

开池宽度的公式（汇总读数与每条街的读数各算一次，`norm` 取对应的群体先验）：

```text
ratio(n, norm, toward) = (n + norm × toward × 10) / (开池机会 + 10) / norm
    // 频率与群体水平之比，以 10 次虚拟机会向 toward 收缩：
    // 汇总读数 toward = 1（群体水平）；分街读数 toward = 同一名玩家汇总读数里的对应比值
betRate   = ratio(三个尺寸的下注之和, 三个 norm 之和)               // 整体比群体多下注多少
checkRate = ratio(check 次数, 1 - 三个 norm 之和)                   // check 次数 = 开池机会 - 下注次数
lean      = ratio(该尺寸下注, 该尺寸 norm) / betRate                // 对这个尺寸的偏爱
often     = betRate > 1 ? max(betRate, 1 / checkRate) : betRate    // 或少 check 多少，取较大者
reach     = often > 1 ? often^min(1, lean) : often                 // 频繁下注只加宽常用的尺寸
tilt      = clamp(lean^0.25, 0.6, big ? 1.9 : 1.2)
width     = clamp(sqrt(reach) × tilt, 0.75, 1.9)
```

宽度主要由“整体下注多频繁”决定，并用平方根保守换算：下注频率的差异有一部分来自位置和主动权的分布，而不全是范围变宽。`tilt` 表示对这个尺寸的偏爱：常规尺寸说明不了多少范围信息，向上最多 1.2；群体只用坚果密集的范围超池，习惯性超池的玩家超池时远比群体宽，因此 big 向上可到 1.9；几乎不用的尺寸向下到 0.6。每次都以 1/4 pot 刺探的 `prober`，small 宽度到上限 1.9，面对其小注时弃牌明显减少。

频繁下注的玩家只在它常用的尺寸上宽（`reach`）：每次都以 1/4 pot 刺探的玩家突然超池，是反常的尺寸，不是又一次刺探。`often` 计入 check 率（下一段）之后可以到 5 左右，只靠 0.6 的 tilt 下限，这样的超池会被读成 `sqrt(5) × 0.6 ≈ 1.34`，比群体的超池范围还宽，AI 会用偏弱的牌去跟一个多半是坚果的超池。`reach` 让“多频繁”只按该尺寸的使用比例起作用：常用尺寸（`lean ≥ 1`）不受影响，从不使用的尺寸回到下限 0.75，与第二轮按尺寸各自计算频率比的结果相同。

全下的尺寸不一定是选择：后手不足一个常规下注的玩家只能全下或 check。真人本街首个下注是全下、且尺寸类比它最常用的尺寸小时（习惯超池的玩家只剩 0.6 pot，总是下注 3/4 pot 的玩家只剩 1/3 pot），这一注只说明它选择了下注，范围比例改乘 `usedWidth`（它按各尺寸下注次数加权的宽度，与跟进率一行相同），不乘它几乎不用的那个尺寸的宽度；与常用尺寸相同或更大的全下仍按尺寸读。90% 机会都超池的玩家在 turn 以 0.6 pot 下注时，中等尺寸读数 0.75，AI 拿 88 在 K♠9♣4♦2♥ 上约一半弃牌；同样大小的全下读成它的超池宽度 1.9，几乎不再弃牌。

下注频率之比在接近 100% 时失灵：群体在 turn/river 约一半机会下注，90% 下注的玩家按频率之比只有 1.84 倍，开方后 1.36；可它只 check 10%（群体 51%），几乎没有留下 check 的牌，下注范围接近它的全部范围。所以下注比群体频繁时，`often` 取“多下注多少”与“少 check 多少”中较大的一个。两者在群体水平附近几乎相等（下注 55% 对群体 49%：1.12 与 1.13），只在很高的频率上分开；下注少于群体的玩家不受影响。

分街读数解决的是“各街习惯不同”的玩家：`overbettor` 在 flop 以半池 c-bet 70%、turn/river 用 1.25 pot 超池。只有汇总读数时，flop 半池注与 turn/river 的机会混在一起，400 手样本上 flop medium 宽度只有 1.26（第二轮只按各尺寸频率之比的公式为 1.22）；分街后为 flop medium **1.77**、turn big **1.90**、river big **1.90**。只玩强牌的 `nit` 各街中等注宽度为 **1.05 / 0.99 / 1.12**（汇总 1.02），都接近 1：它下注多是因为翻前范围强，不是因为范围宽。每次都刺探的 `prober` 三条街的小注宽度都是 **1.90**；只看下注频率之比时，turn/river 只有 1.49 / 1.42（见上一段）。跟进率同理：flop c-bet（群体 0.49）与 turn 续打（0.70）的群体水平差很多，分街读数不会把“flop 常 c-bet、turn 常放弃”的玩家读成平均水平。

分街读数向这名玩家**自己的汇总读数**收缩，而不是向群体：该街还没有样本时就等于汇总读数，样本越多越接近该街自己的频率。到达 turn/river 的手数少，若每条街都从群体水平重新起步，几乎每次都下注的玩家要很久才在后面的街道上被读出来。最初的实现正是这样：分街读数先向群体收缩，再按 `该街开池机会 / 16` 从汇总读数过渡，`prober` 的河牌小注宽度在 16 次河牌机会时从汇总的 1.90 掉到约 1.5，约 50 次机会才回到 1.90，一局 100–300 手的对局大部分时间都落在这段低谷里。同一份 `prober` 画像上两种算法的小注宽度（50 手时两者都还受总的下注权重限制）：

| 手数 | turn / river 开池机会 | 向群体收缩后过渡 turn / river | 向汇总读数收缩 turn / river |
| ---: | ---: | ---: | ---: |
| 50 | 8 / 7 | 1.59 / 1.54 | 1.78 / 1.78 |
| 100 | 13 / 11 | 1.71 / 1.57 | **1.90 / 1.90** |
| 150 | 25 / 20 | 1.68 / 1.71 | 1.90 / 1.90 |
| 200 | 35 / 29 | 1.81 / 1.81 | 1.90 / 1.90 |
| 300 | 50 / 38 | 1.90 / 1.90 | 1.90 / 1.90 |

`overbettor` 的 flop 半池 c-bet 在 100 / 200 手时读到 1.54 / 1.89（前一种算法 1.33 / 1.64）。代价是尺寸习惯会跨街带入：`overbettor` 从不在 flop 超池，flop 超池宽度却因它在 turn/river 的超池习惯读到 1.57（33 次 flop 机会时；前一种算法 0.85）。它不在 flop 超池，这一读数不影响对局；真人若在 flop 突然超池，AI 按它在别的街的超池习惯读它，直到 flop 自己的样本足够。

跟进率只说明加注者**多常**继续下注，不说明它**拿什么**下注，所以领先读数要除以这条街实际所用尺寸的宽度。`overbettor` 在 turn 续打 64%（群体 0.70），只看跟进率时 turn `leadMult` 为 1.06，领先份额不减反增；可它续打时用 1.25 pot 超池打强牌和大部分空气，正是该 check 给它、再 check-raise 或抓诈唬的对手。除以宽度后（同一 400 手样本），turn（超池宽度 1.90）的 `leadMult` 为 **0.56**，flop（半池宽度 1.77）为 **0.39**，river 为 **0.47**。只用常规尺寸、宽度接近 1 的加注者几乎不受影响：单元测试里同样 45 次 turn 机会续打 25 次，全用半池时 `leadMult ≈ 1.09`，全用超池时 ≈ 0.64。只玩强牌的 `nit` 宽度读数接近 1（flop 中等注 1.05），flop 领先读数从 1.43 降到 1.36。配对评估里这一修正对 `overbettor` 的结果没有可测的影响（§17.2）。

`lightRaise` 只在真人被加注时的弃牌率明显高于基准时出现：弃牌率 0.67 时 `read ≈ 1.6`，AI 会以约 35% 的额外频率用本来只会跟注或弃牌的手牌加注它的下注；弃牌率与基准相当时为 0。反过来，从不弃牌的真人 `raiseFold` 降到 0.45，半诈唬加注和 check-raise 诈唬随之减少，只剩价值加注。

`shownWeakEvidence`：至少 3 次摊牌河牌下注时为 `clamp(bluffCaught / 0.3, 0.4, 1.3)`，否则 0.7——**激进不等于诈唬多**，抓诈唬需要摊牌证据佐证。

河牌诈唬读数：对应尺度至少 **4 次**摊牌下注后启用，`read = clamp((weak/shown)/0.33, 0.5, 1.5)`，按 `总权重 × 0.7` 向 1 混合；大注/小注样本不足时回退到总体读数。

---

## 16. 自我形象、思考时间与规则保护

**双轨形象**（`src/ai/image.ts`）：

```text
short_t = 0.65 × short_{t-1} + 0.35 × x_t        // 半衰期 ≈ 1.6 手
long_t  = 0.92 × long_{t-1}  + 0.08 × x_t        // 半衰期 ≈ 8 手
x_t = 本手激进行动 / 全部非弃牌行动
  摊牌且输：x + 0.25（被看到的“诈唬”记得更牢）；摊牌且赢：x × 0.7（“他有牌”）
没有任何激进机会的手牌不更新

trust      = 机会数 / (机会数 + 12)
recentImage = (1 - w) × short + w × long，  w = 0.25 + 0.5 × trust
```

初值 **0.30**。形象越激进，诈唬越少（§11），价值阈值最多下降 4 个百分点（§12.1）。

**思考时间**：基础 **350–1050ms**；弃牌、跟注或标记为 `tough` 的决策额外 **0–700ms**，单机常规模式理论范围 **350–1750ms**；联机服务器截断到 **450–1600ms**；快速模式进一步缩短。

**规则保护**（独立于策略参数）：

- 单次不足额 all-in 不重开已行动者的加注权；多个不足额 all-in 累计达到一个完整最小加注时正确重开。
- all-in 金额不超过应跟金额时记录为 call；后续范围不会误判为 raise。
- 后续不足额加注不虚增 3-bet/4-bet 层级；无人能投入超过当前下注时禁止继续加注。
- 过期 AI 决策或异常联机消息若请求非法 bet/raise/all-in，安全降级为 call/check/fold。
- 主池/边池按最小非零档位逐层剥离，结算守恒（`sidePots.test.ts`、`game.test.ts`）。

---

## 17. 审计采纳情况

针对《困难德州扑克 AI 策略审计与优化报告》逐条核对源码后的处理结果：

| 审计条目 | 判定 | 处理 | 位置 |
| --- | --- | --- | --- |
| 3.1 翻前排序失真（AKs > AA） | 确定问题，已复现 | 显式 169 类可玩性表 + 独立全下排序；4-bet/5-bet 改显式类别 | `preflopStrength.ts`、`preflopRanges.ts` |
| 3.2 下注 EV>0 ≠ 优于过牌 | 确定问题 | 主动下注对照 `EV(check)`，加注对照 `EV(call)`，记录 `dEV` | §12 |
| 3.3 被跟注后应用条件范围 | 确定问题 | `calledEquity` 按继续份额收窄各角色范围，多人联合响应 | §9、§12.2 |
| 3.4 固定 sigmoid 随机选劣势动作 | 确定问题 | 河牌/其他街 deadZone 截断；下注/加注用无差别门 | §12.3、§12.4 |
| 4.1 每街重排替代历史后验 | 结构局限 | **部分采纳**：翻前范围连续带入 + 过牌者/跟注者/未行动者按行动角色封顶；未实现逐组合权重向量 | §9 |
| 4.2 跟注者/过牌者封顶不是硬事实 | 过强假设 | 跟注者保留 15% 慢打、过牌者保留 20% 陷阱；check 给加注者几乎不封顶 | §9 |
| 4.3 最少组合数稀释紧范围 | 条件性风险 | 下限降到 `max(6, 对手数×3)`；冲突回退沿排序而非随机牌 | §9 |
| 5.1 浅码只在 3-bet 后处理 | 高优先级 | 未开池即引入深度：open 乘数、≤12BB open-jam、<22BB 投机牌弃牌 | §3 |
| 5.2 SB limp 缺少顶端 | 结构暴露 | premium 以 18% 进入 limp 分支 | §3 |
| 5.3 limper 越多隔离越宽 | 待验证 | 隔离范围每多一名 limper 收紧 0.02，尺度继续增大 | §4 |
| 5.4 4-bet jam 仅凭 “≤50BB 且 ≥7.5BB” | 条件性风险 | 浅码分支比较 fold / call / jam 的 EV | §6 |
| 5.5 shove 范围断崖 | 确定问题 | 分段线性 `shoveRangeFraction`，有回归测试 | §8 |
| 5.6 大额下注 ≠ 终结性全下 | 必须核对 | **部分采纳**：未关闭行动/后手转化为 margin；未拆成三类节点 | §8 |
| 6.1 单一 effective 描述多人 | 正确性 | **已采纳**（第三轮）：有效后手取仍能行动的对手；已全下者成为独立采样角色；主池/边池分层计算下注、过牌与跟注 EV；跟注赔率按可赢底池；翻前加注者全下时总进入全下模型 | §2.3、§8、§9、§12.6 |
| 6.2 模拟对手数来源 | 正确性 | 改为台面 `committedOpponents` | §8 |
| 6.3 多人 fold equity 联合响应 | 近似 | 被跟注分支采用 `FE^(1/n)` 的独立近似；弃牌率本身仍为线性扣分 | §12.5 |
| 7.1 多分支概率叠加 | 实现核查，已确认存在 | 单计划单次抽样，频率重新校准为最终频率 | §14 |
| 7.2 湿润度一词多用 | 特征混用 | **未采纳**（待拆分为四项特征） | §10 |
| 7.3 阻断牌相对继续范围计算 | 待验证 | **未采纳**（仍用固定阻断分） | §10 |
| 7.4 尺寸与价值/诈唬组合联动 | 待验证 | **部分采纳**（第三轮）：河牌按行动线实测“每手空气对应的价值下注数”，按 `s/(1+s)` 配给诈唬并在薄/极化尺寸间分配，河牌弃牌率随尺寸的斜率按群体实测拟合；翻牌/转牌未按尺寸配比 | §12.5、§14 |
| 7.5 几何尺度适用范围 | 应收窄 | 限定为极化、SPR≤3、单挑 | §13 |
| 8.1 大小注口径不一致 | 确定问题 | 共享 `isBigRiverBet`（0.55 pot） | §15 |
| 8.2 摊牌弱牌率 ≠ 诈唬率 | 统计限制 | 文档与注释改称 shown-weak rate；信任度 0.7 | §15 |
| 8.3 激进 ≠ 诈唬多 | 特征过宽 | 激进按 `excess` 分级，抓诈唬需摊牌证据；未按动作类别分层统计 | §15 |
| 8.4 人格参数命名 | 命名/校准 | 文档明确 `pfr` 为倾向参数；未重命名字段（兼容） | §1 |
| 8.5 形象半衰期过短 | 可量化 | 双轨形象 + 摊牌区分 + 机会归一化 | §16 |
| 9.1 850 次不足以支撑 1.2 点边界 | 精度问题 | 自适应二次采样；河牌单挑精确枚举 | §9 |
| 9.2 缓存键 | 工程 | 已核对：缓存只含公共牌（翻前另含排序模式），阻断与范围在使用时过滤 | §9 |
| 9.3 随机数流分离 | 工程 | **未采纳**：AI 内部的决策、采样与思考时间仍共用一个 rng（评估脚本已按决策分流，§18.1） | — |
| 12.1 确定性测试 | 验证 | 新增排序、边界连续性、过牌者模型、精确枚举、负 EV 截断、单次抽样频率测试 | `*.test.ts` |
| 12.2–12.5 回归集、消融、对手池 | 验证 | **部分采纳**：6 个脚本对手 + 配对（duplicate）评估 `npm run eval:ai`；第三轮起每个决策的随机数由它在运行中的位置决定，`compare.ts` 逐副牌配对两个版本（§18.1）；尚无固定节点回归集 | `scripts/ai-eval/` |

### 17.1 第二轮复盘

在审计之后又按“线下强玩家会怎么打、会读出什么”复盘了一遍，并用配对评估逐项验证：

| 发现的问题 | 证据 | 处理 | 位置 |
| --- | --- | --- | --- |
| 翻前按翻后实时行动顺序判断开池者位置 | 中间玩家弃牌后，UTG 开池面对 BB 与按钮偷盲得到同样的防守范围与 3-bet 范围 | 按开池者桌面座位取 RFI 宽度，防守与 value 3-bet 随开池宽度连续变化 | §5 |
| 翻后范围不区分翻前加注者与跟注者 | BB 跟注者被当成开池范围；翻后先行动的加注者被当成前位范围 | 范围对手按角色取开池范围或跟注范围 | §9 |
| 在上一街攻击者之前行动时，强牌几乎全部领先下注 | 群体 donk 22.3%、面对 c-bet 弃牌 49%、flop check-raise 0.6%：过牌范围只剩弱牌 | Check 给加注者 + check-raise（价值牌与强听牌），领先下注只占少数 | §12.4、§14 |
| 读不出“每次都小注刺探”和“频繁超池”的玩家 | 对 `prober` / `overbettor` 基本无收益（-23.7 / -1.2 bb/100） | 按尺寸统计开池下注频率，放宽对应尺寸的范围与大注诈唬份额 | §9、§15 |
| 读不出很少跟进的加注者 | 对 c-bet 少的 `nit`，check 给它等于送免费牌 | 跟进率读数缩放领先份额 | §14、§15 |
| 读不出“下注被加注就弃牌” | 对 `prober` 的 flop 小注只加注 3%，而它被加注后弃牌 67% | 被加注弃牌率读数：修正加注弃牌率、check-raise 诈唬频率，并加入 light raise | §12.4、§15 |
| 真人弃牌后，画像仍作用于 AI 之间的底池 | 代码审查 | 单机只在真人在局时传入画像 | §15 |

第二轮留下三个问题：开池下注频率按尺寸汇总所有街道，只在 flop 用半池 c-bet、turn/river 改用超池的玩家，其 flop 半池 c-bet 的宽度读数被稀释；AI 作为攻击者的河牌下注几乎都来自价值计划，河牌诈唬比例没有按尺寸校准（审计 7.4）；翻后只用单一有效筹码（审计 6.1）。三项都在第三轮处理（§17.2）。

### 17.2 第三轮复盘

逐项实现第二轮留下的问题，并用配对评估逐项验证。验证中发现的回退与评估方法本身的问题也在本轮处理：

| 问题 | 证据 | 处理 | 位置 |
| --- | --- | --- | --- |
| 开池下注频率按尺寸汇总所有街道 | `overbettor` 的 flop 半池 c-bet 在 400 手样本上只读到宽度 1.22，AI 面对它仍弃牌约 61% | 开池频率与跟进率按街各记一份，分街读数随样本逐步替代汇总读数；同一样本最终读到 flop 半池 1.77、turn 超池 1.90 | §15 |
| 河牌诈唬没有按尺寸配比（审计 7.4） | AI 作为转牌攻击者单挑到河牌，空气只下注 3.4%；攻击者河牌下注中带诈唬标签的小注 0.3%、大注 0% | 按行动线实测每手空气对应的价值下注数，以 `s/(1+s)` 配给诈唬并在两种尺寸间分配；河牌弃牌率随尺寸的斜率按群体实测拟合；新增真人面对河牌下注的弃牌率读数 | §12.5、§14、§15 |
| 翻后只有单一有效筹码（审计 6.1） | 有人全下时，KJ 顶对多数 check 给不能再行动的全下者；fold equity 把全下者也算作会弃牌 | 有效后手取仍能行动的对手；已全下者单独采样；主池/边池分层计算下注、过牌与跟注 EV；跟注赔率按可赢底池 | §2.3、§9、§12.6 |
| 回退：翻前短码全下、深码在后 | 有效后手改为仍能行动的对手后，18BB 全下后面还有 100BB 玩家时不再进入全下模型，KQs 约 60% 以 3-bet 回应一个不能再行动的全下 | 当前加注者已全下时总进入全下模型，跟注赔率按可赢底池（`call / winnable`） | §8 |
| 分街跟进率只看频率 | `overbettor` 在 turn 续打少于群体，分街跟进率把它读成“该领先下注”（turn `leadMult` 1.05–1.17），可它续打时用超池打强牌和大部分空气。起初以为这造成了对它的回退（AI 面对其 turn 超池的弃牌率变高）；四组种子的平均（第二轮 -18.3、改动后 -21.2 bb/100）与逐决策配对评估都显示那是随机数流错开的噪声，第二轮自己在不同种子上的这一弃牌率就在 45%–60% 之间 | 领先读数除以这条街所用尺寸的宽度（`lead / max(1, usedWidth)`） | §15 |
| 回退：多人河牌的诈唬频率减半 | 计划 3 按 `0.5^(对手数-1)` 递减，翻牌、转牌都已过牌的多人底池河牌过牌率 54.0% → 58.6%，三街全过牌率 6.2% → 6.7%（同一批牌与随机数，16 个种子、756 个多人翻牌） | 改为 `0.7^(对手数-1)`，两者回到 54.0% / 6.2% | §14 |
| 回退：分街读数低估几乎每次都下注的玩家 | 群体 turn/river 约一半机会下注，`prober` 下注 80%–90% 也只读到宽度 1.49 / 1.42（汇总读数约 1.8）；同一局面下 AI 面对它的 turn 刺探弃牌 20% → 25%、river 29% → 32%，逐决策配对评估对它 +6.1 ±5.2 bb/100（对 AI 不利） | 下注比群体频繁时，`often` 同时看“少 check 多少”，取较大者；`prober` 三条街都读到 1.90 | §15 |
| 回退：分街读数从群体水平重新起步 | 上一项修正之后，同一批局面上 AI 面对 `prober` 河牌小注仍比第二轮多弃牌（27% → 30%，7 个跟注变成弃牌）：分街读数先向群体收缩、再从汇总读数过渡，河牌小注宽度在 16 次河牌机会时掉到约 1.5（汇总 1.90），约 50 次才恢复 | 分街读数改以这名玩家的汇总比值为先验；`prober` 三条街在 100 手时都读到 1.90（此前 turn 1.71、river 1.57），同一批局面上 turn/river 的回应与第二轮完全相同 | §15 |
| 回退：频繁下注者少用的尺寸被读宽 | `often` 计入 check 率之后可以到 5 左右，0.6 的 tilt 下限让每次都小注刺探的玩家突然超池时被读成 1.2–1.35 倍宽（第二轮 0.75），AI 会用偏弱的牌去跟一个多半是坚果的反常超池 | “多频繁”只按该尺寸的使用比例起作用：`reach = often^min(1, lean)`，从不使用的尺寸回到 0.75 | §15 |
| 后手不足时的全下被当成尺寸选择 | `maniac` 总是下注 3/4 pot，后手不足时的全下却落在小注一档；`reach` 让这个它“很少用”的尺寸回到窄读数，AI 面对它河牌小额全下的弃牌率 17% → 20%，逐决策配对评估对它 +4.5 ±2.8 bb/100（对 AI 不利） | 全下小于这名玩家最常用的尺寸时，按它各尺寸下注次数加权的宽度读；面对 `maniac` 河牌 / turn 小额全下的弃牌率降到 10% / 6%，对它 -6.5 ±4.8 bb/100 | §15 |
| 评估：两个版本只共享牌 | 旧脚本里 AI 的随机数按座位轮换成流，第一个不同的决策之后，同一副牌上的随机数全部错开：同样的种子上两版对 `nit` 相差 10 bb/100，逐决策配对后只差 -1.2 ±1.5 | 每个决策（脚本对手与 AI）用由其位置（种子、牌局、座位轮换、行动序号）确定的随机数，两版只在决策不同的地方分开；`compare.ts` 逐副牌配对两次运行 | §18.1 |

本轮合计（§18.1，同一批牌与随机数上逐副牌配对）：对 `maniac` 多赢 **48.2 ±15.5** bb/100，其中计入 check 率的 `often` 一项占 32.7 ±14.8；对其余五个脚本对手的配对差都在 ±3 bb/100 之内，87%–98% 的牌局结果与第二轮完全相同。困难 vs 困难的群体里（§18.2），同一局面上只有 0.27% 的决策与第二轮不同，都在翻后、多数在河牌；多人翻牌三街全过牌率保持 6.2%。

仍未解决的问题：

- 对 `overbettor` 没有净收益（配对差 -0.4 ±4.7）：AI 在 flop 多跟了它的半池 c-bet，这些牌到 turn 面对价值密集的超池时多半放弃，flop 的跟注没有计入之后面对超池时的实现率；它 turn 下注比群体少，turn 超池的宽度读数也略低于第二轮（§18.1）。
- 审计 7.2（湿润度拆成四项特征）、7.3（阻断牌相对继续范围计算）与 9.3（决策、采样与思考时间分离随机数流）仍未采纳；翻牌 / 转牌的价值与诈唬比例仍未按尺寸配比（7.4 的其余部分）；尚无固定节点回归集。

---

## 18. 当前实测行为指标

### 18.1 配对评估：对脚本对手

`npm run eval:ai -- <bot> 1000 11,22 6 out.json`：6 人桌、100BB，两个种子各 1000 副牌，每副牌让脚本对手在 6 个座位各打一遍（共 12,000 手）。表中是脚本对手的 bb/100（**负数表示 AI 赢**），± 为标准误。本轮起评估逐决策配对（§17.2）：两个版本在同样的种子上看到相同的牌与相同的随机数，只在决策不同的地方分开。“配对差”是 `compare.ts` 逐副牌相减后的均值（负数表示第三轮多赢），“结果不变”是两版输赢完全相同的牌局比例。旧脚本的随机数流不同，此前文档里的数字（例如第二轮复盘前对 `prober` 的 -23.7）不能与本表比较，本表两列都用新脚本重跑。

| 脚本对手 | 漏洞 | 第二轮 | 第三轮 | 配对差 | 结果不变 |
| --- | --- | ---: | ---: | ---: | ---: |
| `prober` | 90% 的机会都以 1/4 pot 刺探，被加注只留顶对以上 | -51.4 ±9.0 | -50.1 ±8.7 | +1.3 ±3.1 | 87% |
| `overbettor` | flop 半池 c-bet 70%；turn/river 用 1.25 pot 超池（强牌与八成空气），中等牌 check | -13.7 ±8.0 | -14.1 ±8.0 | -0.4 ±4.7 | 92% |
| `nit` | 只玩 12%，只用顶对以上下注 | -17.2 ±5.7 | -18.3 ±5.5 | -1.1 ±1.6 | 98% |
| `abc` | 价值下注、跟注顶对、少诈唬 | -12.8 ±6.7 | -15.7 ±6.8 | -2.8 ±2.9 | 97% |
| `station` | 宽跟注，任何对子或听牌都跟到底 | -168.7 ±15.1 | -170.3 ±15.2 | -1.6 ±3.4 | 87% |
| `maniac` | 开池 55%，被 check 到就以 3/4 pot 下注 80% | -405.9 ±32.6 | **-454.1 ±33.6** | **-48.2 ±15.5** | 66% |

两列各自的标准误为 5.5–33.6 bb/100，配对差的只有 1.6–15.5：多数牌局上两版的决策完全相同，这部分运气在相减时抵消。

**`maniac`** 被 check 到就下注 80%，turn/river 几乎从不 check。第二轮只按下注频率之比读它，频率接近 100% 时这个比值失灵（§15）。各项的配对差：前六项合计 -6.1 ±15.1；计入 check 率的 `often` -32.7 ±14.8；分街读数改向汇总读数收缩 -7.4 ±11.8；`reach` +4.5 ±2.8（它后手不足时的小额全下落在它“很少用”的小注一档，被读窄）；后手不足的全下改按常用尺寸读 -6.5 ±4.8。

**`overbettor`** 与第二轮持平。分街读数把它的 flop 半池 c-bet 读宽（§15），同一批局面上 AI 面对它 flop 下注的弃牌率 63% → 56%；可多跟的牌到 turn 面对超池时多半放弃，flop 的跟注没有计入之后面对超池时的实现率。它 turn / river 单挑超池的牌里两对以上占 62% / 73%，其余是空气；AI 弃牌时当时领先的只有 20% / 10%，跟注时领先 51% / 46%（1.25 pot 的赔率要求约 36%），面对超池本身的回应基本正确。它在 turn 的开池下注频率（两个种子上 37% / 46%）不高于群体的 49%，`sqrt(often) < 1`：AI 面对它 turn 超池时读到的宽度平均 1.68 / 1.78，第二轮的汇总读数为 1.78 / 1.79，同一批局面上 turn 的弃牌率因此略高（51% → 54%）。与这两项修正之前相比，分街读数向汇总读数收缩与 `reach` 两项在六个种子上合计让它多赢 3.3 ±2.8 bb/100（`reach` 在 `11,22` 上对它没有影响），在误差之内，但方向不利。

读数生效后，AI 面对脚本对手下注的回应（弃牌 / 跟注 / 加注；按各版本实际到达的局面统计，同一批局面上的对照见 §17.2）：

| 场景 | 第二轮 | 第三轮 |
| --- | --- | --- |
| `prober` 的 flop 1/4 pot 下注 | 17% / 64% / 18% | 17% / 65% / 18% |
| `prober` 的 turn 1/4 pot 下注 | 18% / 62% / 20% | 18% / 62% / 20% |
| `prober` 的 river 1/4 pot 下注 | 26% / 53% / 21% | 28% / 52% / 20% |
| `overbettor` 的 flop 半池 c-bet | 59% / 35% / 6% | 53% / 39% / 7% |
| `overbettor` 的 turn 超池 | 58% / 35% / 8% | 61% / 33% / 6% |
| `overbettor` 的 river 超池 | 56% / 40% / 4% | 61% / 33% / 5% |
| `maniac` 的 flop 3/4 pot 下注 | 27% / 64% / 9% | 23% / 67% / 10% |
| `maniac` 的 river 3/4 pot 下注 | 43% / 48% / 9% | 38% / 52% / 10% |
| `maniac` 的 river 小额全下 | 20% / 80% / 0% | 10% / 90% / 0% |

### 18.2 困难 vs 困难的群体行为

6 人桌、100BB、困难 vs 困难，两个种子（`4242` / `777`）各 1500 手：

| 指标 | 第二轮 | 第三轮 |
| --- | ---: | ---: |
| VPIP / PFR | 27.2% / 17.5% | 26.8% / 17.1% |
| 3-bet / 面对 3-bet 弃牌 | 6.8% / 51.6% | 5.8% / 54.1% |
| Flop c-bet（单挑 / 多人） | 57.7% / 26.3% | 55.7% / 27.5% |
| 面对 flop c-bet 弃牌 | 41.5% | 40.9% |
| Flop check-raise | 4.6% | 6.6% |
| Donk（领先下注） | 5.1% | 5.6% |
| Turn 续打 | 70.9% | 73.7% |
| 河牌开池下注（全部 / 转牌攻击者单挑） | 47.6% / 62.7% | **53.6% / 71.7%** |
| 看到翻牌后摊牌率 / 摊牌胜率 | 28.2% / 50.6% | 27.3% / 52.2% |
| 发生全下的手牌 | 2.2% | 2.0% |
| 平均决策耗时 | 3.5ms | 3.3ms |

这套群体脚本整局共用一个随机数流：第一个不同的决策之后，后面的牌与随机数全部错开，两列之差多半是噪声。在同一局面、同一随机数上逐决策对照两版（沿第三轮的行动线）：全部 26,956 个决策中只有 72 个（0.27%）不同，翻前一个也没有，53 个在河牌。表中翻前、flop 与 turn 的差异都来自随机数错开；河牌开池下注的增加是真实的，来自按尺寸配比的河牌诈唬（§14）。

多人翻牌三街全部过牌率（同一批牌与随机数，16 个种子各 260 手、共 756 个多人翻牌）：第二轮与第三轮都是 **6.2%**，flop、turn 都已过牌的多人底池河牌过牌率都是 54.0%，756 手中只有 4 手的过牌情况不同。第二轮复盘前后的 10.4% → 5.0% 来自另一批样本（8 个种子、约 400 个多人翻牌、旧脚本），不能与这里直接比较。

群体指标是行为诊断；收益以 18.1 的配对评估为准。固定节点回归集仍未建立。
