---
name: breatic-canvas
description: Use when working on a breatic canvas Space — creating, wiring, grouping or moving nodes, applying a generation template, setting a generate node's mode, model, prompt and references, generating, running node tools that call breatic's models, locking nodes, or putting a node back to an earlier version.
---

# Working on a breatic canvas

## What is on a canvas

| Node type | Holds | Generates |
|---|---|---|
| text | words | no |
| image | a picture | yes |
| video | a video | yes |
| audio | a sound | yes |
| group | other nodes, framed | no |
| annotation | a comment thread pinned to the canvas | no |

`get_canvas_capabilities` gives the exact list: which types you can create, the modes each generate node has, and which type may connect into which. Models for a mode come from `list_generation_models` (parameters, defaults, typical time and price).

## Connections are references

A connection into a generate node makes its source one of that node's **references**: the generation can use it. Connect with `connect_nodes` (the canvas refuses connections its rule does not allow, `cannot_connect`), and write the reference into a prompt as `@[name](node id)`. A prompt that @-mentions a node not connected into it is refused (`not_a_reference`).

## Making a flow

Two ways:

- **From a template.** `list_generation_templates`, then `get_generation_template` to read it. `create_canvas_nodes` with `template: { id }` places the whole flow as picking it in the generate panel does: on a new node, or on `template.nodeId` (a node of the template's anchor type). Its nodes, connections, models, settings and prompts are written and its resource files fetched in. When the answer says `toFill: true`, the user is left an empty node to fill or words in `{✏️ ...}` to write: fill them from what the user wants (with `update_canvas_node`, or `begin_upload` for a file) before generating.
- **Node by node.** `create_canvas_nodes` with `nodes` (and `edges` by index, `group` to frame them), then `update_canvas_node` for each generate node's `generation`: `mode`, `model`, `params`, `prompt`, `lyrics`, `shots`, `slots`.

Nodes with no position are placed where the user is looking, moved right until they cover nothing. A template's new nodes join the group its anchor is in; when the anchor is in none, two or more new nodes get a group of their own.

## Generating

1. Read the node (`read_canvas` with its id) and check its settings.
2. `run_generation` with the node id. It runs exactly what the node's panel would: refused with the panel's words when a prompt, a reference or a voice is missing.
3. The task id comes back at once; the result lands on the node and arrives in `finishedTasks`, or ask `get_task_result`.

`read_node_history` lists a node's earlier results; `restore_node_version` puts one back.

## Node tools that call our models

`run_mini_tool` runs the tools listed in its description (upscale, remove background, inpaint, erase, sketch, expand, relight, restyle, video upscale and extend, audio enhance and separate, and more). The result goes into new nodes beside the source, wired from it. Fill a tool's slots (`slots`, by slot name) from nodes on the canvas.

Some tools need a picture you make first, then upload with `begin_upload` (destination `detached`) and pass by address:

| Tool | Input | What it is |
|---|---|---|
| `image.inpaint`, `image.erase` | `mask` | PNG the size of the source: white where to change, black elsewhere |
| `image.sketch` | `sketch` | The source with the rough shapes drawn on |
| `image.expand` | `expand.image`, `expand.mask` | The source on a larger transparent canvas, and a mask the same size: white over the new area, black over the source |

Tools that only process a file (crop, rotate, trim, join, speed, convert) are not in this list: do them on your machine and upload the result (`breatic-media-files`).

## Locks and deletion

- A locked node refuses every change until unlocked (`lock_canvas_nodes`, `unlock_canvas_nodes`); a locked group freezes its frame and membership.
- `delete_canvas_nodes` deletes nodes with their edges; deleting a group deletes its members. A locked node, a node with a running task and someone else's note are kept, and the answer says which and why.

## Comments

`comment_on_canvas` writes a note at a point or on a node, or replies to a note (`annotationId`). Replying to a thread handed to you answers it.
