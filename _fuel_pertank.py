# -*- coding: utf-8 -*-
# 一次性脚本：燃料按箱独立存储，跑完即删
import io

s = io.open('js/main.js', encoding='utf-8', newline=None).read()

def rep(old, new):
    global s
    assert s.count(old) == 1, 'marker x%d: %s' % (s.count(old), old[:70])
    s = s.replace(old, new, 1)

# 1) 质量模型 + 燃料助手（按箱存储）
rep("""        function shipMass(fuel) {
            const info = shipInfo();
            return info.dryMass + info.fuelCap * Math.max(0, Math.min(1, fuel));
        }

        // 当前实际加速度（已经算上油门和质量）
        function thrustAccel(fuel, throttle) {
            const m = shipMass(fuel);
            return m > 0 ? shipInfo().thrust * Math.max(0, Math.min(1, throttle)) / m : 0;
        }""",
"""        // ==================== 燃料按箱存储 ====================
        // 每个燃料箱部件自带油量 p.fuel（0~容量）。发动机抽全船所有油箱
        //（等比消耗，油门手感不变）；分离时各段带走自己格子里的油箱和油——
        // 上面级没放油箱就没油烧（分级火箭的物理约束，与 KSP 一致）。
        function tankFuel(p) {
            return (p.fuel !== undefined) ? p.fuel : (PART_TYPES[p.type] ? PART_TYPES[p.type].fuel : 0);
        }
        function aliveTanks() {
            return shipDef.parts.filter(p => p.type === 'tank' && !destroyed.has(p.id) && !severed.has(p.id));
        }
        function totalFuel() {
            return aliveTanks().reduce((s, p) => s + tankFuel(p), 0);
        }
        function totalCap() {
            return aliveTanks().reduce((s, p) => s + (PART_TYPES[p.type].fuel || 0), 0);
        }
        function totalRatio() {
            const c = totalCap();
            return c > 0 ? Math.max(0, Math.min(1, totalFuel() / c)) : 0;
        }
        // 等比抽取：所有油箱同比例下降（frac = 占总容量的比例）
        function drainFuel(frac) {
            for (const p of aliveTanks()) {
                const t = PART_TYPES[p.type];
                p.fuel = Math.max(0, tankFuel(p) - frac * t.fuel);
            }
        }
        function setFuelRatio(r) {
            for (const p of aliveTanks()) {
                p.fuel = Math.max(0, Math.min(1, r)) * PART_TYPES[p.type].fuel;
            }
        }
        function partsRatio(parts) {
            let f = 0, c = 0;
            for (const p of parts) {
                const t = PART_TYPES[p.type];
                if (!t || t.fuel <= 0) continue;
                f += tankFuel(p); c += t.fuel;
            }
            return c > 0 ? f / c : 0;
        }
        function shipMass() {
            let m = 0;
            for (const p of shipDef.parts) {
                if (destroyed.has(p.id) || severed.has(p.id)) continue;
                const t = PART_TYPES[p.type];
                if (!t) continue;
                m += t.mass + tankFuel(p);
            }
            return m;
        }

        // 当前实际加速度（已经算上油门和质量）
        function thrustAccel(throttle) {
            const m = shipMass();
            return m > 0 ? shipInfo().thrust * Math.max(0, Math.min(1, throttle)) / m : 0;
        }""")

# 2) 质心：按各箱油量
rep("""        function shipCenterOfMass(def, spec, fuelRatio) {
            const P = PART_PX;
            const fr = (typeof fuelRatio === 'number') ? fuelRatio : 1;   // 默认按满油算""",
"""        function shipCenterOfMass(def, spec, fuelGet) {
            const P = PART_PX;""")
rep("""        function shipCenterOfMass(def, spec, fuelRatio) {
            const P = PART_PX;
            const fr = (typeof fuelRatio === 'number') ? fuelRatio : 1;   // 默认按满油算""",
"""        function shipCenterOfMass(def, spec, fuelGet) {
            const P = PART_PX;
            // fuelGet(p) 返回该油箱当前油量；缺省按满油算（规格估算用）""")
rep("""                // 部件质量：燃料箱里有多少油，就算多少燃料质量（质量随燃料减少）
                const partFuel = t.fuel * fr;
                const m = t.mass + partFuel;""",
"""                // 部件质量：燃料箱里有多少油，就算多少燃料质量（按箱独立）
                const partFuel = fuelGet ? fuelGet(p) : t.fuel;
                const m = t.mass + partFuel;""")

# 3) 质心重算：传按箱油量
rep("""            if (rocket.fuel !== lastComFuel) {
                SPEC.com = shipCenterOfMass(shipDef, SPEC, rocket.fuel);
                lastComFuel = rocket.fuel;
            }""",
"""            if (totalFuel() !== lastComFuel) {
                SPEC.com = shipCenterOfMass(shipDef, SPEC, q => tankFuel(q));
                lastComFuel = totalFuel();
            }""")

