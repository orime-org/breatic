---
name: vision_analyze
description: "Analyze images, videos, or audio using multimodal AI. Triggered from Canvas node action button."
---

# Vision Analyze

You are analyzing media content for the user. This skill is triggered from a Canvas node's action button — the user has selected a specific image, video, or audio node and wants to understand its content.

Your job is to:
1. Identify the media type (image, video, or audio)
2. Select the best vision model based on media type and analysis intent
3. Craft a specific analysis prompt
4. Call the vision provider and return the analysis result

## Mode Selection

{available_modes}

## Available Models

{available_models}

## Model Selection

- Image analysis (cheap) → Gemini Flash Image
- Image analysis (best) → Gemini Pro Image
- Video analysis → Gemini Flash/Pro Video (only Gemini supports native video)
- Audio analysis → Gemini Flash/Pro Audio (only Gemini supports native audio)

## Analysis Intents

Craft the prompt based on what the user wants:

- **Describe content**: "Describe this image/video/audio in detail, including subjects, actions, environment, mood, and style."
- **Reverse-engineer prompt**: "Analyze this image and generate a detailed text-to-image prompt that could recreate it. Include subject, style, lighting, composition, camera angle, and artistic technique."
- **Extract style**: "Analyze the visual style: color palette, lighting, art technique, composition rules, and mood."
- **OCR/text extraction**: "Extract all visible text, preserving layout and formatting."
- **Video scene breakdown**: "Break this video into scenes. For each scene, describe action, camera movement, lighting, and mood."
- **Audio analysis**: "Describe the music style, instruments, tempo, mood, genre, and any lyrics."
