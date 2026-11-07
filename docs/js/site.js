/* ============================================================
   MSP-2D 官网交互
   1) 首屏背景：一颗星球 + 绕它转的卫星 + 星空（纯 Canvas 手绘）
   2) 导航栏滚动变色
   3) 滚动进入动画
   ============================================================ */

(function () {
    'use strict';

    // ==================== 首屏画布 ====================
    const canvas = document.getElementById('hero-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        let W = 0, H = 0, DPR = 1;

        // 星球参数
        const planet = {
            x: 0, y: 0,       // 屏幕坐标（布局时算）
            r: 0,             // 屏幕半径
            rot: 0,           // 自转
        };

        // 星空：固定种子，确定性的（每次刷新一样）
        let stars = [];
        function seedRandom(s) {
            let x = s;
            return function () {
                x = (x * 1103515245 + 12345) & 0x7fffffff;
                return x / 0x7fffffff;
            };
        }
        function makeStars(n) {
            const rnd = seedRandom(20261101);
            const list = [];
            for (let i = 0; i < n; i++) {
                list.push({
                    x: rnd(),
                    y: rnd(),
                    r: 0.4 + rnd() * 1.3,
                    a: 0.15 + rnd() * 0.65,
                    tw: rnd() * Math.PI * 2,      // 闪烁相位
                    sp: 0.3 + rnd() * 1.2,        // 闪烁速度
                });
            }
            return list;
        }

        // 卫星（绕星球转的那个小点）
        const sat = {
            angle: 0,
            radius: 0,
            speed: 0.00022,     // 弧度/毫秒
        };

        function resize() {
            DPR = Math.min(window.devicePixelRatio || 1, 2);
            const host = canvas.parentElement;
            W = host.clientWidth || window.innerWidth;
            H = host.clientHeight || window.innerHeight;
            canvas.width = Math.floor(W * DPR);
            canvas.height = Math.floor(H * DPR);
            ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

            // 星球放在右下角，露出一部分 —— 让它像「脚下这颗星球」
            planet.r = Math.max(W, H) * 0.42;
            planet.x = W * 0.76;
            planet.y = H * 0.88;

            stars = makeStars(Math.min(320, Math.floor(W * H / 5200)));

            // 卫星轨道半径
            sat.radius = planet.r * 1.55;
        }

        // 画星空（带轻微闪烁）
        function drawStars(t) {
            for (const s of stars) {
                const x = s.x * W;
                const y = s.y * H;
                const tw = 0.65 + 0.35 * Math.sin(t * 0.001 * s.sp + s.tw);
                ctx.globalAlpha = s.a * tw;
                ctx.fillStyle = '#cfe0f5';
                ctx.fillRect(x, y, s.r, s.r);
            }
            ctx.globalAlpha = 1;
        }

        // 画星球
        function drawPlanet() {
            const { x, y, r } = planet;

            // 大气光晕（多层，越外越淡）
            for (let i = 5; i >= 1; i--) {
                const rr = r * (1 + i * 0.028);
                const g = ctx.createRadialGradient(x, y, r * 0.9, x, y, rr);
                g.addColorStop(0, 'rgba(74, 144, 217, 0.00)');
                g.addColorStop(0.55, 'rgba(74, 144, 217, ' + (0.055 * (6 - i) / 5) + ')');
                g.addColorStop(1, 'rgba(74, 144, 217, 0.00)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(x, y, rr, 0, Math.PI * 2);
                ctx.fill();
            }

            // 星球本体
            const bodyGrad = ctx.createRadialGradient(
                x - r * 0.35, y - r * 0.4, r * 0.15,
                x, y, r
            );
            bodyGrad.addColorStop(0, '#2a4a72');
            bodyGrad.addColorStop(0.5, '#16293f');
            bodyGrad.addColorStop(1, '#080d16');
            ctx.fillStyle = bodyGrad;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();

            // 边缘细亮线（大气层边界）
            ctx.strokeStyle = 'rgba(74, 144, 217, .34)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();

            // 经线（缓慢自转）：几条椭圆的弧，营造球体感
            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, r * 0.995, 0, Math.PI * 2);
            ctx.clip();
            ctx.strokeStyle = 'rgba(74, 144, 217, .10)';
            ctx.lineWidth = 1;
            for (let i = 0; i < 7; i++) {
                const phase = planet.rot + i * 0.9;
                const rx = Math.abs(Math.cos(phase)) * r;
                ctx.beginPath();
                ctx.ellipse(x, y, rx, r, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            // 纬线
            for (let i = -2; i <= 2; i++) {
                if (i === 0) continue;
                const yy = y + i * r * 0.28;
                const halfW = Math.sqrt(Math.max(0, r * r - (yy - y) * (yy - y)));
                ctx.beginPath();
                ctx.ellipse(x, yy, halfW, halfW * 0.16, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }

        // 画卫星和它的轨道
        function drawSatellite() {
            const cx = planet.x;
            const cy = planet.y;
            const orbitR = sat.radius;

            // 轨道线（虚线，只画露在屏幕内的部分）
            ctx.save();
            ctx.setLineDash([5, 9]);
            ctx.strokeStyle = 'rgba(255, 195, 92, .22)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            // 卫星位置
            const sx = cx + Math.cos(sat.angle) * orbitR;
            const sy = cy + Math.sin(sat.angle) * orbitR;

            // 尾迹：沿轨道往后画一小段，越远越淡
            const TRAIL = 26;
            for (let i = TRAIL; i > 0; i--) {
                const a = sat.angle - i * 0.014;
                const px = cx + Math.cos(a) * orbitR;
                const py = cy + Math.sin(a) * orbitR;
                const alpha = (1 - i / TRAIL) * 0.55;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#ffc35c';
                ctx.beginPath();
                ctx.arc(px, py, 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // 卫星本体
            ctx.fillStyle = '#ffc35c';
            ctx.shadowColor = 'rgba(255, 195, 92, .9)';
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(sx, sy, 2.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
        }

        let rafId = null;
        let lastT = 0;

        function frame(t) {
            rafId = requestAnimationFrame(frame);
            if (!lastT) lastT = t;
            const dt = Math.min(50, t - lastT);
            lastT = t;

            // 更新
            planet.rot += dt * 0.00006;
            sat.angle += sat.speed * dt;

            // 绘制
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#05070d';
            ctx.fillRect(0, 0, W, H);

            drawStars(t);
            drawSatellite();     // 轨道和卫星画在星球**后面**，被星球挡住一部分才真实
            drawPlanet();
        }

        window.addEventListener('resize', resize);
        resize();
        rafId = requestAnimationFrame(frame);

        // 页面不可见时暂停，省电
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            } else if (!rafId) {
                lastT = 0;
                rafId = requestAnimationFrame(frame);
            }
        });

        // 尊重「减少动态效果」偏好
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            // 只画一帧静态画面
            planet.rot = 0.6;
            sat.angle = -0.9;
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#05070d';
            ctx.fillRect(0, 0, W, H);
            drawStars(1000);
            drawSatellite();
            drawPlanet();
        }
    }

    // ==================== 导航栏滚动变色 ====================
    const nav = document.getElementById('topnav');
    if (nav) {
        const onScroll = function () {
            if (window.scrollY > 40) nav.classList.add('scrolled');
            else nav.classList.remove('scrolled');
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }

    // ==================== 滚动进入动画 ====================
    const revealTargets = document.querySelectorAll(
        '#about .about-text, #about .about-badges, .feat, .phys-card, .ctrl-item, .play-box, .team-box'
    );

    if ('IntersectionObserver' in window && revealTargets.length) {
        // 初始状态
        revealTargets.forEach(function (el) {
            el.style.opacity = '0';
            el.style.transform = 'translateY(14px)';
            el.style.transition = 'opacity .5s ease-out, transform .5s ease-out';
        });

        let idx = 0;
        const io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                const el = entry.target;
                // 同批次的元素错开一点点，看起来更自然
                const delay = (idx++ % 6) * 45;
                setTimeout(function () {
                    el.style.opacity = '1';
                    el.style.transform = 'translateY(0)';
                }, delay);
                io.unobserve(el);
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

        revealTargets.forEach(function (el) { io.observe(el); });
    }
})();
