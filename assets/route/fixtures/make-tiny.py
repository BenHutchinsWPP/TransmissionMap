"""Writes the COG fixtures cog-read.test.ts reads (run: venv/bin/python make-tiny.py).

tiny.tif:  3-band uint8 1000x700, EPSG:5070, DEFLATE, pixel-interleaved, 512 tiles;
           band k = (x*7 + y*13 + k*31) % 256, except tile (1,1) which is all zero.
predictor2.tif / none.tif: 64x64 variants (128 tiles) (PREDICTOR=2 / COMPRESS=NONE).
"""
import os
import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()

here = os.path.dirname(os.path.abspath(__file__))
COMMON = ["INTERLEAVE=PIXEL", "BIGTIFF=NO", "OVERVIEWS=NONE"]


def write(name, w, h, opts, block=512, zero_block=False):
    y, x = np.mgrid[0:h, 0:w]
    mem = gdal.GetDriverByName("MEM").Create("", w, h, 3, gdal.GDT_Byte)
    mem.SetGeoTransform((-2000000.0, 250.0, 0, 3000000.0, 0, -250.0))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(5070)
    mem.SetProjection(srs.ExportToWkt())
    for k in range(3):
        a = ((x * 7 + y * 13 + (k + 1) * 31) % 256).astype(np.uint8)
        if zero_block:
            a[512:, 512:] = 0
        mem.GetRasterBand(k + 1).WriteArray(a)
    out = os.path.join(here, name)
    if os.path.exists(out):
        os.remove(out)
    gdal.Translate(out, mem, format="COG", creationOptions=COMMON + opts + [f"BLOCKSIZE={block}"])


write("tiny.tif", 1000, 700, ["COMPRESS=DEFLATE", "PREDICTOR=NO", "SPARSE_OK=TRUE"], zero_block=True)
write("predictor2.tif", 64, 64, ["COMPRESS=DEFLATE", "PREDICTOR=2"], block=128)
write("none.tif", 64, 64, ["COMPRESS=NONE"], block=128)
