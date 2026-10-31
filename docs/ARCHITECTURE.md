# 架构（ARCHITECTURE）

> 技术栈：原生 JavaScript（ES Module）+ Canvas 2D + Python 标准库服务器。
> **零构建、零 npm 依赖** —— 改完代码刷新即生效，测试用 Node 直接跑。

## 目录

```
play-main.html      游戏页骨架（~310 行），只含 DOM + <script type="module" src="js/main.js">
build.html          造船厂（内联脚本，暂未模块化）
station.html        观察站（内联脚本，暂未模块化）
index.html          主菜单
server.py           协同服务器：静态文件 + /api/*（存档/飞船/操控权/世界状态广播）

js/
  main.js           组合根：游戏状态、物理步、输入、渲染循环、网络、存档都在这（~2400 行）
  core/constants.js 全部物理/尺度常量（唯一来源；各段注释解释互相约束，别单改一个数）
  core/format.js    距离/速度格式化（纯函数）
  world/planet.js   星球 + 引力 + 大气密度（纯计算，Node 可测）
  ship/partTypes.js 部件定义表（质量/推力/尺寸的唯一事实源）
  ship/shipSpec.js  船体规格：质量/包围盒/质心/碰撞点（纯计算，Node 可测）
  ship/…            vessel/damage 计划中（见「边界」）
  physics/prediction.js  轨道预测：真空椭圆走解析几何，其余数值积分（与 physicsStep 同一套力）
  ui/achievements.js 成就 + toast + 面板
  render/camera.js  相机状态对象

tools/tests/
  headless.mjs      手写浏览器桩（canvas/DOM/localStorage/断网 fetch/手动泵帧）
  run.mjs           回归套件入口，23 个用例
docs/SMOKE-TEST.md  手测冒烟清单（10 条）
```

## 分层规则

1. **纯模块不碰 DOM、不读游戏状态**——`constants/format/planet/partTypes/shipSpec/prediction`
   只做计算，Node 能直接 `import` 单测。新模块先问一句：能不能在 Node 里测？
2. **唯一事实源**：
   - 部件数值 → `ship/partTypes.js`（build/station 目前还有副本，见 KNOWN_ISSUES）
   - 质量/推力 → 实时 `shipInfo()`（**禁止**再引入冻结常量，`DRY_MASS/FULL_THRUST` 教训）
   - 换船 → 唯一入口 `setShipDef()`（shipDef/SPEC/血量表/温度表/已毁集合必须一起换）
3. **状态归属**：`rocket/shipDef/SPEC/vessels/keys/stats` 等模块级 `let` 都住在 main.js；
   对外（测试）只通过 `__test` 导出暴露，**用 getter 包装**——这些变量会被重新绑定，导出快照会拿到旧对象。

## 主循环与数据流

```
gameLoop（每帧，真实时间）
 ├─ updateAchievementToast(frameTime)   ← UI 计时用真实时间，不随时间倍率缩放
 ├─ 操控端: 累加器 × timeScale → physicsStep(FIXED_DT) × N（每帧上限 260 步）
 │    physicsStep: 输入(真实时间)→引力→发动机(检查发动机/油箱存活)→阻力→位移→着陆/损毁/分离→残骸→加热→成就
 ├─ 观战端: applyRemoteWorld() 插值服务器状态
 ├─ 渲染插值: 步进前后各快照一次状态，渲染按 alpha=累加器余量/步长 取插值位置
 │    （物理 60Hz 固定步进，高刷屏 240Hz 下不插值会 4 帧一跳——Fix Your Timestep）
 ├─ render（相机硬锁插值位置/星球/预测线（屏幕空间描边）/船/碎片）
 └─ 每 1s 自动 saveMission()（观战端不存）
```

预测线语义：**假设此刻关机滑行**的轨迹。真空 + 椭圆 → 解析椭圆（零积分）；
点火/大气/逃逸 → 数值积分 + 100ms 节流。

## 协同模型

- **操控端**（同一时间一个）跑物理，10Hz `POST /api/state` 上报世界；
  观战端带 `since=rev` 增量拉取。服务器不跑物理，只转发和存档。
- 操控权由服务端 `_touch` 分配：无人操控时自动接管；掉线回归且已被接管则降级观战；
  被踢端 30 秒冷却。`/api/save` 只认当前操控端。
- 不带 `cid` 的请求不登记客户端（防 anon-IP 幽灵端抢操控权）。

## 存档三层

| 层 | 位置 | 内容 | 触发 |
|---|---|---|---|
| 任务档 | localStorage `msp2d-mission-v1` | 本局全状态（含损毁/残骸） | 每秒 + pagehide |
| 共享档 | 服务器 `savegame.json` | planet/rocket/camera | 手动 S（仅操控端） |
| 成就 | localStorage `msp2d-achievements` | 已解锁 id 集合 | 解锁/结算时 |

## 测试

```bash
node tools/tests/run.mjs
```

- 原理：`headless.mjs` 造最小浏览器桩，把 `js/main.js` **原样**跑在 Node 里，
  回归测的是真实游戏代码。`requestAnimationFrame` 被替换成手动泵帧（`env.pumpFrames(n)`）。
- 约定：用例开头 `resetToGround()` 归零状态；toast 断言前先 `resetToasts()`；
  改物理/损毁/换船代码后必须跑一遍，全绿再提交。
- `window.__lastGameError`：主循环单帧异常会被捕获记录（循环不停摆），
  真浏览器排查问题先看它。
