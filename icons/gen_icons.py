#!/usr/bin/env python3
"""Gera todos os ícones do PulseShare a partir de um único desenho vetorial.

Uso (na raiz do projeto):  python3 icons/gen_icons.py
Requer Pillow (com suporte a WebP).

Desenho: quadrado arredondado com degradê vertical índigo (#4F46E5) → laranja
(#F97316) e um raio branco. Coordenadas em uma grade de 128×128.

Saídas:
  icons/icon.svg, icons/icon{16,32,48,128,192,512}.png  (web, extensão, portal)
  extension/icons/*                                      (cópia)
  android/app/src/main/res/drawable/ic_launcher_background.xml  (degradê)
  android/app/src/main/res/drawable/ic_launcher_foreground.xml  (raio, ícone adaptativo/temático)
  android/app/src/main/res/drawable/ic_stat_pulseshare.xml      (ícone pequeno das notificações)
  android/app/src/main/res/mipmap-*/ic_launcher{,_round}.webp   (Android 7.x)
"""
import math
import os
import shutil

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

TOP = (0x4F, 0x46, 0xE5)
BOTTOM = (0xF9, 0x73, 0x16)
CORNER = 28           # raio do canto do quadrado (grade 128)
BOLT_R = 1.5          # arredondamento dos cantos do raio

# Contorno do raio (sentido horário na tela), antes do arredondamento
BOLT = [
    (71.6, 13.5),     # topo (achatado)
    (80.1, 13.5),
    (68.2, 50.5),
    (98.0, 50.5),     # ponta da direita
    (51.1, 116.6),    # ponta de baixo
    (59.3, 70.0),
    (31.6, 70.0),     # ponta da esquerda
]


def inset_polygon(pts, r):
    """Desloca cada aresta r para dentro e intersecta as vizinhas."""
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    sign = 1 if area > 0 else -1
    lines = []
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        ln = math.hypot(dx, dy)
        nx, ny = -dy / ln * sign, dx / ln * sign  # normal para dentro
        lines.append(((x1 + nx * r, y1 + ny * r), (dx, dy)))
    out = []
    for i in range(n):
        (p, d), (q, e) = lines[i - 1], lines[i]
        den = d[0] * e[1] - d[1] * e[0]
        t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
        out.append((p[0] + d[0] * t, p[1] + d[1] * t))
    return out


BOLT_IN = inset_polygon(BOLT, BOLT_R)


def bolt_bbox():
    xs = [p[0] for p in BOLT_IN]
    ys = [p[1] for p in BOLT_IN]
    return min(xs) - BOLT_R, min(ys) - BOLT_R, max(xs) + BOLT_R, max(ys) + BOLT_R


def path_data(pts, fn):
    return 'M' + 'L'.join('%.2f,%.2f' % fn(x, y) for x, y in pts) + 'Z'


# ---------------------------------------------------------------- raster ----
def gradient(size):
    g = Image.new('RGBA', (size, size))
    px = g.load()
    for y in range(size):
        t = y / (size - 1)
        c = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
        for x in range(size):
            px[x, y] = c
    return g


def draw_bolt(draw, scale, ox=0.0, oy=0.0, fill=(255, 255, 255, 255)):
    pts = [(ox + x * scale, oy + y * scale) for x, y in BOLT_IN]
    draw.polygon(pts, fill=fill)
    w = BOLT_R * 2 * scale
    for i in range(len(pts)):
        draw.line([pts[i], pts[(i + 1) % len(pts)]], fill=fill, width=max(1, round(w)))
    rr = BOLT_R * scale
    for x, y in pts:
        draw.ellipse([x - rr, y - rr, x + rr, y + rr], fill=fill)


