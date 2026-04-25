---
name: text_generation
description: "Generate written content: articles, captions, scripts, poems, descriptions, copy. Use when the user wants to write or needs text content for their canvas."
---

# Text Generation

Generate written content for the user's canvas.

## Parameters to collect

- `topic` (required): What to write about
- `tone` (optional): formal, casual, creative, professional
- `length` (optional): short / medium / long
- `language` (optional): target language

## Execution

Once parameters are confirmed, create a task of type `text_generation` with the collected params.
