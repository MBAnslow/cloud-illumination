import { useEffect } from "react";
import { periodContainsHour, periodLengthHours, useSimStore } from "../state";

/**
 * Headless component that advances the sky clock every animation frame.
 * Mount once at the app root so the Play button works on every route.
 */
export function SkyClockRuntime(): null {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dtMs = now - last;
      last = now;
      const state = useSimStore.getState();
      if (!state.sky.autoPlay) return;
      const hoursPerMs = 24 / (Math.max(1, state.sky.cycleSeconds) * 1000);
      const dh = dtMs * hoursPerMs;
      const cur = state.sky.timeHours;
      // The clock normally loops inside the active day period. Outside it
      // (user scrubbed freely) it advances across the full 24h without
      // snapping back.
      const period =
        state.dayCycle.periods.find(
          (p) => p.id === state.dayCycle.activePeriodId,
        ) ?? state.dayCycle.periods[0];
      if (!period || !periodContainsHour(period, cur)) {
        state.setSky({ timeHours: (((cur + dh) % 24) + 24) % 24 });
        return;
      }
      const distToEnd =
        period.endHour >= period.startHour
          ? period.endHour - cur
          : cur >= period.startHour
            ? 24 - cur + period.endHour
            : period.endHour - cur;
      if (dh < distToEnd) {
        let next = cur + dh;
        if (next >= 24) next -= 24;
        state.setSky({ timeHours: next });
      } else if (state.dayCycle.autoNext) {
        state.advancePeriod();
      } else {
        const overshoot = (dh - distToEnd) % periodLengthHours(period);
        let next = period.startHour + overshoot;
        if (next >= 24) next -= 24;
        state.setSky({ timeHours: next });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}
