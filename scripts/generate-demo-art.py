#!/usr/bin/env python3
"""
BajkoKreator — 4-Pass Painterly Watercolor Storybook Art Generator

Generates 11 cohesive 1024x1024 (~125-165 KB) progressive JPEG watercolor plates
for BajkoKreator's Demo Mode in public/demo-art/:
  - cover.jpg
  - page-01.jpg ... page-10.jpg

Pipeline:
  Pass 1: WebGL2 GLSL domain-warped 5-octave FBM wet-on-wet sky + atmospheric
          scatter + lifted clouds + cauliflower drying rims + pigment granulation
  Pass 2: Canvas2D recursive Tyler Hobbs deformPoly multi-layer watercolor glazes
          with wet-edge pooling, clustered organic foliage/cloud dabs, gnarled
          trunks, shimmering water surfaces, and 5-plane atmospheric depth
  Pass 3: Hand-tremored variable-pressure sepia dip-pen ink (#3A281C) architectural
          & botanical details + poetic small-scale back-view silhouettes + luminous
          gouache windows, lanterns, sunbeams, fireflies, and stars
  Pass 4: One-time 1024x1024 WebGL2 300gsm cold-press cotton paper multiply +
          subtle #FAF6EE storybook edge harmonization + Pillow adaptive progressive
          JPEG encoding (subsampling=0 preferred, strictly 115-175 KB).
"""

from __future__ import annotations

import base64
import io
import os
import sys
import time
from pathlib import Path
from typing import Tuple

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT_DIR / "public" / "demo-art"

SCENES = [
    "cover",
    "page-01",
    "page-02",
    "page-03",
    "page-04",
    "page-05",
    "page-06",
    "page-07",
    "page-08",
    "page-09",
    "page-10",
]

