# The media container: ffprobe reads what an uploaded object is, ffmpeg lifts a
# cover frame out of it (#209 + #210, design §4.2), and vips cuts a picture's
# preview (inner#1320, inner#1339).
#
# The service imports the Worker's own modules: the ffprobe arguments and the
# answer format are one agreement between the two sides, and a second copy
# inside the container would drift.
#
# Built from the repository root, which is what puts THIRD-PARTY.md within
# reach. wrangler resolves the build context against the directory its config
# sits in and defaults it to this file's own directory, so each top-level and
# production container block in wrangler.toml.template carries
# `image_build_context = "../.."`. A wrangler.toml is each developer's own copy;
# keep that context in every container block. Every source taken from the
# context is written from the repository root.

# The analysis process uses the same musl base as the media programs. Its
# limited OpenCV build has no FFmpeg, GStreamer, GUI or backend plugins.
ARG ALPINE_IMAGE=alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
FROM ${ALPINE_IMAGE} AS opencv-builder
ARG BUILD_JOBS=2
RUN apk add --no-cache \
    build-base cmake ninja pkgconf linux-headers curl ca-certificates \
    python3=3.12.16-r0 python3-dev=3.12.16-r0 \
    py3-numpy=2.3.5-r0 py3-numpy-dev=2.3.5-r0 \
    zlib-dev libjpeg-turbo-dev libpng-dev
WORKDIR /build
RUN curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
      https://github.com/opencv/opencv/archive/4.12.0/opencv-4.12.0.tar.gz \
      --output opencv-4.12.0.tar.gz \
 && echo '8ac63ddd61e22cc0eaeafee4f30ae6e1cab05fc4929e2cea29070203b9ca8dfead12cc0fd7c4a87b65c1e20ec6b9ab4865a1b83fad33d114fc0708fdf107c51b  opencv-4.12.0.tar.gz' | sha512sum -c - \
 && tar -xzf opencv-4.12.0.tar.gz
RUN cmake -S /build/opencv-4.12.0 -B /build/opencv-build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/opt/opencv \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_INSTALL_RPATH=/opt/opencv/lib \
    -DBUILD_SHARED_LIBS=ON \
    -DBUILD_LIST=core,imgproc,imgcodecs,videoio,dnn,calib3d,features2d,flann,objdetect,python3 \
    -DBUILD_opencv_world=OFF -DBUILD_opencv_apps=OFF \
    -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
    -DBUILD_DOCS=OFF -DBUILD_JAVA=OFF -DBUILD_PACKAGE=OFF \
    -DBUILD_opencv_python2=OFF -DBUILD_opencv_python3=ON \
    -DPYTHON3_EXECUTABLE=/usr/bin/python3 \
    -DOPENCV_PYTHON3_INSTALL_PATH=/opt/opencv/lib/python3.12/site-packages \
    -DOPENCV_SKIP_PYTHON_LOADER=OFF \
    -DOPENCV_ENABLE_NONFREE=OFF -DOPENCV_GENERATE_SETUPVARS=OFF \
    -DWITH_FFMPEG=OFF -DWITH_GSTREAMER=OFF \
    -DVIDEOIO_ENABLE_PLUGINS=OFF -DDNN_ENABLE_PLUGINS=OFF \
    -DWITH_GTK=OFF -DWITH_QT=OFF -DWITH_OPENGL=OFF -DWITH_VTK=OFF \
    -DWITH_WAYLAND=OFF -DWITH_FRAMEBUFFER=OFF \
    -DWITH_V4L=OFF -DWITH_1394=OFF -DWITH_OPENNI2=OFF \
    -DWITH_GPHOTO2=OFF -DWITH_XINE=OFF -DWITH_OBSENSOR=OFF \
    -DWITH_ARAVIS=OFF -DWITH_MFX=OFF -DWITH_PVAPI=OFF \
    -DWITH_LIBREALSENSE=OFF -DWITH_UEYE=OFF -DWITH_XIMEA=OFF \
    -DWITH_CUDA=OFF -DWITH_CUDNN=OFF -DWITH_OPENCL=OFF -DWITH_VULKAN=OFF \
    -DWITH_VA=OFF -DWITH_VA_INTEL=OFF -DWITH_OPENVINO=OFF \
    -DWITH_WEBNN=OFF -DWITH_TIMVX=OFF -DWITH_CANN=OFF -DWITH_ONNX=OFF \
    -DOPENCV_DNN_CUDA=OFF -DOPENCV_DNN_OPENCL=OFF -DOPENCV_DNN_OPENVINO=OFF \
    -DWITH_PROTOBUF=ON -DBUILD_PROTOBUF=ON -DPROTOBUF_UPDATE_FILES=OFF \
    -DWITH_FLATBUFFERS=OFF -DOPENCV_DNN_TFLITE=OFF \
    -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_TBB=OFF -DWITH_LAPACK=OFF \
    -DWITH_EIGEN=OFF -DWITH_QUIRC=OFF \
    -DWITH_JPEG=ON -DBUILD_JPEG=OFF -DWITH_PNG=ON -DBUILD_PNG=OFF \
    -DBUILD_ZLIB=OFF -DWITH_TIFF=OFF -DWITH_WEBP=OFF \
    -DWITH_OPENEXR=OFF -DWITH_OPENJPEG=OFF -DWITH_JASPER=OFF \
    -DWITH_AVIF=OFF -DWITH_JPEGXL=OFF -DWITH_GDAL=OFF -DWITH_GDCM=OFF \
    -DWITH_SPNG=OFF \
 && timeout 1800 cmake --build /build/opencv-build --parallel "${BUILD_JOBS}" \
 && cmake --install /build/opencv-build \
 && mkdir -p /opt/opencv/build-record /opt/opencv/share/licenses \
 && cp /build/opencv-build/CMakeCache.txt /build/opencv-build/install_manifest.txt /opt/opencv/build-record/ \
 && cp /build/opencv-4.12.0/LICENSE /opt/opencv/share/licenses/OpenCV-APACHE-2.0.txt \
 && cp /build/opencv-4.12.0/3rdparty/protobuf/LICENSE /opt/opencv/share/licenses/Protobuf-LICENSE.txt \
 && cp /build/opencv-4.12.0/modules/features2d/3rdparty/mscr/chi_table_LICENSE.txt /opt/opencv/share/licenses/MSCR-LICENSE.txt \
 && apk info -vv > /opt/opencv/build-record/builder-apk-packages.txt
