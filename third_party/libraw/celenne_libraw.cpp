// Celenne Studio's bridge to LibRaw (built to WebAssembly by scripts/raw/build-libraw.ps1).
// LibRaw only unpacks the sensor data and reads the camera's metadata; Celenne develops the image
// itself (src/formats/rawDevelop.ts), the same way as its own DNG decoder.
//
// clr_decode returns a pointer to CLR_N doubles at the fixed indices below (read by
// src/formats/libraw.ts; keep both in sync). One file is open at a time; clr_free releases it.
#include "libraw/libraw.h"
#include <cstring>

enum {
  I_ERROR = 0, I_RAW_W, I_RAW_H, I_SPP, I_SAMPLES_PTR,
  I_TOP, I_LEFT, I_WIDTH, I_HEIGHT, I_FLIP,
  I_COLORS, I_PAT_ROWS, I_PAT_COLS, I_PAT /* 36 */,
  I_BLACK = I_PAT + 36, I_CBLACK /* 4 */, I_CB_ROWS = I_CBLACK + 4, I_CB_COLS, I_CB /* 36 */,
  I_MAXIMUM = I_CB + 36, I_CAM_MUL /* 4 */, I_PRE_MUL = I_CAM_MUL + 4, I_CAM_XYZ = I_PRE_MUL + 4 /* 12 */,
  I_CROP = I_CAM_XYZ + 12 /* 4 */, I_BASELINE_EXPOSURE = I_CROP + 4, I_PIXEL_ASPECT, I_IS_RGB,
  CLR_N
};

static libraw_data_t *g = nullptr;
static libraw_processed_image_t *mem = nullptr; // clr_reference's output
static double out[CLR_N];
static char strings[2][64];

