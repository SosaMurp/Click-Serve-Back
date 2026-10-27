const crypto = require('crypto');

// RNF-04: TOTP según RFC 6238 (HMAC-SHA1, 6 dígitos, periodo de 30 s, ventana de ±30 s).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hash[hash.length - 1] & 0xf;
  const code = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

function totp(secret, timeMs = Date.now(), digits = 6) {
  return hotp(secret, Math.floor(timeMs / 1000 / 30), digits);
}

function verifyTotp(secret, code, window = 1, timeMs = Date.now()) {
  const given = String(code ?? '').replace(/\D/g, '');
  if (!secret || given.length !== 6) return false;
  const counter = Math.floor(timeMs / 1000 / 30);
  for (let w = -window; w <= window; w += 1) {
    const expected = hotp(secret, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return true;
  }
  return false;
}

function otpauthUri(secret, email) {
  const label = encodeURIComponent(`Click & Serve:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Click & Serve')}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, totp, hotp, verifyTotp, otpauthUri, base32Encode, base32Decode };
