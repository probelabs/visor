import type { RecordingOctokit } from './github-recorder';

let __rec: RecordingOctokit | null = null;

export function setGlobalRecorder(r: RecordingOctokit | null): void {
  __rec = r;
}

export function getGlobalRecorder(): RecordingOctokit | null {
  return __rec;
}
