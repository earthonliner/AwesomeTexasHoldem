# 困难难度 AI 策略详解（含当前参数）

> 本文档描述困难难度 AI 的完整决策模型：范围、胜率、弃牌率、动作 EV、尺度、混合与真人剥削是**如何在同一套口径下彼此衔接**的。以下数值是当前实现的基准、公式和上下限，用于模拟有范围意识、会混合策略且会针对熟客调整的线下现金局强玩家，**并非声称已经求得 GTO 均衡**。最终动作还会受随机混合、具体组合、位置、有效筹码、行动线和玩家画像共同影响；文中 `range=0.25` 表示按对应规则排序后保留约 25% 的两张底牌组合，不代表每一类牌都以 25% 概率行动。
>
> 代码入口：`src/ai/decision.ts`（决策）、`src/ai/preflopRanges.ts`（翻前范围函数）、`src/engine/preflopStrength.ts`（起手牌排序）、`src/engine/monteCarlo.ts`（范围采样与胜率）、`src/ai/profile.ts`（真人画像）、`src/ai/image.ts`（自我形象）。文末「审计采纳情况」记录了外部策略审计的逐条处理结果。

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
组合计数正确 → 场景范围正确 → 对手按角色（下注者/跟注者/过牌者/未行动者）建模
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

有效深度统一定义为 `effectiveDepthBB = (min(本方后手, 对局有效后手) + 本手已投入) / BB`。

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

```text
defendRange
  = 位置基准
  × exp(-0.20 × max(0, openBB - 2.5))
  × 开池者位置修正        // 位置因子 ≥0.72：×1.18；≤0.42：×0.78
  × style
  × 真人范围修正          // 被画像真人开池：× sqrt(rangeMult)
  + min(0.08, caller数 × 0.035)
最终 clamp [0.055, 0.56]
```

- 尺寸项为指数衰减，4.5BB→5BB 只会平滑收紧，不存在范围断崖。
- Value 3-bet：对偏后开池 top **8.5%**，其他位置 top **5.5%**。
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

`effective = max(1, min(本方后手, 对局有效后手))`，`currentLevel = 本街已投入 + toCall`。满足 `toCall ≥ effective × 0.52` 或 `currentLevel ≥ maxRaiseTo` 时进入全下模型：

```text
jamRange = shoveRangeFraction(currentLevelBB)          // 分段线性插值，无断崖
  控制点：6BB→0.34, 10BB→0.24, 18BB→0.14, 30BB→0.09, 55BB→0.05, 90BB→0.04
≤15BB 且 CO/BTN/SB 的首次 jam ×1.45（只剩盲注在后的短码 jam 范围远宽于前位）
4-bet+ pot ×0.72；被画像真人 ×rangeMult；最终 clamp [0.025, 0.30]
```

例：BB 持 A9o 面对 BTN 10BB open-jam（`villR=0.30`，赔率 0.44，胜率 ≈0.53）跟注；K8o/Q7o 弃牌；同样的 A9o 面对 25BB jam（`villR=0.11`）弃牌。

- 对手组合按**全下排序**抽样，困难运行 **850 次**。
- 模拟对手数 = 台面上**已投入到当前下注级别或已全下**的对手数（`committedOpponents`），而不是 “最后一次加注后的 caller 数 + 1”；尚未行动的玩家不算对手，而是转化为安全边际。
- 底池赔率 `odds = toCall / (potBefore + toCall)`。
- 安全边际 `margin = 0.012 + min(2, 后方未行动人数) × 0.012 + (跟注后仍有 >20% 底池的后手且行动未关闭 ? 0.01 : 0)`。
- 继续门槛：`equity + (攻击者为被画像真人 ? valueLean×0.30 : 0) ≥ odds + margin`。
- 后方仍有玩家时的隔离：面对 ≥40BB 的 jam 仅 `AA/KK`，较短 jam 可用 `AA/KK/QQ/AKs/AKo`。
- 引擎禁止制造无人可匹配的“假加注”。

“跟注后仍有筹码和未来行动”的局面（`chipsBehind > 0.2 × potAfterCall`）只通过 margin 处理；这是审计 5.6 指出的近似，尚未拆成独立的三类节点。

---

## 9. 对手翻后范围：按角色采样

范围采样器 `estimateEquityVsRange` 把每名对手分成四种角色，从**同一份按当前牌面排序、并经翻前范围过滤**的组合列表中抽样：

