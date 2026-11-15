# Helper runs

A chat that asks for a picture runs a script, and the script starts its own
headless provider session in a folder it makes for that one request. That
session is the chat's work. It is shown as one of the chat's nested
conversations, labelled for what it is, and never as a chat or a Mesh of its
own.

**Recognised** (`kinds.ts`, `recognition.ts`). A run is a headless Grok
session in a folder that was made for it. Two things say a folder was:

- its name: it sits directly inside a temp directory and carries a generator's
  prefix. `GENERATORS` is the one place a generator is listed: its folder
  prefix, the kind its runs are, and the label a phone that does not know the
  kind shows;
- what became of it, whatever a script called it: the session was given one
  request, the folder is not a checkout of its own, and it is gone again from
  inside a Git checkout or the temp directory, or was made in the last
  fifteen minutes. A folder that a live run was linked from counts as well.

A run that made a picture is an image generation; any other is a helper run.
A headless session in a workspace that stays, in a checkout of its own such as
a worktree, or one given a second request, is a chat.

**Linked** (`capture.ts`, `links.ts`). Nothing recorded after the fact names
the chat that started a run. The run's live process does: Claude Code and
Codex give every command a chat runs that chat's id, and the run inherits it.
Each process sample (`machine-load`) passes its provider processes here. A
process is looked at once: its working folder is read, and only when that is a
run's folder (a generator's, or for Grok one made minutes ago that is not a
checkout of its own) is its environment read, for the chat's id alone. Nothing
read from a process is logged or kept beyond that id. The link is written to
`helper-runs.json` in the config directory, keyed by the run's folder, and
outlives the process. The first capture of a run stands.

**Shown** (`attach.ts`). The session catalog adds each linked run to its
parent's `childThreads` with `kind` set, and leaves the parent's own state,
clock and spend alone. Opening the conversation reads the run's own messages.
A run whose parent was not captured, or whose parent is no longer on this
computer, is published nowhere; the provider's own history still has it.

**Pictures** (`pictures/`). The script copies a
run's picture away and deletes the run's folder the moment the run ends, so
the folder of every live linked run is looked at five times a second while
its process lives (file events arrived seconds late under load, after such a
folder was gone). A picture is read as soon as it is written to its end and is
kept from memory: on macOS as a JPEG at most 1600 pixels long (`sips`, never
enlarged), elsewhere as it is when it is at most 8 MB. Copies live in
`helper-run-pictures/` in the config directory with one `index.json`, at most
12 per run, and are let go with the run's history or when the store passes its
bounds. The run's card carries them as `images`, and its last answer shows them
in place of the path line that names them. A phone reads one with
`session.image.query` on the parent chat; the id names the run and the
picture's content, never a path, and only the chat that started the run is
answered.

**Meshes.** A run is not passed to the Mesh, and a generator's folder never
registers one. A Mesh without a remote whose folder is a generator's, or is
gone from inside a Git checkout or the temp directory, was registered for a
run before the run was recognised: it stays in the Mesh store and is left out
of every list of this computer's Projects. A workspace of its own is kept
whether its folder is there or not.

Tests live in `tests/`; the Mesh behaviour is covered in
`../mesh/runtime/tests/helper-run-meshes.test.ts`.

Licensed under the GrantTap Commercial Source License. See the repository root `LICENSE`.
