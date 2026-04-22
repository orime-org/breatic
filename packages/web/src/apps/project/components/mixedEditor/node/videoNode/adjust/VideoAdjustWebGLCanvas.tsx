import React, { memo, useEffect, useRef } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import type { AdjustValue } from '../../imageNode/adjust/AdjustBottomToolbar';
import { adjustValueToWebglUniforms } from './adjustValueToWebglUniforms';

const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_position.x * 0.5 + 0.5, 1.0 - (a_position.y * 0.5 + 0.5));
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_video;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hueAngle;
uniform vec3 u_rgbGain;
uniform float u_vignette;
uniform float u_fadeAlpha;
uniform float u_grain;
uniform float u_time;
in vec2 v_uv;
out vec4 fragColor;

vec3 applyHueMatrix(vec3 color, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  float one = c + (1.0 - c) / 3.0;
  float r = (1.0 / 3.0) * (1.0 - c);
  float sr = (1.0 / sqrt(3.0)) * s;
  mat3 m = mat3(
    one, r - sr, r + sr,
    r + sr, one, r - sr,
    r - sr, r + sr, one
  );
  return m * color;
}

void main() {
  vec4 texc = texture(u_video, v_uv);
  vec3 rgb = texc.rgb;
  rgb *= u_rgbGain;
  rgb = applyHueMatrix(rgb, u_hueAngle);
  float L = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(L), rgb, 1.0 + u_saturation);
  float ct = 1.0 + u_contrast * 0.85;
  rgb = (rgb - 0.5) * ct + 0.5 + u_brightness * 0.22;
  rgb = clamp(rgb, 0.0, 1.0);

  vec2 p = v_uv - 0.5;
  float d = length(p) * 1.4142135623730951;
  float dn = smoothstep(0.06, 1.0, d);
  float edge = pow(dn, 1.6);
  rgb *= (1.0 - u_vignette * edge);

  rgb = mix(rgb, vec3(1.0), u_fadeAlpha);

  float n = fract(sin(dot(vec3(v_uv, u_time), vec3(12.9898, 78.233, 45.1643))) * 43758.5453);
  rgb += (n - 0.5) * u_grain * 0.08;

  fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vert);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

export type VideoAdjustWebGLCanvasProps = {
  videoRef: React.RefObject<VideoRef | null>;
  adjustValue: AdjustValue;
  className?: string;
};

/**
 * Full-screen quad WebGL2 preview: samples the underlying {@link HTMLVideoElement} each frame
 * and applies adjust uniforms (see {@link adjustValueToWebglUniforms}).
 */
const VideoAdjustWebGLCanvas: React.FC<VideoAdjustWebGLCanvasProps> = ({ videoRef, adjustValue, className }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const adjustValueRef = useRef(adjustValue);
  adjustValueRef.current = adjustValue;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) return;

    const program = createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!program) return;

    const loc = {
      u_video: gl.getUniformLocation(program, 'u_video'),
      u_brightness: gl.getUniformLocation(program, 'u_brightness'),
      u_contrast: gl.getUniformLocation(program, 'u_contrast'),
      u_saturation: gl.getUniformLocation(program, 'u_saturation'),
      u_hueAngle: gl.getUniformLocation(program, 'u_hueAngle'),
      u_rgbGain: gl.getUniformLocation(program, 'u_rgbGain'),
      u_vignette: gl.getUniformLocation(program, 'u_vignette'),
      u_fadeAlpha: gl.getUniformLocation(program, 'u_fadeAlpha'),
      u_grain: gl.getUniformLocation(program, 'u_grain'),
      u_time: gl.getUniformLocation(program, 'u_time'),
    };

    const vao = gl.createVertexArray();
    if (!vao) return;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const tex = gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.floor(container.clientWidth * dpr));
      const h = Math.max(1, Math.floor(container.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${container.clientWidth}px`;
        canvas.style.height = `${container.clientHeight}px`;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const ro = new ResizeObserver(() => {
      resize();
    });
    ro.observe(container);
    resize();

    const applyUniforms = () => {
      const u = adjustValueToWebglUniforms(adjustValueRef.current);
      gl.useProgram(program);
      gl.uniform1f(loc.u_brightness, u.brightness);
      gl.uniform1f(loc.u_contrast, u.contrast);
      gl.uniform1f(loc.u_saturation, u.saturation);
      gl.uniform1f(loc.u_hueAngle, u.hueAngle);
      gl.uniform3f(loc.u_rgbGain, u.rgbGain[0], u.rgbGain[1], u.rgbGain[2]);
      gl.uniform1f(loc.u_vignette, u.vignette);
      gl.uniform1f(loc.u_fadeAlpha, u.fadeAlpha);
      gl.uniform1f(loc.u_grain, u.grain);
      gl.uniform1f(loc.u_time, performance.now() * 0.001);
    };

    let rafId = 0;

    const draw = () => {
      resize();
      const vid = videoRef.current?.getHtmlVideoElement?.() ?? null;
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (vid && vid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
        } catch {
          /* CORS / tainted canvas */
        }
      }
      if (loc.u_video) gl.uniform1i(loc.u_video, 0);
      applyUniforms();
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      gl.deleteTexture(tex);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    };
  }, [videoRef]);

  return (
    <div ref={containerRef} className={`absolute inset-0 z-[3] overflow-hidden ${className ?? ''}`}>
      <canvas ref={canvasRef} className='pointer-events-none block h-full w-full object-contain' />
    </div>
  );
};

export default memo(VideoAdjustWebGLCanvas);