RUN curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
      https://files.pythonhosted.org/packages/e3/14/727cbb58c72d6df4520153ea6788e1efdebb5d6b446392c784017c70ce0a/scenedetect_headless-0.7.2-py3-none-any.whl \
      --output /build/scenedetect.whl \
 && echo '583fd5dbc2418f027a1c17c3444d0bbd8cb630357e19705c4f68ae4c1aa51ef2  /build/scenedetect.whl' | sha256sum -c - \
 && python3 -m zipfile -e /build/scenedetect.whl /opt/scenedetect

# ── Bundle the service into one file ─────────────────────────────────────
# The official Node image for this stage only: it carries npm, and nothing
# from it reaches the image that runs.
FROM node:24-alpine3.23 AS build
WORKDIR /src
COPY packages/ingest/tsconfig.json ./
COPY packages/ingest/src ./src
COPY packages/ingest/container ./container
# The mini-tool runs build their colour, denoise, equaliser and compressor filters, and
# the probe reads audio peaks, from these files of shared (src/jobs/op-args.ts,
# container/stream-peaks.ts), resolved through tsconfig's @shared/* path.
COPY packages/shared/src/adjust-value.ts /shared/src/adjust-value.ts
COPY packages/shared/src/audio-eq.ts /shared/src/audio-eq.ts
COPY packages/shared/src/audio-denoise.ts /shared/src/audio-denoise.ts
COPY packages/shared/src/audio-dynamics.ts /shared/src/audio-dynamics.ts
COPY packages/shared/src/audio-peaks.ts /shared/src/audio-peaks.ts
COPY packages/shared/src/upload/agent-picture-types.ts /shared/src/upload/agent-picture-types.ts
# The presentation probe plans the frame grid from these (container/presentation-run.ts).
COPY packages/shared/src/mini-tools/canonical-json.ts /shared/src/mini-tools/canonical-json.ts
COPY packages/shared/src/mini-tools/types.ts /shared/src/mini-tools/types.ts
COPY packages/shared/src/mini-tools/video-encode-plan.ts /shared/src/mini-tools/video-encode-plan.ts
COPY packages/shared/src/upload/frame-grid-rate.ts /shared/src/upload/frame-grid-rate.ts
COPY packages/shared/src/upload/frame-grid.ts /shared/src/upload/frame-grid.ts
# The planned job runner names each recipe's inputs with this (container/plan-run.ts); the rest are the types the service
# imports. container/__tests__/image-shared-files.node.test.ts holds this list to the imports.
COPY packages/shared/src/upload/mini-tool-plan-types.ts /shared/src/upload/mini-tool-plan-types.ts
COPY packages/shared/src/media/long-media-job-types.ts /shared/src/media/long-media-job-types.ts
COPY packages/shared/src/upload/video-presentation-types.ts /shared/src/upload/video-presentation-types.ts
COPY scripts/release.mjs ./scripts/release.mjs
ARG RELEASE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
RUN mkdir -p /out && node scripts/release.mjs build-info "$RELEASE_VERSION" "$VCS_REF" /out/build-info.json
# esbuild is pinned so this image builds the same way on every machine. No
# manifest in this repository declares esbuild — it arrives seven times over as
# a transitive dependency, at seven different versions — so there is no "the
# repo's version" to follow; this pin is its own. Bundling here rather than on
# whoever runs the build is what makes `docker build` the whole of it, which is
# also the fourth GPL obligation below. The playback and edit command builders' source digests are embedded here: they are
# part of the presentation producer and edit profile versions (container/presentation-run.ts, frames-split design §3.5).
RUN npm install --no-audit --no-fund --global esbuild@0.25.12 \
  && esbuild container/server.ts \
    --define:__PLAYBACK_BUILDER_SHA256__="\"$(sha256sum container/playback-command.ts | cut -d ' ' -f 1)\"" \
    --define:__EDIT_BUILDER_SHA256__="\"$(sha256sum container/edit-command.ts | cut -d ' ' -f 1)\"" \
    --bundle --platform=node --format=esm --target=node24 \
    --tsconfig=tsconfig.json \
    --outfile=/out/server.mjs

