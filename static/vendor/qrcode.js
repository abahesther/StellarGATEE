/**
 * Minimal QR Code encoder — produces an inline SVG string.
 *
 * Vendored under static/vendor/ so the dashboard can render payment URIs as
 * QR codes without a third-party network request, which the dashboard CSP
 * (`connect-src 'self'`) and `script-src 'self'` would block anyway.
 *
 * Only supports byte-mode encoding (UTF-8 input), error-correction level M,
 * and the smallest version that fits the data. This covers SEP-7 URIs of
 * typical length (≤ ~180 characters) with room to spare.
 *
 * License: MIT
 * Based on the public QR Code specification ISO/IEC 18004:2015.
 */
(function (root, factory) {
  "use strict";
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.QRCode = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── GF(256) arithmetic ──────────────────────────────────────────────────────
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = x << 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
  }

  function gfPolyMul(p, q) {
    var r = new Uint8Array(p.length + q.length - 1);
    for (var i = 0; i < p.length; i++)
      for (var j = 0; j < q.length; j++)
        r[i + j] ^= gfMul(p[i], q[j]);
    return r;
  }

  function gfPolyDiv(dividend, divisor) {
    var out = new Uint8Array(dividend);
    for (var i = 0; i < dividend.length - (divisor.length - 1); i++) {
      var c = out[i];
      if (c !== 0)
        for (var j = 1; j < divisor.length; j++)
          out[i + j] ^= gfMul(divisor[j], c);
    }
    return out.slice(dividend.length - (divisor.length - 1));
  }

  function generatorPoly(degree) {
    var g = new Uint8Array([1]);
    for (var i = 0; i < degree; i++)
      g = gfPolyMul(g, new Uint8Array([1, GF_EXP[i]]));
    return g;
  }

  // ── Version / capacity tables for ECL=M ────────────────────────────────────
  // Each entry: [version, data_codewords, ec_codewords_per_block, blocks]
  var VERSIONS_M = [
    [1,  16,  10, 1],
    [2,  28,  16, 1],
    [3,  44,  26, 1],
    [4,  64,  18, 2],
    [5,  86,  24, 2],
    [6, 108,  16, 4],
    [7, 124,  18, 4],
    [8, 154,  22, 4],
    [9, 182,  22, 5],
    [10, 216, 26, 5],
  ];

  function pickVersion(byteCount) {
    for (var i = 0; i < VERSIONS_M.length; i++) {
      // Header: mode (4) + char count indicator (8 for byte mode, v1-9)
      if (VERSIONS_M[i][1] >= byteCount + 2) return VERSIONS_M[i];
    }
    return null; // too long
  }

  // ── Bit buffer ──────────────────────────────────────────────────────────────
  function BitBuffer() {
    this.buf = [];
    this.len = 0;
  }
  BitBuffer.prototype.put = function (val, length) {
    for (var i = length - 1; i >= 0; i--) {
      if ((val >>> i) & 1) this.buf.push(1); else this.buf.push(0);
      this.len++;
    }
  };

  // ── Data encoding (byte mode) ───────────────────────────────────────────────
  function encodeData(bytes, version, totalCodewords) {
    var bb = new BitBuffer();
    bb.put(0x4, 4);                // mode: byte
    bb.put(bytes.length, 8);       // character count
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
    // Terminator
    bb.put(0, Math.min(4, totalCodewords * 8 - bb.len));
    // Pad to byte boundary
    while (bb.len % 8) bb.put(0, 1);
    // Pad codewords
    var pad = [0xEC, 0x11];
    var pi = 0;
    while (bb.len < totalCodewords * 8) { bb.put(pad[pi++ & 1], 8); }
    // Pack bits into bytes
    var out = new Uint8Array(totalCodewords);
    for (var j = 0; j < totalCodewords; j++) {
      var byte = 0;
      for (var b = 0; b < 8; b++) byte = (byte << 1) | (bb.buf[j * 8 + b] || 0);
      out[j] = byte;
    }
    return out;
  }

  // ── Error correction ────────────────────────────────────────────────────────
  function makeEcBlocks(data, vinfo) {
    var dcw = vinfo[1], ecpb = vinfo[2], blocks = vinfo[3];
    var blockSize = Math.floor(dcw / blocks);
    var largeBlocks = dcw - blockSize * blocks;
    var gen = generatorPoly(ecpb);
    var result = { dc: [], ec: [] };
    var offset = 0;
    for (var i = 0; i < blocks; i++) {
      var size = blockSize + (i >= blocks - largeBlocks ? 1 : 0);
      var block = data.slice(offset, offset + size);
      offset += size;
      result.dc.push(block);
      result.ec.push(gfPolyDiv(block, gen));
    }
    return result;
  }

  function interleave(blocks) {
    var out = [];
    var maxLen = 0;
    for (var i = 0; i < blocks.length; i++) if (blocks[i].length > maxLen) maxLen = blocks[i].length;
    for (var j = 0; j < maxLen; j++)
      for (var k = 0; k < blocks.length; k++)
        if (j < blocks[k].length) out.push(blocks[k][j]);
    return out;
  }

  // ── Module placement ────────────────────────────────────────────────────────
  var FORMAT_INFO_M = [
    0x5BCF, 0x5AA8, 0x5BE3, 0x5AC4, 0x5EF5, 0x5FD2, 0x5E99, 0x5FBE,
    0x4E31, 0x4F16, 0x4E5D, 0x4F7A, 0x4B4B, 0x4A6C, 0x4B27, 0x4A00,
    0x70FC, 0x71DB, 0x7090, 0x71B7, 0x7586, 0x74A1, 0x75EA, 0x74CD,
    0x6542, 0x6465, 0x652E, 0x6409, 0x6038, 0x611F, 0x6054, 0x6173,
  ];

  function makeMatrix(size) {
    var m = [];
    for (var i = 0; i < size; i++) {
      m.push(new Int8Array(size)); // 0=unset, 1=dark, -1=light
    }
    return m;
  }

  function setFinderPattern(m, row, col) {
    for (var r = -1; r <= 7; r++)
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
        var dark = (r === -1 || r === 7 || c === -1 || c === 7) ||
          (r >= 1 && r <= 5 && c >= 1 && c <= 5);
        m[rr][cc] = dark ? 1 : -1;
      }
  }

  function setTimingPatterns(m, size) {
    for (var i = 8; i < size - 8; i++) {
      m[6][i] = (i % 2 === 0) ? 1 : -1;
      m[i][6] = (i % 2 === 0) ? 1 : -1;
    }
  }

  function setAlignmentPattern(m, row, col) {
    for (var r = -2; r <= 2; r++)
      for (var c = -2; c <= 2; c++) {
        var dark = (r === -2 || r === 2 || c === -2 || c === 2) || (r === 0 && c === 0);
        m[row + r][col + c] = dark ? 1 : -1;
      }
  }

  // Alignment pattern centers for versions 1-10
  var ALIGN_CENTERS = [
    [], [], [6,18], [6,22], [6,26], [6,30], [6,34],
    [6,22,38], [6,24,42], [6,26,46], [6,28,50],
  ];

  function setAlignmentPatterns(m, version, size) {
    var centers = ALIGN_CENTERS[version] || [];
    for (var i = 0; i < centers.length; i++)
      for (var j = 0; j < centers.length; j++) {
        var r = centers[i], c = centers[j];
        if (m[r][c] !== 0) continue;
        setAlignmentPattern(m, r, c);
      }
  }

  function isFunction(m, row, col) {
    return m[row][col] !== 0;
  }

  function placeDataBits(m, bits, size, mask) {
    var bitIdx = 0;
    var dir = -1; // -1 = up, 1 = down
    var col = size - 1;
    while (col > 0) {
      if (col === 6) col--;
      var rowStart = dir === -1 ? size - 1 : 0;
      for (var i = 0; i < size; i++) {
        var row = rowStart + dir * i;
        for (var dc = 0; dc < 2; dc++) {
          var c = col - dc;
          if (m[row][c] !== 0) continue;
          var bit = bitIdx < bits.length ? bits[bitIdx++] : 0;
          var masked = applyMask(mask, row, c, bit);
          m[row][c] = masked ? 1 : -1;
        }
      }
      dir = -dir;
      col -= 2;
    }
  }

  function applyMask(mask, row, col, bit) {
    var m;
    switch (mask) {
      case 0: m = (row + col) % 2 === 0; break;
      case 1: m = row % 2 === 0; break;
      case 2: m = col % 3 === 0; break;
      case 3: m = (row + col) % 3 === 0; break;
      case 4: m = (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0; break;
      case 5: m = ((row * col) % 2 + (row * col) % 3) === 0; break;
      case 6: m = ((row * col) % 2 + (row * col) % 3) % 2 === 0; break;
      case 7: m = ((row + col) % 2 + (row * col) % 3) % 2 === 0; break;
      default: m = false;
    }
    return m ? !bit : !!bit;
  }

  function setFormatInfo(m, size, mask) {
    var fmt = FORMAT_INFO_M[mask];
    var bits = [];
    for (var i = 14; i >= 0; i--) bits.push((fmt >>> i) & 1);

    // Horizontal + vertical strips around top-left finder
    var pos = [
      [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
      [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8],
    ];
    for (var j = 0; j < pos.length; j++) {
      m[pos[j][0]][pos[j][1]] = bits[j] ? 1 : -1;
    }
    // Top-right
    for (var k = 0; k < 8; k++) m[8][size - 1 - k] = bits[k] ? 1 : -1;
    // Bottom-left
    for (var l = 0; l < 7; l++) m[size - 7 + l][8] = bits[8 + l] ? 1 : -1;
    // Dark module
    m[size - 8][8] = 1;
  }

  function penalty(m, size) {
    var score = 0;
    // Rule 1: five or more in a row
    for (var r = 0; r < size; r++) {
      var runH = 1, runV = 1;
      for (var c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { runH++; if (runH === 5) score += 3; else if (runH > 5) score++; }
        else runH = 1;
        if (m[c][r] === m[c - 1][r]) { runV++; if (runV === 5) score += 3; else if (runV > 5) score++; }
        else runV = 1;
      }
    }
    // Rule 2: 2x2 blocks
    for (var i = 0; i < size - 1; i++)
      for (var j = 0; j < size - 1; j++)
        if (m[i][j] === m[i + 1][j] && m[i][j] === m[i][j + 1] && m[i][j] === m[i + 1][j + 1]) score += 3;
    return score;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Encode `text` as a QR code and return an inline SVG string.
   *
   * @param {string} text  The data to encode (UTF-8).
   * @param {object} [opts]
   * @param {number} [opts.size=200]     SVG width/height in pixels.
   * @param {number} [opts.margin=4]     Quiet-zone modules.
   * @param {string} [opts.dark="#000"]  Dark module colour.
   * @param {string} [opts.light="#fff"] Light module colour.
   * @returns {string}  SVG markup (no XML declaration, suitable for innerHTML).
   */
  function toSvg(text, opts) {
    var o = opts || {};
    var svgSize = o.size || 200;
    var margin = o.margin !== undefined ? o.margin : 4;
    var dark = o.dark || "#000";
    var light = o.light || "#fff";

    // Encode text to UTF-8 bytes
    var bytes = unescape(encodeURIComponent(text)).split("").map(function (c) { return c.charCodeAt(0); });

    var vinfo = pickVersion(bytes.length);
    if (!vinfo) return ""; // data too long

    var version = vinfo[0];
    var size = version * 4 + 17;
    var totalDcw = vinfo[1];

    var data = encodeData(bytes, version, totalDcw);
    var ecBlocks = makeEcBlocks(data, vinfo);
    var allBits = interleave(ecBlocks.dc).concat(interleave(ecBlocks.ec));

    // Convert bytes to bits
    var bits = [];
    for (var i = 0; i < allBits.length; i++)
      for (var b = 7; b >= 0; b--) bits.push((allBits[i] >>> b) & 1);

    // Choose best mask
    var bestMask = 0, bestPenalty = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var m = makeMatrix(size);
      setFinderPattern(m, 0, 0);
      setFinderPattern(m, 0, size - 7);
      setFinderPattern(m, size - 7, 0);
      setTimingPatterns(m, size);
      setAlignmentPatterns(m, version, size);
      placeDataBits(m, bits, size, mask);
      setFormatInfo(m, size, mask);
      var p = penalty(m, size);
      if (p < bestPenalty) { bestPenalty = p; bestMask = mask; }
    }

    // Final matrix with best mask
    var matrix = makeMatrix(size);
    setFinderPattern(matrix, 0, 0);
    setFinderPattern(matrix, 0, size - 7);
    setFinderPattern(matrix, size - 7, 0);
    setTimingPatterns(matrix, size);
    setAlignmentPatterns(matrix, version, size);
    placeDataBits(matrix, bits, size, bestMask);
    setFormatInfo(matrix, size, bestMask);

    // Render SVG
    var totalModules = size + margin * 2;
    var cellSize = svgSize / totalModules;
    var rects = [];

    // Background
    rects.push(
      '<rect width="' + svgSize + '" height="' + svgSize + '" fill="' + light + '"/>'
    );

    for (var row = 0; row < size; row++) {
      for (var col = 0; col < size; col++) {
        if (matrix[row][col] === 1) {
          var x = (col + margin) * cellSize;
          var y = (row + margin) * cellSize;
          rects.push(
            '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) +
            '" width="' + cellSize.toFixed(2) + '" height="' + cellSize.toFixed(2) +
            '" fill="' + dark + '"/>'
          );
        }
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      svgSize + " " + svgSize + '" role="img">' + rects.join("") + "</svg>";
  }

  return { toSvg: toSvg };
});