def render(size, shape='square', pad=0.0):
    """Ícone completo. shape: 'square' (cantos arredondados) ou 'circle'."""
    ss = 8
    big = size * ss
    inner = big * (1 - 2 * pad)
    off = big * pad
    scale = inner / 128.0
    mask = Image.new('L', (big, big), 0)
    md = ImageDraw.Draw(mask)
    if shape == 'circle':
        md.ellipse([off, off, off + inner - 1, off + inner - 1], fill=255)
    else:
        md.rounded_rectangle([off, off, off + inner - 1, off + inner - 1], radius=CORNER * scale, fill=255)
    bg = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    bg.paste(gradient(round(inner)).resize((round(inner), round(inner))), (round(off), round(off)))
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)
    if shape == 'circle':
        # o raio fica um pouco menor dentro do círculo
        k = 0.86
        draw_bolt(d, scale * k, off + inner * (1 - k) / 2, off + inner * (1 - k) / 2)
    else:
        draw_bolt(d, scale, off, off)
    return img.resize((size, size), Image.LANCZOS)


# ------------------------------------------------------------------- svg ----
def svg():
    p = path_data(BOLT_IN, lambda x, y: (x, y))
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#4F46E5"/><stop offset="1" stop-color="#F97316"/>'
        '</linearGradient></defs>'
        '<rect width="128" height="128" rx="%d" fill="url(#g)"/>'
        '<path d="%s" fill="#fff" stroke="#fff" stroke-width="%g" stroke-linejoin="round"/>'
        '</svg>\n' % (CORNER, p, BOLT_R * 2)
    )


# --------------------------------------------------------------- android ----
VECTOR_HEAD = ('<?xml version="1.0" encoding="utf-8"?>\n'
               '<!-- Gerado por icons/gen_icons.py — não edite à mão -->\n')


def android_background():
    # Camada de 108dp; só o centro (18..90) aparece pela máscara → degradê nesse trecho
    return VECTOR_HEAD + '''<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="54" android:startY="18"
                android:endX="54" android:endY="90"
                android:startColor="#FF4F46E5"
                android:endColor="#FFF97316" />
        </aapt:attr>
    </path>
</vector>
'''


def android_foreground():
    # Grade 128 → área visível de 72dp centrada na camada de 108dp
    s = 72 / 128.0
    p = path_data(BOLT_IN, lambda x, y: (18 + x * s, 18 + y * s))
    return VECTOR_HEAD + '''<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFFFF"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="%.2f"
        android:strokeLineJoin="round"
        android:pathData="%s" />
</vector>
''' % (BOLT_R * 2 * s, p)


def android_status_icon():
    # Ícone pequeno da notificação: só a silhueta do raio (o Android pinta de branco)
    x0, y0, x1, y1 = bolt_bbox()
    s = 21.0 / (y1 - y0)
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    p = path_data(BOLT_IN, lambda x, y: (12 + (x - cx) * s, 12 + (y - cy) * s))
    return VECTOR_HEAD + '''<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="%.2f"
        android:strokeLineJoin="round"
        android:pathData="%s" />
</vector>
''' % (BOLT_R * 2 * s, p)


def write(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def main():
    icons = os.path.join(ROOT, 'icons')
    write(os.path.join(icons, 'icon.svg'), svg())
    for size in (16, 32, 48, 128, 192, 512):
        render(size).save(os.path.join(icons, 'icon%d.png' % size), optimize=True)

    ext = os.path.join(ROOT, 'extension', 'icons')
    os.makedirs(ext, exist_ok=True)
    for name in os.listdir(icons):
        if name.endswith(('.png', '.svg')):
            shutil.copy(os.path.join(icons, name), ext)

    draw = os.path.join(RES, 'drawable')
    write(os.path.join(draw, 'ic_launcher_background.xml'), android_background())
    write(os.path.join(draw, 'ic_launcher_foreground.xml'), android_foreground())
    write(os.path.join(draw, 'ic_stat_pulseshare.xml'), android_status_icon())

    for dpi, size in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
        d = os.path.join(RES, 'mipmap-' + dpi)
        os.makedirs(d, exist_ok=True)
        render(size, 'square', pad=1 / 24).save(os.path.join(d, 'ic_launcher.webp'), 'WEBP', lossless=True)
        render(size, 'circle', pad=1 / 24).save(os.path.join(d, 'ic_launcher_round.webp'), 'WEBP', lossless=True)
    print('ícones gerados')


if __name__ == '__main__':
    main()
