/*
 * PulseShare — visualizador de imagens com zoom e arraste (sem dependências).
 * Usado pelo app (app.js) e pela extensão (popup.js). Arquivo duplicado: raiz,
 * android/app/src/main/assets/www/ e extension/ (ver CLAUDE.md §2).
 *
 *   PulseShareImageViewer.attach(stageEl, src)  -> controlador {zoomIn, zoomOut, reset, destroy}
 *       Monta a imagem com zoom/arraste dentro de um elemento já existente.
 *   PulseShareImageViewer.open({ src, title, meta, actions:[{label, onClick}], onClose })
 *       Abre em tela cheia (overlay próprio). close() / isOpen().
 *
 * Gestos: pinça (2 dedos), roda do mouse, duplo toque/clique (alterna zoom),
 * arrastar com 1 dedo/mouse quando ampliada. Teclas: Esc fecha, + / - / 0.
 */
(function () {
  'use strict';

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function attach(stage, src, opts) {
    opts = opts || {};
    stage.innerHTML = '';
    stage.style.position = stage.style.position || 'relative';
    stage.style.overflow = 'hidden';
    stage.style.touchAction = 'none';
    stage.style.userSelect = 'none';

    const img = document.createElement('img');
    img.alt = opts.alt || '';
    img.draggable = false;
    img.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;max-height:none;' +
      'will-change:transform;opacity:0;transition:opacity .15s;user-select:none;-webkit-user-drag:none;';
    stage.appendChild(img);

    let nw = 0, nh = 0;        // tamanho natural
    let fit = 1;               // escala que encaixa a imagem na tela
    let s = 1, x = 0, y = 0;   // escala e deslocamento atuais
    let animTimer = null;
    const pointers = new Map();
    let gesture = null;
    let lastTap = 0;
    let destroyed = false;

    function size() { return { w: stage.clientWidth || 1, h: stage.clientHeight || 1 }; }
    function maxScale() { return Math.max(fit * 8, 4); }

    function constrain() {
      const { w, h } = size();
      const cw = nw * s, ch = nh * s;
      x = cw <= w ? (w - cw) / 2 : clamp(x, w - cw, 0);
      y = ch <= h ? (h - ch) / 2 : clamp(y, h - ch, 0);
    }

    function apply(animated) {
      constrain();
      img.style.transition = animated ? 'opacity .15s, transform .2s ease-out' : 'opacity .15s';
      img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      stage.style.cursor = s > fit * 1.01 ? (gesture ? 'grabbing' : 'grab') : 'zoom-in';
      if (animated) {
        clearTimeout(animTimer);
        animTimer = setTimeout(() => { img.style.transition = 'opacity .15s'; }, 220);
      }
    }

    function zoomAt(newScale, px, py, animated) {
      newScale = clamp(newScale, fit, maxScale());
      // mantém o ponto (px,py) da tela parado durante o zoom
      x = px - (px - x) * (newScale / s);
      y = py - (py - y) * (newScale / s);
      s = newScale;
      apply(animated);
    }

    function reset(animated) {
      const { w, h } = size();
      if (!nw || !nh) return;
      fit = Math.min(w / nw, h / nh);
      s = fit;
      x = (w - nw * s) / 2;
      y = (h - nh * s) / 2;
      apply(animated);
    }

    function center() { const { w, h } = size(); return { cx: w / 2, cy: h / 2 }; }
    function zoomIn() { const { cx, cy } = center(); zoomAt(s * 1.6, cx, cy, true); }
    function zoomOut() { const { cx, cy } = center(); zoomAt(s / 1.6, cx, cy, true); }

    function localPoint(e) {
      const r = stage.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    }

    function onWheel(e) {
      e.preventDefault();
      const { px, py } = localPoint(e);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      zoomAt(s * factor, px, py, false);
    }

    function startGesture() {
      const pts = Array.from(pointers.values());
      if (pts.length >= 2) {
        const [a, b] = pts;
        gesture = {
          type: 'pinch',
          dist: Math.hypot(a.px - b.px, a.py - b.py) || 1,
          mx: (a.px + b.px) / 2,
          my: (a.py + b.py) / 2,
          s0: s, x0: x, y0: y
        };
      } else if (pts.length === 1) {
        gesture = { type: 'pan', px: pts[0].px, py: pts[0].py, x0: x, y0: y, moved: false };
      } else {
        gesture = null;
      }
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      try { stage.setPointerCapture(e.pointerId); } catch {}
      pointers.set(e.pointerId, localPoint(e));
      startGesture();
      apply(false);
    }

    function onPointerMove(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, localPoint(e));
      if (!gesture) return;
      const pts = Array.from(pointers.values());
      if (gesture.type === 'pinch' && pts.length >= 2) {
        const [a, b] = pts;
        const dist = Math.hypot(a.px - b.px, a.py - b.py) || 1;
        const mx = (a.px + b.px) / 2, my = (a.py + b.py) / 2;
        const ns = clamp(gesture.s0 * (dist / gesture.dist), fit * 0.85, maxScale());
        // zoom em torno do ponto médio inicial + arraste pelo deslocamento do ponto médio
        x = mx - (gesture.mx - gesture.x0) * (ns / gesture.s0);
        y = my - (gesture.my - gesture.y0) * (ns / gesture.s0);
        s = ns;
        img.style.transition = 'opacity .15s';
        img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      } else if (gesture.type === 'pan' && pts.length === 1) {
        const dx = pts[0].px - gesture.px, dy = pts[0].py - gesture.py;
        if (Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
        x = gesture.x0 + dx;
        y = gesture.y0 + dy;
        apply(false);
      }
    }

    function onPointerUp(e) {
      if (!pointers.has(e.pointerId)) return;
      const wasPan = gesture && gesture.type === 'pan' && !gesture.moved && pointers.size === 1;
      const pt = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (s < fit) { s = fit; }
      startGesture();
      apply(true);

      // Duplo toque / duplo clique alterna entre encaixado e ampliado
      if (wasPan && e.type === 'pointerup') {
        const now = Date.now();
        if (now - lastTap < 300) {
          lastTap = 0;
          if (s > fit * 1.05) reset(true);
          else zoomAt(fit * 2.5, pt.px, pt.py, true);
        } else {
          lastTap = now;
        }
      }
    }

    function onResize() { if (!destroyed) reset(false); }

    img.onload = () => {
      nw = img.naturalWidth || 1;
      nh = img.naturalHeight || 1;
      img.style.width = nw + 'px';
      img.style.height = nh + 'px';
      reset(false);
      img.style.opacity = '1';
    };
    img.onerror = () => {
      stage.innerHTML = '<div style="color:#94a3b8;font-size:12px;font-style:italic;position:absolute;inset:0;display:flex;align-items:center;justify-content:center">Não foi possível carregar a imagem.</div>';
    };
    img.src = src;

    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', onResize);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(onResize); ro.observe(stage); }

    return {
      zoomIn, zoomOut,
      reset: () => reset(true),
      isZoomed: () => s > fit * 1.01,
      destroy() {
        destroyed = true;
        stage.removeEventListener('wheel', onWheel);
        stage.removeEventListener('pointerdown', onPointerDown);
        stage.removeEventListener('pointermove', onPointerMove);
        stage.removeEventListener('pointerup', onPointerUp);
        stage.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('resize', onResize);
        if (ro) ro.disconnect();
        stage.innerHTML = '';
        stage.style.cursor = '';
      }
    };
  }

  // Barra flutuante − / ⟲ / + (estilos inline: não depende do Tailwind)
  function buildZoomBar(ctrl) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;left:50%;bottom:calc(14px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);' +
      'display:flex;gap:6px;padding:5px;border-radius:999px;background:rgba(15,23,42,.82);border:1px solid rgba(148,163,184,.25);z-index:2;';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = 'width:38px;height:38px;border-radius:999px;border:none;background:rgba(51,65,85,.9);color:#fff;' +
        'font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;';
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    bar.appendChild(mk('−', 'Diminuir zoom', () => ctrl.zoomOut()));
    bar.appendChild(mk('⟲', 'Ajustar à tela', () => ctrl.reset()));
    bar.appendChild(mk('+', 'Aumentar zoom', () => ctrl.zoomIn()));
    return bar;
  }

  let overlay = null;
  let overlayCtrl = null;
  let overlayOnClose = null;

  function onKey(e) {
    if (!overlay || !overlayCtrl) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === '+' || e.key === '=') overlayCtrl.zoomIn();
    else if (e.key === '-') overlayCtrl.zoomOut();
    else if (e.key === '0') overlayCtrl.reset();
  }

  function open(o) {
    o = o || {};
    close();
    overlay = document.createElement('div');
    overlay.className = 'ps-image-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(2,6,23,.97);display:flex;flex-direction:column;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:calc(8px + env(safe-area-inset-top, 0px)) 10px 8px;' +
      'background:rgba(15,23,42,.85);border-bottom:1px solid rgba(51,65,85,.6);flex-shrink:0;';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
    const t = document.createElement('span');
    t.textContent = o.title || 'Imagem';
    t.style.cssText = 'color:#fff;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    info.appendChild(t);
    if (o.meta) {
      const m = document.createElement('span');
      m.textContent = o.meta;
      m.style.cssText = 'color:#34d399;font-size:10px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      info.appendChild(m);
    }
    header.appendChild(info);
    (o.actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.style.cssText = 'padding:7px 11px;border-radius:10px;border:1px solid rgba(56,189,248,.4);background:rgba(14,165,233,.18);' +
        'color:#bae6fd;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;';
      b.addEventListener('click', (e) => { e.stopPropagation(); a.onClick && a.onClick(); });
      header.appendChild(b);
    });
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Fechar');
    x.style.cssText = 'width:36px;height:36px;border-radius:10px;border:none;background:rgba(51,65,85,.9);color:#fff;font-size:15px;font-weight:700;cursor:pointer;flex-shrink:0;';
    x.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    header.appendChild(x);

    const stage = document.createElement('div');
    stage.style.cssText = 'position:relative;flex:1;min-height:0;';

    overlay.appendChild(header);
    overlay.appendChild(stage);
    document.body.appendChild(overlay);

    overlayCtrl = attach(stage, o.src, { alt: o.title || '' });
    stage.appendChild(buildZoomBar(overlayCtrl));
    overlayOnClose = o.onClose || null;
    document.addEventListener('keydown', onKey, true);
    return overlayCtrl;
  }

  function close() {
    if (!overlay) return false;
    document.removeEventListener('keydown', onKey, true);
    if (overlayCtrl) overlayCtrl.destroy();
    overlay.remove();
    overlay = null;
    overlayCtrl = null;
    const cb = overlayOnClose;
    overlayOnClose = null;
    if (cb) { try { cb(); } catch {} }
    return true;
  }

  window.PulseShareImageViewer = {
    attach,
    buildZoomBar,
    open,
    close,
    isOpen: () => Boolean(overlay)
  };
})();
