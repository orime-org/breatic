---
name: breatic-media-files
description: Use when a breatic task involves a file — cropping, rotating, resizing, trimming, joining, changing speed, converting, pulling frames or drawing a mask for a picture, video or sound, downloading something the user linked, or uploading a file from your machine to a breatic canvas or document.
---

# Files in breatic

## Who does what

| Work | Where |
|---|---|
| Processing that calls no model: crop, rotate, resize, trim, join, speed, convert, denoise with a local tool, pull frames, draw a mask or a sketch, pad a picture for expanding | **On your machine**, then upload the result |
| Generation, understanding, transcription, node tools that call our models | **Our tools**: `run_generation`, `understand_node`, `transcribe_node`, `run_mini_tool` |

When the user gives you an address (a file link, or a video on a web page), download it yourself, process it if needed, and upload it.

Everything that ends up on a canvas or in a document is stored through the upload below.

## What the canvas takes

| Kind | Formats |
|---|---|
| Picture | PNG, JPEG, WebP |
| Video | MP4, WebM, MOV |
| Sound | MP3, WAV, M4A, WebM |

One file is at most 2 GiB. Convert anything else before uploading.

## Common processing

```bash
# Pictures (ImageMagick 7)
magick in.png -rotate 90 out.png
magick in.png -resize 2048x2048 out.png
magick in.png -crop 800x600+100+50 +repage out.png

# Mask for image.inpaint / image.erase: black, white where to change, same size as the source
magick -size 1024x768 xc:black -fill white -draw "rectangle 300,200 600,500" mask.png

# Padded picture and mask for image.expand: source centred on a larger transparent canvas
magick in.png -background none -gravity center -extent 1600x1000 padded.png
magick -size 1600x1000 xc:white \( in.png -fill black -colorize 100 \) -gravity center -composite expand-mask.png

# Video and sound (ffmpeg)
ffmpeg -ss 00:00:05 -to 00:00:12 -i in.mp4 -c copy cut.mp4
ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4      # list.txt: file 'a.mp4' per line
ffmpeg -i in.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" fast.mp4
ffmpeg -ss 3 -i in.mp4 -frames:v 1 frame.png
ffmpeg -i in.mov -c:v libx264 -c:a aac out.mp4
```

## Uploading

1. Hash each file: `sha256sum file` (macOS: `shasum -a 256 file`).
2. `begin_upload` with each file's `name`, `contentType`, `size` (bytes) and `sha256`, and one destination:

   | Destination | Where the file lands |
   |---|---|
   | `canvas` | New nodes; two or more are framed in a group. With `afterNodeId`, placed after that node and wired from it |
   | `into_node` | Fills one empty node of the file's type |
   | `document` | One file, inserted as a media block after `afterBlockId` (or at the end) of this document Space |
   | `detached` | Stored only, to pass to `run_mini_tool` as a mask, sketch or padded picture |

3. Each file's answer is `stored` (the Studio already holds it; nothing to send), `failed` (with the reason), or `send`. For `send`, cut the file into `totalParts` pieces of `partSize` bytes and send them in order:

   ```bash
   split -b <partSize> -d -a 4 file part_            # part_0000, part_0001, ...
   curl -sS -X PUT --data-binary @part_0000 -H "x-upload-token: <token>" "<partUrl with {partNumber}=1>"
   ```

   Each answer is JSON `{ partNumber, etag, token }`. Keep every `{ partNumber, etag }`, and send the next part with the `token` the last answer gave.
4. `finish_upload` with the file's `finish` fields, the last `token` and every `{ partNumber, etag }`. It waits until the file is stored and answers `stored` with its address (and `blockId` for a document). When it answers `finishing`, call it again with the same arguments.
5. If a part cannot be sent, or you stop, call `abort_upload` with the file's `taskId`: the node records a failed upload and can be deleted or filled again. An upload without a `taskId` (`detached`, `document`) needs no abort.

The stored file's type, size and hash are read from the bytes that arrive, so send the file exactly as hashed.