CHROME_EXECUTABLE = "/usr/bin/google-chrome"
CHROME_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
]

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>BajkoKreator Watercolor Atelier</title>
<style>
  html, body { margin: 0; padding: 0; background: #FAF6EE; overflow: hidden; }
  canvas { display: block; }
</style>
</head>
<body>
<canvas id="main" width="1024" height="1024"></canvas>
<script>
(() => {
  const W = 1024;
  const H = 1024;
  const mainCanvas = document.getElementById('main');
  const ctx = mainCanvas.getContext('2d', { willReadFrequently: false });

  // =========================================================================
  // Deterministic PRNG (Mulberry32) & Math Utilities
  // =========================================================================
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function randRange(rng, lo, hi) { return lo + (hi - lo) * rng(); }
  function gauss(rng) { return (rng() + rng() + rng() - 1.5) * 0.85; }

  // =========================================================================
  // Color Utilities (Hex <-> HSL)
  // =========================================================================
  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    const n = parseInt(clean, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hexToVec3(hex) {
    const [r, g, b] = hexToRgb(hex);
    return [r / 255, g / 255, b / 255];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }

  function hexToHsl(hex) {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHsl(r, g, b);
  }

  function hslaStr(h, s, l, a) {
    const hh = ((h % 360) + 360) % 360;
    return `hsla(${hh.toFixed(1)}, ${clamp(s, 0, 100).toFixed(1)}%, ${clamp(l, 0, 100).toFixed(1)}%, ${clamp(a, 0, 1).toFixed(4)})`;
  }

  function rgbaHex(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${clamp(a, 0, 1).toFixed(4)})`;
  }

  // =========================================================================
  // PASS 1 & PASS 4: WebGL2 Shaders (Wet-on-Wet Sky + 300gsm Cotton Paper)
  // =========================================================================
  function createGLContext(size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    return { canvas: c, gl };
  }

  function compileProgram(gl, vsSrc, fsSrc) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error('VS: ' + gl.getShaderInfoLog(vs));
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error('FS: ' + gl.getShaderInfoLog(fs));
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('LINK: ' + gl.getProgramInfoLog(prog));
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return prog;
  }

  const QUAD_VS = `#version 300 es
  in vec2 a_pos;
  out vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }`;

  const SKY_FS = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 outColor;

  uniform float u_seed;
  uniform vec3 u_skyTop;
  uniform vec3 u_skyMid;
  uniform vec3 u_skyHorizon;
  uniform vec2 u_sunPos;
  uniform vec3 u_sunColor;
  uniform float u_sunRadius;
  uniform float u_bloomStrength;
  uniform float u_cloudAmount;
  uniform vec3 u_cloudTint;
  uniform float u_horizonY;
  uniform float u_granulation;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21) + u_seed * 0.173);
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = rot * p * 2.02 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    // Flip Y so uv.y = 0 at top, 1 at bottom (matches Canvas2D)
    vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);

    // Domain-warped wet-on-wet watercolor wash
    vec2 q = vec2(
      fbm(uv * 2.4 + vec2(1.2, 3.4) + u_seed * 0.11),
      fbm(uv * 2.4 + vec2(5.7, 1.8) + u_seed * 0.07)
    );
    vec2 r = vec2(
      fbm(uv * 2.8 + 1.25 * q + vec2(8.3, 2.8)),
      fbm(uv * 2.8 + 1.25 * q + vec2(1.9, 6.2))
    );
    float wash = fbm(uv * 2.2 + 1.15 * r);

    // Three-stop vertical watercolor gradient with organic wash distortion
    float yNorm = clamp(uv.y / max(0.25, u_horizonY), 0.0, 1.0);
    float t = clamp(yNorm + (wash - 0.5) * 0.28, 0.0, 1.0);
    vec3 col;
    if (t < 0.55) {
      col = mix(u_skyTop, u_skyMid, smoothstep(0.0, 0.55, t));
    } else {
      col = mix(u_skyMid, u_skyHorizon, smoothstep(0.55, 1.0, t));
    }

    // Subtle secondary wet wash pooling variation
    float wash2 = fbm(uv * 4.1 - 0.7 * q + vec2(3.1, 7.4));
    col = mix(col, col * (0.93 + 0.14 * wash2), 0.45);

    // Wet-on-wet cauliflower / drying backrun rim
    float rim = smoothstep(0.43, 0.56, wash) - smoothstep(0.56, 0.71, wash);
    col -= vec3(0.048, 0.038, 0.028) * rim;

    // Atmospheric sun/moon scatter
    vec2 dSun = (uv - u_sunPos) * vec2(1.0, 1.12);
    float distSun = length(dSun);
    float scatter = exp(-distSun * u_sunRadius);
    float core = exp(-distSun * (u_sunRadius * 2.6));
    col = mix(col, u_sunColor, clamp(scatter * u_bloomStrength, 0.0, 0.85));
    col += u_sunColor * core * u_bloomStrength * 0.25;

    // Soft lifted watercolor clouds in upper sky
    if (u_cloudAmount > 0.01) {
      float cloudField = fbm(uv * vec2(2.1, 3.6) + 0.85 * q + vec2(2.3, 0.8));
      float cloudMask = smoothstep(0.50 - u_cloudAmount * 0.12, 0.78, cloudField);
      float skyBand = smoothstep(0.02, 0.16, uv.y) * (1.0 - smoothstep(u_horizonY * 0.55, u_horizonY * 0.96, uv.y));
      float lift = cloudMask * skyBand * u_cloudAmount;
      vec3 cloudLight = mix(vec3(0.995, 0.978, 0.942), u_sunColor, 0.22);
      float underside = smoothstep(0.44, 0.62, fbm(uv * vec2(2.1, 3.6) + 0.85 * q + vec2(2.3, 1.05)));
      vec3 cloudCol = mix(u_cloudTint, cloudLight, clamp(1.0 - underside * 0.45, 0.25, 1.0));
      col = mix(col, cloudCol, clamp(lift * 0.78, 0.0, 0.85));
    }

    // Mineral pigment granulation settling in wash valleys
    float g1 = noise(uv * 92.0 + r * 3.5);
    float g2 = noise(uv * 215.0 - q * 4.2);
    float gran = ((g1 * 0.6 + g2 * 0.4) - 0.5) * u_granulation * (0.65 + 0.7 * wash);
    col += vec3(gran * 0.95, gran * 0.92, gran * 0.88);

    // Below horizon gentle warm ground wash base
    if (uv.y > u_horizonY) {
      float below = smoothstep(u_horizonY, min(1.0, u_horizonY + 0.25), uv.y);
      col = mix(col, mix(u_skyHorizon, vec3(0.94, 0.90, 0.82), 0.4), below * 0.35);
    }

    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

  const PAPER_FS = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 outColor;

  float hash(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    vec2 uv = v_uv;
    // 3-frequency cold-press 300gsm dimple tooth
    float d1 = noise(uv * 105.0);
    float d2 = noise(uv * 225.0 + vec2(17.3, 9.1));
    float d3 = noise(uv * 450.0 + vec2(3.7, 29.4));
    float tooth = d1 * 0.45 + d2 * 0.35 + d3 * 0.20;

    // Subtle organic cotton rag fibers
    float fH = noise(vec2(uv.x * 42.0, uv.y * 340.0));
    float fV = noise(vec2(uv.x * 340.0, uv.y * 42.0));
    float fibers = (fH + fV) * 0.5;

    // Gentle large-scale paper unevenness
    float macro = noise(uv * 7.5);

    float v = 0.928 + tooth * 0.056 + fibers * 0.014 + (macro - 0.5) * 0.016;
    vec3 cotton = vec3(1.0, 0.992, 0.976) * clamp(v, 0.915, 1.0);
    outColor = vec4(cotton, 1.0);
  }`;

  // Persistent WebGL2 contexts
  const skyGL = createGLContext(512);
  const skyProg = compileProgram(skyGL.gl, QUAD_VS, SKY_FS);

  // One-time 1024x1024 cold-press cotton paper texture
  const paperGL = createGLContext(1024);
  const paperProg = compileProgram(paperGL.gl, QUAD_VS, PAPER_FS);
  paperGL.gl.viewport(0, 0, 1024, 1024);
  paperGL.gl.useProgram(paperProg);
  paperGL.gl.drawArrays(paperGL.gl.TRIANGLES, 0, 6);

  function renderSkyPass(cfg) {
    const gl = skyGL.gl;
    gl.viewport(0, 0, 512, 512);
    gl.useProgram(skyProg);
    const u = (name) => gl.getUniformLocation(skyProg, name);
    gl.uniform1f(u('u_seed'), cfg.seed);
    gl.uniform3fv(u('u_skyTop'), hexToVec3(cfg.skyTop));
    gl.uniform3fv(u('u_skyMid'), hexToVec3(cfg.skyMid));
    gl.uniform3fv(u('u_skyHorizon'), hexToVec3(cfg.skyHorizon));
    gl.uniform2f(u('u_sunPos'), cfg.sunPos[0], cfg.sunPos[1]);
    gl.uniform3fv(u('u_sunColor'), hexToVec3(cfg.sunColor));
    gl.uniform1f(u('u_sunRadius'), cfg.sunRadius ?? 2.8);
    gl.uniform1f(u('u_bloomStrength'), cfg.bloomStrength ?? 0.55);
    gl.uniform1f(u('u_cloudAmount'), cfg.cloudAmount ?? 0.5);
    gl.uniform3fv(u('u_cloudTint'), hexToVec3(cfg.cloudTint ?? '#DFC9BD'));
    gl.uniform1f(u('u_horizonY'), cfg.horizonY ?? 0.65);
    gl.uniform1f(u('u_granulation'), cfg.granulation ?? 0.055);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(skyGL.canvas, 0, 0, W, H);
    ctx.restore();
  }

  // =========================================================================
  // PASS 2: Painterly Watercolor Geometry & Brushwork Library
  // =========================================================================

  // Recursive midpoint displacement (Tyler Hobbs watercolor polygon deformation)
  function deformPoly(pts, rng, depth = 3, spread = 0.22) {
    let cur = pts;
    let s = spread;
    for (let d = 0; d < depth; d++) {
      const next = [];
      const n = cur.length;
      for (let i = 0; i < n; i++) {
        const p0 = cur[i];
        const p1 = cur[(i + 1) % n];
        next.push(p0);
        const dx = p1[0] - p0[0];
        const dy = p1[1] - p0[1];
        const len = Math.hypot(dx, dy);
        if (len > 1.5) {
          const nx = -dy / len;
          const ny = dx / len;
          const jitter = (rng() + rng() - 1.0) * s * len;
          const along = (rng() - 0.5) * 0.12;
          next.push([
            (p0[0] + p1[0]) * 0.5 + dx * along + nx * jitter,
            (p0[1] + p1[1]) * 0.5 + dy * along + ny * jitter,
          ]);
        }
      }
      cur = next;
      s *= 0.55;
    }
    return cur;
  }

  function tracePoly(pts) {
    if (pts.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
  }

  function makeOrganicOval(cx, cy, rx, ry, sides, rng, wobble = 0.22, rot = 0) {
    const pts = [];
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const rScale = 1 + (rng() - 0.5) * 2 * wobble;
      const lx = Math.cos(a) * rx * rScale;
      const ly = Math.sin(a) * ry * rScale;
      pts.push([cx + lx * cosR - ly * sinR, cy + lx * sinR + ly * cosR]);
    }
    return pts;
  }

  function makeOrganicRect(x, y, w, h, rng, jitter = 2.5) {
    const segsX = Math.max(2, Math.round(w / 45));
    const segsY = Math.max(2, Math.round(h / 45));
    const pts = [];
    for (let i = 0; i < segsX; i++) {
      pts.push([x + (i / segsX) * w + (rng() - 0.5) * jitter, y + (rng() - 0.5) * jitter]);
    }
    for (let i = 0; i < segsY; i++) {
      pts.push([x + w + (rng() - 0.5) * jitter, y + (i / segsY) * h + (rng() - 0.5) * jitter]);
    }
    for (let i = 0; i < segsX; i++) {
      pts.push([x + w - (i / segsX) * w + (rng() - 0.5) * jitter, y + h + (rng() - 0.5) * jitter]);
    }
    for (let i = 0; i < segsY; i++) {
      pts.push([x + (rng() - 0.5) * jitter, y + h - (i / segsY) * h + (rng() - 0.5) * jitter]);
    }
    return pts;
  }

  // Multi-layer translucent watercolor wash with wet-edge pooling & directional light
  function wcWash(basePts, opts, rng) {
    const {
      color,
      color2 = null,
      layers = 24,
      alpha = 0.055,
      depth = 3,
      spread = 0.20,
      wetEdge = true,
      edgeDarken = 10,
      lightAngle = -Math.PI * 0.35,
      highlightColor = null,
      highlightLayers = 0,
      composite = 'source-over',
    } = opts;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of basePts) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const span = Math.max(20, Math.hypot(maxX - minX, maxY - minY) * 0.55);
    const gx = Math.cos(lightAngle) * span;
    const gy = Math.sin(lightAngle) * span;

    const [h1, s1, l1] = hexToHsl(color);
    const [h2, s2, l2] = color2 ? hexToHsl(color2) : [h1 + 6, s1 * 0.94, clamp(l1 - 8, 5, 95)];

    ctx.save();
    ctx.globalCompositeOperation = composite;

    for (let i = 0; i < layers; i++) {
      const poly = deformPoly(basePts, rng, depth, spread * randRange(rng, 0.72, 1.28));
      const dh = (rng() - 0.5) * 7;
      const ds = (rng() - 0.5) * 9;
      const dl = (rng() - 0.5) * 7;
      const a = alpha * randRange(rng, 0.75, 1.25);

      const grad = ctx.createLinearGradient(cx - gx, cy - gy, cx + gx, cy + gy);
      grad.addColorStop(0, hslaStr(h1 + dh, s1 + ds, l1 + dl + 2, a));
      grad.addColorStop(1, hslaStr(h2 + dh, s2 + ds, l2 + dl - 2, a * 1.05));

      tracePoly(poly);
      ctx.fillStyle = grad;
      ctx.fill();

      // Dried pigment wet-edge pooling rim
      if (wetEdge && (i % 3 === 0)) {
        ctx.strokeStyle = hslaStr(h2 - 4 + dh * 0.5, s2 + 6, clamp(l2 - edgeDarken, 4, 92), a * 0.72);
        ctx.lineWidth = randRange(rng, 1.1, 2.4);
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }

    // Optional sunlit pigment lift / warm rim highlight
    if (highlightColor && highlightLayers > 0) {
      const [hh, hs, hl] = hexToHsl(highlightColor);
      const offX = Math.cos(lightAngle) * -Math.min(18, span * 0.08);
      const offY = Math.sin(lightAngle) * -Math.min(18, span * 0.08);
      const shifted = basePts.map(([px, py]) => [px + offX, py + offY]);
      for (let i = 0; i < highlightLayers; i++) {
        const poly = deformPoly(shifted, rng, Math.max(2, depth - 1), spread * 0.85);
        tracePoly(poly);
        ctx.fillStyle = hslaStr(hh + (rng() - 0.5) * 5, hs, hl + (rng() - 0.5) * 4, alpha * 0.85);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // Organic clustered foliage / bush / blossom dabs with 3-value light modeling
  function wcBrushDabCluster(cx, cy, rx, ry, palette, count, rng, opts = {}) {
    const {
      lightDir = [-0.6, -0.8], // vector pointing toward light
      dabMin = 8,
      dabMax = 26,
      alpha = 0.24,
      skyPeeps = true,
      subLobes = 4,
    } = opts;

    const lobes = [];
    for (let i = 0; i < subLobes; i++) {
      const a = (i / subLobes) * Math.PI * 2 + rng() * 0.9;
      const dist = randRange(rng, 0.12, 0.52);
      lobes.push([cx + Math.cos(a) * rx * dist, cy + Math.sin(a) * ry * dist, randRange(rng, 0.45, 0.78)]);
    }

    // Back shadow pass, midtone pass, sunlit crown rim pass
    const passes = [
      { key: 'shadow', frac: 0.36, bias: -0.25, aMul: 0.95 },
      { key: 'mid',    frac: 0.42, bias:  0.05, aMul: 0.90 },
      { key: 'light',  frac: 0.22, bias:  0.42, aMul: 0.85 },
    ];

    ctx.save();
    for (const pass of passes) {
      const n = Math.max(4, Math.round(count * pass.frac));
      const colors = palette[pass.key];
      for (let i = 0; i < n; i++) {
        const lobe = lobes[Math.floor(rng() * lobes.length)];
        const ox = gauss(rng) * rx * lobe[2] * 0.56 + lightDir[0] * rx * pass.bias * 0.48;
        const oy = gauss(rng) * ry * lobe[2] * 0.56 + lightDir[1] * ry * pass.bias * 0.48;
        const px = lobe[0] + ox;
        const py = lobe[1] + oy;

        // Leave delicate sky-peep openings near outer crown rim
        if (skyPeeps && pass.key !== 'light') {
          const nd = Math.hypot((px - cx) / rx, (py - cy) / ry);
          if (nd > 0.72 && rng() < 0.22) continue;
        }

        const r1 = randRange(rng, dabMin, dabMax) * (pass.key === 'light' ? 0.78 : 1.0);
        const r2 = r1 * randRange(rng, 0.55, 0.95);
        const rot = randRange(rng, 0, Math.PI);
        const raw = makeOrganicOval(px, py, r1, r2, 6, rng, 0.28, rot);
        const poly = deformPoly(raw, rng, 1, 0.20);
        const hex = colors[Math.floor(rng() * colors.length)];
        const [h, s, l] = hexToHsl(hex);
        const a = alpha * pass.aMul * randRange(rng, 0.65, 1.3);

        tracePoly(poly);
        ctx.fillStyle = hslaStr(h + (rng() - 0.5) * 8, s + (rng() - 0.5) * 8, l + (rng() - 0.5) * 6, a);
        ctx.fill();
        if (rng() < 0.28) {
          ctx.strokeStyle = hslaStr(h - 4, s + 5, clamp(l - 11, 5, 92), a * 0.55);
          ctx.lineWidth = 0.9;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  // Rolling horizon / midground watercolor hill band
  function wcHillBand(yBase, amp, freq, phase, colorTop, colorBot, rng, opts = {}) {
    const {
      steps = 28,
      layers = 20,
      alpha = 0.055,
      wetEdge = true,
      ridgeHighlight = null,
      bottomY = H + 40,
      spread = 0.14,
      depth = 2,
    } = opts;

    const ridge = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = lerp(-40, W + 40, t);
      const y =
        yBase +
        Math.sin(t * Math.PI * freq + phase) * amp +
        Math.sin(t * Math.PI * (freq * 2.1) + phase * 1.7) * (amp * 0.34) +
        Math.cos(t * Math.PI * (freq * 3.7) - phase) * (amp * 0.14);
      ridge.push([x, y]);
    }
    const poly = [...ridge, [W + 40, bottomY], [-40, bottomY]];
    wcWash(poly, {
      color: colorTop,
      color2: colorBot,
      layers,
      alpha,
      depth,
      spread,
      wetEdge,
      edgeDarken: 8,
      lightAngle: Math.PI * 0.5,
      highlightColor: ridgeHighlight,
      highlightLayers: ridgeHighlight ? 4 : 0,
    }, rng);
    return ridge;
  }

  // Painterly pillowy watercolor cumulus cloud
  function wcCloudPuff(cx, cy, w, h, lightHex, shadowHex, rng, alpha = 0.06) {
    const puffs = [
      [cx - w * 0.32, cy + h * 0.12, w * 0.28, h * 0.38],
      [cx - w * 0.12, cy - h * 0.12, w * 0.32, h * 0.48],
      [cx + w * 0.14, cy - h * 0.06, w * 0.30, h * 0.44],
      [cx + w * 0.34, cy + h * 0.14, w * 0.24, h * 0.34],
      [cx,            cy + h * 0.16, w * 0.44, h * 0.30],
    ];
    // Underside shadow first
    for (const [px, py, rx, ry] of puffs) {
      const base = makeOrganicOval(px, py + ry * 0.22, rx * 0.96, ry * 0.72, 9, rng, 0.20);
      wcWash(base, {
        color: shadowHex,
        color2: shadowHex,
        layers: 9,
        alpha: alpha * 0.75,
        depth: 2,
        spread: 0.22,
        wetEdge: false,
      }, rng);
    }
    // Sunlit billowing top
    for (const [px, py, rx, ry] of puffs) {
      const base = makeOrganicOval(px, py - ry * 0.06, rx, ry, 10, rng, 0.22);
      wcWash(base, {
        color: lightHex,
        color2: shadowHex,
        layers: 12,
        alpha: alpha,
        depth: 2,
        spread: 0.22,
        wetEdge: true,
        edgeDarken: 4,
        lightAngle: Math.PI * 0.48,
      }, rng);
    }
  }

  // Organic gnarled tree trunk & branches (layered bark watercolor + crevices)
  function wcTrunkSegment(x1, y1, x2, y2, w1, w2, litHex, shadowHex, rng, inkEdges = true) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const nx = -dy / len, ny = dx / len;
    const bend = (rng() - 0.5) * len * 0.16;
    const mx = (x1 + x2) * 0.5 + nx * bend;
    const my = (y1 + y2) * 0.5 + ny * bend;

    const steps = Math.max(4, Math.round(len / 22));
    const leftPts = [], rightPts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const omt = 1 - t;
      const cx = omt * omt * x1 + 2 * omt * t * mx + t * t * x2;
      const cy = omt * omt * y1 + 2 * omt * t * my + t * t * y2;
      const tx = 2 * omt * (mx - x1) + 2 * t * (x2 - mx);
      const ty = 2 * omt * (my - y1) + 2 * t * (y2 - my);
      const tl = Math.hypot(tx, ty) || 1;
      const pnx = -ty / tl, pny = tx / tl;
      const hw = lerp(w1, w2, t) * 0.5 * (1 + (rng() - 0.5) * 0.14);
      leftPts.push([cx + pnx * hw, cy + pny * hw]);
      rightPts.push([cx - pnx * hw, cy - pny * hw]);
    }
    const poly = [...leftPts, ...rightPts.reverse()];
    wcWash(poly, {
      color: litHex,
      color2: shadowHex,
      layers: 14,
      alpha: 0.11,
      depth: 2,
      spread: 0.12,
      wetEdge: true,
      edgeDarken: 12,
      lightAngle: Math.PI * 0.12,
    }, rng);

    if (inkEdges && w1 > 4) {
      inkPolyline(leftPts, clamp(w1 * 0.045, 0.7, 2.2), rng, 1.1, '#3A281C', 0.65);
      inkPolyline(rightPts.reverse(), clamp(w1 * 0.055, 0.8, 2.5), rng, 1.1, '#3A281C', 0.78);
      // Bark texture strokes
      const strokes = Math.min(6, Math.max(1, Math.floor(w1 / 12)));
      for (let k = 0; k < strokes; k++) {
        const frac = randRange(rng, 0.2, 0.8);
        const s0 = randRange(rng, 0.1, 0.55);
        const s1 = Math.min(0.95, s0 + randRange(rng, 0.18, 0.35));
        const pA = [
          lerp(leftPts[Math.floor(s0 * steps)][0], rightPts[Math.floor(s0 * steps)][0], frac),
          lerp(leftPts[Math.floor(s0 * steps)][1], rightPts[Math.floor(s0 * steps)][1], frac),
        ];
        const pB = [
          lerp(leftPts[Math.floor(s1 * steps)][0], rightPts[Math.floor(s1 * steps)][0], frac),
          lerp(leftPts[Math.floor(s1 * steps)][1], rightPts[Math.floor(s1 * steps)][1], frac),
        ];
        inkLine(pA[0], pA[1], pB[0], pB[1], randRange(rng, 0.5, 1.2), rng, 1.4, '#4A3324', 0.45);
      }
    }
  }

  function wcBranchTree(x, y, len, angle, width, depth, litHex, shadowHex, rng, tipsOut = null) {
    const x2 = x + Math.cos(angle) * len;
    const y2 = y + Math.sin(angle) * len;
    wcTrunkSegment(x, y, x2, y2, width, width * 0.68, litHex, shadowHex, rng, depth >= 1);
    if (depth <= 0) {
      if (tipsOut) tipsOut.push([x2, y2, width]);
      return;
    }
    const subCount = depth >= 2 ? 2 : (rng() < 0.65 ? 2 : 3);
    for (let i = 0; i < subCount; i++) {
      const spread = subCount === 2 ? (i === 0 ? -1 : 1) * randRange(rng, 0.28, 0.58) : (i - 1) * randRange(rng, 0.36, 0.54);
      wcBranchTree(
        x2, y2,
        len * randRange(rng, 0.64, 0.80),
        angle + spread,
        width * 0.66,
        depth - 1,
        litHex, shadowHex,
        rng,
        tipsOut,
      );
    }
  }

  // Painterly pine tree (irregular drooping bough-dab clusters — NEVER triangles!)
  function wcPineTree(x, baseY, height, width, colors, rng, trunkHex = '#5B3E2B', alpha = 0.26) {
    const topY = baseY - height;
    // Trunk
    wcTrunkSegment(x, baseY + 12, x + (rng() - 0.5) * 6, topY + height * 0.22, width * 0.14, width * 0.04, trunkHex, '#2F241D', rng, height > 180);
    // Layered irregular drooping pine boughs from bottom to top
    const tiers = Math.max(6, Math.round(height / 24));
    for (let t = 0; t < tiers; t++) {
      const frac = t / (tiers - 1); // 0 = bottom, 1 = top
      const ty = lerp(baseY - height * 0.16, topY + 10, frac);
      const span = width * (1.0 - frac * 0.78) * randRange(rng, 0.82, 1.18);
      const boughs = Math.max(3, Math.round(lerp(8, 3, frac)));
      for (let b = 0; b < boughs; b++) {
        const bx = x + randRange(rng, -span * 0.52, span * 0.52);
        const droop = Math.abs(bx - x) * 0.28 + randRange(rng, 0, 8);
        const rx = randRange(rng, 10, 24) * (1 - frac * 0.45);
        const ry = rx * randRange(rng, 0.45, 0.78);
        const tilt = (bx < x ? -0.25 : 0.25) + (rng() - 0.5) * 0.2;
        const raw = makeOrganicOval(bx, ty + droop, rx, ry, 6, rng, 0.30, tilt);
        const poly = deformPoly(raw, rng, 1, 0.22);
        const colList = frac > 0.65 || bx < x ? colors.light : (b % 2 === 0 ? colors.mid : colors.shadow);
        const hex = colList[Math.floor(rng() * colList.length)];
        const [h, s, l] = hexToHsl(hex);
        tracePoly(poly);
        ctx.fillStyle = hslaStr(h + (rng() - 0.5) * 7, s, l + (rng() - 0.5) * 6, alpha * randRange(rng, 0.75, 1.3));
        ctx.fill();
      }
    }
  }

  // Shimmering watercolor water surface with horizontal reflection bands & dry-brush foam
  function wcWaterSurface(yTop, yBot, topHex, midHex, deepHex, reflectHex, rng, opts = {}) {
    const { shimmerX = W * 0.5, shimmerW = 300, foam = true } = opts;
    const waterPoly = [[-30, yTop], [W + 30, yTop], [W + 30, yBot + 20], [-30, yBot + 20]];
    wcWash(waterPoly, {
      color: topHex,
      color2: deepHex,
      layers: 20,
      alpha: 0.075,
      depth: 2,
      spread: 0.08,
      wetEdge: false,
      lightAngle: Math.PI * 0.5,
    }, rng);

    // Midtone watercolor currents
    for (let i = 0; i < 34; i++) {
      const t = rng();
      const y = lerp(yTop + 8, yBot - 6, t);
      const rw = randRange(rng, 55, 220) * (0.5 + t * 0.8);
      const rh = randRange(rng, 4, 15) * (0.5 + t * 0.9);
      const cx = randRange(rng, -20, W + 20);
      const raw = makeOrganicOval(cx, y, rw, rh, 8, rng, 0.20);
      const poly = deformPoly(raw, rng, 1, 0.16);
      tracePoly(poly);
      ctx.fillStyle = rgbaHex(rng() < 0.55 ? midHex : deepHex, randRange(rng, 0.08, 0.19));
      ctx.fill();
    }

    // Luminous horizontal reflection ripples
    for (let i = 0; i < 65; i++) {
      const t = Math.pow(rng(), 1.15);
      const y = lerp(yTop + 6, yBot - 8, t);
      const dist = gauss(rng) * shimmerW * (0.45 + t * 0.75);
      const cx = shimmerX + dist;
      const rw = randRange(rng, 14, 72) * (0.45 + t * 0.95);
      const rh = randRange(rng, 1.5, 4.8) * (0.6 + t * 0.7);
      const raw = makeOrganicOval(cx, y, rw, rh, 6, rng, 0.25);
      tracePoly(raw);
      ctx.fillStyle = rgbaHex(reflectHex, randRange(rng, 0.12, 0.34));
      ctx.fill();
    }

    // Paper-white dry-brush sparkle streaks
    if (foam) {
      for (let i = 0; i < 40; i++) {
        const t = rng();
        const y = lerp(yTop + 10, yBot - 10, t);
        const cx = shimmerX + gauss(rng) * shimmerW * 0.95;
        const len = randRange(rng, 12, 54) * (0.5 + t * 0.8);
        inkLine(cx - len * 0.5, y, cx + len * 0.5, y + (rng() - 0.5) * 2.5, randRange(rng, 0.8, 2.0), rng, 0.9, '#FFF9ED', randRange(rng, 0.28, 0.58));
      }
    }
  }

  // =========================================================================
  // PASS 3: Hand-Tremored Sepia Dip-Pen Ink & Gouache Luminous Accents
  // =========================================================================
  function inkLine(x1, y1, x2, y2, width, rng, wobble = 1.6, color = '#3A281C', alpha = 0.78) {
    const dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist < 1) return;
    const steps = Math.max(2, Math.round(dist / 9));
    const nx = -(y2 - y1) / dist;
    const ny = (x2 - x1) / dist;
    const phase = rng() * Math.PI * 2;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const env = Math.sin(t * Math.PI);
      const off = (Math.sin(t * 9 + phase) * 0.55 + (rng() - 0.5) * 0.9) * wobble * env;
      pts.push([lerp(x1, x2, t) + nx * off, lerp(y1, y2, t) + ny * off]);
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgbaHex(color, alpha);
    for (let i = 0; i < pts.length - 1; i++) {
      const t = (i + 0.5) / (pts.length - 1);
      // Natural dip-pen pressure taper + slight dry-nib skip
      const pressure = 0.55 + 0.55 * Math.sin(t * Math.PI) + (rng() - 0.5) * 0.22;
      ctx.lineWidth = Math.max(0.45, width * pressure);
      ctx.beginPath();
      ctx.moveTo(pts[i][0], pts[i][1]);
      ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  function inkPolyline(pts, width, rng, wobble = 1.3, color = '#3A281C', alpha = 0.76) {
    for (let i = 0; i < pts.length - 1; i++) {
      inkLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], width, rng, wobble, color, alpha);
    }
  }

  function inkQuadCurve(x1, y1, cx, cy, x2, y2, width, rng, wobble = 1.3, color = '#3A281C', alpha = 0.76) {
    const pts = [];
    const steps = Math.max(6, Math.round((Math.hypot(cx - x1, cy - y1) + Math.hypot(x2 - cx, y2 - cy)) / 12));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const omt = 1 - t;
      pts.push([
        omt * omt * x1 + 2 * omt * t * cx + t * t * x2,
        omt * omt * y1 + 2 * omt * t * cy + t * t * y2,
      ]);
    }
    inkPolyline(pts, width, rng, wobble, color, alpha);
  }

  // Luminous warm radial glow (windows, lanterns, moon, fireflies)
  function drawGlow(x, y, r, innerHex, outerHex, alpha = 0.45, composite = 'screen') {
    ctx.save();
    ctx.globalCompositeOperation = composite;
    const g = ctx.createRadialGradient(x, y, r * 0.04, x, y, r);
    g.addColorStop(0, rgbaHex(innerHex, alpha));
    g.addColorStop(0.42, rgbaHex(outerHex, alpha * 0.52));
    g.addColorStop(1, rgbaHex(outerHex, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Hand-painted hanging paper / brass storybook lantern
  function drawHangingLantern(x, y, size, glowHex, shellHex, rng, cordTopY = null) {
    if (cordTopY !== null) {
      inkLine(x, cordTopY, x, y - size * 0.9, 1.1, rng, 1.0, '#3A281C', 0.72);
    }
    drawGlow(x, y, size * 5.2, '#FFF7D6', glowHex, 0.52, 'screen');
    drawGlow(x, y, size * 2.4, '#FFFDF2', glowHex, 0.58, 'lighter');
    const body = makeOrganicOval(x, y, size * 0.76, size * 0.96, 8, rng, 0.10);
    wcWash(body, { color: '#FFF8DE', color2: shellHex, layers: 10, alpha: 0.16, depth: 1, spread: 0.10, wetEdge: true }, rng);
    // Warm cream gouache core
    const core = makeOrganicOval(x, y, size * 0.42, size * 0.55, 6, rng, 0.12);
    tracePoly(core);
    ctx.fillStyle = 'rgba(255, 251, 236, 0.85)';
    ctx.fill();
    // Sepia ink lantern cap, ribs & tassel
    inkPolyline([...body, body[0]], 1.2, rng, 0.6, '#3A281C', 0.82);
    inkLine(x - size * 0.45, y - size * 0.92, x + size * 0.45, y - size * 0.92, 2.2, rng, 0.4, '#3A281C', 0.88);
    inkLine(x - size * 0.35, y + size * 0.92, x + size * 0.35, y + size * 0.92, 1.8, rng, 0.4, '#3A281C', 0.85);
    inkLine(x, y + size * 0.95, x + (rng() - 0.5) * 3, y + size * 1.48, 1.0, rng, 0.6, '#8B5232', 0.75);
  }

  // Volumetric sunbeam / lighthouse ray
  function drawLightBeam(x1, y1, x2, y2, w1, w2, hex, alpha = 0.14) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let k = 0; k < 3; k++) {
      const expand = 1 + k * 0.35;
      const a = alpha * (k === 0 ? 0.8 : (k === 1 ? 0.5 : 0.28));
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, rgbaHex(hex, a));
      grad.addColorStop(0.65, rgbaHex(hex, a * 0.48));
      grad.addColorStop(1, rgbaHex(hex, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x1 + nx * w1 * expand * 0.5, y1 + ny * w1 * expand * 0.5);
      ctx.lineTo(x2 + nx * w2 * expand * 0.5, y2 + ny * w2 * expand * 0.5);
      ctx.lineTo(x2 - nx * w2 * expand * 0.5, y2 - ny * w2 * expand * 0.5);
      ctx.lineTo(x1 - nx * w1 * expand * 0.5, y1 - ny * w1 * expand * 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Firefly & gouache paint spatter
  function drawFireflies(count, xMin, xMax, yMin, yMax, rng, hex = '#FFE28A') {
    for (let i = 0; i < count; i++) {
      const x = randRange(rng, xMin, xMax);
      const y = randRange(rng, yMin, yMax);
      const r = randRange(rng, 1.2, 3.2);
      drawGlow(x, y, r * 6.5, '#FFFBEA', hex, randRange(rng, 0.30, 0.65), 'screen');
      const dot = makeOrganicOval(x, y, r, r * randRange(rng, 0.85, 1.15), 5, rng, 0.15);
      tracePoly(dot);
      ctx.fillStyle = rgbaHex('#FFFDF0', randRange(rng, 0.72, 0.96));
      ctx.fill();
    }
  }

  function drawStarSpatter(count, yMax, rng) {
    for (let i = 0; i < count; i++) {
      const x = randRange(rng, 18, W - 18);
      const y = randRange(rng, 18, yMax);
      const r = randRange(rng, 0.8, 2.4) * (rng() < 0.12 ? 1.55 : 1.0);
      if (r > 2.2) {
        drawGlow(x, y, r * 4.5, '#FFFDF4', '#D9E4FA', 0.35, 'screen');
      }
      const dot = makeOrganicOval(x, y, r, r, 5, rng, 0.15);
      tracePoly(dot);
      ctx.fillStyle = rgbaHex(rng() < 0.7 ? '#FFF9E8' : '#DAE5FA', randRange(rng, 0.45, 0.92));
      ctx.fill();
    }
  }

  // Distant tiny birds in flight
  function drawDistantBirds(cx, cy, count, scale, rng, color = '#4A392E') {
    for (let i = 0; i < count; i++) {
      const bx = cx + (rng() - 0.5) * 140 * scale;
      const by = cy + (rng() - 0.5) * 55 * scale;
      const s = randRange(rng, 6, 13) * scale;
      const tilt = (rng() - 0.5) * 0.25;
      inkQuadCurve(bx - s, by + s * 0.2, bx - s * 0.4, by - s * 0.45 + tilt * s, bx, by, 1.3, rng, 0.4, color, 0.72);
      inkQuadCurve(bx, by, bx + s * 0.4, by - s * 0.45 - tilt * s, bx + s, by + s * 0.2, 1.3, rng, 0.4, color, 0.72);
    }
  }

  // Foreground botanical wildflowers, swaying grasses, and fern fronds
  function drawMeadowBotanicals(yTop, yBot, count, rng, opts = {}) {
    const {
      grassColors = ['#3B5842', '#527352', '#2E4638'],
      flowerColors = ['#F2C96B', '#D97B59', '#B9A3CC', '#FFF5DC'],
      xMin = -10,
      xMax = W + 10,
      scale = 1.0,
      nightMode = false,
    } = opts;

    // Grass blades
    for (let i = 0; i < count; i++) {
      const x = randRange(rng, xMin, xMax);
      const y = randRange(rng, yTop, yBot);
      const h = randRange(rng, 28, 86) * scale;
      const lean = randRange(rng, -24, 24) * scale;
      const col = grassColors[Math.floor(rng() * grassColors.length)];
      inkQuadCurve(x, y, x + lean * 0.45, y - h * 0.55, x + lean, y - h, randRange(rng, 1.0, 2.4) * scale, rng, 0.9, col, nightMode ? 0.75 : 0.62);
    }

    // Painterly wildflower clusters
    const flowerCount = Math.round(count * 0.36);
    for (let i = 0; i < flowerCount; i++) {
      const x = randRange(rng, xMin + 12, xMax - 12);
      const y = randRange(rng, yTop + 6, yBot - 6);
      const stemH = randRange(rng, 22, 62) * scale;
      const lean = randRange(rng, -16, 16) * scale;
      const fx = x + lean;
      const fy = y - stemH;
      inkQuadCurve(x, y, x + lean * 0.5, y - stemH * 0.5, fx, fy, 1.1 * scale, rng, 0.6, grassColors[0], 0.55);

      const fCol = flowerColors[Math.floor(rng() * flowerColors.length)];
      const petals = Math.floor(randRange(rng, 3, 6));
      for (let p = 0; p < petals; p++) {
        const pa = (p / petals) * Math.PI * 2 + rng() * 0.5;
        const pr = randRange(rng, 3.2, 6.8) * scale;
        const px = fx + Math.cos(pa) * pr * 0.85;
        const py = fy + Math.sin(pa) * pr * 0.72;
        const raw = makeOrganicOval(px, py, pr, pr * 0.75, 5, rng, 0.25, pa);
        tracePoly(raw);
        ctx.fillStyle = rgbaHex(fCol, nightMode ? 0.58 : randRange(rng, 0.68, 0.92));
        ctx.fill();
      }
      // Flower center dot
      const ctr = makeOrganicOval(fx, fy, 2.2 * scale, 2.2 * scale, 5, rng, 0.15);
      tracePoly(ctr);
      ctx.fillStyle = rgbaHex(nightMode ? '#E4C27A' : '#8A5628', 0.8);
      ctx.fill();
    }
  }

  function drawFernFrond(x, y, len, angle, color, rng, alpha = 0.72) {
    const tipX = x + Math.cos(angle) * len;
    const tipY = y + Math.sin(angle) * len;
    const midX = (x + tipX) * 0.5 + Math.cos(angle - Math.PI * 0.5) * len * 0.16;
    const midY = (y + tipY) * 0.5 + Math.sin(angle - Math.PI * 0.5) * len * 0.16;
    inkQuadCurve(x, y, midX, midY, tipX, tipY, 2.0, rng, 0.8, color, alpha);

    const pairs = 11;
    for (let i = 1; i < pairs; i++) {
      const t = i / pairs;
      const omt = 1 - t;
      const sx = omt * omt * x + 2 * omt * t * midX + t * t * tipX;
      const sy = omt * omt * y + 2 * omt * t * midY + t * t * tipY;
      const leafLen = Math.sin(t * Math.PI) * len * 0.28 + 5;
      for (const side of [-1, 1]) {
        const la = angle + side * (1.05 - t * 0.28);
        const lx = sx + Math.cos(la) * leafLen * 0.55;
        const ly = sy + Math.sin(la) * leafLen * 0.55;
        const raw = makeOrganicOval(lx, ly, leafLen * 0.55, leafLen * 0.19, 6, rng, 0.22, la);
        tracePoly(raw);
        ctx.fillStyle = rgbaHex(color, alpha * randRange(rng, 0.55, 0.85));
        ctx.fill();
      }
    }
  }

  // Poetic small-scale back-view storybook traveler + tiny animal companion (ZERO faces!)
  function drawBackViewTraveler(x, footY, scale, cloakHex, rng, opts = {}) {
    const { hasLantern = true, companion = 'fox' } = opts;
    const h = 88 * scale;
    const w = 34 * scale;

    // Soft cast shadow
    const shad = makeOrganicOval(x + 6 * scale, footY + 3 * scale, w * 0.85, 7 * scale, 8, rng, 0.18);
    tracePoly(shad);
    ctx.fillStyle = 'rgba(34, 38, 48, 0.24)';
    ctx.fill();

    // Boots
    for (const dx of [-5.5 * scale, 5.5 * scale]) {
      const boot = makeOrganicOval(x + dx, footY - 4 * scale, 4.5 * scale, 6.5 * scale, 6, rng, 0.14);
      tracePoly(boot);
      ctx.fillStyle = rgbaHex('#3A281C', 0.88);
      ctx.fill();
    }

    // Flowing hooded storybook cloak (back view)
    const cloakPts = [
      [x - w * 0.28, footY - h * 0.74],
      [x + w * 0.28, footY - h * 0.74],
      [x + w * 0.56, footY - h * 0.14],
      [x + w * 0.34, footY - h * 0.09],
      [x,            footY - h * 0.12],
      [x - w * 0.36, footY - h * 0.09],
      [x - w * 0.54, footY - h * 0.16],
    ];
    wcWash(cloakPts, {
      color: cloakHex,
      color2: '#2D2426',
      layers: 14,
      alpha: 0.16,
      depth: 2,
      spread: 0.10,
      wetEdge: true,
      edgeDarken: 10,
    }, rng);
    inkPolyline([...cloakPts, cloakPts[0]], 1.2 * scale, rng, 0.7, '#3A281C', 0.78);

    // Back of head + soft hood/hair silhouette (no face!)
    const head = makeOrganicOval(x, footY - h * 0.86, 12.5 * scale, 13.5 * scale, 9, rng, 0.12);
    wcWash(head, { color: '#5A3B28', color2: '#2E1E16', layers: 12, alpha: 0.18, depth: 1, spread: 0.10, wetEdge: true }, rng);
    // Warm scarf knot
    const scarf = makeOrganicOval(x, footY - h * 0.73, 12 * scale, 5 * scale, 7, rng, 0.14);
    wcWash(scarf, { color: '#E8B86D', color2: '#B96B42', layers: 8, alpha: 0.22, depth: 1, spread: 0.10, wetEdge: false }, rng);

    // Optional warm brass lantern held to the side
    if (hasLantern) {
      const lx = x + w * 0.68;
      const ly = footY - h * 0.42;
      inkLine(x + w * 0.25, footY - h * 0.60, lx, ly - 10 * scale, 2.0 * scale, rng, 0.6, '#3A281C', 0.82);
      drawHangingLantern(lx, ly, 7.2 * scale, '#F5B856', '#E8A44A', rng, ly - 11 * scale);
    }

    // Tiny animal companion silhouette beside traveler (fox or cat, back view)
    if (companion) {
      const cx = x - w * 0.82;
      const cy = footY - 2 * scale;
      const bodyCol = companion === 'fox' ? '#C7683B' : '#4E4442';
      const body = makeOrganicOval(cx, cy - 11 * scale, 8.5 * scale, 11.5 * scale, 8, rng, 0.14);
      wcWash(body, { color: bodyCol, color2: '#3B2820', layers: 10, alpha: 0.22, depth: 1, spread: 0.12, wetEdge: true }, rng);
      const chead = makeOrganicOval(cx + 1 * scale, cy - 23 * scale, 6.8 * scale, 6.4 * scale, 7, rng, 0.12);
      wcWash(chead, { color: bodyCol, color2: '#3B2820', layers: 9, alpha: 0.22, depth: 1, spread: 0.10, wetEdge: true }, rng);
      // Pointed ears
      const ear1 = [[cx - 5 * scale, cy - 26 * scale], [cx - 6 * scale, cy - 34 * scale], [cx - 1 * scale, cy - 28 * scale]];
      const ear2 = [[cx + 2 * scale, cy - 28 * scale], [cx + 7 * scale, cy - 34 * scale], [cx + 6 * scale, cy - 26 * scale]];
      for (const ear of [ear1, ear2]) {
        tracePoly(ear);
        ctx.fillStyle = rgbaHex(bodyCol, 0.85);
        ctx.fill();
      }
      // Fluffy curled tail
      const tail = makeOrganicOval(cx - 11 * scale, cy - 8 * scale, 9 * scale, 4.5 * scale, 7, rng, 0.18, -0.35);
      wcWash(tail, { color: bodyCol, color2: '#F5E8D0', layers: 8, alpha: 0.22, depth: 1, spread: 0.14, wetEdge: false }, rng);
    }
  }

  // =========================================================================
  // PASS 4: 300gsm Cold-Press Paper Multiply & Warm #FAF6EE Storybook Vignette
  // =========================================================================
  function applyPaperAndVignette(rng, vignetteStrength = 0.34) {
    // 1. Multiply 300gsm cold-press cotton paper tooth over entire illustration
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 1.0;
    ctx.drawImage(paperGL.canvas, 0, 0, W, H);
    ctx.restore();

    // 2. Subtle feathered #FAF6EE storybook edge harmonization
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const rGrad = ctx.createRadialGradient(W * 0.5, H * 0.5, W * 0.38, W * 0.5, H * 0.5, W * 0.72);
    rGrad.addColorStop(0, 'rgba(250, 246, 238, 0.0)');
    rGrad.addColorStop(0.76, 'rgba(250, 246, 238, 0.0)');
    rGrad.addColorStop(1.0, `rgba(250, 246, 238, ${vignetteStrength.toFixed(3)})`);
    ctx.fillStyle = rGrad;
    ctx.fillRect(0, 0, W, H);

    // Delicate 18px deckled warm cotton margin glaze along all four edges
    const edges = [
      [0, 0, 0, 22],
      [0, H, 0, H - 22],
      [0, 0, 22, 0],
      [W, 0, W - 22, 0],
    ];
    for (const [x1, y1, x2, y2] of edges) {
      const eg = ctx.createLinearGradient(x1, y1, x2, y2);
      eg.addColorStop(0, 'rgba(250, 246, 238, 0.38)');
      eg.addColorStop(1, 'rgba(250, 246, 238, 0.0)');
      ctx.fillStyle = eg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  // =========================================================================
  // ALL 11 DISTINCT COHESIVE STORYBOOK SCENES
  // =========================================================================

  // -------------------------------------------------------------------------
  // COVER: Enchanted Ancient Oak Clearing (airy luminous upper-center sky!)
  // -------------------------------------------------------------------------
  function drawScene_cover(rng) {
    // Plane 1: Golden morning apricot -> airy pale cerulean top sky
    renderSkyPass({
      seed: 101.3,
      skyTop: '#A4C8D8',
      skyMid: '#DFDFD6',
      skyHorizon: '#F7D292',
      sunPos: [0.50, 0.44],
      sunColor: '#FFF0C2',
      sunRadius: 2.3,
      bloomStrength: 0.62,
      cloudAmount: 0.48,
      cloudTint: '#E5CFC4',
      horizonY: 0.66,
      granulation: 0.055,
    });

    // Subtle sunlit clouds near upper sides (keeping upper-center airy!)
    wcCloudPuff(260, 190, 240, 82, '#FFF9EE', '#E4CFC2', rng, 0.052);
    wcCloudPuff(790, 215, 250, 86, '#FFF9EE', '#E4CFC2', rng, 0.050);
    drawDistantBirds(510, 230, 5, 0.9, rng, '#6A5648');

    // Plane 2: Soft misty lavender-blue distant hills
    wcHillBand(615, 42, 1.8, 0.4, '#B7BED1', '#8FA2B8', rng, { layers: 16, alpha: 0.055 });
    wcHillBand(668, 36, 2.2, 2.1, '#8FA896', '#678472', rng, { layers: 18, alpha: 0.062, ridgeHighlight: '#F7E1B2' });

    // Distant woodland archway glow on horizon
    drawGlow(512, 650, 210, '#FFF6D4', '#F4C87A', 0.48, 'screen');

    // Plane 3: Rolling sunlit mossy meadow + curving golden path
    wcHillBand(725, 32, 1.5, 0.9, '#88A674', '#4B6B51', rng, { layers: 22, alpha: 0.065, ridgeHighlight: '#E7D48C' });

    // Winding sunlit mossy dirt path leading from bottom-center toward distant clearing
    const pathPts = [
      [488, 672], [536, 672],
      [560, 745], [538, 820], [595, 910], [670, 1030],
      [390, 1030], [452, 915], [478, 822], [462, 748],
    ];
    wcWash(pathPts, {
      color: '#F2DCAC',
      color2: '#C7A578',
      layers: 20,
      alpha: 0.075,
      depth: 2,
      spread: 0.16,
      wetEdge: true,
      edgeDarken: 8,
    }, rng);

    // Stepping stones along path
    const stones = [[512, 718, 18], [504, 760, 22], [518, 808, 25], [496, 865, 30], [526, 932, 34]];
    for (const [sx, sy, sr] of stones) {
      const st = makeOrganicOval(sx, sy, sr, sr * 0.42, 7, rng, 0.18);
      wcWash(st, { color: '#D8C9B4', color2: '#9E8D7B', layers: 10, alpha: 0.12, depth: 1, spread: 0.12, wetEdge: true }, rng);
    }

    // Plane 4: Grand ancient gnarled oak trunks framing left & right edges with overarching leafy boughs
    const oakPalette = {
      shadow: ['#2C473A', '#3B5946'],
      mid: ['#527556', '#678B5E', '#486A4F'],
      light: ['#9AB36A', '#C8C572', '#DFCC83'],
    };

    // Left ancient oak framing edge
    wcTrunkSegment(46, 1020, 82, 540, 138, 88, '#7A5438', '#3F2A1F', rng, true);
    wcTrunkSegment(78, 560, 210, 315, 62, 26, '#7A5438', '#3F2A1F', rng, true);
    wcTrunkSegment(82, 545, 290, 180, 48, 16, '#7A5438', '#3F2A1F', rng, true);
    wcTrunkSegment(185, 350, 370, 220, 26, 9, '#7A5438', '#3F2A1F', rng, true);

    // Right ancient oak framing edge
    wcTrunkSegment(978, 1020, 934, 530, 142, 90, '#785236', '#3B281E', rng, true);
    wcTrunkSegment(936, 550, 800, 300, 62, 24, '#785236', '#3B281E', rng, true);
    wcTrunkSegment(930, 535, 735, 175, 48, 16, '#785236', '#3B281E', rng, true);
    wcTrunkSegment(825, 345, 650, 225, 26, 9, '#785236', '#3B281E', rng, true);

    // Lush overarching oak foliage framing sides & upper corners (center sky remains open!)
    wcBrushDabCluster(145, 145, 215, 165, oakPalette, 120, rng, { lightDir: [0.5, 0.3], dabMin: 11, dabMax: 28, alpha: 0.25 });
    wcBrushDabCluster(875, 155, 215, 165, oakPalette, 120, rng, { lightDir: [-0.5, 0.3], dabMin: 11, dabMax: 28, alpha: 0.25 });
    wcBrushDabCluster(95, 355, 150, 125, oakPalette, 85, rng, { lightDir: [0.6, 0.2], dabMin: 10, dabMax: 24, alpha: 0.24 });
    wcBrushDabCluster(930, 365, 155, 125, oakPalette, 85, rng, { lightDir: [-0.6, 0.2], dabMin: 10, dabMax: 24, alpha: 0.24 });

    // Sepia ink garland cord slung gently between overarching boughs with 5 glowing brass lanterns
    inkQuadCurve(230, 278, 512, 378, 794, 275, 1.3, rng, 0.8, '#3A281C', 0.72);
    const lanterns = [
      [300, 326, 13],
      [405, 354, 15],
      [512, 364, 16],
      [620, 352, 15],
      [722, 324, 13],
    ];
    for (const [lx, ly, ls] of lanterns) {
      drawHangingLantern(lx, ly + ls * 1.1, ls, '#F4C062', '#E59B4C', rng, ly - 4);
    }

    // Plane 5: Lush foreground wildflower meadow, ferns, and rising golden fireflies
    drawFernFrond(30, 990, 190, -0.82, '#2F4D3C', rng, 0.78);
    drawFernFrond(95, 1020, 165, -0.58, '#466B4F', rng, 0.72);
    drawFernFrond(990, 995, 195, -2.30, '#2F4D3C', rng, 0.78);
    drawFernFrond(915, 1022, 168, -2.55, '#466B4F', rng, 0.72);

    drawMeadowBotanicals(805, 1020, 155, rng, {
      grassColors: ['#2E4A3A', '#476A4E', '#5D8059'],
      flowerColors: ['#F7CF65', '#DC7654', '#BFA4D0', '#FFF7DF'],
      scale: 1.05,
    });
    drawFireflies(34, 140, 885, 360, 920, rng, '#FFE082');
  }

  // -------------------------------------------------------------------------
  // PAGE 01: Cozy Timber Cottage at Golden Dawn
  // -------------------------------------------------------------------------
  function drawScene_page_01(rng) {
    // Plane 1: Rose-apricot sunrise sky
    renderSkyPass({
      seed: 202.7,
      skyTop: '#8EB0C7',
      skyMid: '#E6BDA8',
      skyHorizon: '#F8D49D',
      sunPos: [0.78, 0.42],
      sunColor: '#FFE8B6',
      sunRadius: 2.5,
      bloomStrength: 0.62,
      cloudAmount: 0.45,
      cloudTint: '#D8B3B0',
      horizonY: 0.62,
      granulation: 0.055,
    });
    wcCloudPuff(720, 195, 290, 88, '#FFF7EA', '#E3BCAC', rng, 0.055);
    wcCloudPuff(255, 155, 210, 68, '#FFF7EA', '#DFBBAE', rng, 0.048);
    drawDistantBirds(710, 260, 4, 0.85, rng, '#6A544A');

    // Plane 2: Pale dawn mist ridges
    wcHillBand(588, 40, 1.9, 1.1, '#B4BCCB', '#8C9FB3', rng, { layers: 16, alpha: 0.055 });
    wcHillBand(640, 34, 2.3, 2.6, '#8EA38E', '#627B69', rng, { layers: 18, alpha: 0.062, ridgeHighlight: '#F5D6A8' });

    // Plane 3: Rolling garden hill, stone hedge & cobblestone lane
    wcHillBand(705, 30, 1.4, 0.3, '#849E6E', '#4F6C50', rng, { layers: 22, alpha: 0.068, ridgeHighlight: '#E7CC8A' });

    // Distant garden trees behind cottage
    const gardenTreePal = {
      shadow: ['#324D3F', '#42614D'],
      mid: ['#5C805E', '#729464'],
      light: ['#A8BA74', '#E0C77B'],
    };
    wcBrushDabCluster(175, 515, 130, 120, gardenTreePal, 90, rng, { lightDir: [0.6, -0.5] });
    wcBrushDabCluster(670, 560, 110, 95, gardenTreePal, 75, rng, { lightDir: [0.5, -0.5] });

    // Winding cobblestone lane
    const lanePts = [
      [410, 742], [492, 742], [585, 815], [705, 920], [820, 1030],
      [510, 1030], [450, 910], [412, 825],
    ];
    wcWash(lanePts, { color: '#E4D2B4', color2: '#B59B7D', layers: 18, alpha: 0.08, depth: 2, spread: 0.14, wetEdge: true }, rng);
    for (let i = 0; i < 24; i++) {
      const t = rng();
      const cx = lerp(455, 645, t) + (rng() - 0.5) * lerp(36, 140, t);
      const cy = lerp(755, 995, t);
      const st = makeOrganicOval(cx, cy, randRange(rng, 10, 22) * (0.5 + t * 0.7), randRange(rng, 5, 10) * (0.5 + t * 0.7), 6, rng, 0.16);
      wcWash(st, { color: '#D3C3AB', color2: '#988672', layers: 7, alpha: 0.13, depth: 1, spread: 0.10, wetEdge: true }, rng);
    }

    // Plane 4: Charming storybook half-timbered cottage (off-center left x ~ 410)
    // Curling pale watercolor chimney smoke rising into dawn sky
    for (let s = 0; s < 9; s++) {
      const t = s / 8;
      const sx = 548 + Math.sin(t * 3.8) * 28 + t * 44;
      const sy = 345 - t * 215;
      const sr = lerp(16, 48, t);
      const puff = makeOrganicOval(sx, sy, sr, sr * 0.72, 8, rng, 0.25);
      wcWash(puff, { color: '#FFFBF3', color2: '#E3D5CC', layers: 8, alpha: 0.055 * (1 - t * 0.45), depth: 2, spread: 0.22, wetEdge: false }, rng);
    }

    // Crooked brick chimney
    const chimney = [[528, 348], [568, 344], [574, 462], [526, 464]];
    wcWash(chimney, { color: '#B86448', color2: '#7D4130', layers: 14, alpha: 0.13, depth: 1, spread: 0.08, wetEdge: true }, rng);
    inkPolyline([...chimney, chimney[0]], 1.4, rng, 0.8);
    for (let by = 362; by < 452; by += 14) {
      inkLine(530, by, 569, by + (rng() - 0.5) * 2, 0.85, rng, 0.5, '#4A2D20', 0.52);
    }

    // Main stucco cottage walls
    const wallPts = makeOrganicRect(250, 530, 325, 222, rng, 2.2);
    wcWash(wallPts, {
      color: '#F5E4C3',
      color2: '#D8B98E',
      layers: 20,
      alpha: 0.11,
      depth: 2,
      spread: 0.07,
      wetEdge: true,
      lightAngle: -Math.PI * 0.2,
    }, rng);

    // Warm stone foundation plinth
    const plinth = makeOrganicRect(246, 712, 333, 42, rng, 2.0);
    wcWash(plinth, { color: '#A99B89', color2: '#786D61', layers: 14, alpha: 0.13, depth: 1, spread: 0.10, wetEdge: true }, rng);

    // Steep mossy terracotta storybook roof
    const roofPts = [
      [208, 548], [320, 396], [420, 368], [520, 400], [612, 546], [568, 558], [250, 558],
    ];
    wcWash(roofPts, {
      color: '#C76948',
      color2: '#893F2C',
      layers: 24,
      alpha: 0.10,
      depth: 2,
      spread: 0.09,
      wetEdge: true,
      edgeDarken: 12,
      highlightColor: '#EAA169',
      highlightLayers: 4,
    }, rng);

    // Soft mossy patches on roof eaves
    wcBrushDabCluster(285, 515, 58, 22, { shadow: ['#4B6749'], mid: ['#6C8B5C'], light: ['#9FB16C'] }, 26, rng, { dabMin: 6, dabMax: 14, alpha: 0.22, skyPeeps: false });
    wcBrushDabCluster(530, 520, 52, 20, { shadow: ['#4B6749'], mid: ['#6C8B5C'], light: ['#9FB16C'] }, 22, rng, { dabMin: 6, dabMax: 14, alpha: 0.20, skyPeeps: false });

    // Shingle scalloped rows in sepia ink
    for (let ry = 425; ry <= 536; ry += 18) {
      const frac = (ry - 372) / 178;
      const xL = lerp(375, 226, frac);
      const xR = lerp(465, 594, frac);
      inkLine(xL, ry, xR, ry + (rng() - 0.5) * 3, 0.9, rng, 1.2, '#4A2C1E', 0.42);
    }
    inkPolyline([[208, 548], [320, 396], [420, 368], [520, 400], [612, 546]], 2.0, rng, 1.1);

    // Half-timber oak beams in sepia ink
    inkLine(252, 556, 574, 556, 3.2, rng, 0.9, '#4D3322', 0.84);
    inkLine(252, 628, 574, 628, 2.4, rng, 0.9, '#4D3322', 0.78);
    for (const bx of [254, 342, 488, 572]) {
      inkLine(bx, 556, bx, 748, 2.5, rng, 0.9, '#4D3322', 0.80);
    }
    // Diagonal timber braces
    inkLine(256, 628, 306, 558, 2.0, rng, 0.8, '#4D3322', 0.74);
    inkLine(570, 628, 522, 558, 2.0, rng, 0.8, '#4D3322', 0.74);

    // Glowing arched attic dormer window
    const dormerRoof = [[374, 476], [420, 424], [468, 476]];
    wcWash(dormerRoof, { color: '#B45B3E', color2: '#7E3926', layers: 12, alpha: 0.14, depth: 1, spread: 0.08, wetEdge: true }, rng);
    inkPolyline(dormerRoof, 1.6, rng, 0.8);
    drawGlow(421, 496, 78, '#FFF8DA', '#F7BC62', 0.62, 'screen');
    const atticWin = makeOrganicOval(421, 494, 24, 29, 8, rng, 0.07);
    wcWash(atticWin, { color: '#FFF8D8', color2: '#F5BD64', layers: 12, alpha: 0.19, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...atticWin, atticWin[0]], 1.5, rng, 0.5);
    inkLine(421, 466, 421, 522, 1.1, rng, 0.4);
    inkLine(398, 494, 444, 494, 1.1, rng, 0.4);

    // Arched wooden front door (center)
    const doorPts = [
      [388, 748], [388, 668], [396, 646], [416, 636], [436, 646], [444, 668], [444, 748],
    ];
    wcWash(doorPts, { color: '#8D5A3B', color2: '#5B3723', layers: 15, alpha: 0.15, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...doorPts, doorPts[0]], 1.6, rng, 0.7);
    inkLine(406, 642, 406, 746, 0.9, rng, 0.5);
    inkLine(426, 642, 426, 746, 0.9, rng, 0.5);
    drawHangingLantern(462, 664, 9.5, '#F5BD5A', '#E69B46', rng, 636);

    // Two cozy glowing cottage windows with sage wooden shutters
    for (const wx of [298, 530]) {
      drawGlow(wx, 666, 68, '#FFF7D4', '#F5B85B', 0.54, 'screen');
      const wRect = makeOrganicRect(wx - 24, 642, 48, 48, rng, 1.2);
      wcWash(wRect, { color: '#FFF6D4', color2: '#F1B65B', layers: 12, alpha: 0.18, depth: 1, spread: 0.06, wetEdge: true }, rng);
      // Shutters
      for (const sx of [wx - 42, wx + 25]) {
        const sh = makeOrganicRect(sx, 642, 17, 48, rng, 1.0);
        wcWash(sh, { color: '#698A74', color2: '#466252', layers: 10, alpha: 0.16, depth: 1, spread: 0.06, wetEdge: true }, rng);
        inkPolyline([...sh, sh[0]], 1.1, rng, 0.5);
      }
      inkPolyline([...wRect, wRect[0]], 1.4, rng, 0.5);
      inkLine(wx, 642, wx, 690, 1.0, rng, 0.4);
      inkLine(wx - 24, 666, wx + 24, 666, 1.0, rng, 0.4);
    }

    // Wooden picket fence & slightly ajar gate across midground
    for (let px = 40; px <= 960; px += 28) {
      if (px > 425 && px < 535) continue; // open garden gateway
      const py = 785 + Math.sin(px * 0.008) * 14;
      const picket = makeOrganicRect(px, py - 46, 13, 52, rng, 1.0);
      wcWash(picket, { color: '#EAE0CE', color2: '#B8A892', layers: 8, alpha: 0.16, depth: 1, spread: 0.08, wetEdge: true }, rng);
      inkLine(px, py + 6, px, py - 46, 1.1, rng, 0.6, '#4B3628', 0.72);
      inkLine(px + 13, py + 6, px + 13, py - 46, 1.0, rng, 0.6, '#4B3628', 0.65);
    }
    inkLine(35, 756, 425, 766, 2.2, rng, 1.0, '#6B523E', 0.75);
    inkLine(540, 764, 975, 752, 2.2, rng, 1.0, '#6B523E', 0.75);
    // Slightly ajar wooden gate
    inkLine(430, 796, 488, 822, 2.2, rng, 0.8, '#6B523E', 0.82);
    inkLine(430, 758, 488, 784, 2.2, rng, 0.8, '#6B523E', 0.82);
    for (let g = 0; g < 4; g++) {
      const gx = lerp(438, 482, g / 3);
      const gy = lerp(756, 782, g / 3);
      inkLine(gx, gy - 12, gx, gy + 44, 1.5, rng, 0.6, '#4B3628', 0.76);
    }

    // Plane 5: Tall blooming hollyhocks, lavender clumps & mossy garden stones
    for (const [hx, hy, hCol] of [[785, 960, '#D97B6C'], [832, 975, '#E9A57C'], [875, 945, '#C96F66'], [118, 955, '#D78A78'], [162, 978, '#E6BE72']]) {
      inkQuadCurve(hx, hy, hx + (rng() - 0.5) * 18, hy - 110, hx + (rng() - 0.5) * 28, hy - 220, 2.0, rng, 1.0, '#3C5941', 0.78);
      for (let b = 0; b < 7; b++) {
        const bx = hx + (rng() - 0.5) * 18;
        const by = hy - 55 - b * 24;
        const bl = makeOrganicOval(bx, by, randRange(rng, 10, 17), randRange(rng, 8, 14), 6, rng, 0.25);
        wcWash(bl, { color: hCol, color2: '#FFF3DF', layers: 7, alpha: 0.20, depth: 1, spread: 0.16, wetEdge: true }, rng);
      }
    }
    drawMeadowBotanicals(825, 1025, 145, rng, {
      grassColors: ['#35523D', '#4F7252', '#64855F'],
      flowerColors: ['#B398C9', '#F4C96C', '#DA7A5A', '#FFF6E2'],
    });
  }

  // -------------------------------------------------------------------------
  // PAGE 02: Sun-Dappled Mossy Woodland Archway
  // -------------------------------------------------------------------------
  function drawScene_page_02(rng) {
    // Plane 1: Luminous golden clearing glowing through the woodland arch
    renderSkyPass({
      seed: 303.9,
      skyTop: '#4A7258',
      skyMid: '#9EB887',
      skyHorizon: '#F9DE99',
      sunPos: [0.51, 0.50],
      sunColor: '#FFF5CA',
      sunRadius: 2.0,
      bloomStrength: 0.78,
      cloudAmount: 0.18,
      cloudTint: '#DCE0B8',
      horizonY: 0.68,
      granulation: 0.055,
    });

    // Plane 2: Receding sunlit birch & oak trunks visible through portal
    const farTrunks = [[425, 690, 18], [468, 675, 14], [556, 675, 15], [602, 690, 20], [380, 710, 24], [648, 710, 24]];
    for (const [tx, ty, tw] of farTrunks) {
      wcTrunkSegment(tx, ty, tx + (rng() - 0.5) * 18, 260, tw, tw * 0.55, '#99A587', '#677B69', rng, false);
    }
    drawGlow(512, 520, 240, '#FFF8DA', '#F7D286', 0.60, 'screen');

    // Plane 3: Mossy forest floor & winding stepping-stone trail
    wcHillBand(690, 28, 1.8, 0.6, '#6E9162', '#304C3C', rng, { layers: 22, alpha: 0.072, ridgeHighlight: '#D9D285' });
    const trail = [
      [486, 668], [538, 668], [575, 760], [615, 875], [690, 1030],
      [355, 1030], [428, 875], [455, 760],
    ];
    wcWash(trail, { color: '#E4CE9F', color2: '#9E8A64', layers: 18, alpha: 0.085, depth: 2, spread: 0.15, wetEdge: true }, rng);
    for (const [sx, sy, sr] of [[512, 705, 19], [500, 752, 23], [522, 804, 27], [495, 868, 32], [535, 938, 38]]) {
      const st = makeOrganicOval(sx, sy, sr, sr * 0.44, 7, rng, 0.20);
      wcWash(st, { color: '#CFC4AF', color2: '#898272', layers: 10, alpha: 0.14, depth: 1, spread: 0.12, wetEdge: true }, rng);
    }

    // Diagonal amber sunbeams streaming through the arch
    drawLightBeam(512, 220, 440, 860, 45, 220, '#FFEAA3', 0.22);
    drawLightBeam(540, 260, 650, 880, 35, 175, '#FFE499', 0.16);

    // Plane 4: Cathedral-like archway of two ancient intertwined mossy trees
    // Left arch tree curving up & right
    wcTrunkSegment(135, 1020, 165, 595, 150, 105, '#6E5038', '#33261E', rng, true);
    wcTrunkSegment(165, 600, 295, 315, 95, 52, '#6E5038', '#33261E', rng, true);
    wcTrunkSegment(290, 322, 535, 215, 48, 20, '#6E5038', '#33261E', rng, true);
    wcTrunkSegment(225, 445, 105, 330, 34, 14, '#6E5038', '#33261E', rng, true);

    // Right arch tree curving up & left to interlock
    wcTrunkSegment(892, 1020, 858, 590, 152, 105, '#6C4E37', '#30241C', rng, true);
    wcTrunkSegment(858, 595, 728, 310, 95, 52, '#6C4E37', '#30241C', rng, true);
    wcTrunkSegment(732, 318, 488, 220, 48, 20, '#6C4E37', '#30241C', rng, true);
    wcTrunkSegment(800, 440, 922, 325, 34, 14, '#6C4E37', '#30241C', rng, true);

    // Mossy cushion patches clinging to trunks
    const mossPal = { shadow: ['#294335', '#3A5844'], mid: ['#587C57', '#6E9462'], light: ['#A9BF6E', '#DED180'] };
    wcBrushDabCluster(175, 645, 58, 95, mossPal, 55, rng, { dabMin: 8, dabMax: 20, alpha: 0.24, skyPeeps: false });
    wcBrushDabCluster(848, 635, 58, 95, mossPal, 55, rng, { dabMin: 8, dabMax: 20, alpha: 0.24, skyPeeps: false });

    // Rich canopy framing the archway with sky-peep holes
    const archCanopy = {
      shadow: ['#253D32', '#314E3E'],
      mid: ['#4A7052', '#628A5E', '#3F634A'],
      light: ['#98B669', '#CBE084', '#E8D88A'],
    };
    wcBrushDabCluster(175, 185, 225, 175, archCanopy, 130, rng, { lightDir: [0.5, 0.4] });
    wcBrushDabCluster(850, 185, 225, 175, archCanopy, 130, rng, { lightDir: [-0.5, 0.4] });
    wcBrushDabCluster(512, 115, 290, 140, archCanopy, 135, rng, { lightDir: [0.0, 0.6] });

    // Hanging ivy vines from arch keystone
    for (const [vx, vy, vlen] of [[365, 255, 145], [415, 228, 125], [472, 215, 105], [555, 218, 118], [618, 238, 140], [662, 268, 135]]) {
      inkQuadCurve(vx, vy, vx + (rng() - 0.5) * 20, vy + vlen * 0.5, vx + (rng() - 0.5) * 16, vy + vlen, 1.2, rng, 0.9, '#3A533C', 0.72);
      for (let k = 1; k <= 6; k++) {
        const lx = vx + (rng() - 0.5) * 14;
        const ly = vy + (k / 6) * vlen;
        const leaf = makeOrganicOval(lx, ly, 7.5, 4.5, 5, rng, 0.2, randRange(rng, -0.7, 0.7));
        tracePoly(leaf);
        ctx.fillStyle = rgbaHex(k % 2 === 0 ? '#6E9460' : '#4A6E4E', 0.75);
        ctx.fill();
      }
    }

    // Small poetic back-view traveler + fox companion stepping toward sunlit portal
    drawBackViewTraveler(505, 815, 0.88, '#9F4A2C', rng, { hasLantern: true, companion: 'fox' });

    // Plane 5: Large unfurling fern fronds, speckled toadstools & fireflies
    drawFernFrond(42, 995, 240, -0.78, '#284235', rng, 0.85);
    drawFernFrond(135, 1022, 195, -0.52, '#41654A', rng, 0.80);
    drawFernFrond(982, 995, 240, -2.36, '#284235', rng, 0.85);
    drawFernFrond(882, 1022, 195, -2.62, '#41654A', rng, 0.80);

    // Speckled storybook toadstools in lower corners
    for (const [mx, my, ms] of [[218, 938, 1.15], [255, 956, 0.80], [782, 945, 1.05], [818, 962, 0.74]]) {
      const stem = makeOrganicRect(mx - 6 * ms, my - 24 * ms, 12 * ms, 28 * ms, rng, 0.8);
      wcWash(stem, { color: '#F6EBD4', color2: '#C9B89B', layers: 8, alpha: 0.18, depth: 1, spread: 0.10, wetEdge: true }, rng);
      const cap = [
        [mx - 22 * ms, my - 20 * ms], [mx - 16 * ms, my - 38 * ms], [mx, my - 44 * ms],
        [mx + 16 * ms, my - 38 * ms], [mx + 22 * ms, my - 20 * ms],
      ];
      wcWash(cap, { color: '#C8563E', color2: '#943728', layers: 12, alpha: 0.17, depth: 1, spread: 0.10, wetEdge: true }, rng);
      inkPolyline([...cap, cap[0]], 1.1, rng, 0.5, '#3A281C', 0.72);
      for (let d = 0; d < 5; d++) {
        const dot = makeOrganicOval(mx + randRange(rng, -13, 13) * ms, my - randRange(rng, 26, 39) * ms, 2.8 * ms, 2.2 * ms, 5, rng, 0.15);
        tracePoly(dot);
        ctx.fillStyle = 'rgba(255, 250, 238, 0.88)';
        ctx.fill();
      }
    }

    drawMeadowBotanicals(845, 1025, 115, rng, {
      grassColors: ['#263F33', '#3D5F46', '#567B55'],
      flowerColors: ['#F8D575', '#FFF5DD', '#E08462'],
    });
    drawFireflies(36, 200, 820, 320, 890, rng, '#FFE488');
  }

  // -------------------------------------------------------------------------
  // PAGE 03: Rolling Emerald & Lavender Hills (Huge clouds + crooked signpost)
  // -------------------------------------------------------------------------
  function drawScene_page_03(rng) {
    // Plane 1: Crisp sunlit cerulean sky with warm sunlit horizon
    renderSkyPass({
      seed: 404.2,
      skyTop: '#6C9FBE',
      skyMid: '#9CC6D8',
      skyHorizon: '#F4E5C8',
      sunPos: [0.22, 0.24],
      sunColor: '#FFF6D8',
      sunRadius: 2.6,
      bloomStrength: 0.45,
      cloudAmount: 0.65,
      cloudTint: '#D2C8D6',
      horizonY: 0.56,
      granulation: 0.052,
    });

    // Billowing luminous watercolor cumulus clouds occupying upper half
    wcCloudPuff(310, 215, 340, 128, '#FFFBF2', '#D5CCD8', rng, 0.062);
    wcCloudPuff(685, 175, 360, 135, '#FFFBF2', '#CFC7D6', rng, 0.060);
    wcCloudPuff(845, 325, 260, 92, '#FFF9EE', '#DCCDC8', rng, 0.052);
    wcCloudPuff(155, 345, 220, 82, '#FFF9EE', '#DAD0D4', rng, 0.050);
    drawDistantBirds(450, 265, 6, 0.95, rng, '#564E54');

    // Plane 2: Sweeping layered blue-lavender mountain range
    wcHillBand(508, 62, 2.1, 0.5, '#A9B2CA', '#838FB0', rng, { layers: 18, alpha: 0.060, ridgeHighlight: '#F4EBDE' });
    wcHillBand(565, 50, 2.5, 2.3, '#9BA0BC', '#7A83A4', rng, { layers: 18, alpha: 0.064 });

    // Plane 3: Rolling sunlit emerald-chartreuse hills + S-curving turquoise brook
    wcHillBand(622, 46, 1.8, 0.9, '#93B276', '#5F8459', rng, { layers: 20, alpha: 0.068, ridgeHighlight: '#E6DC8F' });
    wcHillBand(700, 44, 1.5, 3.1, '#7CA166', '#4A6E4E', rng, { layers: 22, alpha: 0.072, ridgeHighlight: '#DCE08A' });

    // Tiny distant cypress/oak clusters dotting the midground ridges
    const farGrove = { shadow: ['#3C5B4B'], mid: ['#587C5C'], light: ['#8FA96B'] };
    for (const [gx, gy, gr] of [[185, 612, 34], [240, 622, 26], [420, 640, 28], [625, 608, 32], [670, 618, 24]]) {
      wcBrushDabCluster(gx, gy, gr, gr * 0.82, farGrove, 32, rng, { dabMin: 5, dabMax: 12, alpha: 0.24 });
    }

    // S-curving silver-turquoise brook winding from mid-horizon to bottom-left
    const brookPts = [
      [510, 650], [534, 652], [492, 712], [538, 775], [462, 855], [340, 945], [225, 1030],
      [25, 1030], [190, 922], [358, 838], [452, 770], [442, 710],
    ];
    wcWash(brookPts, {
      color: '#9AD0D4',
      color2: '#558E9A',
      layers: 20,
      alpha: 0.095,
      depth: 2,
      spread: 0.14,
      wetEdge: true,
      edgeDarken: 10,
      highlightColor: '#FFF7E4',
      highlightLayers: 4,
    }, rng);
    // Shimmering water highlights along brook
    for (let i = 0; i < 24; i++) {
      const t = rng();
      const bx = lerp(475, 155, t) + Math.sin(t * 7) * 28;
      const by = lerp(672, 1005, t);
      inkLine(bx - 16, by, bx + 16, by + (rng() - 0.5) * 3, 1.3, rng, 0.8, '#FFF9EE', 0.55);
    }
    // Stepping stones across brook
    for (const [sx, sy, sr] of [[315, 868, 18], [358, 882, 20], [404, 892, 19]]) {
      const st = makeOrganicOval(sx, sy, sr, sr * 0.48, 7, rng, 0.16);
      wcWash(st, { color: '#DBD0BC', color2: '#9A8C78', layers: 10, alpha: 0.16, depth: 1, spread: 0.10, wetEdge: true }, rng);
      inkPolyline([...st, st[0]], 1.0, rng, 0.5, '#4A3C30', 0.55);
    }

    // Foreground grassy knoll on right-third
    const knoll = [[450, 1035], [510, 825], [680, 765], [860, 778], [1045, 835], [1045, 1035]];
    wcWash(knoll, { color: '#83A766', color2: '#446848', layers: 22, alpha: 0.078, depth: 2, spread: 0.14, wetEdge: true, highlightColor: '#DFD88A', highlightLayers: 4 }, rng);

    // Plane 4: Charming crooked hand-drawn wooden trail signpost on grassy knoll
    const postX = 720, postBaseY = 865, postTopY = 555;
    wcTrunkSegment(postX, postBaseY, postX - 10, postTopY, 26, 20, '#966A47', '#543826', rng, true);

    // Directional arrow planks (2 planks pointing left & right)
    const plank1 = [[604, 622], [770, 608], [786, 626], [770, 646], [604, 654], [584, 638]];
    wcWash(plank1, { color: '#DFC092', color2: '#A87F54', layers: 14, alpha: 0.15, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...plank1, plank1[0]], 1.5, rng, 0.8);
    // Decorative lettering squiggles on plank 1
    inkQuadCurve(622, 634, 665, 628, 712, 631, 1.3, rng, 1.4, '#4E3524', 0.65);
    inkQuadCurve(724, 629, 742, 625, 756, 628, 1.2, rng, 1.2, '#4E3524', 0.65);

    const plank2 = [[642, 672], [818, 682], [840, 700], [816, 716], [642, 706]];
    wcWash(plank2, { color: '#D8B788', color2: '#9E754B', layers: 14, alpha: 0.15, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...plank2, plank2[0]], 1.5, rng, 0.8);
    inkQuadCurve(664, 691, 715, 696, 782, 697, 1.3, rng, 1.4, '#4E3524', 0.65);

    // Tiny perched robin silhouette on top of the signpost
    const rx = postX - 10, ry = postTopY - 12;
    const rBody = makeOrganicOval(rx, ry, 13, 9.5, 7, rng, 0.14, -0.2);
    wcWash(rBody, { color: '#6E5346', color2: '#3F2D25', layers: 9, alpha: 0.22, depth: 1, spread: 0.10, wetEdge: true }, rng);
    const rBreast = makeOrganicOval(rx - 5, ry + 2, 7, 6.5, 6, rng, 0.12);
    tracePoly(rBreast);
    ctx.fillStyle = rgbaHex('#D46C45', 0.86);
    ctx.fill();
    const rHead = makeOrganicOval(rx - 9, ry - 8, 6.5, 6.0, 6, rng, 0.10);
    tracePoly(rHead);
    ctx.fillStyle = rgbaHex('#564036', 0.90);
    ctx.fill();
    inkLine(rx - 14, ry - 9, rx - 21, ry - 8, 1.4, rng, 0.2, '#3A281C', 0.88);
    inkLine(rx + 10, ry - 2, rx + 24, ry - 11, 2.0, rng, 0.3, '#4B362C', 0.85);

    // Plane 5: Windswept meadow grasses, daisies, wild thyme & clover
    drawMeadowBotanicals(805, 1025, 180, rng, {
      grassColors: ['#365740', '#507852', '#6C925E'],
      flowerColors: ['#FFF9EC', '#F6CF65', '#C2A3D2', '#E08765'],
      scale: 1.05,
    });
  }

  // -------------------------------------------------------------------------
  // PAGE 04: Enchanted Giant Oak Treehouse Library
  // -------------------------------------------------------------------------
  function drawScene_page_04(rng) {
    // Plane 1: Warm amber afternoon sky
    renderSkyPass({
      seed: 505.4,
      skyTop: '#7D9FB8',
      skyMid: '#C9C9BC',
      skyHorizon: '#F2C684',
      sunPos: [0.80, 0.36],
      sunColor: '#FFE8AD',
      sunRadius: 2.5,
      bloomStrength: 0.56,
      cloudAmount: 0.40,
      cloudTint: '#D8C5B8',
      horizonY: 0.72,
      granulation: 0.055,
    });

    // Plane 2: Misty treetop canopy sea in soft blue-sage
    wcHillBand(680, 48, 3.2, 0.8, '#90A79F', '#657F79', rng, { layers: 16, alpha: 0.058 });
    wcHillBand(760, 45, 2.8, 2.5, '#6F8B78', '#486657', rng, { layers: 18, alpha: 0.068 });

    // Plane 3: Secondary tree platform on right + swinging plank-and-rope suspension bridge
    wcTrunkSegment(935, 1030, 905, 420, 128, 80, '#6B4932', '#3A281E', rng, true);
    const rightPlat = makeOrganicRect(795, 575, 165, 22, rng, 1.5);
    wcWash(rightPlat, { color: '#8F6240', color2: '#5A3B26', layers: 12, alpha: 0.16, depth: 1, spread: 0.08, wetEdge: true }, rng);
    inkPolyline([...rightPlat, rightPlat[0]], 1.4, rng, 0.7);

    // Suspension bridge curving from treehouse balcony (x=590, y=560) to right platform (x=815, y=580)
    inkQuadCurve(590, 560, 705, 612, 815, 580, 2.2, rng, 0.9, '#4A3122', 0.82);
    inkQuadCurve(590, 524, 705, 575, 815, 544, 1.5, rng, 0.9, '#4A3122', 0.78);
    for (let i = 1; i <= 11; i++) {
      const t = i / 12;
      const omt = 1 - t;
      const bx = omt * omt * 590 + 2 * omt * t * 705 + t * t * 815;
      const by = omt * omt * 560 + 2 * omt * t * 612 + t * t * 580;
      const ry = omt * omt * 524 + 2 * omt * t * 575 + t * t * 544;
      inkLine(bx, ry, bx, by, 1.0, rng, 0.6, '#5A3D2B', 0.70);
      const plank = makeOrganicRect(bx - 7, by - 4, 14, 9, rng, 0.6);
      wcWash(plank, { color: '#A3724C', color2: '#6A472E', layers: 6, alpha: 0.22, depth: 1, spread: 0.08, wetEdge: false }, rng);
    }

    // Plane 4: Monumental ancient oak trunk cradling multi-tiered treehouse library
    wcTrunkSegment(420, 1040, 428, 565, 240, 175, '#785137', '#3D291E', rng, true);
    wcTrunkSegment(385, 650, 140, 405, 76, 30, '#724D34', '#3B281D', rng, true);
    wcTrunkSegment(490, 630, 680, 420, 62, 24, '#724D34', '#3B281D', rng, true);
    wcTrunkSegment(415, 580, 285, 220, 64, 22, '#724D34', '#3B281D', rng, true);
    wcTrunkSegment(465, 575, 605, 210, 58, 22, '#724D34', '#3B281D', rng, true);

    // Rich surrounding oak foliage canopy
    const oakLibPal = {
      shadow: ['#284437', '#385745'],
      mid: ['#4E7254', '#65885B', '#42644C'],
      light: ['#9DB46B', '#D3CA78', '#E5D388'],
    };
    wcBrushDabCluster(215, 235, 215, 165, oakLibPal, 115, rng, { lightDir: [0.6, -0.3] });
    wcBrushDabCluster(645, 215, 215, 160, oakLibPal, 115, rng, { lightDir: [0.5, -0.4] });
    wcBrushDabCluster(440, 130, 245, 130, oakLibPal, 110, rng, { lightDir: [0.4, -0.5] });
    wcBrushDabCluster(910, 325, 155, 135, oakLibPal, 85, rng, { lightDir: [-0.4, -0.4] });

    // Wooden balcony deck supporting treehouse
    const deck = makeOrganicRect(245, 558, 365, 26, rng, 1.5);
    wcWash(deck, { color: '#9E6E47', color2: '#5D3C27', layers: 14, alpha: 0.16, depth: 1, spread: 0.08, wetEdge: true }, rng);
    inkPolyline([...deck, deck[0]], 1.6, rng, 0.7);
    // Wooden diagonal deck struts
    inkLine(285, 584, 342, 655, 4.2, rng, 0.8, '#4E3323', 0.85);
    inkLine(565, 584, 512, 655, 4.2, rng, 0.8, '#4E3323', 0.85);

    // Multi-tiered treehouse wooden body
    const houseBody = makeOrganicRect(288, 385, 276, 174, rng, 2.0);
    wcWash(houseBody, { color: '#C69362', color2: '#855838', layers: 20, alpha: 0.13, depth: 2, spread: 0.07, wetEdge: true, highlightColor: '#ECD09F', highlightLayers: 3 }, rng);
    inkPolyline([...houseBody, houseBody[0]], 1.7, rng, 0.8);
    // Horizontal timber plank lines
    for (let py = 408; py < 555; py += 20) {
      inkLine(290, py, 562, py + (rng() - 0.5) * 2, 0.85, rng, 0.6, '#4D3221', 0.45);
    }

    // Upper reading turret on left side
    const turret = makeOrganicRect(298, 290, 114, 98, rng, 1.5);
    wcWash(turret, { color: '#CCA06E', color2: '#895E3E', layers: 16, alpha: 0.14, depth: 1, spread: 0.07, wetEdge: true }, rng);
    inkPolyline([...turret, turret[0]], 1.5, rng, 0.7);

    // Crooked cedar-shingle roofs (main + pointed turret roof)
    const mainRoof = [[258, 398], [430, 315], [596, 398], [568, 408], [285, 408]];
    wcWash(mainRoof, { color: '#B55B3D', color2: '#753422', layers: 20, alpha: 0.13, depth: 2, spread: 0.08, wetEdge: true }, rng);
    inkPolyline([[258, 398], [430, 315], [596, 398]], 1.8, rng, 1.0);

    const turretRoof = [[276, 298], [356, 202], [434, 298]];
    wcWash(turretRoof, { color: '#BF6243', color2: '#7C3926', layers: 18, alpha: 0.14, depth: 2, spread: 0.08, wetEdge: true }, rng);
    inkPolyline([...turretRoof, turretRoof[0]], 1.8, rng, 0.9);

    // Glowing arched leaded-glass windows with tiny bookshelf silhouettes inside!
    const windows = [[355, 342, 24, 30], [362, 472, 34, 46], [488, 472, 36, 46]];
    for (const [wx, wy, wrx, wry] of windows) {
      drawGlow(wx, wy, wrx * 3.4, '#FFF8DA', '#F7BC5E', 0.58, 'screen');
      const arch = [
        [wx - wrx, wy + wry], [wx - wrx, wy - wry * 0.25],
        [wx - wrx * 0.65, wy - wry * 0.85], [wx, wy - wry],
        [wx + wrx * 0.65, wy - wry * 0.85], [wx + wrx, wy - wry * 0.25], [wx + wrx, wy + wry],
      ];
      wcWash(arch, { color: '#FFF8D8', color2: '#F3B85B', layers: 12, alpha: 0.20, depth: 1, spread: 0.05, wetEdge: true }, rng);
      // Tiny book spine silhouettes along bottom sill inside window
      if (wrx > 26) {
        for (let bx = wx - wrx + 6; bx < wx + wrx - 8; bx += 7) {
          const bh = randRange(rng, 10, 18);
          inkLine(bx, wy + wry - 3, bx + (rng() - 0.5) * 1.5, wy + wry - 3 - bh, 3.2, rng, 0.2, '#7D4C32', 0.48);
        }
      }
      inkPolyline([...arch, arch[0]], 1.5, rng, 0.5, '#3A281C', 0.85);
      inkLine(wx, wy - wry, wx, wy + wry, 1.0, rng, 0.4, '#3A281C', 0.72);
      inkLine(wx - wrx, wy + 2, wx + wrx, wy + 2, 1.0, rng, 0.4, '#3A281C', 0.72);
    }

    // Balcony railing
    inkLine(248, 526, 608, 526, 2.0, rng, 0.8, '#4E3220', 0.82);
    for (let rx = 256; rx <= 600; rx += 24) {
      inkLine(rx, 526, rx, 560, 1.3, rng, 0.5, '#4E3220', 0.76);
    }

    // Rope ladder hanging down from balcony on left
    inkQuadCurve(282, 582, 266, 765, 294, 965, 1.6, rng, 0.9, '#4A3122', 0.80);
    inkQuadCurve(322, 582, 306, 765, 334, 965, 1.6, rng, 0.9, '#4A3122', 0.80);
    for (let ly = 608; ly <= 948; ly += 28) {
      const shift = Math.sin((ly - 582) * 0.008) * -12;
      inkLine(280 + shift, ly, 322 + shift, ly + 2, 2.6, rng, 0.5, '#6B482E', 0.82);
    }

    // Hanging glowing paper lanterns from branches
    drawHangingLantern(215, 455, 13, '#F6C062', '#E69B4A', rng, 395);
    drawHangingLantern(632, 462, 12, '#F6C062', '#E59654', rng, 405);
    drawHangingLantern(778, 525, 11, '#F6C062', '#E8A555', rng, 465);

    // Calm perched owl silhouette on upper-right branch
    const ox = 648, oy = 374;
    const oBody = makeOrganicOval(ox, oy, 14, 20, 8, rng, 0.12);
    wcWash(oBody, { color: '#6E5544', color2: '#3B2C24', layers: 10, alpha: 0.24, depth: 1, spread: 0.08, wetEdge: true }, rng);
    const oHead = makeOrganicOval(ox, oy - 20, 11, 10, 7, rng, 0.10);
    wcWash(oHead, { color: '#6E5544', color2: '#3B2C24', layers: 9, alpha: 0.24, depth: 1, spread: 0.08, wetEdge: true }, rng);
    inkLine(ox - 8, oy - 28, ox - 11, oy - 34, 1.8, rng, 0.3);
    inkLine(ox + 8, oy - 28, ox + 11, oy - 34, 1.8, rng, 0.3);

    // Plane 5: Foreground framing oak boughs & floating warm dust motes/sparks
    wcBrushDabCluster(65, 935, 140, 115, oakLibPal, 75, rng, { dabMin: 11, dabMax: 26, alpha: 0.28 });
    wcBrushDabCluster(955, 940, 145, 115, oakLibPal, 75, rng, { dabMin: 11, dabMax: 26, alpha: 0.28 });
    drawFireflies(28, 130, 880, 290, 860, rng, '#FFE48C');
  }

  // -------------------------------------------------------------------------
  // PAGE 05: Misty Arched Stone Bridge & Weeping Willows
  // -------------------------------------------------------------------------
  function drawScene_page_05(rng) {
    // Plane 1: Pale pearl-apricot sunlit mist & soft teal-sage atmosphere
    renderSkyPass({
      seed: 606.1,
      skyTop: '#9AC0C0',
      skyMid: '#D8E3D9',
      skyHorizon: '#F5E7CF',
      sunPos: [0.50, 0.36],
      sunColor: '#FFF7E0',
      sunRadius: 2.2,
      bloomStrength: 0.65,
      cloudAmount: 0.35,
      cloudTint: '#D8DCD4',
      horizonY: 0.56,
      granulation: 0.052,
    });

    // Plane 2: Soft pale sunlit mist dissolving distant riverbanks
    wcHillBand(492, 34, 2.2, 0.7, '#B4C9C2', '#8FAEA9', rng, { layers: 16, alpha: 0.055 });
    wcHillBand(538, 28, 1.9, 2.4, '#8BA994', '#638474', rng, { layers: 18, alpha: 0.062 });
    drawGlow(512, 495, 220, '#FFF8E4', '#F3DFBE', 0.45, 'screen');

    // Plane 3: Shimmering turquoise forest brook filling lower half
    wcWaterSurface(555, 1024, '#B9DBD7', '#7BB0B2', '#44767F', '#FFF5DD', rng, {
      shimmerX: 512,
      shimmerW: 250,
      foam: true,
    });

    // Soft mossy riverbanks anchoring left & right ends of bridge
    const bankL = [[-30, 560], [275, 575], [310, 648], [215, 725], [-30, 745]];
    wcWash(bankL, { color: '#78966D', color2: '#3E5B49', layers: 20, alpha: 0.08, depth: 2, spread: 0.14, wetEdge: true }, rng);
    const bankR = [[1054, 558], [755, 575], [718, 648], [815, 728], [1054, 748]];
    wcWash(bankR, { color: '#78966D', color2: '#3E5B49', layers: 20, alpha: 0.08, depth: 2, spread: 0.14, wetEdge: true }, rng);

    // Subtle reflection of bridge arch in the turquoise brook
    const archRefl = [
      [255, 650], [770, 650], [755, 775], [645, 755], [512, 705], [380, 755], [270, 775],
    ];
    wcWash(archRefl, { color: '#6E7C7A', color2: '#466870', layers: 14, alpha: 0.055, depth: 2, spread: 0.18, wetEdge: false }, rng);

    // Plane 4: Graceful semicircular mossy cobblestone arch bridge (x = 225..800)
    const bridgePts = [
      [220, 656], [228, 564], [360, 514], [512, 496], [664, 514], [796, 564], [804, 656],
      [670, 656], [648, 608], [596, 566], [512, 550], [428, 566], [376, 608], [354, 656],
    ];
    wcWash(bridgePts, {
      color: '#C9BCA9',
      color2: '#897F74',
      layers: 24,
      alpha: 0.105,
      depth: 2,
      spread: 0.07,
      wetEdge: true,
      edgeDarken: 12,
      highlightColor: '#F5EAD6',
      highlightLayers: 4,
    }, rng);

    // Shadow underside of stone arch vault
    const vault = [
      [354, 656], [376, 608], [428, 566], [512, 550], [596, 566], [648, 608], [670, 656],
      [642, 656], [616, 616], [575, 582], [512, 570], [449, 582], [408, 616], [382, 656],
    ];
    wcWash(vault, { color: '#646A6F', color2: '#3B4852', layers: 14, alpha: 0.10, depth: 1, spread: 0.08, wetEdge: false }, rng);

    // Sepia-ink stone voussoirs around the arch + parapet coping stones
    inkQuadCurve(226, 564, 512, 466, 798, 564, 2.0, rng, 1.0, '#46372C', 0.80);
    inkQuadCurve(226, 594, 512, 502, 798, 594, 1.5, rng, 0.9, '#46372C', 0.72);
    inkQuadCurve(354, 656, 512, 460, 670, 656, 2.0, rng, 0.8, '#3A281C', 0.84);
    for (let i = 0; i <= 14; i++) {
      const a = Math.PI + (i / 14) * Math.PI;
      const x1 = 512 + Math.cos(a) * 156;
      const y1 = 652 + Math.sin(a) * 102;
      const x2 = 512 + Math.cos(a) * 180;
      const y2 = 652 + Math.sin(a) * 124;
      inkLine(x1, y1, x2, y2, 1.1, rng, 0.5, '#4A392E', 0.68);
    }
    // Parapet vertical stone joints
    for (let px = 260; px <= 764; px += 36) {
      const t = (px - 226) / 572;
      const pyTop = 564 - Math.sin(t * Math.PI) * 68;
      inkLine(px, pyTop, px, pyTop + 30, 0.95, rng, 0.5, '#524236', 0.55);
    }
    // Soft moss accents on bridge stones
    wcBrushDabCluster(325, 595, 42, 22, { shadow: ['#486950'], mid: ['#6B8D63'], light: ['#9FB474'] }, 26, rng, { dabMin: 5, dabMax: 12, alpha: 0.24, skyPeeps: false });
    wcBrushDabCluster(702, 598, 42, 22, { shadow: ['#486950'], mid: ['#6B8D63'], light: ['#9FB474'] }, 26, rng, { dabMin: 5, dabMax: 12, alpha: 0.24, skyPeeps: false });

    // Graceful weeping willows framing both sides with cascading painterly fronds
    wcTrunkSegment(82, 740, 128, 390, 96, 54, '#735942', '#423328', rng, true);
    wcTrunkSegment(946, 740, 898, 385, 96, 54, '#735942', '#423328', rng, true);

    const willowPal = {
      shadow: ['#3B5C4E', '#4C6E5B'],
      mid: ['#6B8F6E', '#82A67D', '#5F8466'],
      light: ['#B2C98A', '#D9DC9E', '#EAE2AE'],
    };
    wcBrushDabCluster(135, 225, 220, 165, willowPal, 125, rng, { lightDir: [0.5, 0.3] });
    wcBrushDabCluster(895, 220, 220, 165, willowPal, 125, rng, { lightDir: [-0.5, 0.3] });

    // Trailing weeping willow curtains draping gracefully toward the water
    function drawWillowCurtain(xStart, xEnd, yTop, yMaxDrop) {
      for (let x = xStart; x <= xEnd; x += randRange(rng, 12, 20)) {
        const drop = randRange(rng, yMaxDrop * 0.55, yMaxDrop);
        const sway = (rng() - 0.5) * 32;
        const y0 = yTop + randRange(rng, -40, 55);
        inkQuadCurve(x, y0, x + sway * 0.5, y0 + drop * 0.5, x + sway, y0 + drop, randRange(rng, 0.9, 1.6), rng, 0.9, '#4D6D54', 0.58);
        const leaves = Math.round(drop / 18);
        for (let l = 0; l < leaves; l++) {
          const lt = l / leaves;
          const lx = lerp(x, x + sway, lt) + (rng() - 0.5) * 9;
          const ly = y0 + lt * drop;
          const lf = makeOrganicOval(lx, ly, randRange(rng, 3.5, 6.2), randRange(rng, 9, 16), 5, rng, 0.18, (rng() - 0.5) * 0.3);
          tracePoly(lf);
          ctx.fillStyle = rgbaHex(l % 3 === 0 ? '#9BB87A' : (l % 2 === 0 ? '#6F926E' : '#4E7058'), randRange(rng, 0.34, 0.62));
          ctx.fill();
        }
      }
    }
    drawWillowCurtain(12, 305, 195, 455);
    drawWillowCurtain(725, 1012, 190, 455);

    // Plane 5: Floating lily pads, cream-pink water lilies, river reeds & mossy pebbles
    const pads = [[248, 865, 48], [322, 892, 38], [678, 855, 44], [748, 895, 52], [442, 945, 42], [585, 928, 36]];
    for (const [px, py, pr] of pads) {
      const pad = makeOrganicOval(px, py, pr, pr * 0.40, 9, rng, 0.15);
      wcWash(pad, { color: '#789A6D', color2: '#3E624D', layers: 11, alpha: 0.16, depth: 1, spread: 0.10, wetEdge: true }, rng);
      inkPolyline([...pad, pad[0]], 0.9, rng, 0.5, '#344F3E', 0.45);
      // Cream-pink water lily blossom on selected pads
      if (pr > 40) {
        for (let p = 0; p < 7; p++) {
          const a = (p / 7) * Math.PI * 2;
          const pet = makeOrganicOval(px + Math.cos(a) * 11, py - 4 + Math.sin(a) * 5, 10, 5.5, 5, rng, 0.16, a);
          tracePoly(pet);
          ctx.fillStyle = rgbaHex(p % 2 === 0 ? '#FFF7EB' : '#F4CFD0', 0.85);
          ctx.fill();
        }
        const ctr = makeOrganicOval(px, py - 4, 5, 3, 5, rng, 0.15);
        tracePoly(ctr);
        ctx.fillStyle = 'rgba(244, 200, 102, 0.92)';
        ctx.fill();
      }
    }
    // River reeds in lower corners
    for (const [rxStart, rxEnd] of [[15, 185], [845, 1010]]) {
      for (let i = 0; i < 24; i++) {
        const rx = randRange(rng, rxStart, rxEnd);
        const rh = randRange(rng, 110, 240);
        const lean = randRange(rng, -24, 24);
        inkQuadCurve(rx, 1030, rx + lean * 0.4, 1030 - rh * 0.5, rx + lean, 1030 - rh, 2.0, rng, 0.9, '#3A5848', 0.72);
        if (i % 5 === 0) {
          const cattail = makeOrganicOval(rx + lean * 0.92, 1030 - rh * 0.86, 5.5, 16, 6, rng, 0.12, lean * 0.008);
          tracePoly(cattail);
          ctx.fillStyle = rgbaHex('#6B442C', 0.85);
          ctx.fill();
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // PAGE 06: Golden-Hour Pine Clearing & Sunbeams
  // -------------------------------------------------------------------------
  function drawScene_page_06(rng) {
    // Plane 1: Rich late-afternoon honey-gold & dusty amber haze
    renderSkyPass({
      seed: 707.5,
      skyTop: '#6A838A',
      skyMid: '#DDA76C',
      skyHorizon: '#F8D487',
      sunPos: [0.16, 0.18],
      sunColor: '#FFF3C0',
      sunRadius: 2.0,
      bloomStrength: 0.76,
      cloudAmount: 0.25,
      cloudTint: '#DFB384',
      horizonY: 0.68,
      granulation: 0.056,
    });

    // Plane 2: Vertical cathedral of misty backlit distant pine trunks
    for (let i = 0; i < 16; i++) {
      const tx = lerp(40, 990, i / 15) + (rng() - 0.5) * 35;
      const tw = randRange(rng, 12, 26);
      wcTrunkSegment(tx, 740, tx + (rng() - 0.5) * 14, 110, tw, tw * 0.45, '#B79C7A', '#7C6D5F', rng, false);
    }
    drawGlow(200, 210, 320, '#FFF7D0', '#F3B85C', 0.62, 'screen');

    // Plane 3: Mossy pine clearing & sunlit grass patches
    wcHillBand(685, 32, 1.7, 1.3, '#7C935B', '#37513D', rng, { layers: 22, alpha: 0.072, ridgeHighlight: '#F2CA78' });
    // Warm sunlit clearing pool on grass
    const sunPool = makeOrganicOval(565, 845, 235, 76, 10, rng, 0.20);
    wcWash(sunPool, { color: '#F3D081', color2: '#9EB064', layers: 16, alpha: 0.085, depth: 2, spread: 0.18, wetEdge: false }, rng);

    // Curving flat mossy stepping stones
    for (const [sx, sy, sr] of [[420, 748, 22], [472, 782, 25], [532, 820, 28], [595, 868, 32], [652, 926, 36]]) {
      const st = makeOrganicOval(sx, sy, sr, sr * 0.44, 7, rng, 0.18);
      wcWash(st, { color: '#CFC2A8', color2: '#897E6B', layers: 10, alpha: 0.14, depth: 1, spread: 0.12, wetEdge: true }, rng);
    }

    // Plane 4: Tall slender pines framing both sides of the clearing
    const pinePal = {
      shadow: ['#223831', '#2E493D'],
      mid: ['#3E5E4A', '#4F7054'],
      light: ['#7B935E', '#B4A964'],
    };
    wcPineTree(145, 785, 590, 225, pinePal, rng, '#7A4D34', 0.28);
    wcPineTree(285, 730, 510, 175, pinePal, rng, '#7A4D34', 0.25);
    wcPineTree(760, 745, 540, 195, pinePal, rng, '#784A32', 0.26);
    wcPineTree(905, 800, 610, 235, pinePal, rng, '#70442E', 0.28);

    // Dramatic diagonal volumetric golden god-rays slanting from upper-left across clearing
    drawLightBeam(140, 20, 585, 855, 65, 250, '#FFE799', 0.26);
    drawLightBeam(250, 0, 775, 835, 52, 210, '#FFE28D', 0.20);
    drawLightBeam(40, 110, 415, 865, 48, 185, '#FFEB9F', 0.17);

    // Poetic back-view traveler holding glowing brass lantern + companion
    drawBackViewTraveler(545, 842, 0.94, '#4B6B5C', rng, { hasLantern: true, companion: 'fox' });

    // Plane 5: Silhouetted foreground pine boughs, bracken ferns & drifting glowing dandelion seeds
    drawFernFrond(35, 995, 225, -0.75, '#253D32', rng, 0.84);
    drawFernFrond(120, 1020, 180, -0.45, '#3C5B45', rng, 0.76);
    drawFernFrond(985, 995, 225, -2.38, '#253D32', rng, 0.84);
    drawFernFrond(885, 1020, 185, -2.65, '#3C5B45', rng, 0.76);

    drawMeadowBotanicals(845, 1025, 130, rng, {
      grassColors: ['#273F33', '#3E5E46', '#617C4E'],
      flowerColors: ['#FFF6DA', '#F7CE6A', '#E39A58'],
    });

    // Luminous dandelion puffs & drifting cottony dandelion seeds catching sunbeams
    for (const [dx, dy, dr] of [[240, 895, 22], [285, 935, 18], [748, 912, 21]]) {
      inkQuadCurve(dx, 1015, dx - 6, dy + 45, dx, dy, 1.5, rng, 0.7, '#425E44', 0.72);
      drawGlow(dx, dy, dr * 2.1, '#FFFDF2', '#FFE69D', 0.55, 'screen');
      const puff = makeOrganicOval(dx, dy, dr, dr, 10, rng, 0.16);
      wcWash(puff, { color: '#FFFDF5', color2: '#F2DFB4', layers: 10, alpha: 0.14, depth: 1, spread: 0.16, wetEdge: true }, rng);
      for (let r = 0; r < 14; r++) {
        const a = (r / 14) * Math.PI * 2;
        inkLine(dx, dy, dx + Math.cos(a) * dr * 0.92, dy + Math.sin(a) * dr * 0.92, 0.65, rng, 0.3, '#FFF9EA', 0.65);
      }
    }
    // Floating dandelion seeds
    for (let s = 0; s < 26; s++) {
      const sx = randRange(rng, 220, 820);
      const sy = randRange(rng, 260, 840);
      drawGlow(sx, sy, 14, '#FFFDF4', '#FFE28A', 0.45, 'screen');
      inkLine(sx, sy, sx + 5, sy + 9, 0.7, rng, 0.3, '#FFF8E6', 0.72);
      inkLine(sx - 4, sy - 3, sx + 4, sy - 3, 0.8, rng, 0.3, '#FFF8E6', 0.72);
    }
  }

  // -------------------------------------------------------------------------
  // PAGE 07: Patchwork Hot-Air Balloon Above Misty Valleys
  // -------------------------------------------------------------------------
  function drawScene_page_07(rng) {
    // Plane 1: Dreamy rosy-apricot sunset -> dusty violet-cerulean zenith
    renderSkyPass({
      seed: 808.3,
      skyTop: '#6B84AC',
      skyMid: '#C79DB0',
      skyHorizon: '#F4BA94',
      sunPos: [0.24, 0.68],
      sunColor: '#FFE8B8',
      sunRadius: 2.3,
      bloomStrength: 0.60,
      cloudAmount: 0.52,
      cloudTint: '#D6A9B0',
      horizonY: 0.78,
      granulation: 0.052,
    });

    // Plane 2: Miniature rolling misty valleys & tiny silver river FAR BELOW (y = 750..1024)
    wcHillBand(785, 36, 2.8, 0.6, '#96A0B8', '#6B7E96', rng, { layers: 16, alpha: 0.062 });
    wcHillBand(848, 34, 2.4, 2.1, '#7D9884', '#4E6E64', rng, { layers: 18, alpha: 0.072, ridgeHighlight: '#EBC89E' });
    wcHillBand(918, 30, 2.1, 0.2, '#6A886D', '#3E5E52', rng, { layers: 20, alpha: 0.078 });
    // Tiny winding silver river in the distant valley
    inkQuadCurve(120, 885, 480, 935, 895, 865, 6.5, rng, 2.5, '#EBF2F0', 0.42);
    inkQuadCurve(120, 885, 480, 935, 895, 865, 2.5, rng, 1.5, '#FFF8E8', 0.65);

    // Plane 3: Pillowy rosy-gold watercolor cotton clouds drifting across lower-mid sky
    wcCloudPuff(205, 675, 340, 118, '#FDECE0', '#D7A8AE', rng, 0.064);
    wcCloudPuff(795, 695, 360, 124, '#FDECE0', '#CFA1AC', rng, 0.064);
    wcCloudPuff(495, 765, 390, 110, '#FCE5D6', '#CE9EA9', rng, 0.058);
    wcCloudPuff(230, 250, 260, 86, '#FFF4E8', '#D3B0BC', rng, 0.048);

    // Plane 4: Majestic vintage patchwork hot-air balloon (upper-right center x=545, y=355)
    const bx = 545, by = 345, bRx = 188, bRy = 206;

    function balloonX(u, v) {
      // Bulbous teardrop envelope profile: v in [-1 (top), 1 (throat)]
      const profile = v < 0.15
        ? Math.sqrt(Math.max(0, 1 - Math.pow((v + 0.12) / 0.92, 2)))
        : lerp(0.955, 0.22, Math.pow((v - 0.15) / 0.85, 1.05));
      return bx + u * bRx * profile;
    }
    function balloonY(v) { return by + v * bRy; }

    // Paint 7 curved vertical patchwork gores (alternating terracotta, honey ochre, sage, twilight indigo)
    const goreColors = [
      ['#C96848', '#994530'],
      ['#F2C572', '#CE9345'],
      ['#6E9378', '#466754'],
      ['#C96848', '#98432E'],
      ['#4A5E84', '#2F3F60'],
      ['#F2C572', '#C98E44'],
      ['#C26448', '#8E3E2A'],
    ];
    const goreEdges = [-1.0, -0.78, -0.48, -0.16, 0.16, 0.48, 0.78, 1.0];

    for (let g = 0; g < 7; g++) {
      const uL = goreEdges[g];
      const uR = goreEdges[g + 1];
      const poly = [];
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const v = lerp(-0.98, 1.0, i / steps);
        poly.push([balloonX(uL, v), balloonY(v)]);
      }
      for (let i = steps; i >= 0; i--) {
        const v = lerp(-0.98, 1.0, i / steps);
        poly.push([balloonX(uR, v), balloonY(v)]);
      }
      wcWash(poly, {
        color: goreColors[g][0],
        color2: goreColors[g][1],
        layers: 16,
        alpha: 0.13,
        depth: 1,
        spread: 0.05,
        wetEdge: true,
        edgeDarken: 8,
        lightAngle: -Math.PI * 0.15,
      }, rng);
    }

    // Horizontal decorative patchwork band across balloon equator
    const eqBand = [];
    for (let i = 0; i <= 14; i++) {
      const u = lerp(-1, 1, i / 14);
      eqBand.push([balloonX(u, -0.06), balloonY(-0.06) + Math.cos(u * Math.PI * 0.5) * 14]);
    }
    for (let i = 14; i >= 0; i--) {
      const u = lerp(-1, 1, i / 14);
      eqBand.push([balloonX(u, 0.12), balloonY(0.12) + Math.cos(u * Math.PI * 0.5) * 14]);
    }
    wcWash(eqBand, { color: '#FAF0D6', color2: '#DFC79C', layers: 14, alpha: 0.15, depth: 1, spread: 0.04, wetEdge: true }, rng);

    // Sepia ink gore seams & equator stitching
    for (const u of goreEdges) {
      const seam = [];
      for (let i = 0; i <= 14; i++) {
        const v = lerp(-0.98, 1.0, i / 14);
        seam.push([balloonX(u, v), balloonY(v)]);
      }
      inkPolyline(seam, Math.abs(u) > 0.9 ? 1.8 : 1.1, rng, 0.7, '#3A281C', 0.76);
    }
    inkPolyline(eqBand.slice(0, 15), 1.3, rng, 0.6, '#3A281C', 0.72);
    inkPolyline(eqBand.slice(15), 1.3, rng, 0.6, '#3A281C', 0.72);

    // Warm burner flame glow illuminating the throat
    const throatY = balloonY(1.0);
    drawGlow(bx, throatY + 12, 92, '#FFF9DB', '#F6B658', 0.72, 'screen');
    const flame = makeOrganicOval(bx, throatY + 16, 12, 18, 6, rng, 0.16);
    tracePoly(flame);
    ctx.fillStyle = 'rgba(255, 246, 210, 0.92)';
    ctx.fill();

    // Rigging ropes & woven wicker basket
    const basketY = throatY + 56;
    for (const rx of [-36, -15, 15, 36]) {
      inkLine(bx + rx, throatY, bx + rx * 0.82, basketY, 1.2, rng, 0.5, '#3A281C', 0.78);
    }
    const basket = makeOrganicRect(bx - 34, basketY, 68, 52, rng, 1.2);
    wcWash(basket, { color: '#C69358', color2: '#7C5430', layers: 16, alpha: 0.16, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...basket, basket[0]], 1.6, rng, 0.6);
    // Wicker cross-hatch weave
    for (let wy = basketY + 10; wy < basketY + 48; wy += 9) {
      inkLine(bx - 33, wy, bx + 33, wy, 0.85, rng, 0.4, '#4B3220', 0.62);
    }
    for (let wx = bx - 22; wx <= bx + 22; wx += 11) {
      inkLine(wx, basketY + 2, wx, basketY + 50, 0.8, rng, 0.4, '#4B3220', 0.52);
    }

    // Small fluttering pennant bunting draped on basket sides
    const penCols = ['#D46B48', '#F2C572', '#6E9378', '#FAF0D6'];
    for (let p = 0; p < 5; p++) {
      const px = lerp(bx - 32, bx + 26, p / 4);
      const pen = [[px, basketY + 6], [px + 11, basketY + 7], [px + 5, basketY + 20]];
      tracePoly(pen);
      ctx.fillStyle = rgbaHex(penCols[p % penCols.length], 0.88);
      ctx.fill();
      inkPolyline([...pen, pen[0]], 0.7, rng, 0.3, '#3A281C', 0.65);
    }

    // Gliding distant birds alongside balloon
    drawDistantBirds(285, 395, 5, 1.05, rng, '#513E3A');
    drawDistantBirds(825, 295, 3, 0.85, rng, '#513E3A');

    // Plane 5: Wispy translucent foreground cloud veils sweeping across bottom corners
    wcCloudPuff(115, 965, 320, 105, '#FFF5EA', '#D8B5BE', rng, 0.056);
    wcCloudPuff(915, 975, 320, 105, '#FFF5EA', '#D4B2BE', rng, 0.056);
  }

  // -------------------------------------------------------------------------
  // PAGE 08: Coastal Stone Lighthouse & Starry Indigo Sea
  // -------------------------------------------------------------------------
  function drawScene_page_08(rng) {
    // Plane 1: Deep luminous twilight indigo night sky (never pure black!)
    renderSkyPass({
      seed: 909.6,
      skyTop: '#1B2746',
      skyMid: '#2D4168',
      skyHorizon: '#5C7397',
      sunPos: [0.30, 0.31],
      sunColor: '#FFE296',
      sunRadius: 3.1,
      bloomStrength: 0.44,
      cloudAmount: 0.28,
      cloudTint: '#3D5076',
      horizonY: 0.60,
      granulation: 0.058,
    });
    drawStarSpatter(115, 560, rng);

    // Subtle starry watercolor cloud wisps
    wcCloudPuff(760, 175, 300, 78, '#6B82A8', '#2A3A5C', rng, 0.042);

    // Plane 2 & 3: Rolling deep-indigo ocean waves with golden beam reflection
    wcWaterSurface(598, 1024, '#3D567D', '#273C60', '#1B2A47', '#F6D587', rng, {
      shimmerX: 660,
      shimmerW: 260,
      foam: true,
    });

    // Lacy dry-brush cream seafoam breaking against the cliff rocks
    for (let i = 0; i < 38; i++) {
      const fx = randRange(rng, 280, 620);
      const fy = randRange(rng, 755, 935);
      const fw = randRange(rng, 18, 65);
      const foam = makeOrganicOval(fx, fy, fw, randRange(rng, 3.5, 9), 7, rng, 0.28);
      tracePoly(foam);
      ctx.fillStyle = rgbaHex('#F4EFE4', randRange(rng, 0.16, 0.44));
      ctx.fill();
    }

    // Plane 4: Rugged coastal ochre-slate cliffside on left-third
    const cliffPts = [
      [-30, 695], [140, 655], [325, 668], [418, 725], [475, 815], [538, 925], [575, 1035], [-30, 1035],
    ];
    wcWash(cliffPts, {
      color: '#8B745C',
      color2: '#3B363C',
      layers: 24,
      alpha: 0.105,
      depth: 2,
      spread: 0.13,
      wetEdge: true,
      edgeDarken: 12,
      highlightColor: '#C9AD82',
      highlightLayers: 4,
    }, rng);

    // Cliff rock facet lines in sepia ink
    inkPolyline([[140, 655], [325, 668], [418, 725], [475, 815]], 1.8, rng, 1.3, '#2E231D', 0.72);
    inkLine(325, 668, 285, 825, 1.3, rng, 1.6, '#2E231D', 0.55);
    inkLine(418, 725, 368, 885, 1.3, rng, 1.6, '#2E231D', 0.55);

    // Dramatic wide translucent golden lighthouse beam sweeping across dark sea toward upper-right!
    const lampX = 292, lampY = 306;
    drawLightBeam(lampX + 12, lampY, 1060, 170, 26, 290, '#FFE89B', 0.34);
    drawLightBeam(lampX + 12, lampY, 1060, 395, 22, 230, '#FFD97D', 0.20);
    drawLightBeam(lampX - 10, lampY, -40, 245, 20, 130, '#FFE494', 0.14);

    // Cozy stone keeper's cottage nestled beside lighthouse
    const kWall = makeOrganicRect(126, 594, 118, 74, rng, 1.4);
    wcWash(kWall, { color: '#E8DFCE', color2: '#9BA0AE', layers: 16, alpha: 0.15, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...kWall, kWall[0]], 1.4, rng, 0.7);
    const kRoof = [[112, 600], [185, 548], [254, 600]];
    wcWash(kRoof, { color: '#B45A3E', color2: '#6B3124', layers: 16, alpha: 0.16, depth: 1, spread: 0.07, wetEdge: true }, rng);
    inkPolyline([...kRoof, kRoof[0]], 1.5, rng, 0.7);
    // Warm glowing cottage window
    drawGlow(182, 632, 52, '#FFF7D4', '#F6B856', 0.65, 'screen');
    const kWin = makeOrganicRect(168, 618, 28, 28, rng, 0.8);
    wcWash(kWin, { color: '#FFF7D6', color2: '#F2B454', layers: 10, alpha: 0.22, depth: 1, spread: 0.05, wetEdge: true }, rng);
    inkPolyline([...kWin, kWin[0]], 1.2, rng, 0.4);
    inkLine(182, 618, 182, 646, 0.9, rng, 0.3);
    inkLine(168, 632, 196, 632, 0.9, rng, 0.3);

    // Sturdy tapered whitewashed stone lighthouse tower (x ~ 292)
    const tower = [[242, 672], [262, 344], [322, 344], [342, 672]];
    wcWash(tower, {
      color: '#F7F1E2',
      color2: '#96A2B5',
      layers: 22,
      alpha: 0.13,
      depth: 1,
      spread: 0.05,
      wetEdge: true,
      lightAngle: Math.PI * 0.05,
    }, rng);
    // Warm terracotta decorative horizontal lighthouse stripe
    const stripe = [[254, 488], [330, 488], [333, 536], [251, 536]];
    wcWash(stripe, { color: '#C25E41', color2: '#803929', layers: 16, alpha: 0.16, depth: 1, spread: 0.05, wetEdge: true }, rng);
    inkPolyline([...tower, tower[0]], 1.7, rng, 0.7);

    // Small glowing spiral-stair tower windows
    for (const wy of [415, 512, 598]) {
      drawGlow(292, wy, 24, '#FFF8D8', '#F6BD5C', 0.45, 'screen');
      const tw = makeOrganicRect(285, wy - 10, 14, 20, rng, 0.5);
      wcWash(tw, { color: '#FFF6D0', color2: '#F0B250', layers: 8, alpha: 0.22, depth: 1, spread: 0.05, wetEdge: true }, rng);
      inkPolyline([...tw, tw[0]], 1.1, rng, 0.3);
    }

    // Iron gallery balcony & railing
    const gallery = makeOrganicRect(248, 334, 88, 13, rng, 0.8);
    wcWash(gallery, { color: '#4B454B', color2: '#272936', layers: 12, alpha: 0.20, depth: 1, spread: 0.05, wetEdge: true }, rng);
    inkLine(246, 314, 338, 314, 1.5, rng, 0.4, '#2C2424', 0.88);
    for (let rx = 250; rx <= 334; rx += 12) {
      inkLine(rx, 314, rx, 334, 1.0, rng, 0.3, '#2C2424', 0.82);
    }

    // Blazing golden lantern room + terracotta dome
    drawGlow(lampX, lampY, 115, '#FFFCEE', '#FFE084', 0.78, 'screen');
    const lampBox = makeOrganicRect(268, 282, 48, 52, rng, 0.7);
    wcWash(lampBox, { color: '#FFFCE6', color2: '#F8CE6E', layers: 14, alpha: 0.24, depth: 1, spread: 0.04, wetEdge: true }, rng);
    inkPolyline([...lampBox, lampBox[0]], 1.4, rng, 0.4);
    inkLine(284, 282, 284, 334, 1.0, rng, 0.3);
    inkLine(300, 282, 300, 334, 1.0, rng, 0.3);

    const dome = [[262, 284], [274, 256], [292, 246], [310, 256], [322, 284]];
    wcWash(dome, { color: '#C25B3E', color2: '#753122', layers: 16, alpha: 0.18, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...dome, dome[0]], 1.5, rng, 0.5);
    inkLine(292, 246, 292, 224, 1.6, rng, 0.3, '#2E2320', 0.85);

    // Plane 5: Dark jagged coastal boulders & wind-swept cliff grasses
    for (const [bx, by, brx, bry] of [[120, 965, 110, 75], [325, 985, 95, 60], [870, 968, 120, 70]]) {
      const rock = makeOrganicOval(bx, by, brx, bry, 8, rng, 0.24);
      wcWash(rock, { color: '#454756', color2: '#23283A', layers: 16, alpha: 0.14, depth: 2, spread: 0.12, wetEdge: true }, rng);
    }
    drawMeadowBotanicals(725, 995, 78, rng, {
      xMin: 0,
      xMax: 390,
      grassColors: ['#293A3A', '#3D524B', '#586A5A'],
      flowerColors: ['#E6D5A8', '#D1A678'],
      nightMode: true,
    });
  }

  // -------------------------------------------------------------------------
  // PAGE 09: Twilight Celebratory Lantern Meadow
  // -------------------------------------------------------------------------
  function drawScene_page_09(rng) {
    // Plane 1: Enchanting twilight gradient (indigo -> violet-rose -> amber horizon)
    renderSkyPass({
      seed: 1010.8,
      skyTop: '#2D3C63',
      skyMid: '#867298',
      skyHorizon: '#E8AC72',
      sunPos: [0.50, 0.64],
      sunColor: '#F8CE8C',
      sunRadius: 2.3,
      bloomStrength: 0.56,
      cloudAmount: 0.34,
      cloudTint: '#7A6B8E',
      horizonY: 0.66,
      granulation: 0.056,
    });
    drawStarSpatter(65, 420, rng);

    // Plane 2: Soft dusky violet distant treeline across horizon
    wcHillBand(632, 32, 2.8, 0.9, '#6C6484', '#4B4C6D', rng, { layers: 18, alpha: 0.068 });

    // Plane 3: Gently sloping evening meadow
    wcHillBand(696, 36, 1.6, 2.2, '#4A6358', '#293D3B', rng, { layers: 22, alpha: 0.075 });

    // Plane 4: Pale silver-barked birch trees across midground + festive lantern garlands!
    const birchSpec = [
      { x: 112, baseY: 910, topY: 60, w: 58 },
      { x: 315, baseY: 825, topY: 90, w: 44 },
      { x: 525, baseY: 795, topY: 115, w: 38 },
      { x: 730, baseY: 830, topY: 85, w: 46 },
      { x: 922, baseY: 920, topY: 55, w: 60 },
    ];
    const birchFoliage = {
      shadow: ['#2B3E44', '#394F4E'],
      mid: ['#4F6B5D', '#627D68'],
      light: ['#8FA075', '#C7B67D'],
    };

    for (const b of birchSpec) {
      // Soft evening birch canopy
      wcBrushDabCluster(b.x + (rng() - 0.5) * 35, b.topY + 125, 130, 105, birchFoliage, 75, rng, { dabMin: 9, dabMax: 22, alpha: 0.24 });
      // Silver-white birch trunk
      wcTrunkSegment(b.x, b.baseY, b.x + (rng() - 0.5) * 18, b.topY, b.w, b.w * 0.55, '#EFE7D8', '#9D99A4', rng, true);
      // Distinctive sepia-ink horizontal birch bark lenticel dashes!
      for (let by = b.topY + 45; by < b.baseY - 20; by += randRange(rng, 14, 28)) {
        const bw = lerp(b.w * 0.55, b.w, (by - b.topY) / (b.baseY - b.topY));
        const lx = b.x + (rng() - 0.5) * bw * 0.45;
        const dashL = randRange(rng, bw * 0.22, bw * 0.58);
        inkLine(lx - dashL * 0.5, by, lx + dashL * 0.5, by + (rng() - 0.5) * 2, randRange(rng, 1.0, 2.2), rng, 0.4, '#3A2E2B', 0.72);
      }
    }

    // Festive garland strings draped gracefully between all 5 birch trunks with 16 glowing paper lanterns!
    const garlandSpans = [
      [112, 340, 315, 365, 65],
      [315, 365, 525, 385, 58],
      [525, 385, 730, 360, 60],
      [730, 360, 922, 335, 65],
      [112, 485, 315, 515, 52],
      [525, 525, 730, 505, 54],
      [730, 505, 922, 480, 52],
    ];
    const lanternHues = [
      ['#FFD97D', '#F2A94B'],
      ['#FFC88A', '#E68356'],
      ['#FFF0B8', '#EBB95E'],
      ['#F9B989', '#DC7A5C'],
    ];
    let lIdx = 0;
    for (const [x1, y1, x2, y2, sag] of garlandSpans) {
      const mx = (x1 + x2) * 0.5;
      const my = (y1 + y2) * 0.5 + sag;
      inkQuadCurve(x1, y1, mx, my, x2, y2, 1.2, rng, 0.7, '#3A281C', 0.72);
      const count = sag > 56 ? 3 : 2;
      for (let k = 1; k <= count; k++) {
        const t = k / (count + 1);
        const omt = 1 - t;
        const lx = omt * omt * x1 + 2 * omt * t * mx + t * t * x2;
        const ly = omt * omt * y1 + 2 * omt * t * my + t * t * y2;
        const sz = randRange(rng, 11.5, 16.5);
        const pal = lanternHues[lIdx++ % lanternHues.length];
        drawHangingLantern(lx, ly + sz * 1.15, sz, pal[0], pal[1], rng, ly);
      }
    }

    // Joyful small back-view traveler + companion silhouette gazing up in wonder
    drawBackViewTraveler(478, 862, 0.92, '#B6583C', rng, { hasLantern: false, companion: 'cat' });

    // Plane 5: Lush evening meadow silhouettes, swaying wildflower stalks & dozens of dancing fireflies
    drawMeadowBotanicals(815, 1025, 170, rng, {
      grassColors: ['#1E3033', '#2D4443', '#3E5750'],
      flowerColors: ['#F4C675', '#E99B74', '#C4A8D4', '#FFF2D2'],
      nightMode: true,
    });
    drawFireflies(56, 70, 955, 420, 960, rng, '#FFE485');
  }

  // -------------------------------------------------------------------------
  // PAGE 10: Moonlit Storybook Village Rooftops & Glowing Attic Window
  // -------------------------------------------------------------------------
  function drawScene_page_10(rng) {
    // Plane 1: Peaceful bedtime indigo night sky
    renderSkyPass({
      seed: 1111.2,
      skyTop: '#1A2542',
      skyMid: '#2D3E66',
      skyHorizon: '#4D618B',
      sunPos: [0.24, 0.21],
      sunColor: '#F5EFE0',
      sunRadius: 2.9,
      bloomStrength: 0.42,
      cloudAmount: 0.26,
      cloudTint: '#3D4F78',
      horizonY: 0.72,
      granulation: 0.056,
    });
    drawStarSpatter(130, 620, rng);

    // Luminous pale cream watercolor crescent moon (upper-left x=245, y=205) with soft silver halo
    const mx = 245, my = 205;
    drawGlow(mx, my, 165, '#FFFDF4', '#B9CBE6', 0.42, 'screen');
    drawGlow(mx, my, 78, '#FFFDF5', '#EAE4CE', 0.52, 'screen');
    // Organic crescent moon polygon (NEVER raw ctx.arc!)
    const moonPts = [];
    for (let i = 0; i <= 18; i++) {
      const a = lerp(-Math.PI * 0.42, Math.PI * 1.18, i / 18);
      moonPts.push([mx + Math.cos(a) * 52, my + Math.sin(a) * 52]);
    }
    for (let i = 18; i >= 0; i--) {
      const a = lerp(-Math.PI * 0.42, Math.PI * 1.18, i / 18);
      moonPts.push([mx + 22 + Math.cos(a) * 42, my - 10 + Math.sin(a) * 42]);
    }
    wcWash(moonPts, { color: '#FFFDF2', color2: '#E8DEC3', layers: 16, alpha: 0.16, depth: 1, spread: 0.05, wetEdge: true, edgeDarken: 3 }, rng);

    // Plane 2: Distant sleepy village rooftops & dark cypress silhouettes in blue night mist
    wcHillBand(665, 34, 2.2, 1.4, '#3A4A6E', '#253352', rng, { layers: 16, alpha: 0.075 });

    // Distant village skyline gables & chimneys
    const farRoofs = [
      [[20, 740], [115, 620], [210, 740]],
      [[175, 760], [295, 635], [415, 760]],
      [[380, 740], [485, 608], [595, 740]],
      [[545, 750], [665, 640], [785, 750]],
      [[760, 740], [885, 612], [1020, 740]],
    ];
    for (const r of farRoofs) {
      wcWash(r, { color: '#394666', color2: '#232E4A', layers: 14, alpha: 0.13, depth: 1, spread: 0.06, wetEdge: true }, rng);
      inkPolyline(r, 1.2, rng, 0.7, '#1B2236', 0.65);
    }
    // Tiny distant cozy village window lights
    for (const [wx, wy] of [[118, 695], [288, 705], [485, 682], [658, 712], [878, 686]]) {
      drawGlow(wx, wy, 26, '#FFE8A3', '#E8A852', 0.45, 'screen');
      const sw = makeOrganicRect(wx - 7, wy - 9, 14, 18, rng, 0.5);
      tracePoly(sw);
      ctx.fillStyle = 'rgba(255, 232, 160, 0.85)';
      ctx.fill();
    }

    // Sleepy dark cypress silhouettes between far roofs
    for (const [cx, cy, ch] of [[225, 725, 118], [412, 720, 105], [780, 715, 125]]) {
      const cyp = makeOrganicOval(cx, cy - ch * 0.5, 18, ch * 0.52, 8, rng, 0.18);
      wcWash(cyp, { color: '#263547', color2: '#1A2538', layers: 12, alpha: 0.16, depth: 1, spread: 0.10, wetEdge: false }, rng);
    }

    // Plane 3: Midground cascading slate-terracotta village rooftops & crooked chimneys
    const midRoofL = [[-20, 880], [165, 720], [375, 865], [375, 1030], [-20, 1030]];
    wcWash(midRoofL, { color: '#5A4A5B', color2: '#2C2F49', layers: 18, alpha: 0.13, depth: 1, spread: 0.07, wetEdge: true }, rng);
    inkPolyline([[-20, 880], [165, 720], [375, 865]], 1.8, rng, 0.9, '#201F2E', 0.78);
    // Crooked chimney on left roof
    const chL = [[82, 795], [86, 688], [126, 686], [130, 760]];
    wcWash(chL, { color: '#6E4E4E', color2: '#3B313E', layers: 14, alpha: 0.16, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...chL, chL[0]], 1.4, rng, 0.6, '#231F2C', 0.78);

    // Plane 4: Close-midground storybook gable wall & steeply pitched shingled roof (lower-right/center)
    // Main gable facade
    const gableWall = [[375, 1035], [375, 678], [625, 458], [875, 678], [875, 1035]];
    wcWash(gableWall, {
      color: '#B8AD9E',
      color2: '#5B6278',
      layers: 20,
      alpha: 0.13,
      depth: 2,
      spread: 0.06,
      wetEdge: true,
      lightAngle: -Math.PI * 0.75,
    }, rng);

    // Steeply pitched moonlit terracotta-slate eaves overhanging gable
    const gableRoofL = [[332, 702], [625, 428], [625, 472], [370, 718]];
    const gableRoofR = [[625, 428], [918, 702], [880, 718], [625, 472]];
    wcWash(gableRoofL, { color: '#7D4E4C', color2: '#3B3246', layers: 18, alpha: 0.16, depth: 1, spread: 0.06, wetEdge: true, highlightColor: '#D6D9E4', highlightLayers: 3 }, rng);
    wcWash(gableRoofR, { color: '#643E44', color2: '#2B283E', layers: 18, alpha: 0.16, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([[332, 702], [625, 428], [918, 702]], 2.4, rng, 1.0, '#1D1B2A', 0.88);
    // Decorative timber bargeboard trim
    inkLine(445, 632, 805, 632, 2.2, rng, 0.8, '#3B2F34', 0.75);
    inkLine(410, 882, 840, 882, 2.2, rng, 0.8, '#3B2F34', 0.70);

    // Single warm glowing arched attic bedroom window (heart of the bedtime scene!)
    const wx = 625, wy = 745, wrx = 74, wry = 94;
    drawGlow(wx, wy, 235, '#FFF8DA', '#F7BC5C', 0.66, 'screen');
    drawGlow(wx, wy, 120, '#FFFDF0', '#FFD882', 0.52, 'lighter');

    const archWin = [
      [wx - wrx, wy + wry], [wx - wrx, wy - wry * 0.18],
      [wx - wrx * 0.72, wy - wry * 0.76], [wx, wy - wry],
      [wx + wrx * 0.72, wy - wry * 0.76], [wx + wrx, wy - wry * 0.18], [wx + wrx, wy + wry],
    ];
    wcWash(archWin, { color: '#FFF8D8', color2: '#F5BC5E', layers: 16, alpha: 0.22, depth: 1, spread: 0.04, wetEdge: true }, rng);

    // Parted cozy curtain silhouettes inside the glowing attic window
    const curtL = [[wx - wrx, wy - wry * 0.2], [wx - wrx * 0.35, wy - wry * 0.75], [wx - wrx * 0.55, wy + wry * 0.25], [wx - wrx * 0.30, wy + wry], [wx - wrx, wy + wry]];
    const curtR = [[wx + wrx, wy - wry * 0.2], [wx + wrx * 0.35, wy - wry * 0.75], [wx + wrx * 0.55, wy + wry * 0.25], [wx + wrx * 0.30, wy + wry], [wx + wrx, wy + wry]];
    wcWash(curtL, { color: '#C27456', color2: '#8B4A3C', layers: 10, alpha: 0.16, depth: 1, spread: 0.06, wetEdge: false }, rng);
    wcWash(curtR, { color: '#C27456', color2: '#8B4A3C', layers: 10, alpha: 0.16, depth: 1, spread: 0.06, wetEdge: false }, rng);

    // Sepia ink window frame, mullions & wooden windowsill
    inkPolyline([...archWin, archWin[0]], 2.4, rng, 0.6, '#36241B', 0.90);
    inkLine(wx, wy - wry, wx, wy + wry, 1.8, rng, 0.4, '#36241B', 0.85);
    inkLine(wx - wrx, wy + 8, wx + wrx, wy + 8, 1.8, rng, 0.4, '#36241B', 0.85);
    inkLine(wx - wrx * 0.84, wy - 44, wx + wrx * 0.84, wy - 44, 1.3, rng, 0.4, '#36241B', 0.78);

    // Warm light spilling onto wooden windowsill + one calm resting golden firefly!
    const sill = makeOrganicRect(wx - wrx - 18, wy + wry, (wrx + 18) * 2, 18, rng, 1.0);
    wcWash(sill, { color: '#E8C58E', color2: '#6B5243', layers: 12, alpha: 0.20, depth: 1, spread: 0.06, wetEdge: true }, rng);
    inkPolyline([...sill, sill[0]], 1.6, rng, 0.6, '#2E2019', 0.86);
    drawFireflies(1, wx + 22, wx + 24, wy + wry - 5, wy + wry - 3, rng, '#FFE892');
    // A couple more gentle sleepy fireflies floating near the eaves
    drawFireflies(10, 410, 840, 560, 890, rng, '#FFE488');

    // Plane 5: Silhouetted foreground dark roof eaves & gently curving night-sky branch in upper-right
    const fgEave = [[-20, 965], [295, 860], [345, 1035], [-20, 1035]];
    wcWash(fgEave, { color: '#242A40', color2: '#171E34', layers: 16, alpha: 0.17, depth: 1, spread: 0.07, wetEdge: true }, rng);

    // Gently curving night-sky branch framing upper-right corner
    wcTrunkSegment(1040, 140, 845, 225, 28, 12, '#2B2B3C', '#181C2E', rng, true);
    wcTrunkSegment(852, 222, 715, 200, 12, 5, '#2B2B3C', '#181C2E', rng, true);
    wcTrunkSegment(890, 205, 790, 295, 10, 4, '#2B2B3C', '#181C2E', rng, true);
    wcBrushDabCluster(885, 165, 155, 95, {
      shadow: ['#1A243B', '#23314D'],
      mid: ['#2C3D5C', '#344766'],
      light: ['#4B6082', '#64799B'],
    }, 68, rng, { lightDir: [-0.7, 0.2], dabMin: 8, dabMax: 20, alpha: 0.28 });
  }

  // =========================================================================
  // Scene Dispatcher
  // =========================================================================
  const RENDERERS = {
    'cover':   [1001, drawScene_cover],
    'page-01': [2002, drawScene_page_01],
    'page-02': [3003, drawScene_page_02],
    'page-03': [4004, drawScene_page_03],
    'page-04': [5005, drawScene_page_04],
    'page-05': [6006, drawScene_page_05],
    'page-06': [7007, drawScene_page_06],
    'page-07': [8008, drawScene_page_07],
    'page-08': [9009, drawScene_page_08],
    'page-09': [1010, drawScene_page_09],
    'page-10': [1111, drawScene_page_10],
  };

  window.renderScene = function (sceneId) {
    const entry = RENDERERS[sceneId];
    if (!entry) throw new Error('Unknown scene: ' + sceneId);
    const [seed, fn] = entry;
    const rng = mulberry32(seed);

    // Reset canvas to warm cotton paper base
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#FAF6EE';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    fn(rng);
    applyPaperAndVignette(rng, sceneId === 'cover' ? 0.30 : 0.34);

    return mainCanvas.toDataURL('image/png');
  };
})();
</script>
</body>
</html>
"""


def encode_adaptive_progressive_jpeg(
    img: Image.Image,
    target_min_kb: float = 125.0,
    target_max_kb: float = 165.0,
    ideal_kb: float = 145.0,
    hard_min_kb: float = 115.0,
    hard_max_kb: float = 175.0,
) -> Tuple[bytes, int, int]:
    """
    Adaptive Pillow progressive JPEG encoder preferring 4:4:4 chroma (subsampling=0)
    to preserve warm watercolor apricot/terracotta/sepia ink edges without chroma bleed.
    Returns (jpeg_bytes, quality, subsampling).
    """
    rgb = img.convert("RGB")

    def encode(quality: int, subsampling: int) -> bytes:
        buf = io.BytesIO()
        rgb.save(
            buf,
            format="JPEG",
            quality=quality,
            subsampling=subsampling,
            optimize=True,
            progressive=True,
        )
        return buf.getvalue()

    def search(subsampling: int, q_lo: int, q_hi: int) -> Tuple[bytes, int, float]:
        best_bytes = b""
        best_q = q_lo
        best_dist = float("inf")
        lo, hi = q_lo, q_hi
        while lo <= hi:
            mid = (lo + hi) // 2
            data = encode(mid, subsampling)
            kb = len(data) / 1024.0
            dist = abs(kb - ideal_kb)
            if dist < best_dist:
                best_bytes, best_q, best_dist = data, mid, dist
            if kb < ideal_kb:
                lo = mid + 1
            else:
                hi = mid - 1
        return best_bytes, best_q, len(best_bytes) / 1024.0

    # Preferred search order: 4:4:4 -> 4:2:2 -> 4:2:0 within [125, 165] KB
    attempts = [
        (0, 82, 95),
        (1, 78, 95),
        (2, 74, 95),
    ]
    for sub, q_lo, q_hi in attempts:
        data, q, kb = search(sub, q_lo, q_hi)
        if target_min_kb <= kb <= target_max_kb:
            return data, q, sub

    # Widest acceptable range [115, 175] KB across all subsamplings
    best_overall: Tuple[bytes, int, int, float] | None = None
    for sub in (0, 1, 2):
        data, q, kb = search(sub, 68, 98)
        if hard_min_kb <= kb <= hard_max_kb:
            return data, q, sub
        dist = abs(kb - ideal_kb)
        if best_overall is None or dist < best_overall[3]:
            best_overall = (data, q, sub, dist)

    assert best_overall is not None
    return best_overall[0], best_overall[1], best_overall[2]


def main() -> int:
    t0 = time.perf_counter()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME_EXECUTABLE,
            headless=True,
            args=CHROME_ARGS,
        )
        try:
            page = browser.new_page(viewport={"width": 1024, "height": 1024})
            page.on("pageerror", lambda err: print(f"[PAGEERROR] {err}", file=sys.stderr))
            page.set_content(HTML_TEMPLATE, wait_until="load")

            for scene_id in SCENES:
                ts = time.perf_counter()
                data_url: str = page.evaluate("id => window.renderScene(id)", scene_id)
                prefix = "data:image/png;base64,"
                if not data_url.startswith(prefix):
                    raise RuntimeError(f"Unexpected data URL for {scene_id}")
                png_bytes = base64.b64decode(data_url[len(prefix):])

                with Image.open(io.BytesIO(png_bytes)) as im:
                    assert im.size == (1024, 1024), f"{scene_id}: expected 1024x1024, got {im.size}"
                    jpg_bytes, quality, subsampling = encode_adaptive_progressive_jpeg(im)

                out_path = OUT_DIR / f"{scene_id}.jpg"
                out_path.write_bytes(jpg_bytes)

                # Strict post-save verification
                file_bytes = out_path.stat().st_size
                kb = file_bytes / 1024.0
                with Image.open(out_path) as check:
                    assert check.size == (1024, 1024), f"{scene_id}: size {check.size}"
                    assert check.mode == "RGB", f"{scene_id}: mode {check.mode}"
                    assert check.info.get("progressive") == 1, f"{scene_id}: not progressive"
                assert 115 * 1024 <= file_bytes <= 175 * 1024, (
                    f"{scene_id}: size {kb:.1f} KB out of [115, 175] KB bounds"
                )

                elapsed_ms = (time.perf_counter() - ts) * 1000.0
                results.append((f"{scene_id}.jpg", "1024x1024", "RGB", 1, quality, subsampling, kb, elapsed_ms))
        finally:
            browser.close()

    total_s = time.perf_counter() - t0
    print(f"{'File':14s} {'Size':10s} {'Mode':5s} {'Prog':5s} {'Q':4s} {'Sub':4s} {'KB':8s} {'Render(ms)':10s}")
    print("-" * 68)
    for fname, sz, mode, prog, q, sub, kb, ms in results:
        print(f"{fname:14s} {sz:10s} {mode:5s} {prog:<5d} {q:<4d} {sub:<4d} {kb:7.1f}  {ms:8.0f}")
    print("-" * 68)
    print(f"Generated {len(results)}/11 plates in {total_s:.2f}s -> {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
