// Contact sheet composition, done in the browser (no native image libraries needed).
export async function contactSheet(page: any, dataUrls: string[], labels: string[], cols: number, cellW: number): Promise<string> {
  return page.evaluate(async ([urls, labels, cols, cellW]: [string[], string[], number, number]) => {
    const imgs = await Promise.all(urls.map((u) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = u; })));
    const cellH = Math.round((cellW * 16) / 9);
    const rows = Math.ceil(imgs.length / cols);
    const c = document.createElement('canvas'); c.width = cols * (cellW + 6) + 6; c.height = rows * (cellH + 26) + 6;
    const g = c.getContext('2d')!;
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    imgs.forEach((im, k) => {
      const x = 6 + (k % cols) * (cellW + 6), y = 6 + Math.floor(k / cols) * (cellH + 26);
      g.drawImage(im, x, y, cellW, cellH);
      g.fillStyle = '#fff'; g.font = '16px monospace'; g.fillText(labels[k] ?? '', x + 4, y + cellH + 18);
    });
    return c.toDataURL('image/png');
  }, [dataUrls, labels, cols, cellW]);
}