| 角色 | 何时 | 抽样池 |
| --- | --- | --- |
| **下注者** | 本街最后攻击者 | 极化：`1 - bluffShare` 来自 top `rangeFraction`（value pool），`bluffShare` 来自 value pool 之外按诈唬候选质量排序的 bluff pool |
| **跟注者** | 面对下注时已跟注的对手 | **85%** 来自 value pool 下方约 35% 组合的 capped 区间，**15%** 慢打份额仍来自 value pool |
| **过牌者** | 无人下注且已在本街 check（上一街 check-through 时，后方未行动者亦按过牌者处理） | **80%** 来自去掉 top `checkedCapTier` 之后的弱区，**20%** 陷阱份额来自 top 区 |
| **未行动者** | 面对下注时尚未行动的后方玩家 | 完整翻前过滤后的范围 |

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
check-raise ×0.62；相关攻击者为被画像真人 ×rangeMult；最终 clamp [0.07,0.88]
```

**翻前范围连续带入**：

| 翻前底池 | 保留组合比例 |
| --- | ---: |
| 4-bet+ | **0.055** |
| 3-bet | **0.12** |
| Single-raised，相关攻击者偏前 / 居中 / 偏后 | **0.19 / 0.26 / 0.34** |
| Limped / 未加注 | **0.72** |
| 无法分类但已加注 | **0.30** |

被画像真人乘 `rangeMult`，最终 clamp `[0.035, 0.86]`。

**下注范围的诈唬份额**：

```text
base = 0.30 + boardWetness × 0.10；betToPot ≥ 0.8 +0.05；river +0.02
同街 ≥2 次激进动作 ×0.70；多人 ÷ sqrt(liveOpponents)；clamp [0.08,0.50]
check-raise ×0.62；被画像真人按大小注读数缩放；最终 clamp [0.03,0.50]
```

**采样实现细节**：

- value pool 至少保留 `max(6, 对手数×3)` 个组合——这只是让有放回采样能工作，不再以 “至少 12 个” 隐性放宽极紧范围。
- 组合冲突时沿同一排序回退到相邻组合（下注者向上、过牌者向下），不再回退到随机两张牌。
- **河牌单挑精确枚举**：所有加权池按权重逐组合评估，结果与随机源和迭代次数无关。
- **自适应采样**：flop/turn 或多人河牌先跑 720 次；若估计值落在最近边界（面对下注时为底池赔率，否则为价值阈值）的 `1.6 × SE` 之内，再跑 720 次取均值。
- 被跟注后的胜率（`calledEquity`）：各角色都只保留 **继续份额** `continueShare = 1 - FE^(1/n)`——下注者 value pool 乘以该份额，过牌者/未行动者取各自池的最强部分，陷阱份额则始终继续。多人时继续人数 `round(n × (1 - FE^(1/n)))`（至少 1 人）。
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
directOdds = toCall / (potBefore + toCall)
听牌隐含赔率：depth = clamp((SPR - 2) / 6, 0, 1)
  impliedDiscount = depth × (IP ? 0.12 : 0.07) × (干净听牌 ? 1 : 0.62)
  needed = directOdds × (1 - impliedDiscount × (0.55 + stackReactivity×0.45))

mathEdge = equity - needed
edge     = mathEdge + (callDown - 0.5) × 0.055 + 非河牌位置修正 + 真人 valueLean
非河牌位置修正 = positionAwareness × (positionFactor - 0.5) × 0.055

deadZone = river ? 0.03 : 0.08
P(continue) = mathEdge < -deadZone ? 0 : sigmoid(edge / 0.038)
directOdds ≤ 0.15 且 equity > 0.17 时 P(continue) ≥ 0.86
```

审计 3.4 的反例（河牌 `edge = -0.08` 仍以 10.9% 跟注）被 deadZone 截断为 0；随机化只保留在 `±0.03`（河牌）/`±0.08`（有牌待发）的无差别带内。

继续之后：

| 动作 | 条件 | 与谁比较 |
| --- | --- | --- |
| Value raise | `equity ≥ valueThreshold + 0.08`、至少一对、混合 `0.48 + aggression×0.32` | `ΔEV = EV(raise) - EV(call)`，`EV(call) = equity × (pot + toCall) - toCall`；坚果免门 |
| Semi-bluff raise | 真实听牌且 `bluffQuality ≥ 0.35`，混合 `bluffFrequency × 0.72` | `EV(raise) - max(EV(call), 0)` |
| Bluff raise（弃牌区） | river `bluffQuality ≥ 0.35` / 其他街 `≥ 0.45`，`toCall ≤ 0.7 pot`，混合 `bluffFrequency × 0.35` | `EV(raise) - max(EV(call), 0)` |
| Trap-call | `trapMore`、`equity ≥ valueThreshold + 0.08`、未 commit，**42%** 只跟不加 | — |

加注的 `heroRisk` 与 `callerContribution` 区分“本方为加注先补齐的金额”和“对手面对加注需要补齐的金额”。

### 12.5 弃牌率模型

