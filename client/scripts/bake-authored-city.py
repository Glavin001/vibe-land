#!/usr/bin/env python3
"""Append deterministic limestone, slate and timber layers without reindexing legacy layers.

Called after build-city-textures.py; can also run alone against committed base
sheets. These original procedural surfaces need no downloads or external assets.
"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BASE_LAYERS = 12


def surface(kind, size):
    y, x = np.mgrid[:size, :size].astype(float) / size
    rng = np.random.default_rng(731 + kind)
    grain = rng.normal(0, 1.4, (size, size))
    row = np.floor(y * (8 if kind == 1 else 6))
    xx = (x * (5 if kind == 1 else 3) + (row % 2) * 0.5) % 1
    yy = (y * (8 if kind == 1 else 6)) % 1
    joint = (xx < 0.018) | (yy < 0.025)
    variation = 3*np.sin(x*61 + row*4) + 2*np.cos(y*87-x*5)
    if kind == 0:
        rgb = np.stack([233+variation+grain, 226+variation+grain, 211+variation+grain], -1)
        rgb[joint] *= 0.77
        height = np.where(joint, 0.22, 0.75) + grain*0.005
    elif kind == 1:
        rgb = np.stack([75+variation+grain, 82+variation+grain, 88+variation+grain], -1)
        rgb[joint] *= 0.55
        height = np.where(joint, 0.2, 0.5+yy*0.3)
    else:
        grain += 4*np.sin(x*440 + 5*np.sin(y*13))
        rgb = np.stack([133+grain, 98+grain, 63+grain], -1)
        height = 0.6+grain*0.008
    albedo = np.concatenate([np.clip(rgb,0,255), (128+127*np.clip(height,0,1))[...,None]], -1).astype('uint8')
    # Periodic finite differences keep normal detail continuous at tile edges.
    dx=(np.roll(height,-1,1)-np.roll(height,1,1))*0.5
    dy=(np.roll(height,-1,0)-np.roll(height,1,0))*0.5
    normal=np.stack([-dx*2,-dy*2,np.ones_like(dx)],-1)
    normal/=np.linalg.norm(normal,axis=-1,keepdims=True)
    packed=np.stack([127.5+normal[...,0]*127.5,127.5+normal[...,1]*127.5,np.full_like(dx,225),235+20*height],-1)
    return albedo, np.clip(packed,0,255).astype('uint8')


def main():
    directory=ROOT/'public/textures/city'
    a=np.asarray(Image.open(directory/'city-albedo.webp').convert('RGBA'))[:BASE_LAYERS*1024].copy()
    s=np.asarray(Image.open(directory/'city-surface.webp').convert('RGBA'))[:BASE_LAYERS*512].copy()
    meta=ROOT/'src/scene/cityTextureSets.generated.ts'
    text=meta.read_text()
    lines=[line for line in text.splitlines() if "role: 'authored'" not in line]
    text='\n'.join(lines)+'\n'
    text=text.replace("'wall' | 'floor' | 'ground'", "'wall' | 'floor' | 'ground' | 'authored'")
    rows=[]
    for kind,key in enumerate(['white-limestone','roof-slate','aged-timber']):
        albedo,_=surface(kind,1024)
        _,packed=surface(kind,512)
        a=np.concatenate([a,albedo]); s=np.concatenate([s,packed])
        srgb=albedo[...,:3].astype(float)/255
        mean=np.where(srgb<=.04045,srgb/12.92,((srgb+.055)/1.055)**2.4).mean(axis=(0,1))
        rows.append("  { slug: '%s', role: 'authored', metresPerTile: 3.000, directional: true, materialKey: '%s', meanLinear: [%s] },"%(key,key,', '.join(f'{v:.4f}' for v in mean)))
    text=text.replace('\n];','\n'+'\n'.join(rows)+'\n];')
    # Lossless avoids accumulating changes to base layers on repeated bakes.
    Image.fromarray(a).save(directory/'city-albedo.webp',lossless=True,method=6)
    Image.fromarray(s).save(directory/'city-surface.webp',lossless=True,method=6)
    meta.write_text(text)
    print('Baked 3 authored layers; legacy indices 0–11 preserved.')


if __name__=='__main__':
    main()
