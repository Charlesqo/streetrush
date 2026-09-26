import { VehicleSystem } from '/src/vehicle.js';

// Local-only review fixture. The game, track, renderer and HUD are production
// modules; only these comparison controls and the optional fault injection differ.
const style = document.createElement('style');
style.textContent = `
body.review-before .timing-board { background:linear-gradient(90deg,rgba(6,10,16,.58),transparent); }
body.review-before .timing-board::before { display:none; }
body.review-before .timing-board small { color:#858c98; text-shadow:inherit; }
#ui-review-tools { position:fixed;bottom:210px;right:18px;z-index:101;background:#101820ed;padding:8px; }
#ui-review-tools button { padding:8px;margin:3px;color:white;background:#283b48;border:1px solid #667b89;cursor:pointer; }
body.review-clean #ui-review-tools, body.review-clean #render-review { visibility:hidden; }
#ui-review-caption { position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:102;background:#101820d9;color:#fff;padding:6px 12px;font:12px sans-serif;pointer-events:none; }
`;
document.head.append(style);
const tools = document.createElement('aside');
tools.id = 'ui-review-tools';
const caption = document.createElement('div');
caption.id = 'ui-review-caption';
caption.textContent = '修改版 · 实机场景 / 固定机位';
const button = (label, action) => {
  const el = document.createElement('button'); el.textContent = label; el.onclick = action; tools.append(el);
};
button('原版计时 UI', () => {document.body.classList.add('review-before');caption.textContent='原版 · 实机场景 / 固定机位';});
button('修改版计时 UI', () => {document.body.classList.remove('review-before');caption.textContent='修改版 · 实机场景 / 固定机位';});
button('隐藏评审工具 V', () => document.body.classList.add('review-clean'));
button('模拟一次物理异常', () => {
  const original = VehicleSystem.prototype.fixedUpdateV24Active;
  VehicleSystem.prototype.fixedUpdateV24Active = function (...args) {
    VehicleSystem.prototype.fixedUpdateV24Active = original;
    const error = new Error('Synthetic UI recovery probe');
    error.code = 'V24_ACTIVE_STEP_ABORTED';
    throw error;
  };
});
document.body.append(tools,caption);
addEventListener('keydown', event => {
  if (event.code === 'KeyV') document.body.classList.toggle('review-clean');
  if (event.code === 'Digit1') tools.children[0].click();
  if (event.code === 'Digit2') tools.children[1].click();
});
