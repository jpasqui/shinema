const frame = document.querySelector('iframe');
const stage = document.querySelector('.stage');
let option = 'marquee';
const descriptions = {
  marquee:
    '<b>Marquee</b> gives artwork room to breathe. Fewer titles are visible at once.',
  archive:
    '<b>Archive</b> makes a large collection easy to scan. Its warm, brighter surface feels less theatrical.',
  signal:
    '<b>Signal</b> keeps browsing in one predictable vertical path. Its split layout is less familiar and prioritizes speed over discovery.',
};
function scale() {
  const phone = document.querySelector('#device').value === 'phone';
  const width = phone ? 390 : 1600;
  frame.style.width = `${width}px`;
  frame.style.height = `${phone ? 844 : 900}px`;
  frame.style.transform = `scale(${stage.clientWidth / width})`;
}
function update() {
  const params = new URLSearchParams({ option });
  for (const name of ['view', 'device', 'state'])
    params.set(name, document.querySelector(`#${name}`).value);
  frame.src = `screen.html?${params}`;
  stage.classList.toggle('phone', params.get('device') === 'phone');
  document.querySelector('#open').href = frame.src;
  document.querySelector('#tradeoff').innerHTML = descriptions[option];
  scale();
}
document.querySelectorAll('[data-option]').forEach((button) =>
  button.addEventListener('click', () => {
    option = button.dataset.option;
    document
      .querySelectorAll('[data-option]')
      .forEach((item) =>
        item.setAttribute('aria-pressed', String(item === button)),
      );
    update();
  }),
);
document
  .querySelectorAll('select')
  .forEach((select) => select.addEventListener('change', update));
new ResizeObserver(scale).observe(stage);
scale();
