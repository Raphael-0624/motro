(() => {
  if (globalThis.__motroInstalled) return;
  globalThis.__motroInstalled = true;
  let pointer;
  document.addEventListener('pointermove', (event) => { pointer = { x: event.clientX, y: event.clientY }; }, { passive: true });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'motro.scroll') return false;
    const x = pointer?.x ?? innerWidth / 2;
    const y = pointer?.y ?? innerHeight / 2;
    let element = document.elementFromPoint(x, y);
    let target = document.scrollingElement;
    while (element && element !== document.documentElement) {
      const style = getComputedStyle(element);
      const vertical = message.dy && /(auto|scroll|overlay)/.test(style.overflowY)
        && element.scrollHeight > element.clientHeight + 1
        && (message.dy > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : element.scrollTop > 0);
      const horizontal = message.dx && /(auto|scroll|overlay)/.test(style.overflowX)
        && element.scrollWidth > element.clientWidth + 1
        && (message.dx > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth - 1 : element.scrollLeft > 0);
      if (vertical || horizontal) { target = element; break; }
      element = element.parentElement;
    }
    target?.scrollBy({ left: message.dx, top: message.dy, behavior: 'instant' });
    respond({ ok: true });
    return false;
  });
})();
