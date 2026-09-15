# Browser plan approval

Pi loads the plan workflow as a bundled internal extension. Start Pi from this
repository with `./pi-test.sh`. Do not load the separate
`examples/extensions/plan-mode` example at the same time: it also registers
`/plan`.

Open the mode settings:

```text
/mode
```

The menu has **Planner model** and **Programming model** submenus. They reuse the
model list from `/model`; the planner list only includes reasoning models. Each
mode defaults independently to **Default model**, which means the model active
when `/plan` starts. Selecting a specific model is optional.

The configuration is stored in `~/.pi/agent/plan-models.json`. Planner uses high
thinking; programming uses thinking off, clamped to what its model supports.
Configuration does not change Pi's default model for other sessions.

Start a task:

```text
/plan Describe the task here
```

Pi selects the planner, opens a local browser URL, and saves its Markdown plan to
a project-specific file under `~/.pi/agent/plans/`. It prefers port 7337 and uses
an available port when another planning session already owns it. The page displays
the plan and current activity, with live updates over a server event stream.
Changes made to the file outside Pi are also detected and invalidate its review
state.

The **Images** panel accepts image selection, drag and drop, and clipboard paste.
The local plan server validates and normalizes each upload, then stores it in a
plan-specific `.attachments` directory with a `.attachments.json` manifest beside
the Markdown file. The manifest is the persistent image annex: reopening the same
project restores its thumbnails and names. Removing an image updates the annex;
discarding or replacing the plan clears its annex as well.

Planner uses a document-editing system prompt rather than the default coding
assistant prompt. The current plan is included directly in that context, so the
planner never reads `plan_current.md` with a tool. When the plan is empty,
`write_plan` writes the complete document in whole mode. Once it has content,
`edit_plan` accepts an array of targeted `oldText`/`newText` replacements in diff
mode. Every `oldText` must identify one unique, non-overlapping region of the
original plan. Multiple replacements are validated together and the entire edit
fails without writing when any replacement is invalid. A full rewrite still
requires an explicit request and `replaceExisting`.

Create `~/.pi/agent/SYSTEM_PLANNING.md` to add custom instructions only to the planner
system prompt. A trusted project may override it with
`.pi/SYSTEM_PLANNING.md`. `SYSTEM.md` remains exclusive to normal programming
mode. Custom planning instructions cannot override the restricted tools,
browser approval, or whole/diff editing protocol.

Repository inspection is disabled by default. When the current request contains
an explicit `@file` mention, the planner may use only `ripgrep` for a narrow,
literal keyword search if the attached content lacks a fact needed by the plan.
Search results are limited to 20 matches with no surrounding context. The planner
does not list directories, discover files, follow imports, or perform exploratory
searches.

When planning finishes, select **Aprobar y ejecutar**. The owning Pi session
switches to the programming model, restores Pi's normal tools, and submits the
approved plan as an ordinary implementation task. Use **Solicitar cambios** with
observations to ask the planner for a revision. The page displays the final
assistant response, or reports a blocked result if execution is interrupted.

Use **Descartar plan actual** to clear the persisted plan and return to an
empty planner draft. **Crear nuevo plan** asks for the next task in a compact
dialog, while **Solicitar cambios** asks for planner observations the same way.
All plan actions remain together in the top toolbar and are unavailable while
Pi is busy.

`/plan` without a task reopens an active plan. After a completed execution, it
starts a new planner cycle with an empty `plan_current.md`, so the next terminal
prompt can describe the task. After a restart it loads a saved plan for the same
project and requires fresh approval.
The project is recorded in the first comment of the Markdown file. Each canonical
project path has an independent persisted plan. Legacy `~/.pi/agent/plan_current.md`
files with a valid project header are moved into this per-project storage when
`/plan` starts.

## Access and lifecycle

- Each terminal first tries port 7337. If it is already owned by another plan
  session, Pi selects an available local port so multiple projects can plan at
  the same time.
- Planner only has the restricted `ripgrep`, `edit_plan`, and `write_plan`.
  Shell commands, file discovery, direct reads, code writes, and other extension
  tools are unavailable during planning.
- Programming uses the same tools and system prompt as an ordinary Pi task. The
  approved plan is included in the user message that starts implementation. Its
  image annex is loaded from disk and mapped to Pi agent `ImageContent` blocks in
  manifest order. Refinement requests receive the same image blocks.
- If the persisted plan changes after approval, subsequent tool calls are
  blocked until the revised plan is reviewed again.
- The HTTP server binds only to `127.0.0.1`. The browser link carries a temporary
  access token; approval also checks the request origin and exact plan revision.
- Switching sessions, reloading extensions, or exiting Pi closes the server.
  The Markdown file remains. Previous tool selection is restored on cleanup.

If the browser cannot be opened automatically, use the complete link printed by
Pi, including its token fragment. Keep the owning terminal running while reviewing.