# ── The image that runs ──────────────────────────────────────────────────
# Alpine rather than a Node base image: the service is that one bundled file,
# so npm and the rest of a Node distribution would be weight with no reader,
# and image size is what the cold start is paid in.
FROM ${ALPINE_IMAGE}
ARG RELEASE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.version=$RELEASE_VERSION \
      org.opencontainers.image.revision=$VCS_REF
RUN apk add --no-cache nodejs=~24 ffmpeg=~8.0 vips-tools=~8.17 sox=~14.4

# Only the separate Python process loads these libraries. No pip resolver or
# prebuilt OpenCV wheel can bring FFmpeg libraries back into that process.
RUN apk add --no-cache \
    python3=3.12.16-r0 py3-numpy=2.3.5-r0 \
    py3-click=8.1.8-r1 py3-platformdirs=4.5.0-r0 py3-tqdm=4.67.1-r0 \
    libstdc++ libgcc zlib libjpeg-turbo libpng
COPY --from=opencv-builder /opt/opencv /opt/opencv
COPY --from=opencv-builder /opt/scenedetect /opt/scenedetect
COPY packages/ingest/container/analysis-runtime.py /app/analysis-runtime.py
COPY packages/ingest/container/ANALYSIS-SOURCE /usr/share/analysis-source/SOURCE
COPY packages/ingest/container/COPYING.GPLv3 /usr/share/analysis-source/GCC-COPYING3
COPY packages/ingest/container/COPYING.RUNTIME /usr/share/analysis-source/GCC-COPYING.RUNTIME
COPY packages/ingest/container/OpenBLAS-LICENSE.txt /usr/share/analysis-source/OpenBLAS-LICENSE.txt
ENV PYTHONPATH=/opt/opencv/lib/python3.12/site-packages:/opt/scenedetect
ENV OPENBLAS_NUM_THREADS=1
RUN set -eu; \
  cp -R /opt/opencv/share/licenses /usr/share/analysis-source/opencv-licenses; \
  cp /opt/scenedetect/scenedetect_headless-0.7.2.dist-info/licenses/LICENSE /usr/share/analysis-source/PySceneDetect-LICENSE; \
  cp /usr/lib/python3.12/LICENSE.txt /usr/share/analysis-source/Python-LICENSE.txt; \
  cp /usr/lib/python3.12/site-packages/numpy-2.3.5.dist-info/LICENSE.txt /usr/share/analysis-source/NumPy-LICENSE.txt; \
  apk info -vv > /opt/opencv/build-record/runtime-apk-packages.txt; \
  { \
    echo; \
    echo "Installed Alpine packages (version, licence, exact recipe commit):"; \
    awk '/^P:/{p=$0} /^V:/{v=$0} /^L:/{l=$0} /^c:/{print p, v, l, $0}' /lib/apk/db/installed; \
  } >> /usr/share/analysis-source/SOURCE