# 4) 燃烧：等比抽各箱 + 镜像
rep("""                } else if (rocket.fuel > 0) {
                    thrusting = true;
                    rocket.fuel = Math.max(0, rocket.fuel - rocket.throttle * dt / FUEL_BURN_SECONDS);
                    if (rocket.fuel <= 0) {
                        rocket.state = 'idle';                          // 没油了，熄火
                        if (!rocket.landed) unlock('out_of_fuel');      // 在天上烧干 = 弹尽粮绝
                    }
                } else {
                    rocket.state = 'idle';
                }
            }""",
"""                } else if (totalFuel() > 0) {
                    thrusting = true;
                    drainFuel(rocket.throttle * dt / FUEL_BURN_SECONDS);
                    rocket.fuel = totalRatio();   // 兼容镜像（HUD/上报/测试读这个）
                    if (totalFuel() <= 0.0001) {
                        rocket.state = 'idle';                          // 没油了，熄火
                        if (!rocket.landed) unlock('out_of_fuel');      // 在天上烧干 = 弹尽粮绝
                    }
                } else {
                    rocket.state = 'idle';
                }
            }""")

# 5) 推力调用点
rep("""                const power = thrustAccel(rocket.fuel, rocket.throttle);""",
"""                const power = thrustAccel(rocket.throttle);""")

# 6) 加油 / 卸油：作用于所有油箱
rep("""                    if (keys.refuel) {
                        rocket.fuel = Math.min(1, rocket.fuel + FUEL_FILL_RATE * inputDt);
                        if (rocket.fuel >= 1) unlock('refuel_full');
                    }
                    if (keys.dump) {
                        const before = rocket.fuel;
                        rocket.fuel = Math.max(0, rocket.fuel - FUEL_FILL_RATE * inputDt);
                        stats.dumpedFuel += before - rocket.fuel;
                        if (stats.dumpedFuel >= 0.5) unlock('dump_half');
                    }""",
"""                    if (keys.refuel) {
                        for (const p of aliveTanks()) {
                            const t = PART_TYPES[p.type];
                            p.fuel = Math.min(t.fuel, tankFuel(p) + FUEL_FILL_RATE * t.fuel * inputDt);
                        }
                        if (totalRatio() >= 0.999) unlock('refuel_full');
                    }
                    if (keys.dump) {
                        const before = totalFuel();
                        for (const p of aliveTanks()) {
                            const t = PART_TYPES[p.type];
                            p.fuel = Math.max(0, tankFuel(p) - FUEL_FILL_RATE * t.fuel * inputDt);
                        }
                        stats.dumpedFuel += totalCap() > 0 ? (before - totalFuel()) / totalCap() : 0;
                        if (stats.dumpedFuel >= 0.5) unlock('dump_half');
                    }""")

# 7) 分级：上面级无油箱警告
rep("""            unlock('first_staging');
            const names = batch.map(a => a.kind === 'sever' ? '分离' : '开伞').join(' + ');""",
"""            unlock('first_staging');
            if (vessels.length > before && hasWorkingEngine() && totalCap() === 0) {
                toastQueue.push({
                    title: '警 告',
                    name: '上面级没有燃料箱',
                    desc: '分离后发动机无法点火——上面级需要自己的油箱',
                });
            }
            const names = batch.map(a => a.kind === 'sever' ? '分离' : '开伞').join(' + ');""")

# 8) splitVessel：燃料重归一废除（按箱模型天然正确）
rep("""                    // 燃料容量变了：油量按「占新容量的比例」重新归一
                    const newCap = g.reduce((s, p) => s + (PART_TYPES[p.type] ? PART_TYPES[p.type].fuel : 0), 0);
                    const oldCap = SPEC.fuelCap || 1;
                    rocket.fuel = Math.max(0, Math.min(1, rocket.fuel * oldCap / Math.max(1e-6, newCap)));
                    lastComFuel = -1;""",
"""                    // 燃料按箱存储：分离后各截带走自己格子里的油箱和油，
                    // 无需重新归一（per-tank 模型天然正确）。""")

# 9) activateVessel：接管目标的燃料比
rep("""            rocket.fuel = target.fuel;""",
"""            rocket.fuel = partsRatio(target.def);   // 接管目标的燃料比""")

# 10) born / detach / 旧主归档：ratio 用所在段实际值
rep("""                const v = makeVessel(g, wx, wy, rocket.vx, rocket.vy, rocket.angle, rocket.fuel);""",
"""                const v = makeVessel(g, wx, wy, rocket.vx, rocket.vy, rocket.angle, partsRatio(g));""")
rep("""            const v = makeVessel(loose, rocket.x, rocket.y, rocket.vx, rocket.vy, rocket.angle, rocket.fuel);""",
"""            const v = makeVessel(loose, rocket.x, rocket.y, rocket.vx, rocket.vy, rocket.angle, partsRatio(loose));""")
rep("""            const old = makeVessel(shipDef.parts, rocket.x, rocket.y,
                                   rocket.vx, rocket.vy, rocket.angle, rocket.fuel);""",
"""            const old = makeVessel(shipDef.parts, rocket.x, rocket.y,
                                   rocket.vx, rocket.vy, rocket.angle, totalRatio());""")

