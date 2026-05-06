export interface MediaItem {
  id: string;
  name?: string;
  type: 'video' | 'audio' | 'image' | 'text';
  url?: string;
  file?: File;
  duration?: number;
  thumbnail?: string; // video frame (base64)
  waveform?: string; // audio URL (base64 blob URL)
  width?: number; // assetoriginalwidth
  height?: number; // assetoriginalheight
  // text （ used fordefaulttext ）
  text?: string;
}

export interface TimelineClip {
  id: string;
  mediaId: string;
  type?: 'video' | 'audio' | 'image' | 'text'; // clip （ ， ）
  start: number; // timelineup start
  end: number; // timelineup end
  trackIndex: number;
  trimStart?: number; // assetcropstarttime（video secstartplayback）
  trimEnd?: number; // assetcropendtime（videoplayback sec）
  // text
  text?: string; // text
  // canvas
  x?: number; // X coordinate
  y?: number; // Y coordinate
  width?: number; // width
  height?: number; // height
  rotation?: number;
  scale?: number;
  opacity?: number; // opacity (0-100, default 100)
  // crop （image/video）
  cropArea?: {
    x: number; // cropregion x coordinate（ ）
    y: number; // cropregion y coordinate（ ）
    width: number; // cropregionwidth（ ）
    height: number; // cropregionheight（ ）
    unit: 'px'; // comment
  };
  croppedUrl?: string; // crop imageURL
  // audio/video
  volume?: number; // (0-200, default 100)
  speed?: number; // playback (0.25-4, default 1)

  // textstyle
  textStyle?: {
    fontFamily?: string; // font（ ， "Consolas-Bold"）
    fontSize?: number; // font size
    color?: string; // color
    textAlign?: string; // alignment
    textDecoration?: string; // decoration (underline, line-through, overline)
    textTransform?: string; // (none, uppercase, lowercase, capitalize)
    fontStyle?: string; // fontstyle (normal, italic)
    strokeColor?: string; // strokecolor
    strokeWidth?: number; // stroke
    shadowColor?: string; // shadowcolor
    shadowOffsetX?: number; // shadowXoffset
    shadowOffsetY?: number; // shadowYoffset
    shadowBlur?: number; // shadowblur
  };

  // image/videostyle
  mediaStyle?: {
    borderRadius?: number; // border radius
    brightness?: number; // brightness (0-200, default 100)
    blur?: number; // blur (0-100, default 0)
    outlineColor?: string; // outlinecolor
    outlineWidth?: number; // outline
    shadowColor?: string; // shadowcolor
    shadowOffsetX?: number; // shadowXoffset
    shadowOffsetY?: number; // shadowYoffset
    shadowBlur?: number; // shadowblur
  };
}