# ── ffmpeg is GPL-licensed (#178) ────────────────────────────────────────
# Alpine builds ffmpeg with GPL components (x264 among them), so distributing
# this image distributes GPL software. Three obligations are met here and the
# fourth by the build being this file:
#
#   1. The licence texts travel with the image, in the directory below.
#   2. The version and its origin are recorded beside them.
#   3. That record names where the corresponding source is fetched from.
#   4. This Dockerfile is the whole build; anyone can reproduce it.
#
# Which licence, measured rather than taken from the package metadata: this
# build carries `--enable-gpl` AND `--enable-version3`, and `ffmpeg -L` answers
# "GNU General Public License … either version 3 of the License, or (at your
# option) any later version". So the binary is GPL-3.0-or-later. Alpine's `L:`
# field says GPL-2.0-or-later AND LGPL-2.1-or-later, which is where the
# or-later chain starts rather than where this build lands; the SOURCE file
# below records both, and all four texts travel with it as upstream ships them.
#
# The texts are copied from this repository rather than pulled at build time.
# Alpine's ffmpeg package installs no licence file of its own — measured, the
# image has none anywhere — so a build that expected to find one would meet
# none of the four while reading as though it met three.
COPY packages/ingest/container/COPYING.GPLv2 /usr/share/ffmpeg-source/COPYING.GPLv2
COPY packages/ingest/container/COPYING.GPLv3 /usr/share/ffmpeg-source/COPYING.GPLv3
COPY packages/ingest/container/COPYING.LGPLv2.1 /usr/share/ffmpeg-source/COPYING.LGPLv2.1
COPY packages/ingest/container/COPYING.LGPLv3 /usr/share/ffmpeg-source/COPYING.LGPLv3

# What this image distributes and under what terms, beside the four texts above
# rather than among them: those are FFmpeg's own, this one covers the image.
COPY THIRD-PARTY.md /usr/share/doc/breatic/THIRD-PARTY.md

# Every value is read out of the installed package rather than written here, so
# what the notice claims is what was actually installed. `c:` is the aports
# commit the package was built from, which names the recipe exactly — a branch
# moves on and stops describing this build.
#
# The licence is read twice from two sources that disagree: the package's `L:`
# field, and the binary's own `-L` output. The binary is the one that knows
# which components were compiled in, so it is quoted first and the metadata is
# recorded beside it. Reading only the metadata is how the entry in
# THIRD-PARTY.md came to say version 2 of a binary that says version 3.
RUN set -eu; \
  info=$(awk '/^P:ffmpeg$/,/^$/' /lib/apk/db/installed); \
  version=$(printf '%s\n' "$info" | sed -n 's/^V://p'); \
  declared=$(printf '%s\n' "$info" | sed -n 's/^L://p'); \
  commit=$(printf '%s\n' "$info" | sed -n 's/^c://p'); \
  upstream=$(printf '%s\n' "$version" | sed 's/-r[0-9]*$//'); \
  { \
    echo "ffmpeg $version."; \
    echo; \
    echo "The licence, as the binary itself reports it (ffmpeg -L):"; \
    ffmpeg -hide_banner -L 2>&1 | head -4 | sed 's/^/  /'; \
    echo; \
    echo "Alpine's package metadata declares: $declared."; \
    echo "That is where the or-later chain starts; the line above is where"; \
    echo "this build lands, because it carries --enable-version3."; \
    echo; \
    echo "Built by Alpine Linux from the recipe at this exact commit:"; \
    echo "  https://gitlab.alpinelinux.org/alpine/aports/-/tree/$commit/community/ffmpeg"; \
    echo; \
    echo "The program's own source for this version:"; \
    echo "  https://ffmpeg.org/releases/ffmpeg-$upstream.tar.xz"; \
    echo; \
    echo "All four licence texts are in this directory, as upstream ships them."; \
  } > /usr/share/ffmpeg-source/SOURCE

