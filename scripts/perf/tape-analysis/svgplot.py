"""Minimal dependency-free SVG charts (no matplotlib on this machine)."""
import math

PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#4b5563', '#ca8a04']


def _nice(lo, hi, n=5):
    if hi <= lo:
        hi = lo + 1
    span = hi - lo
    step = 10 ** math.floor(math.log10(span / n))
    for m in (1, 2, 2.5, 5, 10):
        if span / (step * m) <= n:
            step *= m
            break
    start = math.floor(lo / step) * step
    ticks = []
    v = start
    while v <= hi + step * 1e-9:
        if v >= lo - step * 1e-9:
            ticks.append(round(v, 10))
        v += step
    return ticks


class Panel:
    def __init__(self, title, ylabel, ymin=None, ymax=None, height=200, log=False):
        self.title, self.ylabel, self.ymin, self.ymax, self.height, self.log = title, ylabel, ymin, ymax, height, log
        self.series = []  # (kind, xs, ys, color, label, extra)
        self.vlines = []  # (x, color, label)
        self.hlines = []

    def line(self, xs, ys, label, color=None, width=1.2):
        self.series.append(('line', xs, ys, color, label, width))
        return self

    def scatter(self, xs, ys, label, color=None, r=1.3):
        self.series.append(('scatter', xs, ys, color, label, r))
        return self

    def step(self, xs, ys, label, color=None, width=1.2):
        self.series.append(('step', xs, ys, color, label, width))
        return self

    def vline(self, x, color='#999', label=None):
        self.vlines.append((x, color, label))
        return self

    def hline(self, y, color='#999', label=None):
        self.hlines.append((y, color, label))
        return self


def render(panels, path, xlabel, xmin=None, xmax=None, width=1100, title=None, xs_are_shared=True):
    ml, mr, mt, gap = 70, 20, 40 if title else 16, 46
    total_h = mt + sum(p.height + gap for p in panels) + 10
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{total_h}" font-family="Helvetica,Arial,sans-serif" font-size="11">',
           f'<rect width="100%" height="100%" fill="white"/>']
    if title:
        out.append(f'<text x="{ml}" y="22" font-size="15" font-weight="bold">{_esc(title)}</text>')
    allx = [x for p in panels for s in p.series for x in s[1]]
    x0 = xmin if xmin is not None else (min(allx) if allx else 0)
    x1 = xmax if xmax is not None else (max(allx) if allx else 1)
    pw = width - ml - mr
    y = mt
    for p in panels:
        ys = [v for s in p.series for v in s[2] if v is not None and not (isinstance(v, float) and math.isnan(v))]
        lo = p.ymin if p.ymin is not None else (min(ys) if ys else 0)
        hi = p.ymax if p.ymax is not None else (max(ys) if ys else 1)
        if p.log:
            lo, hi = math.log10(max(lo, 1e-3)), math.log10(max(hi, 1e-3))
        if hi <= lo:
            hi = lo + 1
        ph = p.height

        def X(v):
            return ml + (v - x0) / (x1 - x0) * pw

        def Y(v):
            if p.log:
                v = math.log10(max(v, 1e-3))
            v = min(max(v, lo), hi)
            return y + ph - (v - lo) / (hi - lo) * ph

        out.append(f'<text x="{ml}" y="{y - 6}" font-weight="bold" font-size="12">{_esc(p.title)}</text>')
        out.append(f'<rect x="{ml}" y="{y}" width="{pw}" height="{ph}" fill="none" stroke="#bbb"/>')
        yt = _nice(lo, hi) if not p.log else list(range(math.floor(lo), math.ceil(hi) + 1))
        for t in yt:
            yy = y + ph - (t - lo) / (hi - lo) * ph
            if yy < y - 0.5 or yy > y + ph + 0.5:
                continue
            lab = f'{10 ** t:g}' if p.log else f'{t:g}'
            out.append(f'<line x1="{ml}" x2="{ml + pw}" y1="{yy:.1f}" y2="{yy:.1f}" stroke="#eee"/>')
            out.append(f'<text x="{ml - 4}" y="{yy + 3:.1f}" text-anchor="end" fill="#555">{lab}</text>')
        for t in _nice(x0, x1, 12):
            xx = X(t)
            out.append(f'<line x1="{xx:.1f}" x2="{xx:.1f}" y1="{y}" y2="{y + ph}" stroke="#f3f3f3"/>')
            out.append(f'<text x="{xx:.1f}" y="{y + ph + 12}" text-anchor="middle" fill="#555">{t:g}</text>')
        out.append(f'<text transform="translate({16},{y + ph / 2}) rotate(-90)" text-anchor="middle" fill="#333">{_esc(p.ylabel)}</text>')
        for (hv, col, lab) in p.hlines:
            yy = Y(hv)
            out.append(f'<line x1="{ml}" x2="{ml + pw}" y1="{yy:.1f}" y2="{yy:.1f}" stroke="{col}" stroke-dasharray="4 3"/>')
            if lab:
                out.append(f'<text x="{ml + pw - 4}" y="{yy - 3:.1f}" text-anchor="end" fill="{col}">{_esc(lab)}</text>')
        for (vx, col, lab) in p.vlines:
            if vx < x0 or vx > x1:
                continue
            xx = X(vx)
            out.append(f'<line x1="{xx:.1f}" x2="{xx:.1f}" y1="{y}" y2="{y + ph}" stroke="{col}" stroke-width="0.8" stroke-dasharray="2 2"/>')
            if lab:
                out.append(f'<text x="{xx + 2:.1f}" y="{y + 10}" fill="{col}" font-size="9">{_esc(lab)}</text>')
        legend_x = ml + 6
        for i, (kind, xs, ys_, col, lab, extra) in enumerate(p.series):
            col = col or PALETTE[i % len(PALETTE)]
            pts = [(X(a), Y(b)) for a, b in zip(xs, ys_) if b is not None and x0 <= a <= x1]
            if kind == 'scatter':
                out.append(f'<g fill="{col}" fill-opacity="0.55">' + ''.join(f'<circle cx="{a:.1f}" cy="{b:.1f}" r="{extra}"/>' for a, b in pts) + '</g>')
            elif pts:
                if kind == 'step':
                    d = [f'M{pts[0][0]:.1f},{pts[0][1]:.1f}']
                    for (a, b), (pa, pb) in zip(pts[1:], pts[:-1]):
                        d.append(f'H{a:.1f}V{b:.1f}')
                    dstr = ''.join(d)
                else:
                    dstr = 'M' + 'L'.join(f'{a:.1f},{b:.1f}' for a, b in pts)
                out.append(f'<path d="{dstr}" fill="none" stroke="{col}" stroke-width="{extra}"/>')
            out.append(f'<rect x="{legend_x}" y="{y + 5}" width="10" height="3" fill="{col}"/>')
            out.append(f'<text x="{legend_x + 13}" y="{y + 10}" fill="#222">{_esc(lab)}</text>')
            legend_x += 20 + 6.2 * len(lab)
        y += ph + gap
    out.append(f'<text x="{ml + pw / 2}" y="{total_h - 4}" text-anchor="middle" fill="#333">{_esc(xlabel)}</text>')
    out.append('</svg>')
    with open(path, 'w') as f:
        f.write('\n'.join(out))


