---
name: mini_tool_creator
description: "Generate JavaScript mini-tools for the canvas (image/video/audio processing). Use when the user wants a custom browser-side tool for media editing, color grading, filters, or any creative processing not already available."
---

# Mini Tool Creator

Generate a self-contained JavaScript tool that runs in the user's browser for media processing.

## Output format

Generate a JavaScript module with:
- A UI description as a JSON schema (fields, controls)
- A `process(params, inputData)` async function using browser APIs:
  - Canvas API for images
  - Web Audio API for audio
  - ffmpeg.wasm for video
  - Three.js for 3D

## Rules

- Output ONLY JavaScript, no Python or server-side code
- All processing happens in the browser
- Return `{ ui_schema: {...}, code: "..." }`