```text
基础：主动下注/刺探 0.39；面对下注的加注 0.30
IP +0.05；每多一名对手 -0.10
尺寸 + clamp(size - 0.5, -0.25, 0.65) × 0.13；阻断牌 + blockerScore × 0.08
面对 check-raise -0.16；同街 ≥2 次激进动作 -0.10
× foldPressure；clamp [0.08, 0.72]
checked-through probe 额外 + 0.04 + positionFactor × 0.03，之后 clamp [0.08, 0.78]
```

多人时 `FE` 解释为 “所有人都弃牌” 的概率，被跟注分支按 `f = FE^(1/n)` 的联合响应收窄各对手范围（§9）。

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

审计 7.4 建议按尺寸统计价值/诈唬组合权重（1/3 pot 约 20% 诈唬、pot 约 33%）；这一统计校准尚未实现，见 §17。

---

## 14. 一次性抽样的行动线计划

无人下注时，AI **只选一个计划、只抽一次样**。计划按优先级排列，第一个适用的计划拥有本次决策；抽样失败即 check，不会落入下一个分支再抽一次。旧实现中普通诈唬、c-bet、probe 依次独立抽样，最终下注率为 `1 - Π(1 - p_i)`（例如 30% 与 40% 叠加成 58%），各个“上限”因此形同虚设。

| 优先级 | 计划 | 适用条件 | 抽样概率（EV 门之前） | 尺寸 |
| ---: | --- | --- | --- | --- |
| 1 | `polar-value` / `thin-value` / `protection-value` | `strongValue` 或 `protectionValue` | 价值 1、保护 `protectionChance`；再乘 `(1 - trapChance)` | 坚果用极化桶，其余薄价值桶 |
| 2 | `range-cbet` | flop、AI 是翻前最后攻击者、未面对 check-raise，且 `hasDraw` 或 `bluffQuality ≥ 0.08` 或 `showdownValue ≤ 0.30` | `clamp(cbetBase × cbetQuality × foldPressure, 0.04, 0.62)` | 薄价值桶 |
| 3 | `checked-to-float` | 上一街对手是攻击者、本街已 check 给 AI、AI 上街不是攻击者、对手 ≤2 | `clamp((0.34 + IP 0.20 + aggression×0.12) × foldPressure × (0.45 + bluffQuality), 0, 0.72)` | 极化桶 |
| 4 | `delayed-probe` / `delayed-protection` | turn/river 且上一街全桌 check-through；turn 候选：听牌、高牌、底/中对、`bluffQuality ≥ 0.10`；river 仅高牌 | `clamp(probeBase × probeQuality × foldPressure, 0.06, 0.64)` | 薄价值桶 |
| 5 | `planned-barrel` | AI 上一街以 bluff 身份进攻且未面对 check-raise | `clamp(((river ? 0.34 : 0.52) + J+ runout 0.08 + bluffQuality×0.18) × bluffMult, 0, 0.72)` | 极化桶 |
| 6 | `candidate-semi-bluff` / `blocker-bluff` | `bluffFrequency > 0` | `bluffFrequency`（§11） | 极化桶 |

```text
protectionChance = clamp(0.36 + aggression×0.34 + wetness×0.10 - (对手数-1)×0.07 + (IP ? 0.05 : 0), 0.25, 0.78)
trapChance       = (trapMore ? 0.20 : 0) + (wetness<0.48、两对+、OOP 且上一街对手主导 ? 0.12 : 0)

cbetBase    = 0.40 + aggression×0.24 + (IP ? 0.10 : 0) + (3-bet/4-bet pot ? 0.08 : 0)
              - (对手数-1)×0.10 - wetness×0.08
cbetQuality = clamp(0.55 + bluffQuality×0.50 + (有 overcard ? 0.06 : 0), 0.55, 1)

probeBase    = 0.28 + aggression×0.24 + positionFactor×0.20 - (对手数-1)×0.07 - (river ? 0.03 : 0)
probeQuality = 一对 ? 0.75 : clamp(0.66 + bluffQuality×0.42 - showdownValue×0.18, 0.55, 1)
```

这些概率都是**最终频率**（单次抽样），因此比旧的分支概率设得更高；随后再乘 §12.3 的 EV 门。所有计划在 commit 局面下只有具备真实权益时才允许补齐全下（价值 `equity ≥ 0.72`）。对子加听牌等半诈唬保留 `isBluff` 标记以接通后续 barrel；若 barrel 变成负 EV，AI 进入 `barrel-giveup` 而不是为了“讲故事”继续烧钱。

---

## 15. 置信度加权的真人画像剥削