# ── vips links GPL libraries (inner#1339) ────────────────────────────────
# libvips is LGPL-2.1-or-later, and Alpine's build links libimagequant
# (GPL-3.0-or-later) and fftw (GPL-2.0-or-later) into it, so the `vips` program
# in this image is carried under GPL-3.0-or-later. It is met the way ffmpeg's
# is above: the service runs it as a separate program and loads no library of
# it (`breatic/media-container-own-code-only`), the licence texts travel with
# the image, and a SOURCE file names each package, its licence and the recipe
# it was built from. Every value is read out of the installed packages.
COPY packages/ingest/container/COPYING.GPLv2 /usr/share/vips-source/COPYING.GPLv2
COPY packages/ingest/container/COPYING.GPLv3 /usr/share/vips-source/COPYING.GPLv3
COPY packages/ingest/container/COPYING.LGPLv2.1 /usr/share/vips-source/COPYING.LGPLv2.1
RUN set -eu; \
  { \
    echo "vips and the two GPL libraries it links, as installed in this image."; \
    echo "Together the program is carried under GPL-3.0-or-later."; \
    echo; \
    for p in vips libimagequant fftw-double-libs; do \
      info=$(awk "/^P:$p\$/,/^\$/" /lib/apk/db/installed); \
      version=$(printf '%s\n' "$info" | sed -n 's/^V://p'); \
      licence=$(printf '%s\n' "$info" | sed -n 's/^L://p'); \
      origin=$(printf '%s\n' "$info" | sed -n 's/^o://p'); \
      commit=$(printf '%s\n' "$info" | sed -n 's/^c://p'); \
      repo=$(apk policy "$p" | tail -1 | sed 's#.*/##'); \
      echo "$p $version, $licence."; \
      echo "  Built by Alpine Linux from the recipe at this exact commit, whose"; \
      echo "  APKBUILD names the upstream source it builds:"; \
      echo "  https://gitlab.alpinelinux.org/alpine/aports/-/tree/$commit/$repo/$origin"; \
      echo; \
    done; \
    echo "The licence texts are in this directory."; \
  } > /usr/share/vips-source/SOURCE

# ── sox is GPL-licensed (inner#1305) ─────────────────────────────────────
# The audio mini-tools' reverb and pitch run the sox program, which Alpine
# ships under GPL-2.0-or-later AND LGPL-2.1-or-later. It is met the way
# ffmpeg's and vips's are: the service runs it as a separate program and
# loads no library of it, the licence texts travel with the image, and a
# SOURCE file names the package, its licence and the recipe it was built
# from, every value read out of the installed package.
COPY packages/ingest/container/COPYING.GPLv2 /usr/share/sox-source/COPYING.GPLv2
COPY packages/ingest/container/COPYING.LGPLv2.1 /usr/share/sox-source/COPYING.LGPLv2.1
RUN set -eu; \
  info=$(awk '/^P:sox$/,/^$/' /lib/apk/db/installed); \
  version=$(printf '%s\n' "$info" | sed -n 's/^V://p'); \
  licence=$(printf '%s\n' "$info" | sed -n 's/^L://p'); \
  commit=$(printf '%s\n' "$info" | sed -n 's/^c://p'); \
  upstream=$(printf '%s\n' "$version" | sed 's/-r[0-9]*$//'); \
  repo=$(apk policy sox | tail -1 | sed 's#.*/##'); \
  { \
    echo "sox $version, $licence."; \
    echo; \
    echo "Built by Alpine Linux from the recipe at this exact commit:"; \
    echo "  https://gitlab.alpinelinux.org/alpine/aports/-/tree/$commit/$repo/sox"; \
    echo; \
    echo "The program's own source for this version:"; \
    echo "  https://downloads.sourceforge.net/project/sox/sox/$upstream/sox-$upstream.tar.bz2"; \
    echo; \
    echo "The licence texts are in this directory."; \
  } > /usr/share/sox-source/SOURCE

# Exercise the actual Python subprocess, the pinned detector and full raw-input
# contract during every image build. The test source is mounted, not shipped.
RUN --network=none --mount=type=bind,source=packages/ingest/container/__tests__/analysis-runtime.test.py,target=/tmp/analysis-runtime.test.py,ro \
    python3 /tmp/analysis-runtime.test.py

COPY --from=build /out/server.mjs /app/server.mjs
COPY --from=build /out/build-info.json /app/build-info.json

# Listening starts immediately: nothing is prepared at startup, because every
# second before the port answers is a second the request that woke this
# container spends waiting.
EXPOSE 8080
CMD ["node", "/app/server.mjs"]

# Which copy of the repository built this image, set by `image_vars` in a
# local wrangler.toml and empty for a deploy. Copies building the same content
# would otherwise share one image ID, and wrangler, after each build, removes
# every other `cloudflare-dev` tag on that ID — the tags another copy's Worker
# starts its containers from. Last, so every layer above stays shared.
ARG DEV_COPY=
LABEL org.breatic.dev-copy=$DEV_COPY
