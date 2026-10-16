import { spawn } from 'node:child_process';
import { HttpError } from '../lib/errors';

/**
 * Higgsfield only accepts WAV for audio inputs, but most audio files are MP3 or M4A. These are converted with ffmpeg
 * (run directly with fixed arguments, never through a shell), to 16-bit mono WAV at 44.1 kHz, which is plenty for speech.
 */
export const CONVERTIBLE_AUDIO = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac', 'audio/webm',
]);

const ffmpegPath = () => process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_SECONDS_OUT = 15 * 60;

export function toWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '44100', '-t', String(MAX_SECONDS_OUT), '-f', 'wav', 'pipe:1'];
    const p = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    let size = 0;
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 60 * 1024 * 1024) p.kill('SIGKILL'); // runaway output guard
      else out.push(c);
    });
    p.stderr.on('data', (c: Buffer) => (err += c.toString().slice(0, 400)));
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new HttpError(400, 'Converting this audio needs ffmpeg, which was not found on this computer. Upload a WAV file instead, or install ffmpeg.', 'ffmpeg_missing')
          : new HttpError(500, 'Could not start the audio converter.', 'convert_failed'),
      );
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const wav = Buffer.concat(out);
      if (code !== 0 || wav.length < 100) return reject(new HttpError(400, `That file could not be read as audio${err ? ` (${err.trim().split('\n')[0].slice(0, 120)})` : ''}. Try a WAV, MP3 or M4A file.`, 'bad_audio'));
      resolve(wav);
    });
    p.stdin.on('error', () => undefined); // ffmpeg may close its input early on a bad file
    p.stdin.end(input);
  });
}
