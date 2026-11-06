export class NativeWheel {
  #api;
  #target = null;
  #queue = Promise.resolve();
  #generation = 0;
  #blocked = false;

  constructor(api) {
    this.#api = api;
    api.onDetach.addListener((source) => {
      if (source.tabId !== this.#target?.tabId) return;
      this.#target = null;
      this.#blocked = true;
      this.#generation++;
    });
  }

  #enqueue(operation) {
    const task = this.#queue.then(operation);
    this.#queue = task.catch(() => {});
    return task;
  }

  async #detach() {
    const target = this.#target;
    this.#target = null;
    if (target) await this.#api.detach(target).catch(() => {});
  }

  release() {
    this.#generation++;
    this.#blocked = false;
    return this.#enqueue(() => this.#detach());
  }

  scroll(tabId, dx, dy, isActive) {
    const generation = this.#generation;
    return this.#enqueue(async () => {
      const active = () => generation === this.#generation && isActive();
      if (!active()) return;
      if (this.#blocked) throw new Error('请结束连接后重新启动；调试连接已关闭，并请关闭该网页的开发者工具。');
      if (this.#target?.tabId !== tabId) {
        await this.#detach();
        if (!active()) return;
        const target = { tabId };
        try { await this.#api.attach(target, '1.3'); }
        catch { throw new Error('请关闭该网页的开发者工具或其他调试插件后重试，当前无法模拟滚轮。'); }
        this.#target = target;
      }
      if (!active()) { await this.#detach(); return; }
      const target = this.#target;
      const { result } = await this.#api.sendCommand(target, 'Runtime.evaluate', {
        expression: '({ x: innerWidth / 2, y: innerHeight / 2 })', returnByValue: true,
      });
      const { x, y } = result?.value || {};
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('请刷新网页后重试，当前无法获取网页中心位置。');
      if (!active()) return;
      // Native input reaches canvas wheel handlers with isTrusted=true, unlike dispatchEvent.
      await this.#api.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      if (!active()) return;
      await this.#api.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy,
      });
    });
  }
}
