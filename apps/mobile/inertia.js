const SAMPLE_WINDOW = 80;
const RELEASE_WINDOW = 70;
const MIN_SPEED = 0.4;
const MAX_SPEED = 1.8;
const GAIN = 0.5;
const DECAY = 140;
const MAX_DURATION = 600;
const STOP_SPEED = 0.035;

export class ScrollMomentum {
  active = false;
  samples = [];

  begin(time) {
    this.cancel();
    this.x = 0; this.y = 0;
    this.samples.push({ time, x: 0, y: 0 });
  }

  sample(dx, dy, time) {
    this.x += dx; this.y += dy;
    this.samples.push({ time, x: this.x, y: this.y });
    while (this.samples.length > 1 && this.samples[0].time < time - SAMPLE_WINDOW) this.samples.shift();
  }

  release(time) {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    this.samples = [];
    if (!first || !last || time - last.time > RELEASE_WINDOW || last.time - first.time < 12) return false;
    const vx = (last.x - first.x) / (last.time - first.time);
    const vy = (last.y - first.y) / (last.time - first.time);
    const speed = Math.hypot(vx, vy);
    if (speed < MIN_SPEED) return false;
    const scale = Math.min(GAIN, MAX_SPEED / speed);
    this.vx = vx * scale; this.vy = vy * scale;
    this.start = time; this.elapsed = 0; this.lastTime = time;
    this.active = true;
    return true;
  }

  step(time) {
    if (!this.active) return null;
    if (time - this.lastTime > 100) { this.cancel(); return null; }
    const elapsed = Math.max(this.elapsed, Math.min(time - this.start, MAX_DURATION));
    // Integrate exponential decay rather than multiplying by frame count.
    const distance = DECAY * (Math.exp(-this.elapsed / DECAY) - Math.exp(-elapsed / DECAY));
    const delta = { dx: this.vx * distance, dy: this.vy * distance };
    this.elapsed = elapsed; this.lastTime = time;
    if (elapsed >= MAX_DURATION || Math.hypot(this.vx, this.vy) * Math.exp(-elapsed / DECAY) < STOP_SPEED) this.active = false;
    return delta;
  }

  cancel() {
    this.active = false;
    this.samples = [];
  }
}
