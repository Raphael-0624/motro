(() => {
  if (globalThis.__motroDomScrollInstalled) return;
  globalThis.__motroDomScrollInstalled = true;
  const fractional = { x: 0, y: 0 };

  function wholePixels(axis, delta) {
    // CSSOM scrollBy rounds per call; retain subpixels instead of drifting every frame.
    const total = fractional[axis] + delta;
    const whole = Math.trunc(total);
    fractional[axis] = total - whole;
    return whole;
  }

  function scrollAxis(start, axis, delta) {
    const root = document.scrollingElement;
    const position = axis === 'x' ? 'scrollLeft' : 'scrollTop';
    const overflow = axis === 'x' ? 'overflowX' : 'overflowY';
    const overscroll = axis === 'x' ? 'overscrollBehaviorX' : 'overscrollBehaviorY';
    let element = start || root;
    while (element && Math.abs(delta) > 0.01) {
      const style = getComputedStyle(element);
      if (element === root || /^(auto|scroll|overlay)$/.test(style[overflow])) {
        const before = element[position];
        element.scrollBy({ left: axis === 'x' ? delta : 0, top: axis === 'y' ? delta : 0, behavior: 'instant' });
        const remaining = delta - (element[position] - before);
        delta = Math.sign(remaining) === Math.sign(delta) ? remaining : 0;
        if (style[overscroll] === 'contain' || style[overscroll] === 'none') return;
      }
      if (element === root) return;
      element = element.parentElement || root;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'motro.scroll') return false;
    if (!Number.isFinite(message.dx) || !Number.isFinite(message.dy)) return false;
    // Resolve each axis afresh: a horizontal child must not capture vertical scrolling.
    const start = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (message.dx) scrollAxis(start, 'x', wholePixels('x', message.dx));
    if (message.dy) scrollAxis(start, 'y', wholePixels('y', message.dy));
    respond({ ok: true });
    return false;
  });
})();