extern "C" {

void clr_free() {
  if (mem) libraw_dcraw_clear_mem(mem);
  mem = nullptr;
  if (g) libraw_close(g);
  g = nullptr;
}

double *clr_decode(const unsigned char *buf, int len) {
  clr_free();
  std::memset(out, 0, sizeof(out));
  g = libraw_init(LIBRAW_OPTIONS_NO_DATAERR_CALLBACK);
  if (!g) { out[I_ERROR] = -1; return out; }
  int err = libraw_open_buffer(g, buf, (size_t)len);
  if (err == LIBRAW_SUCCESS) err = libraw_unpack(g);
  if (err != LIBRAW_SUCCESS) { out[I_ERROR] = err; return out; }

  libraw_rawdata_t &rd = g->rawdata;
  libraw_image_sizes_t &sz = g->sizes;
  libraw_colordata_t &co = g->color;
  out[I_RAW_W] = sz.raw_width;
  out[I_RAW_H] = sz.raw_height;
  if (rd.raw_image) { out[I_SPP] = 1; out[I_SAMPLES_PTR] = (double)(size_t)rd.raw_image; }
  else if (rd.color3_image) { out[I_SPP] = 3; out[I_SAMPLES_PTR] = (double)(size_t)rd.color3_image; }
  else if (rd.color4_image) { out[I_SPP] = 4; out[I_SAMPLES_PTR] = (double)(size_t)rd.color4_image; }
  else { out[I_ERROR] = -2; return out; } // floating-point or unsupported layout
  // Row pitch in samples must equal the width (LibRaw allocates rows contiguously).
  if (rd.raw_image && sz.raw_pitch != sz.raw_width * 2) { out[I_ERROR] = -3; return out; }

  out[I_TOP] = sz.top_margin;
  out[I_LEFT] = sz.left_margin;
  out[I_WIDTH] = sz.width;
  out[I_HEIGHT] = sz.height;
  out[I_FLIP] = sz.flip;
  out[I_PIXEL_ASPECT] = sz.pixel_aspect;
  out[I_COLORS] = g->idata.colors;
  out[I_IS_RGB] = std::strncmp(g->idata.cdesc, "RGB", 3) == 0 ? 1 : 0;

  // LibRaw's colour index of each photosite (0 = R, 1 = G, 2 = B, 3 = second green, which can have
  // its own black level), relative to the visible area's top-left corner. 6 × 6 covers Bayer
  // (2 × 2) and X-Trans.
  const bool xtrans = g->idata.filters == 9;
  const int pr = xtrans ? 6 : 2, pc = xtrans ? 6 : 2;
  out[I_PAT_ROWS] = rd.raw_image ? pr : 0;
  out[I_PAT_COLS] = rd.raw_image ? pc : 0;
  if (rd.raw_image)
    for (int r = 0; r < pr; r++)
      for (int c = 0; c < pc; c++) {
        out[I_PAT + r * pc + c] = libraw_COLOR(g, r, c);
      }

  // Black levels: common + per channel + repeating pattern (relative to the visible area).
  out[I_BLACK] = co.black;
  for (int i = 0; i < 4; i++) out[I_CBLACK + i] = co.cblack[i];
  int cbr = co.cblack[4], cbc = co.cblack[5];
  if (cbr > 0 && cbc > 0 && cbr * cbc <= 36) {
    out[I_CB_ROWS] = cbr; out[I_CB_COLS] = cbc;
    for (int i = 0; i < cbr * cbc; i++) out[I_CB + i] = co.cblack[6 + i];
  }
  out[I_MAXIMUM] = co.maximum;
  for (int i = 0; i < 4; i++) { out[I_CAM_MUL + i] = co.cam_mul[i]; out[I_PRE_MUL + i] = co.pre_mul[i]; }
  for (int i = 0; i < 4; i++)
    for (int j = 0; j < 3; j++) out[I_CAM_XYZ + i * 3 + j] = co.cam_xyz[i][j];
  // Default crop inside the visible area (LibRaw's first inset crop), when the file has one.
  const libraw_raw_inset_crop_t &ic = sz.raw_inset_crops[0];
  if (ic.cwidth > 0 && ic.cheight > 0 && ic.cleft != 0xffff && ic.ctop != 0xffff) {
    out[I_CROP] = ic.cleft; out[I_CROP + 1] = ic.ctop; out[I_CROP + 2] = ic.cwidth; out[I_CROP + 3] = ic.cheight;
  }
  out[I_BASELINE_EXPOSURE] = co.dng_levels.baseline_exposure;
  std::strncpy(strings[0], g->idata.make, 63);
  std::strncpy(strings[1], g->idata.model, 63);
  return out;
}

const char *clr_string(int which) { return which == 0 ? strings[0] : strings[1]; }
const char *clr_version() { return libraw_version(); }

// For tests only: LibRaw's own development of the open file, as a reference for Celenne's
// (camera white balance and white level, no auto brightness, no highlight recovery, ProPhoto
// RGB, gamma 1.8, 16 bits). Returns [error, width, height, colors, bits, data pointer]; clr_free releases it.
static double processed[6];
double *clr_reference(int quality) {
  std::memset(processed, 0, sizeof(processed));
  if (!g) { processed[0] = -1; return processed; }
  if (mem) { libraw_dcraw_clear_mem(mem); mem = nullptr; }
  libraw_output_params_t &o = g->params;
  o.use_camera_wb = 1; o.no_auto_bright = 1; o.highlight = 0; o.output_color = 4; o.output_bps = 16;
  o.gamm[0] = 1 / 1.8; o.gamm[1] = 0; o.user_qual = quality;
  o.adjust_maximum_thr = 0; // the camera's white level, as Celenne (and Adobe) use
  int err = libraw_dcraw_process(g);
  if (err == LIBRAW_SUCCESS) mem = libraw_dcraw_make_mem_image(g, &err);
  if (err != LIBRAW_SUCCESS || !mem) { processed[0] = err ? err : -1; return processed; }
  processed[1] = mem->width; processed[2] = mem->height; processed[3] = mem->colors; processed[4] = mem->bits;
  processed[5] = (double)(size_t)mem->data;
  return processed;
}

}
