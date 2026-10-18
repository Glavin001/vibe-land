#!/usr/bin/env python3
"""Compose verified local screenshots without browser file-loading races."""
import json,math,pathlib,sys
from PIL import Image,ImageDraw
folder=pathlib.Path(sys.argv[1]);names=json.loads(sys.argv[2]);heading=sys.argv[3]
w,h,gap=480,300,16;rows=math.ceil(len(names)/3)
sheet=Image.new('RGB',(3*w+4*gap,80+rows*(h+36+gap)), '#182d26');draw=ImageDraw.Draw(sheet)
draw.text((gap,20),heading,fill='#e4e8df')
for i,name in enumerate(names):
    file=folder/(name+'.png')
    if not file.exists():file=folder/(name+'.jpg')
    with Image.open(file) as source:
        source.load();im=source.convert('RGB');im.thumbnail((w,h))
    x=gap+(i%3)*(w+gap);y=70+(i//3)*(h+36+gap)
    sheet.paste(im,(x,y));draw.text((x,y+h+8),name,fill='#b7c7ba')
sheet.save(folder/'contact-sheet.png',optimize=True)
