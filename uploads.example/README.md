# Uploads Directory

This directory stores AIGC-generated files (images, videos, audio, 3D models) when using local storage.

## Setup

Rename this directory to `uploads/`:

```bash
mv uploads.example uploads
```

The `uploads/` directory is git-ignored and will be created automatically when the server starts.

## Structure

```
uploads/
├── image/     # Generated images
├── video/     # Generated videos
├── audio/     # Generated audio / TTS
├── tts/       # Text-to-speech output
├── three-d/   # 3D models
└── understand/ # Analysis results
```

## Docker

When using Docker Compose, `uploads/` is mounted as a volume:

```yaml
volumes:
  - ./uploads:/app/uploads
```

## Cloud Storage

For production, set `STORAGE_PROVIDER=s3` or `STORAGE_PROVIDER=aliyun_oss` in `.env` instead of using local storage.
