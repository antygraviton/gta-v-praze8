// PROTOTYPE HUD (Czech): health, interaction prompt, wanted stars, speed. No menu/minimap yet.
export default class UI {
  init(ctx) {
    this.ev = ctx.events;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;color:#fff;font:600 18px sans-serif;text-shadow:0 1px 3px #000';
    el.innerHTML = '<div id="h" style="position:absolute;left:16px;bottom:16px"></div>' +
      '<div id="w" style="position:absolute;right:16px;top:16px;color:#ffd33d"></div>' +
      '<div id="s" style="position:absolute;right:16px;bottom:16px"></div>' +
      '<div id="p" style="position:absolute;left:50%;bottom:20%;transform:translateX(-50%)"></div>' +
      '<div id="t" style="position:absolute;left:16px;top:16px;font-size:14px;opacity:.8">Klik = myš · WASD · Shift · Mezerník · F nastoupit/vystoupit</div>';
    document.body.appendChild(el); this.el = el;
    const q = (i) => el.querySelector('#' + i);
    this.offs = [
      this.ev.on('player:state', (s) => { q('h').textContent = `Zdraví: ${Math.round(s.health)}`; }),
      this.ev.on('wanted:changed', (n) => { q('w').textContent = '★'.repeat(n) + '☆'.repeat(5 - n); }),
      this.ev.on('ui:prompt', (p) => { q('p').textContent = p?.text ? `[${p.key ?? 'F'}] ${p.text}` : ''; }),
      this.ev.on('vehicle:telemetry', (t) => { q('s').textContent = t?.speedKmh != null ? `${Math.round(t.speedKmh)} km/h` : ''; }),
      this.ev.on('player:exitVehicle', () => { q('s').textContent = ''; }),
    ];
    q('w').textContent = '☆☆☆☆☆';
  }
  update() {}
  dispose() { this.offs?.forEach((o) => o()); this.el?.remove(); }
}
