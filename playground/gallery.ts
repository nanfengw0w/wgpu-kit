/** 画廊页:精选宇宙卡片 + 本地收藏(localStorage)+ 链接导入。Shadertoy 模式的第一步(无后端)。 */
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

interface Card { name: string; url: string }

const CURATED: Card[] = [
  { name: '🧫 细胞宇宙', url: './index.html?p=cells&m=grid&n=66000&s=wgpu-kit' },
  { name: '🐍 蛇群宇宙', url: './index.html?p=snakes&m=grid&n=66000&s=ourob0ros' },
  { name: '🪐 轨道宇宙', url: './index.html?p=orbitals&m=grid&n=66000&s=kepler' },
  { name: '🦠 病毒宇宙', url: './index.html?p=viruses&m=grid&n=66000&s=phage' },
  { name: '🎲 随机宇宙(每次不同)', url: './index.html?p=random&m=grid&n=66000&s=meow' },
  { name: '🌊 图灵珊瑚', url: './life.html?sim=turing' },
  { name: '🍄 粘菌网络', url: './life.html?sim=physarum' },
  { name: '🐦 Boids 鸟群', url: './life.html?sim=boids' },
  { name: '🪼 软体触手', url: './life.html?sim=tentacles' },
];

function favList(): Card[] {
  return JSON.parse(localStorage.getItem('wgpu-kit-gallery') ?? '[]');
}

function saveFav(list: Card[]): void {
  localStorage.setItem('wgpu-kit-gallery', JSON.stringify(list.slice(0, 96)));
}

function cardEl(c: Card, opts: { deletable?: boolean } = {}): HTMLElement {
  const a = document.createElement(opts.deletable ? 'div' : 'a');
  if (!opts.deletable) (a as HTMLAnchorElement).href = c.url;
  a.className = 'card';
  const b = document.createElement('b');
  b.textContent = c.name;
  const s = document.createElement('span');
  s.textContent = c.url.replace('./', '');
  a.appendChild(b);
  a.appendChild(s);
  if (opts.deletable) {
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.onclick = (e) => {
      e.stopPropagation();
      saveFav(favList().filter((x) => x.url !== c.url));
      renderFav();
    };
    a.appendChild(del);
  }
  return a;
}

function renderFav(): void {
  const grid = document.getElementById('fav')!;
  grid.innerHTML = '';
  const list = favList();
  if (list.length === 0) {
    grid.innerHTML = '<span style="color:#6d7f9e">还没有收藏——回 playground 点 ⭐ 收藏,或粘贴别人分享的链接。</span>';
  }
  for (const c of list) grid.appendChild(cardEl(c, { deletable: true }));
  report('gallery-favs', true, `${list.length} 条`);
}

// 渲染精选
{
  const grid = document.getElementById('curated')!;
  for (const c of CURATED) grid.appendChild(cardEl(c));
  report('gallery-curated', true, `${CURATED.length} 张卡片`);
}

// 导入
document.getElementById('importBtn')!.onclick = () => {
  const input = document.getElementById('paste') as HTMLInputElement;
  const url = input.value.trim();
  if (!url) return;
  const ok = url.includes('index.html?') || url.includes('life.html?');
  if (!ok) { report('gallery-import-bad', false, url.slice(0, 60)); return; }
  const list = favList();
  list.unshift({ name: `导入 · ${new URL(url, location.href).searchParams.get('p') ?? 'demo'}`, url: new URL(url, location.href).href });
  saveFav(list);
  input.value = '';
  renderFav();
  report('gallery-import', true, '已加入收藏');
};

renderFav();
(window as unknown as { __done: boolean }).__done = true;

export {};
