# Breatic

**English** | [简体中文](README-CN.md)

Breatic is an AI creative workspace built around **projects with multiple Spaces**. Keep a script in a Document Space, develop scenes in separate Canvas Spaces, and work with AI and collaborators in the same project. You choose how to divide the work: by scene, episode, deliverable or creative direction.

## Organize a project with Spaces

A **Studio** holds your projects and assets. A **Project** brings together the work for a particular production. Each project can contain multiple **Spaces**, including several of the same type, which you switch between using tabs.

| Space | What you do there | Examples |
| --- | --- | --- |
| **Document Space** | Write and structure the text that guides the work, using headings, lists and formatted text | A creative brief, script, shot descriptions or production checklist |
| **Canvas Space** | Arrange references and media on an infinite canvas; use prompts, models and reference inputs to generate and refine assets | A scene workspace, character exploration, visual direction or a set of alternative shots |

A Canvas Space is a creative work area within the project. Its nodes hold the individual references, prompts and media you work with. Give different parts of a production their own Spaces so the script and each scene remain easy to find as the project grows.

### Example: a 30-second video

Create one project with four Spaces:

| Space name | Type | Contents |
| --- | --- | --- |
| Script and brief | Document | The story, dialogue, visual direction and a description of each segment |
| 01 · Opening · 0–10s | Canvas | Opening-shot references, prompts and candidate images or clips |
| 02 · Main scene · 10–20s | Canvas | The main action, scene assets and variations to compare |
| 03 · Ending · 20–30s | Canvas | The closing shot and its supporting assets |

Keep the script in its Document Space and switch to each Canvas Space to develop that segment. For a one-minute short drama, you could use six scene canvases alongside the script. For a different project, organize Spaces by character, topic or deliverable instead.

The ten-second divisions are your planning convention; Space names do not set clip duration or assemble a finished video. Download the chosen assets and use a video editor for final sequencing. Canvas and Document Spaces are available now; Timeline is not yet available.

## Create with AI and collaborators

Use the project chat to discuss ideas and work with the AI agent. On the canvas, choose a model, add a prompt and references, and compare or refine the results alongside the rest of your scene. Supported media includes images, video, audio and 3D assets; available generation capabilities depend on your provider credentials and model access.

Invite collaborators with the project's access controls to work on the same production. Canvas and document changes synchronize in real time, so the written plan and visual work can be developed together. Breatic is under active development.

## Choose how to run it

**Installing Breatic and developing Breatic are different workflows.** Running it on your own computer does not require a development server.

| Your goal | Guide |
| --- | --- |
| Use it yourself, or share it with a household/private team on your LAN | [Personal and LAN deployment](deploy/LOCAL.md) |
| Run a private instance on a server with a domain | [Private server and domain deployment](deploy/SERVER.md) |
| Modify source code, debug or contribute | [Development setup](deploy/DEVELOPMENT.md) |

For installation, the application runs as published Docker images: web, API, background jobs and collaboration, backed by PostgreSQL and Redis. File uploads use an Ingest Worker and media container deployed to **your Cloudflare account**, with files stored in your R2 bucket. AI calls use your provider accounts. This is not an offline or wholly on-premises installation.

Start with the personal/LAN guide. It covers Cloudflare provisioning, secrets, application configuration and startup in order. Do not run `pnpm dev` or a local upload Worker just to use the product. The current Cloudflare provisioning step does use Node/pnpm/Wrangler once to publish the matching Worker; they are not long-running application requirements.

## Your first project

After completing installation:

1. Open the instance in a desktop browser, register an account, save your recovery code and finish your personal Studio setup. There is no shared default password or login bypass.
2. Create a project for the work you want to make and choose its initial Space type.
3. Use the **+** button in the project's Space bar to add a **Document** Space. Name it “Script and brief” and write the story or requirements. If you started with a Document Space, use that one.
4. Add one or more **Canvas** Spaces for your scenes or creative directions. Give each a meaningful name, then upload references or add nodes to begin working.
5. Switch between Spaces using their tabs; use the Space list to find and manage the project's other Spaces. Use chat and the canvas tools to generate and refine assets with a configured provider.
6. Share the project with permitted collaborators and choose their access permissions.

If you are joining an existing instance, use the address provided by its operator and start with account registration; you do not need to deploy another copy. Operators should complete the deployment guide's login, persistence, collaboration, upload and generation checks before inviting users.

## Working in Breatic

