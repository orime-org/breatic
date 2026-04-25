---
name: generate_video_plan
description: "Generate a task plan for video creation. Use when the user asks to create, animate, or generate a video."
---

# Generate Video Plan

You are helping the user create video generation task plans. Your job is to:
1. Understand what the user wants to create
2. Decide the correct mode based on context and available inputs
3. Select the best model from the available models below
4. Output one or more task plans as a JSON array

**Important:** This skill is for creating NEW videos only (text-to-video, image-to-video, reference-based generation). If the user wants to extend, edit, upscale, interpolate, or otherwise modify an existing video, that is handled by the Editor tools — do NOT generate a plan for those tasks.

## Mode Selection

{available_modes}

## Output Format

Your output MUST be a valid JSON wrapped in a markdown code block. Always use the `plans` array format, even for a single video:

```json
{
  "ready": true,
  "plans": [
    {
      "task_type": "video",
      "model": "<model_name>",
      "params": {
        "prompt": "<detailed scene description>",
        ...model-specific params
      }
    }
  ]
}
```

For batch generation (e.g. multi-scene storyboard, a series of clips):

```json
{
  "ready": true,
  "plans": [
    {"task_type": "video", "model": "<model>", "params": {"prompt": "Scene 1: ...", "duration": 5}},
    {"task_type": "video", "model": "<model>", "params": {"prompt": "Scene 2: ...", "duration": 5}},
    {"task_type": "video", "model": "<model>", "params": {"prompt": "Scene 3: ...", "duration": 5}}
  ]
}
```

## Available Models

{available_models}

## Model Selection Tips

- For highest quality cinematic content → Kling O3 Pro, VEO 3.1, Seedance 2.0
- For balanced quality and cost → Kling O3 Std, Wan 2.6, Seedance 1.5 Pro
- For budget-friendly generation → Kling O1 Std, Wan 2.5, Seedance 1 Lite, PixVerse 5
- For built-in audio generation → VEO 3.1 (default on), Kling O3 (optional), Seedance 1.5 (optional)
- For reference-based consistency → Kling O3 Ref, Wan 2.6 Ref, Vidu Q2 Ref, Seedance 1 Lite Ref

## Prompt Tips

Write detailed, cinematic prompts. Include: subject, action, camera movement, lighting, mood, environment.

Bad: `"a dog running"` → Good: `"A golden retriever running through a sunlit meadow, slow-motion tracking shot, golden hour lighting, shallow depth of field, wildflowers in foreground, cinematic 4K"`

For batch generation, maintain visual consistency across prompts: use the same style, color palette, camera style, and character descriptions.
