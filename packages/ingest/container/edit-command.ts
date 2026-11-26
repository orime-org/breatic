// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The edit-file command builder (frames-split design §4.2, §4.3 colour/HDR row, §3.5 edit-file receipt row): the tier's
 * encoder, its container and the picture an edit chunk encodes, the HDR tone map included. Kept apart from the playback
 * commands (`playback-command.ts`): its source digest, embedded at the container build, is part of the edit profile version,
 * so a change to playback commands never invalidates an edit file.
 */
import type { EditFileTier } from '@shared/mini-tools/video-encode-plan.js';
import type { FrameRate } from '@shared/upload/frame-grid-rate.js';
import type { MiniToolPlanColorInputs } from '@shared/upload/mini-tool-plan-types.js';

/** The frozen edit-file settings a tier's encoder reads (`presentation.edit`). */
export interface EditSettings { crf: number; preset: string; proresProfile: string }

// The plan's matrix names as zscale and setparams spell them.
const ZSCALE_MATRICES: Readonly<Record<string, string>> = { bt709: '709', bt601: '170m', bt2020nc: '2020_ncl', smpte240m: 'smpte240m', fcc: 'fcc' };
const SCALE_MATRICES: Readonly<Record<string, string>> = { bt709: 'bt709', bt601: 'bt601', bt2020nc: 'bt2020', smpte240m: 'smpte240m', fcc: 'fcc' };
const TAG_MATRICES: Readonly<Record<string, string>> = { bt709: 'bt709', bt601: 'smpte170m', bt2020nc: 'bt2020nc', smpte240m: 'smpte240m', fcc: 'fcc' };
// Each tier's pixel format (§4.2 opaque and transparent rows).
const TIER_FORMATS: Readonly<Record<EditFileTier, string>> = {
  edit_h264_intra_8bit_420: 'yuv420p', edit_h264_intra_10bit_420: 'yuv420p10le', edit_h264_intra_8bit_444: 'yuv444p',
  edit_h264_intra_10bit_444: 'yuv444p10le', edit_prores: 'yuva444p10le',
};

/**
 * The value of a matrix in a lookup.
 * @param table - The lookup.
 * @param matrix - The plan matrix.
 * @returns Its value.
 * @throws {RangeError} When the matrix is not in it.
 */
function named(table: Readonly<Record<string, string>>, matrix: string): string {
  const value = table[matrix];
  if (value === undefined) throw new RangeError(`No edit-file value for the matrix ${matrix}`);
  return value;
}

/**
 * The square-pixel display picture of decoded frames: a sample aspect ratio above 1 widens, below 1 heightens, rounded.
 * @returns The filter text.
 * @throws {never} Never.
 */
function squarePixels(): string {
  return "scale=w='if(gt(sar,1),round(iw*sar),iw)':h='if(lt(sar,1),round(ih/sar),ih)'";
}

/**
 * The picture an edit chunk encodes (§4.2, §4.3): an HDR source tone mapped once to SDR BT.709 with every input fact named
 * (the plan matrix, the probed transfer, primaries, range and chroma location; odd-sided subsampled frames go to 4:4:4
 * first, which zimg needs); an SDR source keeps its plan matrix; square pixels at the display size; the tier's format; the
 * matrix written as a tag.
 * @param color - The plan's explicit colour inputs.
 * @param toneMap - The plan's conversion.
 * @param tier - The edit tier.
 * @param oddSubsampled - Whether the decoded frames are subsampled with an odd side.
 * @returns The filter chain text.
 * @throws {RangeError} When a matrix has no value.
 */
export function editPicture(color: MiniToolPlanColorInputs, toneMap: 'none' | 'sdr-bt709', tier: EditFileTier, oddSubsampled: boolean): string {
  const format = TIER_FORMATS[tier];
  const alpha = tier === 'edit_prores';
  if (toneMap === 'sdr-bt709') {
    const inputs = `min=${named(ZSCALE_MATRICES, color.matrix)}:${color.transfer === null ? '' : `tin=${color.transfer}:`}pin=${color.primaries ?? 'bt709'}:` +
      `rin=${color.range === 'pc' ? 'full' : 'limited'}:cin=${color.chromaLocation}`;
    const chain = `zscale=${inputs}:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`;
    // Odd sides: zimg cannot read subsampled planes there, so the frames reach it in 4:4:4.
    const head = oddSubsampled ? `format=${alpha ? 'yuva444p16le' : 'yuv444p16le'},` : '';
    const full = alpha ? 'yuva444p16le' : 'yuv444p16le';
    return `${head}${chain},format=${full},${squarePixels()},format=${format},setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`;
  }
  const matrix = named(SCALE_MATRICES, color.matrix);
  return `${squarePixels()}:in_color_matrix=${matrix}:in_range=${color.range}:out_color_matrix=${matrix}:out_range=tv,format=${format},setsar=1,` +
    `setparams=colorspace=${named(TAG_MATRICES, color.matrix)}:range=tv`;
}

/**
 * The encoder and muxer of an edit tier (§4.2): all-intra H.264 at the tier's format in MP4, or ProRes 4444 in MOV; one frame
 * per 1/fps from 0.
 * @param tier - The edit tier.
 * @param settings - The frozen settings the tier's encoder reads.
 * @param fps - The grid rate.
 * @returns The encoder arguments and the muxer arguments.
 * @throws {never} Never.
 */
export function editEncode(tier: EditFileTier, settings: EditSettings, fps: FrameRate): { video: string[]; muxer: string[] } {
  const timing = ['-fps_mode', 'passthrough', '-enc_time_base:v', `${fps.denominator}/${fps.numerator}`, '-bsf:v', 'setts=duration=1'];
  const prores = tier === 'edit_prores';
  return prores
    ? { video: ['-c:v', 'prores_ks', '-profile:v', settings.proresProfile, '-pix_fmt', TIER_FORMATS[tier], ...timing], muxer: ['-f', 'mov'] }
    : { video: ['-c:v', 'libx264', '-preset', settings.preset, '-crf', String(settings.crf), '-g', '1', '-bf', '0', '-pix_fmt', TIER_FORMATS[tier], ...timing],
      muxer: ['-movflags', '+faststart', '-f', 'mp4'] };
}

/**
 * The muxer an edit stitch writes for a tier: MOV for ProRes, MP4 otherwise, fragmented so the file is written front to back
 * and goes to its upload as it is written; a moov written last would need the whole file on disk first.
 * @param tier - The edit tier.
 * @returns The muxer arguments.
 * @throws {never} Never.
 */
export function editMuxer(tier: EditFileTier): string[] {
  return ['-movflags', '+frag_keyframe+empty_moov', '-f', tier === 'edit_prores' ? 'mov' : 'mp4'];
}
