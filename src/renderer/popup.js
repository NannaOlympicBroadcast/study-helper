import { renderMarkdown } from './md.js';

const $ = (s) => document.querySelector(s);
let hideTimer = null;
let pinned = false;

function reportSize() {
  requestAnimationFrame(() => window.api.call('popup:resize', $('#card').scrollHeight + 2));
}

function show({ item, durationSec }) {
  pinned = false;
  $('#p-pin').style.opacity = 1;
  $('#p-mod').textContent = item.module.name;
  $('#p-title').textContent = item.entry.title;
  $('#p-title').title = item.entry.title;
  $('#p-body').innerHTML = renderMarkdown(item.entry.content || '');
  reportSize();
  clearTimeout(hideTimer);
  const bar = $('#p-bar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  if (durationSec > 0) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        bar.style.transition = `width ${durationSec}s linear`;
        bar.style.width = '0%';
      })
    );
    hideTimer = setTimeout(() => !pinned && window.api.call('popup:close'), durationSec * 1000);
  }
}

window.api.on('popup:entry', show);
$('#p-close').addEventListener('click', () => window.api.call('popup:close'));
$('#p-next').addEventListener('click', () => window.api.call('popup:next'));
$('#p-pin').addEventListener('click', () => {
  pinned = true;
  clearTimeout(hideTimer);
  const bar = $('#p-bar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  $('#p-pin').style.opacity = 0.4;
});
