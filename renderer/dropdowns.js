'use strict';

/* 原生select仅保存值；可访问的自定义面板负责交互，动画只由用户展开时触发。 */
(() => {
  /** @brief 与工作台共用本地Lucide图标，不在下拉组件中手绘图形。 */
  const icon=name=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-'+name);svg.setAttribute('aria-hidden','true');svg.append(use);return svg;};
  const controls = new Map(); let current = null; let serial = 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  class Dropdown {
    constructor(source) {
      this.source = source; this.opened = false; this.optionKey = ''; this.active = 0; this.animation = null; this.typeBuffer = ''; this.typeTimer = null;
      const id = source.id || `select-${++serial}`; this.id = `dropdown-${id}`;
      this.host = document.createElement('span'); this.host.className = 'bouncy-select'; this.host.dataset.for = id;
      this.trigger = document.createElement('button'); this.trigger.type = 'button'; this.trigger.className = 'dropdown-trigger'; this.trigger.id = `${this.id}-trigger`;
      this.trigger.setAttribute('role', 'combobox'); this.trigger.setAttribute('aria-haspopup', 'listbox'); this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.setAttribute('aria-controls', `${this.id}-list`);
      this.label = document.createElement('span'); this.label.className = 'dropdown-label'; const arrow = icon('chevron-down'); arrow.setAttribute('class','dropdown-chevron'); arrow.setAttribute('aria-hidden', 'true'); this.trigger.append(this.label, arrow);
      this.panel = document.createElement('div'); this.panel.className = 'dropdown-panel'; this.panel.id = `${this.id}-list`; this.panel.setAttribute('role', 'listbox'); this.panel.hidden = true;
      this.host.append(this.trigger, this.panel); source.after(this.host); source.hidden = true; source.tabIndex = -1; source.setAttribute('aria-hidden', 'true');
      this.trigger.addEventListener('click', event => { event.preventDefault(); this.opened ? this.close() : this.open(); });
      this.trigger.addEventListener('keydown', event => this.keydown(event));
      this.panel.addEventListener('pointerdown', event => event.preventDefault());
      source.addEventListener('change', () => this.sync()); source.addEventListener('input', () => this.sync());
      this.observer = new MutationObserver(() => this.sync()); this.observer.observe(source, { childList: true, subtree: true, characterData: true, attributes: true });
      controls.set(source, this); this.sync();
    }
    options() { return [...this.source.options]; }
    sync() {
      const options = this.options(); const key = options.map(o => `${o.value}\0${o.text}\0${o.disabled}`).join('\n');
      if (key !== this.optionKey) {
        this.optionKey = key; this.panel.replaceChildren();
        options.forEach((o, index) => { const item = document.createElement('div'); item.className = 'dropdown-option'; item.id = `${this.id}-option-${index}`; item.setAttribute('role', 'option'); item.setAttribute('aria-disabled', String(o.disabled)); item.dataset.index = String(index);
          const content = document.createElement('span'); content.textContent = o.text; const tick = document.createElement('span'); tick.className = 'dropdown-tick'; tick.append(icon('check')); tick.setAttribute('aria-hidden', 'true'); item.append(content, tick);
          item.addEventListener('pointermove', () => { if (!o.disabled && this.active !== index) this.highlight(index, false); });
          item.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.commit(index); }); this.panel.append(item);
        });
      }
      this.trigger.disabled = this.source.disabled; this.trigger.setAttribute('aria-label', this.source.getAttribute('aria-label') || this.source.labels?.[0]?.textContent?.trim() || '选择选项');
      const selected = Math.max(0, this.source.selectedIndex); const value = options[selected]?.text || '请选择'; if (this.label.textContent !== value) this.label.textContent = value;
      this.panel.setAttribute('aria-label', this.trigger.getAttribute('aria-label'));
      [...this.panel.children].forEach((item, i) => { item.setAttribute('aria-selected', String(i === this.source.selectedIndex)); item.classList.toggle('selected', i === this.source.selectedIndex); });
      if (!this.opened) this.active = selected;
      else { this.active = Math.min(this.active, options.length - 1); this.highlight(this.active, false); this.position(); }
      if (this.source.disabled && this.opened) this.close();
    }
    position() {
      const rect = this.trigger.getBoundingClientRect(); const width = Math.max(rect.width, Math.min(340, Math.max(130, this.panel.scrollWidth)));
      const height = Math.min(280, this.panel.scrollHeight || this.options().length * 35 + 12); const below = innerHeight - rect.bottom;
      const top = below < height + 12 && rect.top > height + 12 ? rect.top - height - 6 : rect.bottom + 6;
      this.panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`; this.panel.style.top = `${Math.max(8, top)}px`; this.panel.style.minWidth = `${Math.min(width, innerWidth - 16)}px`;
      this.panel.style.maxHeight = `${Math.max(80, Math.min(280, innerHeight - top - 10))}px`;
    }
    open(index) {
      if (this.source.disabled || !this.options().length) return; if (current && current !== this) current.close(false);
      current = this; this.opened = true; this.animation?.cancel(); this.panel.hidden = false; this.host.classList.add('is-open'); this.trigger.setAttribute('aria-expanded', 'true');
      this.sync(); this.highlight(index ?? Math.max(0, this.source.selectedIndex), true); this.position();
      if (!reduced()) this.animation = this.panel.animate([
        { opacity: 0, transform: 'translateY(-6px) scale(.98)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ], { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' });
    }
    close(focus = false) {
      if (!this.opened) return; this.opened = false; if (current === this) current = null;
      this.host.classList.remove('is-open'); this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.removeAttribute('aria-activedescendant'); this.animation?.cancel();
      if (!reduced()) { this.animation = this.panel.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(-5px) scale(.97)' }], { duration: 150, easing: 'cubic-bezier(.16,1,.3,1)' }); this.animation.onfinish = () => { if (!this.opened) this.panel.hidden = true; }; }
      else this.panel.hidden = true;
      if (focus) this.trigger.focus();
    }
    highlight(index, scroll) {
      const options = this.options(); if (index < 0 || index >= options.length || options[index].disabled) return;
      this.active = index; [...this.panel.children].forEach((item, i) => item.classList.toggle('highlighted', i === index)); this.trigger.setAttribute('aria-activedescendant', `${this.id}-option-${index}`);
      if (scroll) this.panel.children[index]?.scrollIntoView({ block: 'nearest' });
    }
    move(delta) {
      const options = this.options(); let i = this.active;
      for (let k = 0; k < options.length; k++) { i = (i + delta + options.length) % options.length; if (!options[i].disabled) { this.highlight(i, true); return; } }
    }
    commit(index) {
      const option = this.options()[index]; if (!option || option.disabled) return;
      this.source.value = option.value; this.source.dispatchEvent(new Event('input', { bubbles: true })); this.source.dispatchEvent(new Event('change', { bubbles: true })); this.sync(); this.close(true);
      if (!reduced()) this.trigger.animate([{ transform: 'scale(.98)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    keydown(event) {
      const key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') { event.preventDefault(); if (!this.opened) this.open(); else this.move(key === 'ArrowDown' ? 1 : -1); }
      else if (key === 'Enter' || key === ' ') { event.preventDefault(); this.opened ? this.commit(this.active) : this.open(); }
      else if (key === 'Escape') { if (this.opened) { event.preventDefault(); event.stopPropagation(); this.close(true); } }
      else if (key === 'Tab') this.close();
      else if (key === 'Home' || key === 'End') { event.preventDefault(); if (!this.opened) this.open(); this.highlight(key === 'Home' ? 0 : this.options().length - 1, true); }
      else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { this.typeBuffer += key.toLowerCase(); clearTimeout(this.typeTimer); this.typeTimer = setTimeout(() => { this.typeBuffer = ''; }, 600); const i = this.options().findIndex(o => !o.disabled && o.text.toLowerCase().startsWith(this.typeBuffer)); if (i >= 0) { if (!this.opened) this.open(); this.highlight(i, true); } }
    }
  }
  function enhance() { document.querySelectorAll('select').forEach(source => { if (!controls.has(source)) new Dropdown(source); }); }
  enhance();
  document.addEventListener('pointerdown', event => { if (current && !current.host.contains(event.target)) current.close(); }, true);
  document.addEventListener('focusin', event => { if (current && !current.host.contains(event.target)) current.close(); });
  window.addEventListener('resize', () => current?.position()); document.addEventListener('scroll', event => { if (current && !current.panel.contains(event.target)) current.close(); }, true);
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => current?.close()));
  window.UwbDropdowns = Object.freeze({ closeAll() { current?.close(); }, refreshAll() { enhance(); for (const control of controls.values()) control.sync(); } });
})();