- **Write the plan:** in a Document Space, use headings for scenes, lists for shot descriptions and to-dos for production tasks. Select text to format it, or use the document shortcuts below.
- **Add and arrange content:** upload references, or right-click an empty canvas area to choose a node type. Drag nodes to arrange them; drag across empty canvas to select an area.
- **Navigate the canvas:** scroll with a mouse wheel or two fingers to pan; pinch or use Ctrl+wheel to zoom. The viewport toolbar also provides zoom, fit-to-window, grid snapping and a minimap. Double-clicking empty canvas does not zoom.
- **Work with selected nodes:** right-click a node or selection for available actions such as copy, duplicate, group, rename, lock/unlock, download and delete. The menu depends on the selection and your permissions; not every action applies to every node.
- **Generate and refine:** choose a model you have configured, provide a prompt and any references, and wait for the task result before continuing with the asset. Missing provider credentials or quota can prevent generation even when the application is healthy.
- **Collaborate and keep your work:** canvas changes synchronize through the collaboration service. Check that synchronization and uploads have completed before leaving; a disconnected browser or unfinished task is not proof that work has been stored. Refresh and reopen the project when verifying persistence.

<a id="keyboard-shortcuts"></a>
## Keyboard shortcuts

Canvas shortcuts apply when the canvas Space owns keyboard focus, not while typing in chat, a text field or an editor. Editing actions require write permission. Locked items and nodes with running tasks may restrict deletion. Click the canvas before using a canvas shortcut.

### Canvas

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Copy selected nodes | `Cmd+C` | `Ctrl+C` |
| Paste supported clipboard content | `Cmd+V` | `Ctrl+V` |
| Duplicate selected nodes without replacing the clipboard | `Cmd+D` | `Ctrl+D` |
| Undo a canvas edit | `Cmd+Z` | `Ctrl+Z` |
| Redo a canvas edit | `Cmd+Shift+Z` | `Ctrl+Shift+Z` or `Ctrl+Y` |
| Group an eligible selection | `Cmd+G` | `Ctrl+G` |
| Ungroup a selected group | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| Delete eligible selected nodes / edges | `Backspace` or `Delete` | `Backspace` or `Delete` |
| Cancel active reference picking or annotation placement | `Esc` | `Esc` |

Copy/paste can depend on browser clipboard permissions and a secure context; use the trusted HTTPS setup in the LAN guide. `Cmd/Ctrl+A` is **not** a select-all-nodes shortcut: outside editable content, the project suppresses page-wide selection. Use canvas selection gestures instead.

### Document editing

These shortcuts act inside the document editor, not on canvas nodes. On macOS, `Option` is the key also labeled `Alt`.

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Bold / italic / underline | `Cmd+B` / `Cmd+I` / `Cmd+U` | `Ctrl+B` / `Ctrl+I` / `Ctrl+U` |
| Strikethrough | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| Inline code | `Cmd+E` | `Ctrl+E` |
| Paragraph | `Cmd+Option+0` | `Ctrl+Alt+0` |
| Heading 1 / 2 / 3 | `Cmd+Option+1` / `2` / `3` | `Ctrl+Alt+1` / `2` / `3` |
| Bulleted list | `Cmd+Shift+8` | `Ctrl+Shift+8` |
| Numbered list | `Cmd+Shift+7` | `Ctrl+Shift+7` |
| To-do list | `Cmd+Shift+9` | `Ctrl+Shift+9` |
| Code block | `Cmd+Option+C` | `Ctrl+Alt+C` |
| Quote | `Cmd+Shift+B` | `Ctrl+Shift+B` |

### Chat

| Action | Shortcut |
| --- | --- |
| Send the current message | `Enter` |
| Insert a line break | `Shift+Enter` |

Enter used to confirm an active input-method composition does not send the message. Submission still depends on the current input and task state.

## What you need

- Docker with Compose for the application and databases.
- A Cloudflare account with R2 and access to Containers for the deployed upload/media service.
- Your own AI provider credentials and available quota for the models you want to use.
- For LAN or domain access, a trusted HTTPS certificate and network access limited to your intended users.

SMTP mail, Google sign-in, Stripe payments and search are optional integrations. The guides distinguish these from the services required for file storage and generation. Cloud services and model calls can incur charges even when Breatic payments are disabled.

## License and permitted use

Breatic is **source-available** under the [Breatic Source-Available License v1.0](LICENSE), based on Apache 2.0 with additional conditions.

The license permits individual use, private groups that are not publicly advertised or open to general sign-up, and internal deployment within one organization. It prohibits offering Breatic to the public without separate authorization, **whether paid or free**. A domain or a server does not by itself determine the permitted audience. Preserve the product's branding and copyright notices. See the license for the complete terms; public-facing licensing inquiries go to [licensing@orime.ai](mailto:licensing@orime.ai).

## For contributors

Breatic uses TypeScript, React/Vite, Hono, PostgreSQL, Redis/BullMQ and Hocuspocus/Yjs, with a separate Cloudflare Worker for uploads.

- [Development setup](deploy/DEVELOPMENT.md): dependencies, local services and tests.
- [Contributing](CONTRIBUTING.md): contribution workflow and conventions.
- [Architecture](docs/ARCHITECTURE.md): packages, services, data flow and frontend structure.
- [Testing](docs/TEST-MANDATE.md): unit, integration and browser verification.

## Security

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), rather than opening a public issue. Third-party components and notices are documented in [THIRD-PARTY.md](THIRD-PARTY.md).

© 2026 Orime, Inc.
