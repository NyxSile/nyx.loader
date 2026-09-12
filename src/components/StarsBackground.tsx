import { useEffect, useRef } from "react";

export const StarsBackground = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const COUNT = 120;
    let W = 0;
    let H = 0;

    const COLORS = [
      "rgb(120, 80, 220)",
      "rgb(90, 60, 180)",
      "rgb(160, 100, 255)",
      "rgb(70, 40, 140)",
      "rgb(200, 170, 255)",
      "rgb(56, 189, 248)",
    ];

    interface Star {
      x: number;
      y: number;
      r: number;
      color: string;
      vx: number;
      vy: number;
      phase: number;
      speed: number;
      minA: number;
      maxA: number;
    }

    let stars: Star[] = [];

    const resize = () => {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    };

    const mkStar = (): Star => ({
      x: Math.random() * (W || window.innerWidth),
      y: Math.random() * (H || window.innerHeight),
      r: Math.random() * 1.3 + 0.3,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      vx: (Math.random() - 0.5) * 0.08,
      vy: -0.04 - Math.random() * 0.07,
      phase: Math.random() * Math.PI * 2,
      speed: 0.005 + Math.random() * 0.012,
      minA: 0.08 + Math.random() * 0.12,
      maxA: 0.55 + Math.random() * 0.45,
    });

    const isStatic = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let isWindowFocused = !document.hidden;
    let raf: number | null = null;

    resize();
    stars = Array.from({ length: COUNT }, mkStar);

    const draw = (shouldAnimate = true) => {
      ctx.clearRect(0, 0, W, H);
      const animateNow = shouldAnimate && isWindowFocused && !isStatic;

      for (const s of stars) {
        if (animateNow) {
          s.phase += s.speed;
          s.x += s.vx;
          s.y += s.vy;
          if (s.x < -10) s.x = W + 10;
          if (s.x > W + 10) s.x = -10;
          if (s.y < -10) s.y = H + 10;
          if (s.y > H + 10) s.y = -10;
        }
        const alpha =
          s.minA + (s.maxA - s.minA) * (0.5 + 0.5 * Math.sin(s.phase));
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
      }
      ctx.globalAlpha = 1.0;

      if (animateNow) {
        raf = requestAnimationFrame(() => draw(true));
      }
    };

    draw(true);

    const onFocus = () => {
      isWindowFocused = true;
      if (raf) cancelAnimationFrame(raf);
      draw(true);
    };

    const onBlur = () => {
      isWindowFocused = false;
      if (raf) cancelAnimationFrame(raf);
      draw(false);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        onBlur();
      } else {
        onFocus();
      }
    };

    let resizeTimer: any;
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf);
      resize();
      draw(false);
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        stars = Array.from({ length: COUNT }, mkStar);
        if (isWindowFocused && !isStatic) {
          onFocus();
        }
      }, 100);
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("resize", onResize);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      id="stars"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        width: "100%",
        height: "100%",
      }}
    />
  );
};
