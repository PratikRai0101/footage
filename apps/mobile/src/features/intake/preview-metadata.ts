import { mediaSchema, type MediaInfo } from '../../../modules/footage-transfer/src/contracts';

function positiveInteger(value: number): number | null {
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : null;
}

/** Playback metadata is read-only; it never substitutes for the native upload hash. */
export function previewMetadata({ durationSeconds, size, mimeType }: {
  durationSeconds: number;
  size: { width: number; height: number } | null;
  mimeType: string | null;
}): MediaInfo {
  return mediaSchema.parse({
    durationMs: positiveInteger(durationSeconds * 1000),
    width: size === null ? null : positiveInteger(size.width),
    height: size === null ? null : positiveInteger(size.height),
    mimeType,
  });
}
