import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { getCuts, getWordsIfAny, listVideos, saveUpload } from '../src/services/effects';

let dir = '';
const was = config.editDir;
let videoId = '';

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cuts-'));
  config.editDir = dir;
  // Two seconds of red, then two seconds of blue: one cut, at 2 seconds
  const clip = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=2:r=10', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=2:r=10', '-filter_complex', 'concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', clip]);
  videoId = (await saveUpload(await fs.readFile(clip), 'video/mp4', 'clip.mp4', null)).id;
}, 60_000);
afterAll(async () => {
  config.editDir = was;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('timeline data', () => {
  it('finds where the picture cuts to a new shot, and remembers it', async () => {
    const cuts = await getCuts(videoId);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toBeGreaterThan(1.8);
    expect(cuts[0]).toBeLessThan(2.2);
    expect(await getCuts(videoId)).toEqual(cuts);
  });

  it('has no words until the video has been transcribed, and does not start a transcription to find out', async () => {
    expect(await getWordsIfAny(videoId)).toEqual([]);
  });

  it('does not mistake the saved cuts for another video', async () => {
    expect((await listVideos('any', true)).map((v) => v.id)).toEqual([videoId]);
  });
});