def scatter_chart(path, title, xs, ys, xlabel, ylabel, fit=None, width=560, height=360, groups=None):
    """Plain x/y scatter with an optional (slope, intercept) fit line."""
    ml, mr, mt, mb = 60, 20, 34, 40
    pw, ph = width - ml - mr, height - mt - mb
    x0, x1 = min(xs), max(xs)
    y0, y1 = 0, max(ys) * 1.05
    X = lambda v: ml + (v - x0) / ((x1 - x0) or 1) * pw
    Y = lambda v: mt + ph - (v - y0) / ((y1 - y0) or 1) * ph
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" font-family="Helvetica,Arial,sans-serif" font-size="11"><rect width="100%" height="100%" fill="white"/>',
           f'<text x="{ml}" y="20" font-size="13" font-weight="bold">{_esc(title)}</text>',
           f'<rect x="{ml}" y="{mt}" width="{pw}" height="{ph}" fill="none" stroke="#bbb"/>']
    for t in _nice(y0, y1):
        out.append(f'<line x1="{ml}" x2="{ml + pw}" y1="{Y(t):.1f}" y2="{Y(t):.1f}" stroke="#eee"/><text x="{ml - 4}" y="{Y(t) + 3:.1f}" text-anchor="end" fill="#555">{t:g}</text>')
    for t in _nice(x0, x1, 8):
        out.append(f'<text x="{X(t):.1f}" y="{mt + ph + 13}" text-anchor="middle" fill="#555">{t:g}</text>')
    cols = groups or [0] * len(xs)
    for a, b, g in zip(xs, ys, cols):
        out.append(f'<circle cx="{X(a):.1f}" cy="{Y(b):.1f}" r="3" fill="{PALETTE[g % len(PALETTE)]}" fill-opacity="0.6"/>')
    if fit:
        k, c = fit
        out.append(f'<line x1="{X(x0):.1f}" y1="{Y(k * x0 + c):.1f}" x2="{X(x1):.1f}" y2="{Y(k * x1 + c):.1f}" stroke="#dc2626" stroke-dasharray="5 3"/>')
    out.append(f'<text x="{ml + pw / 2}" y="{height - 6}" text-anchor="middle">{_esc(xlabel)}</text>')
    out.append(f'<text transform="translate(14,{mt + ph / 2}) rotate(-90)" text-anchor="middle">{_esc(ylabel)}</text></svg>')
    with open(path, 'w') as f:
        f.write('\n'.join(out))


def _esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
