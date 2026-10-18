import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_AVATAR_BYTES = 512 * 1024;
export const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const AVATAR_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const AVATAR_ID_RE = /^[a-f0-9]{32}$/;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the bytes really are, whatever the client claimed: 'jpg', 'png', 'webp', or null (SVG, HTML, anything else). */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(PNG)) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Profile pictures kept as files next to the data file. Each upload gets a fresh random id, so a changed picture
 * is a new URL (and can be cached forever) and nobody can guess another person's picture from their email or callsign.
 */
export function createAvatarStore(dir) {
  const fileFor = (id, ext) => path.join(dir, `${id}.${ext}`);

  return {
    dir,

    /** Save validated image bytes. Returns the new id. Throws a plain Error if the bytes are not a supported image. */
    save(buf) {
      const ext = sniffImage(buf);
      if (!ext) throw new Error('That file is not a JPEG, PNG or WebP picture.');
      if (buf.length > MAX_AVATAR_BYTES) throw new Error('That picture is too large.');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = crypto.randomBytes(16).toString('hex');
      const tmp = fileFor(id, `${ext}.tmp`);
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.renameSync(tmp, fileFor(id, ext)); // atomic: nobody ever sees half a file
      return id;
    },

    /** Delete a picture. Missing files and bad ids are ignored. */
    remove(id) {
      if (!AVATAR_ID_RE.test(String(id))) return;
      for (const ext of Object.keys(AVATAR_MIME)) fs.rmSync(fileFor(id, ext), { force: true });
    },

    /** Locate a stored picture: { file, type } or null. */
    find(id) {
      if (!AVATAR_ID_RE.test(String(id))) return null;
      for (const ext of Object.keys(AVATAR_MIME)) {
        const file = fileFor(id, ext);
        if (fs.existsSync(file)) return { file, type: AVATAR_MIME[ext] };
      }
      return null;
    },
  };
}