# 11) blowUpPart：油箱被炸 = 油跟着箱子没了
rep("""            // 燃料箱被炸 → 它装的那部分油也没了。
            // 分母用「还活着的油箱总容量（含自己这箱）」：旧实现用 spec.fuelCap
            // 不排除已炸油箱 —— 多箱船炸到最后会剩下对应箱子已不存在的幽灵燃料。
            let aliveCap = t.fuel;
            for (const q of v.def.parts) {
                if (q.id !== p.id && !v.dead.has(q.id)) {
                    const tq = PART_TYPES[q.type];
                    if (tq) aliveCap += tq.fuel;
                }
            }
            if (t.fuel > 0 && aliveCap > 0) {
                const share = t.fuel / aliveCap;
                const lost = v.fuel * share;   // 当前油量里属于这个箱子的部分
                v.fuel = Math.max(0, v.fuel - lost);
                if (v.isMain && lost > 0.001) {
                    toastQueue.push({
                        title: '燃 料 损 失',
                        name: `燃料箱炸了，掉了 ${Math.round(lost * 100)}% 油`,
                        desc: `剩余燃料 ${Math.round(v.fuel * 100)}%`,
                    });
                }
                if (v.fuel <= 0 && v.state === 'firing') v.state = 'idle';
            }""",
"""            // 燃料按箱存储：油箱被炸 = 它的油跟着箱子一起没了
            // （按箱独立，旧版「全船共享一个燃料池 + 按份额扣油」的结构已废除）。
            if (t.fuel > 0 && tankFuel(p) > 0) {
                if (v.isMain) {
                    toastQueue.push({
                        title: '燃 料 损 失',
                        name: `燃料箱炸了，损失 ${Math.round(tankFuel(p))} 单位油`,
                        desc: '其余油箱的燃料不受影响',
                    });
                    rocket.fuel = totalRatio();   // 镜像
                }
            }""")

# 12) HUD：燃料条/文本/推重比
rep("""            fuelFill.style.height = (rocket.fuel * 100).toFixed(1) + '%';
            fuelFill.style.background = rocket.fuel < 0.2""",
"""            fuelFill.style.height = (totalRatio() * 100).toFixed(1) + '%';
            fuelFill.style.background = totalRatio() < 0.2""")
rep("""            const massNow = shipMass(rocket.fuel);""",
"""            const massNow = shipMass();""")
rep("""            const twrNow = thrustAccel(rocket.fuel, 1) / G0_PX;
            const massInfo = shipInfo();
            const massTip = `质量 ${massNow.toFixed(0)}（空船 ${massInfo.dryMass}）· 推重比 ${twrNow.toFixed(2)}:1`
                + (rocket.fuel < 0.999 ? `  已减重 ${(massInfo.fuelCap * (1 - rocket.fuel)).toFixed(0)}` : '');""",
"""            const twrNow = thrustAccel(1) / G0_PX;
            const massInfo = shipInfo();
            const massTip = `质量 ${massNow.toFixed(0)}（空船 ${massInfo.dryMass}）· 推重比 ${twrNow.toFixed(2)}:1`
                + (totalRatio() < 0.999 ? `  已减重 ${(totalCap() - totalFuel()).toFixed(0)}` : '');""")
rep("""                `燃料 ${Math.round(rocket.fuel * 100)}% · 满油门还能烧 ${Math.round(rocket.fuel * FUEL_BURN_SECONDS)} 秒`""",
"""                `燃料 ${Math.round(totalRatio() * 100)}% · 满油门还能烧 ${Math.round(totalRatio() * FUEL_BURN_SECONDS)} 秒`""")

# 13) loadGame：读档燃料比 → 按箱
rep("""                    resetInterp();   // 读档是传送：插值状态归位
                    alert('读档成功！');""",
"""                    resetInterp();   // 读档是传送：插值状态归位
                    setFuelRatio(rocket.fuel);   // 旧档的燃料比作用到各油箱
                    alert('读档成功！');""")

# 14) setShipDef：新船油箱明确满油
rep("""            destroyed = new Set();
            severed.clear();   // 新船没有已切断的分离器
            chuteStates = {};  // 新船的伞全部包好""",
"""            destroyed = new Set();
            severed.clear();   // 新船没有已切断的分离器
            chuteStates = {};  // 新船的伞全部包好
            for (const p of shipDef.parts) {
                const t = PART_TYPES[p.type];
                if (t && t.fuel > 0) p.fuel = t.fuel;   // 新船油箱满油
            }""")

io.open('js/main.js', 'w', encoding='utf-8', newline='\n').write(s)
print('per-tank fuel refactor done')
