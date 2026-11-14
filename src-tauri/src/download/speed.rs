//! 下载速率的显示平滑。

/// 平滑下载速率显示：各下载链路原来直接上报"距上次推送的字节差 / 时间差"，
/// 小文件收尾、建连换源的空隙里就会在 0 和突发峰值之间反复横跳。
/// 这里做指数移动平均（EMA），停顿时向 0 衰减而不是直接归零或跳回全局平均。
#[derive(Debug, Clone)]
pub struct SpeedSmoother {
    smooth: f64,
}

impl SpeedSmoother {
    pub fn new() -> Self {
        Self { smooth: 0.0 }
    }

    /// 输入一次瞬时速率采样，返回平滑后的显示值。
    /// `elapsed_ms` 是该采样的统计窗口：窗口太小（<30ms，多为任务收尾时
    /// 被强制推送的一帧）时不更新，避免单帧尖峰把显示值顶飞。
    pub fn update(&mut self, instant_bps: u64, elapsed_ms: u64) -> u64 {
        if elapsed_ms >= 30 {
            let value = instant_bps as f64;
            if value > 0.0 {
                if self.smooth <= 0.0 {
                    self.smooth = value;
                } else {
                    self.smooth += (value - self.smooth) * 0.4;
                }
            } else {
                self.smooth *= 0.6;
                if self.smooth < 512.0 {
                    self.smooth = 0.0;
                }
            }
        }
        self.smooth as u64
    }

    pub fn current(&self) -> u64 {
        self.smooth as u64
    }
}

impl Default for SpeedSmoother {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_smoother_converges_without_jumping() {
        let mut smoother = SpeedSmoother::new();
        // 首个采样直接采用，避免从 0 爬升的迟滞。
        assert_eq!(smoother.update(10_000_000, 120), 10_000_000);
        // 同量级抖动只会小幅跟随，不会照单全收。
        let second = smoother.update(12_000_000, 120);
        assert!(second > 10_000_000 && second < 12_000_000, "second={second}");
        // 极小窗口的收尾帧不更新，避免单帧尖峰。
        let frozen = smoother.current();
        assert_eq!(smoother.update(90_000_000, 5), frozen);
        // 停顿逐次衰减而不是直接归零。
        let decayed = smoother.update(0, 2000);
        assert!(decayed > 0 && decayed < frozen, "decayed={decayed}");
        // 长时间停顿最终归零。
        for _ in 0..30 {
            smoother.update(0, 2000);
        }
        assert_eq!(smoother.current(), 0);
    }
}