单机保存一份真人画像；局域网按真人座位分别维护。多人池只把当前/上一街相关真人攻击者的画像用于本次决策；没有明确攻击者时，只有 heads-up 才使用唯一真人作为 fallback。

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

- Steal 只统计 unopened pot 中 CO/BTN/SB 对盲位的首个 open。
- C-bet 只统计翻前最后攻击者在 flop 的下注及真人回应。
- 河牌“弱牌下注”只在摊牌后确认：高牌或只能玩公共牌才记为 weak。它衡量的是 **被看到的河牌下注中弱牌的比例**，不是总体诈唬率（成功的诈唬不会亮牌），因此读取时只按 **0.7** 的信任度混合。
- **大小注共用一个分类函数** `isBigRiverBet`：`betToPot > 0.55` 为大注，统计与读取口径一致（此前统计用 0.55、读取用 0.70，0.6 pot 会被错桶）。

**置信度**：

```text
总权重 = clamp(hands / 36, 0, 1)
偷盲权重 = 总权重 × clamp(stealFaced / 8, 0, 1)
c-bet 权重 = 总权重 × clamp(cbetFaced / 10, 0, 1)
行动权重 = 总权重 × clamp((aggressive + passive) / 35, 0, 1)
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
| 6.1 单一 effective 描述多人 | 正确性 | **未采纳**（引擎逐池结算正确；AI 决策仍用单一 effective 与胜率×总底池） | — |
| 6.2 模拟对手数来源 | 正确性 | 改为台面 `committedOpponents` | §8 |
| 6.3 多人 fold equity 联合响应 | 近似 | 被跟注分支采用 `FE^(1/n)` 的独立近似；弃牌率本身仍为线性扣分 | §12.5 |
| 7.1 多分支概率叠加 | 实现核查，已确认存在 | 单计划单次抽样，频率重新校准为最终频率 | §14 |
| 7.2 湿润度一词多用 | 特征混用 | **未采纳**（待拆分为四项特征） | §10 |
| 7.3 阻断牌相对继续范围计算 | 待验证 | **未采纳**（仍用固定阻断分） | §10 |
| 7.4 尺寸与价值/诈唬组合联动 | 待验证 | **未采纳**（缺少按尺寸的组合权重统计） | §13 |
| 7.5 几何尺度适用范围 | 应收窄 | 限定为极化、SPR≤3、单挑 | §13 |
| 8.1 大小注口径不一致 | 确定问题 | 共享 `isBigRiverBet`（0.55 pot） | §15 |
| 8.2 摊牌弱牌率 ≠ 诈唬率 | 统计限制 | 文档与注释改称 shown-weak rate；信任度 0.7 | §15 |
| 8.3 激进 ≠ 诈唬多 | 特征过宽 | 激进按 `excess` 分级，抓诈唬需摊牌证据；未按动作类别分层统计 | §15 |
| 8.4 人格参数命名 | 命名/校准 | 文档明确 `pfr` 为倾向参数；未重命名字段（兼容） | §1 |
| 8.5 形象半衰期过短 | 可量化 | 双轨形象 + 摊牌区分 + 机会归一化 | §16 |
| 9.1 850 次不足以支撑 1.2 点边界 | 精度问题 | 自适应二次采样；河牌单挑精确枚举 | §9 |
| 9.2 缓存键 | 工程 | 已核对：缓存只含公共牌（翻前另含排序模式），阻断与范围在使用时过滤 | §9 |
| 9.3 随机数流分离 | 工程 | **未采纳**（决策/采样/思考时间仍共用一个 rng） | — |
| 12.1 确定性测试 | 验证 | 新增排序、边界连续性、过牌者模型、精确枚举、负 EV 截断、单次抽样频率测试 | `*.test.ts` |
| 12.2–12.5 回归集、消融、对手池 | 验证 | **未采纳**：目前只有行为诊断（§18），没有固定节点回归集与配对对战框架 | — |

---

## 18. 当前实测行为指标

6 人桌、100BB、困难 vs 困难、400 手、两组随机种子（`4242` / `777`）：

| 指标 | 审计前 | 当前 |
| --- | ---: | ---: |
| 多人翻牌三街全部过牌率 | ≈ 15% | **8.4% / 9.4%** |
| Flop 全桌过牌率 | 33% | 30% / 37% |
| Turn 全桌过牌率 | — | 24% / 22% |
| River 全桌过牌率 | 47% | **27% / 27%** |
| VPIP / PFR | — | 0.33 / 0.19、0.32 / 0.19 |
| 每手全下次数 | — | 0.03 / 0.025 |
| 摊牌率（每手） | — | 0.20 / 0.23 |
| 平均决策耗时 | — | ≈ 3.5ms |

这些是行为诊断，不是收益证明；审计 12 章的固定节点回归集与配对对战尚待建立。
